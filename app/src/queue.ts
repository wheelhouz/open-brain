import { query } from "./db.js";
import { config } from "./config.js";
import { generateEmbedding } from "./openrouter.js";
import pgvector from "pgvector";

const MAX_ATTEMPTS = 5;
const WORKER_POLL_INTERVAL_MS = 30_000;

const RATE_LIMIT_DELAY_MS = parseInt(
  process.env.EMBEDDING_RATE_LIMIT_MS || "200",
  10,
);

let running = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const MAX_PENDING_JOBS = 500;

export async function enqueueEmbeddingJob(
  loopId: string,
  model: string,
): Promise<void> {
  // Check pending job count before inserting
  const countResult = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM embedding_jobs WHERE status = 'pending'`,
  );
  const pendingCount = parseInt(countResult.rows[0]?.count || "0", 10);
  if (pendingCount >= MAX_PENDING_JOBS) {
    console.warn(`[queue] Queue depth cap reached (${pendingCount} pending jobs), skipping enqueue for loop ${loopId}`);
    return;
  }

  await query(
    `INSERT INTO embedding_jobs (job_type, payload_json)
     VALUES ('loop_embedding', $1::jsonb)
     ON CONFLICT DO NOTHING`,
    [JSON.stringify({ loop_id: loopId, target_model: model })],
  );
}

export async function claimNextJob(
  jobType: string,
): Promise<Record<string, unknown> | null> {
  const result = await query(
    `UPDATE embedding_jobs
     SET status = 'claimed', claimed_at = now(), attempt_count = attempt_count + 1
     WHERE id = (
       SELECT id FROM embedding_jobs
       WHERE status = 'pending' AND job_type = $1 AND available_at <= now()
       ORDER BY available_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [jobType],
  );
  return result.rows[0] ?? null;
}

async function recoverStaleClaims(): Promise<void> {
  await query(
    `UPDATE embedding_jobs
     SET status = 'pending', claimed_at = NULL,
         available_at = now() + (attempt_count * interval '1 minute')
     WHERE status = 'claimed'
       AND claimed_at < now() - interval '5 minutes'
       AND attempt_count < $1`,
    [MAX_ATTEMPTS],
  );
}

async function processJob(
  job: Record<string, unknown>,
): Promise<void> {
  const jobId = job.id as string;
  const payload = job.payload_json as { loop_id: string; target_model: string };

  try {
    // Fetch loop content
    const loopResult = await query(
      `SELECT id, content FROM open_loops WHERE id = $1`,
      [payload.loop_id],
    );

    if (loopResult.rows.length === 0) {
      // Loop no longer exists — mark job complete
      await query(
        `UPDATE embedding_jobs SET status = 'complete', completed_at = now(), last_error = 'loop not found' WHERE id = $1`,
        [jobId],
      );
      return;
    }

    const loop = loopResult.rows[0] as { id: string; content: string };

    // Generate embedding
    const embedding = await generateEmbedding(loop.content);

    // Write embedding to loop row
    await query(
      `UPDATE open_loops
       SET embedding = $1::vector, embedding_model = $2, embedded_at = now()
       WHERE id = $3`,
      [pgvector.toSql(embedding), payload.target_model, loop.id],
    );

    // Mark job complete
    await query(
      `UPDATE embedding_jobs SET status = 'complete', completed_at = now() WHERE id = $1`,
      [jobId],
    );
  } catch (err) {
    const attemptCount = job.attempt_count as number;
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (attemptCount >= MAX_ATTEMPTS) {
      await query(
        `UPDATE embedding_jobs SET status = 'failed', last_error = $1, completed_at = now() WHERE id = $2`,
        [errorMsg, jobId],
      );
    } else {
      // Reset to pending with backoff
      await query(
        `UPDATE embedding_jobs
         SET status = 'pending', claimed_at = NULL, last_error = $1,
             available_at = now() + ($2 * interval '1 minute')
         WHERE id = $3`,
        [errorMsg, attemptCount, jobId],
      );
    }
    console.error(`[queue] Job ${jobId} failed:`, err);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;

  try {
    // Recover stale claims first
    await recoverStaleClaims();

    // Process jobs until none remain
    let job = await claimNextJob("loop_embedding");
    while (job) {
      await processJob(job);
      if (RATE_LIMIT_DELAY_MS > 0) {
        await delay(RATE_LIMIT_DELAY_MS);
      }
      job = await claimNextJob("loop_embedding");
    }
  } catch (err) {
    console.error("[queue] drain error:", err);
  } finally {
    running = false;
  }
}

export function triggerWorker(): void {
  void drain();
}

export function startEmbeddingWorker(): void {
  // Kick off an initial drain
  void drain();
  // Set up heartbeat
  pollTimer = setInterval(() => void drain(), WORKER_POLL_INTERVAL_MS);
}

export async function scheduleBackfillSweep(): Promise<void> {
  // Backfill thought provenance
  await query(
    `UPDATE thoughts
     SET embedding_model = $1, embedded_at = created_at
     WHERE embedding_model IS NULL AND embedding IS NOT NULL`,
    [config.embeddingModel],
  );

  // Find unembedded loops without a failed job
  const result = await query(
    `SELECT ol.id FROM open_loops ol
     WHERE ol.embedding IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM embedding_jobs ej
         WHERE ej.payload_json->>'loop_id' = ol.id::text
           AND ej.status = 'failed'
       )`,
  );

  for (const row of result.rows) {
    const r = row as { id: string };
    await enqueueEmbeddingJob(r.id, config.embeddingModel);
  }

  triggerWorker();
}

// For testing — stop the polling interval
export function stopEmbeddingWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
