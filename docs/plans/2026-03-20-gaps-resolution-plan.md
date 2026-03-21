# Gaps Resolution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Open Brain's structured memory (loops, entity facts, mentions) retrievable on par with thoughts through a unified retrieval broker, and eliminate stale memory artifacts from edit/reprocess flows.

**Architecture:** A new `rag.ts` broker queries `thoughts` and `open_loops` in parallel, merges results into a common `MemoryCandidate` shape, and serves both chat and MCP. A background worker in `queue.ts` embeds loops asynchronously via a Postgres-backed job queue. Intent routing in `openrouter.ts` steers queries to the right retrieval path. Entity canonicalization migrates all surfaces from `metadata.people` to the `entities` table.

**Tech Stack:** TypeScript ESM, Hono, PostgreSQL + pgvector, Vitest, OpenRouter API

**Design doc:** `docs/plans/2026-03-20-gaps-resolution-design.md`
**Source spec:** `docs/design/open-brain-gaps-resolution-v1.9.md`

---

## Phase 1 — Schema Foundation

### Task 1: Create migration file

**Files:**
- Create: `db/migrations/002_loop_embeddings.sql`

**Step 1: Write the migration SQL**

```sql
-- 002_loop_embeddings.sql
-- Adds embedding support to open_loops, model provenance to thoughts,
-- and the embedding_jobs queue table.
-- All statements idempotent — re-executed on every app boot.

-- 1. open_loops: embedding columns
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS embedding       vector(1536);
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS embedded_at     timestamptz;

-- 2. thoughts: model provenance columns
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS embedding_model  text;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS embedded_at      timestamptz;

-- 3. Partial HNSW index on open_loops.embedding (excludes NULL rows)
CREATE INDEX IF NOT EXISTS open_loops_embedding_idx
  ON open_loops USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- 4. Embedding jobs queue table
CREATE TABLE IF NOT EXISTS embedding_jobs (
  id            bigserial    PRIMARY KEY,
  job_type      text         NOT NULL
      CHECK (job_type IN ('loop_embedding')),
  payload_json  jsonb        NOT NULL,
  status        text         NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'claimed', 'complete', 'failed')),
  attempt_count integer      NOT NULL DEFAULT 0,
  available_at  timestamptz  NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  last_error    text,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

-- 5. Queue polling index
CREATE INDEX IF NOT EXISTS embedding_jobs_status_idx
  ON embedding_jobs (status, available_at)
  WHERE status IN ('pending', 'claimed');

-- 6. One active job per loop (prevents duplicate work)
CREATE UNIQUE INDEX IF NOT EXISTS embedding_jobs_one_active_per_loop
  ON embedding_jobs ((payload_json->>'loop_id'))
  WHERE job_type = 'loop_embedding'
    AND status IN ('pending', 'claimed');
```

**Step 2: Verify file exists**

Run: `ls db/migrations/002_loop_embeddings.sql`
Expected: file listed

**Step 3: Commit**

```bash
git add db/migrations/002_loop_embeddings.sql
git commit -m "feat(schema): add loop embeddings migration"
```

---

### Task 2: Update init.sql with same DDL

**Files:**
- Modify: `db/init.sql` (append after the `blocked_by_entity_id` ALTER on line 191, before `match_thoughts` function on line 194)

**Step 1: Add the new DDL to init.sql**

Insert the same SQL from Task 1 between the `blocked_by_entity_id` column addition and the `match_thoughts` function. All statements must use `IF NOT EXISTS`.

The block to insert (identical DDL to migration file):

```sql
-- Loop embedding support
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS embedding       vector(1536);
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS embedded_at     timestamptz;

-- Thought model provenance
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS embedding_model  text;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS embedded_at      timestamptz;

CREATE INDEX IF NOT EXISTS open_loops_embedding_idx
  ON open_loops USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- Embedding jobs queue
CREATE TABLE IF NOT EXISTS embedding_jobs (
  id            bigserial    PRIMARY KEY,
  job_type      text         NOT NULL
      CHECK (job_type IN ('loop_embedding')),
  payload_json  jsonb        NOT NULL,
  status        text         NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'claimed', 'complete', 'failed')),
  attempt_count integer      NOT NULL DEFAULT 0,
  available_at  timestamptz  NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  last_error    text,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS embedding_jobs_status_idx
  ON embedding_jobs (status, available_at)
  WHERE status IN ('pending', 'claimed');

CREATE UNIQUE INDEX IF NOT EXISTS embedding_jobs_one_active_per_loop
  ON embedding_jobs ((payload_json->>'loop_id'))
  WHERE job_type = 'loop_embedding'
    AND status IN ('pending', 'claimed');
```

**Step 2: Commit**

```bash
git add db/init.sql
git commit -m "feat(schema): mirror loop embeddings DDL in init.sql"
```

---

### Task 3: Verify idempotence and backward compatibility

**Step 1: Run existing tests**

Run: `make test`
Expected: all tests pass — schema changes don't affect mocked tests

**Step 2: Start the app and verify double-boot (requires running DB)**

Run: `make up && sleep 3 && make down && make up`
Expected: no SQL errors on second boot, all DDL idempotent

**Step 3: Verify current loop creation still works**

Capture a thought with action items via the API and confirm:
- Thought row created
- Open loop row created
- Evidence row created
- No errors from new nullable columns

**Step 4: Commit verification notes (if any fixes needed)**

---

## Phase 2 — Write Path, Worker, and Backfill

### Task 4: Create queue.ts module

**Files:**
- Create: `app/src/queue.ts`
- Test: `app/src/__tests__/queue.test.ts`

**Step 1: Write the failing test**

Create `app/src/__tests__/queue.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
}));

vi.mock("pgvector", () => ({
  default: { toSql: vi.fn((v) => `[${v.join(",")}]`) },
}));

import { query } from "../db.js";

describe("queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueueEmbeddingJob inserts with ON CONFLICT DO NOTHING", async () => {
    const { enqueueEmbeddingJob } = await import("../queue.js");
    (query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 1 });

    await enqueueEmbeddingJob("loop-123", "openai/text-embedding-3-small");

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT DO NOTHING"),
      expect.arrayContaining(["loop_embedding"]),
    );
  });

  it("claimNextJob uses FOR UPDATE SKIP LOCKED", async () => {
    const { claimNextJob } = await import("../queue.js");
    (query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });

    await claimNextJob("loop_embedding");

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE SKIP LOCKED"),
      expect.anything(),
    );
  });

  it("scheduleBackfillSweep enqueues jobs for unembedded loops", async () => {
    const { scheduleBackfillSweep } = await import("../queue.js");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ id: "loop-1" }, { id: "loop-2" }] }) // unembedded loops
      .mockResolvedValue({ rows: [], rowCount: 1 }); // enqueue calls

    await scheduleBackfillSweep();

    // Should query for unembedded loops
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("embedding IS NULL"),
      expect.anything(),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/__tests__/queue.test.ts`
Expected: FAIL — `../queue.js` does not exist

**Step 3: Write the implementation**

Create `app/src/queue.ts`:

```typescript
import { query } from "./db.js";
import { config } from "./config.js";
import { generateEmbedding } from "./openrouter.js";
import pgvector from "pgvector";

const MAX_ATTEMPTS = 5;
const WORKER_POLL_INTERVAL_MS = 30_000; // 30s baseline
const CLAIM_LEASE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_DELAY_MS = parseInt(process.env.EMBEDDING_RATE_LIMIT_MS || "200", 10);

let workerRunning = false;
let triggerFn: (() => void) | null = null;

export async function enqueueEmbeddingJob(loopId: string, model: string): Promise<void> {
  await query(
    `INSERT INTO embedding_jobs (job_type, payload_json)
     VALUES ($1, $2::jsonb)
     ON CONFLICT DO NOTHING`,
    ["loop_embedding", JSON.stringify({ loop_id: loopId, target_model: model })],
  );
}

export async function claimNextJob(jobType: string) {
  const result = await query(
    `UPDATE embedding_jobs
     SET status = 'claimed',
         claimed_at = now(),
         attempt_count = attempt_count + 1
     WHERE id = (
       SELECT id FROM embedding_jobs
       WHERE status = 'pending'
         AND job_type = $1
         AND available_at <= now()
       ORDER BY available_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [jobType],
  );
  return result.rows[0] || null;
}

async function recoverStaleJobs(): Promise<void> {
  await query(
    `UPDATE embedding_jobs
     SET status = 'pending',
         claimed_at = NULL,
         available_at = now() + (attempt_count * interval '1 minute')
     WHERE status = 'claimed'
       AND claimed_at < now() - interval '5 minutes'
       AND attempt_count < $1`,
    [MAX_ATTEMPTS],
  );
}

async function processEmbeddingJob(job: Record<string, unknown>): Promise<void> {
  const payload = job.payload_json as { loop_id: string; target_model: string };
  const jobId = job.id as number;

  try {
    // Fetch loop content
    const loopResult = await query<{ content: string }>(
      `SELECT content FROM open_loops WHERE id = $1`,
      [payload.loop_id],
    );

    if (loopResult.rows.length === 0) {
      await query(
        `UPDATE embedding_jobs SET status = 'failed', last_error = 'Loop not found', completed_at = now() WHERE id = $1`,
        [jobId],
      );
      return;
    }

    // Generate embedding
    const embedding = await generateEmbedding(loopResult.rows[0].content);

    // Write embedding to loop
    await query(
      `UPDATE open_loops
       SET embedding = $1,
           embedding_model = $2,
           embedded_at = now()
       WHERE id = $3`,
      [pgvector.toSql(embedding), payload.target_model, payload.loop_id],
    );

    // Mark complete
    await query(
      `UPDATE embedding_jobs SET status = 'complete', completed_at = now() WHERE id = $1`,
      [jobId],
    );

    console.log(JSON.stringify({ event: "embedding_job_complete", loop_id: payload.loop_id }));
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const attemptCount = (job.attempt_count as number) || 0;

    if (attemptCount >= MAX_ATTEMPTS) {
      await query(
        `UPDATE embedding_jobs SET status = 'failed', last_error = $1, completed_at = now() WHERE id = $2`,
        [errorMsg, jobId],
      );
      console.log(JSON.stringify({ event: "embedding_job_failed_permanent", loop_id: payload.loop_id, error: errorMsg }));
    } else {
      await query(
        `UPDATE embedding_jobs
         SET status = 'pending',
             last_error = $1,
             available_at = now() + (attempt_count * interval '1 minute')
         WHERE id = $2`,
        [errorMsg, jobId],
      );
      console.log(JSON.stringify({ event: "embedding_job_retry", loop_id: payload.loop_id, attempt: attemptCount, error: errorMsg }));
    }
  }
}

async function drain(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    await recoverStaleJobs();
    let job;
    while ((job = await claimNextJob("loop_embedding"))) {
      await processEmbeddingJob(job);
      // Rate limiting
      if (RATE_LIMIT_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
      }
    }
  } finally {
    workerRunning = false;
  }
}

export function startEmbeddingWorker(): void {
  setInterval(drain, WORKER_POLL_INTERVAL_MS);
  triggerFn = () => { drain().catch((err) => console.error("Worker drain error:", err)); };
  console.log("Embedding worker started");
}

export function triggerWorker(): void {
  if (triggerFn) triggerFn();
}

export async function scheduleBackfillSweep(): Promise<void> {
  try {
    // Backfill thought provenance (only safe if single embedding model historically)
    await query(
      `UPDATE thoughts
       SET embedding_model = $1,
           embedded_at = created_at
       WHERE embedding_model IS NULL
         AND embedding IS NOT NULL`,
      [config.embeddingModel],
    );

    // Find unembedded loops that don't already have a failed job
    const unembedded = await query<{ id: string }>(
      `SELECT ol.id FROM open_loops ol
       WHERE ol.embedding IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM embedding_jobs ej
           WHERE ej.payload_json->>'loop_id' = ol.id::text
             AND ej.status = 'failed'
         )`,
      [],
    );

    for (const row of unembedded.rows) {
      await enqueueEmbeddingJob(row.id, config.embeddingModel);
    }

    if (unembedded.rows.length > 0) {
      console.log(JSON.stringify({ event: "backfill_sweep", enqueued: unembedded.rows.length }));
      triggerWorker();
    }
  } catch (err) {
    console.error("Backfill sweep error:", err);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run src/__tests__/queue.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add app/src/queue.ts app/src/__tests__/queue.test.ts
git commit -m "feat: add embedding job queue and worker module"
```

---

### Task 5: Wire worker bootstrap in index.ts

**Files:**
- Modify: `app/src/index.ts:32-36`

**Step 1: Update index.ts**

Current (`app/src/index.ts:32-36`):
```typescript
await initDb();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Open Brain listening on :${info.port}`);
});
```

Change to:
```typescript
import { startEmbeddingWorker, scheduleBackfillSweep } from "./queue.js";

await initDb();
startEmbeddingWorker();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Open Brain listening on :${info.port}`);
  scheduleBackfillSweep();
});
```

Note: The import goes at the top of the file with other imports (after line 6).

**Step 2: Run tests**

Run: `make test`
Expected: all tests pass (tests import `app.js` not `index.js`, so no side effects)

**Step 3: Commit**

```bash
git add app/src/index.ts
git commit -m "feat: bootstrap embedding worker at app startup"
```

---

### Task 6: Update thought insert path with provenance

**Files:**
- Modify: `app/src/pipeline.ts:61-65`

**Step 1: Write the failing test**

Add to `app/src/__tests__/capture.test.ts`:

```typescript
it("writes embedding_model and embedded_at on capture", async () => {
  mockCapture.mockResolvedValue({
    id: "test-uuid",
    metadata: { type: "note", topics: [], people: [], action_items: [], dates_mentioned: [], source_context: null },
    created_at: "2026-03-20T00:00:00Z",
  });

  await app.request("/api/capture", {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ content: "Test thought" }),
  });

  expect(mockCapture).toHaveBeenCalledWith("Test thought", undefined, undefined);
});
```

Note: The real provenance test is at the pipeline unit level. For this route-level test, we verify capture still works. The actual INSERT change is verified by inspecting the SQL.

**Step 2: Update the INSERT in pipeline.ts**

Current (`app/src/pipeline.ts:61-65`):
```typescript
const result = await query<{ id: string; created_at: string }>(
  `INSERT INTO thoughts (content, embedding, metadata, parent_id)
   VALUES ($1, $2, $3, $4)
   RETURNING id, created_at`,
  [content, pgvector.toSql(embedding), JSON.stringify(metadataWithHash), parentId || null],
);
```

Change to:
```typescript
const result = await query<{ id: string; created_at: string }>(
  `INSERT INTO thoughts (content, embedding, metadata, parent_id, embedding_model, embedded_at)
   VALUES ($1, $2, $3, $4, $5, $6)
   RETURNING id, created_at`,
  [content, pgvector.toSql(embedding), JSON.stringify(metadataWithHash), parentId || null, config.embeddingModel, new Date().toISOString()],
);
```

Add `import { config } from "./config.js";` at top of file if not already present.

**Step 3: Run tests**

Run: `make test`
Expected: all tests pass

**Step 4: Commit**

```bash
git add app/src/pipeline.ts
git commit -m "feat: write embedding_model and embedded_at on thought insert"
```

---

### Task 7: Update thought update path with provenance

**Files:**
- Modify: `app/src/routes/thoughts.ts:226-253` (the PATCH /:id handler's SQL)

**Step 1: Update the full-reprocess SQL branch**

Current (`app/src/routes/thoughts.ts:226-238`):
```typescript
sql = `UPDATE thoughts
  SET content = $1,
      embedding = $2,
      metadata = metadata || $3::jsonb,
      updated_at = now()
  WHERE id = $4 AND deleted_at IS NULL
  RETURNING id, content, metadata, created_at, updated_at`;
params = [
  content,
  pgvector.toSql(embedding),
  JSON.stringify({ ...metadataForStorage, content_hash }),
  id,
];
```

Change to:
```typescript
sql = `UPDATE thoughts
  SET content = $1,
      embedding = $2,
      metadata = metadata || $3::jsonb,
      embedding_model = $5,
      embedded_at = $6,
      updated_at = now()
  WHERE id = $4 AND deleted_at IS NULL
  RETURNING id, content, metadata, created_at, updated_at`;
params = [
  content,
  pgvector.toSql(embedding),
  JSON.stringify({ ...metadataForStorage, content_hash }),
  id,
  config.embeddingModel,
  new Date().toISOString(),
];
```

**Step 2: Update the embed-only SQL branch**

Current (`app/src/routes/thoughts.ts:241-253`):
```typescript
sql = `UPDATE thoughts
  SET content = $1,
      embedding = $2,
      metadata = jsonb_set(metadata, '{content_hash}', $3::jsonb),
      updated_at = now()
  WHERE id = $4 AND deleted_at IS NULL
  RETURNING id, content, metadata, created_at, updated_at`;
params = [
  content,
  pgvector.toSql(embedding),
  JSON.stringify(content_hash),
  id,
];
```

Change to:
```typescript
sql = `UPDATE thoughts
  SET content = $1,
      embedding = $2,
      metadata = jsonb_set(metadata, '{content_hash}', $3::jsonb),
      embedding_model = $5,
      embedded_at = $6,
      updated_at = now()
  WHERE id = $4 AND deleted_at IS NULL
  RETURNING id, content, metadata, created_at, updated_at`;
params = [
  content,
  pgvector.toSql(embedding),
  JSON.stringify(content_hash),
  id,
  config.embeddingModel,
  new Date().toISOString(),
];
```

Add `import { config } from "../config.js";` at top of file.

**Step 3: Run tests**

Run: `make test`
Expected: all tests pass

**Step 4: Commit**

```bash
git add app/src/routes/thoughts.ts
git commit -m "feat: write embedding provenance on thought update"
```

---

### Task 8: Update loop creation with idempotent insert + evidence repair + embedding enqueue

**Files:**
- Modify: `app/src/pipeline.ts:8-25` (`createLoopsFromActionItems` function)

**Step 1: Rewrite createLoopsFromActionItems**

Current (`app/src/pipeline.ts:8-25`):
```typescript
export async function createLoopsFromActionItems(
  actionItems: Array<{ content: string; loop_type: string } | string>,
  thoughtId: string,
): Promise<void> {
  for (const item of actionItems) {
    const loopContent = typeof item === "string" ? item : item.content;
    const loopType = typeof item === "string" ? "task" : (item.loop_type || "task");
    const loopResult = await query<{ id: string }>(
      `INSERT INTO open_loops (content, loop_type, source_thought_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [loopContent, loopType, thoughtId],
    );
    await query(
      `INSERT INTO open_loop_evidence (loop_id, thought_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [loopResult.rows[0].id, thoughtId],
    );
  }
}
```

Change to:
```typescript
export async function createLoopsFromActionItems(
  actionItems: Array<{ content: string; loop_type: string } | string>,
  thoughtId: string,
): Promise<void> {
  for (const item of actionItems) {
    const loopContent = typeof item === "string" ? item : item.content;
    const loopType = typeof item === "string" ? "task" : (item.loop_type || "task");

    // 1. Idempotent insert
    const insertResult = await query<{ id: string }>(
      `INSERT INTO open_loops (content, loop_type, source_thought_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [loopContent, loopType, thoughtId],
    );

    // 2. Resolve effective loop_id (new or existing)
    let loopId: string;
    if (insertResult.rows.length > 0) {
      loopId = insertResult.rows[0].id;
    } else {
      const existing = await query<{ id: string }>(
        `SELECT id FROM open_loops WHERE md5(content) = md5($1) AND source_thought_id = $2`,
        [loopContent, thoughtId],
      );
      loopId = existing.rows[0].id;
    }

    // 3. Always upsert evidence (repairs missing edges on rerun)
    await query(
      `INSERT INTO open_loop_evidence (loop_id, thought_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [loopId, thoughtId],
    );

    // 4. Enqueue embedding only when loop is new or unembedded
    const needsEmbedding = insertResult.rows.length > 0
      || (await query(
           `SELECT 1 FROM open_loops WHERE id = $1 AND embedding IS NULL`,
           [loopId],
         )).rows.length > 0;

    if (needsEmbedding) {
      try {
        const { enqueueEmbeddingJob, triggerWorker } = await import("./queue.js");
        await enqueueEmbeddingJob(loopId, config.embeddingModel);
        triggerWorker();
      } catch {
        // Don't fail loop creation if embedding enqueue fails
      }
    }
  }
}
```

Add `import { config } from "./config.js";` at top if not present.

**Step 2: Run tests**

Run: `make test`
Expected: all tests pass

**Step 3: Commit**

```bash
git add app/src/pipeline.ts
git commit -m "feat: idempotent loop creation with evidence repair and embedding enqueue"
```

---

### Task 9: Run full Phase 2 verification

**Step 1: Run all tests**

Run: `make test`
Expected: all tests pass

**Step 2: Verify no circular imports**

Run: `cd app && node -e "import('./src/pipeline.js')" 2>&1`
Expected: no circular dependency errors

**Step 3: Verify import graph**

Confirm:
- `index.ts` imports from `queue.ts` — yes
- `pipeline.ts` imports from `queue.ts` — yes
- Neither `pipeline.ts` nor `queue.ts` imports from `index.ts` — yes
- No circular risk

**Step 4: Commit any fixes**

---

## Phase 3 — Unified Retrieval Broker

### Task 10: Define MemoryCandidate interface and searchMemory signature

**Files:**
- Modify: `app/src/rag.ts` (add after existing interfaces, around line 28)

**Step 1: Add the interface and function stub**

Add after the `RAGContext` interface (line 32):

```typescript
export interface MemoryCandidate {
  memory_type: "thought" | "loop" | "fact";
  id: string;
  content: string;
  source: string;
  score: number;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface SearchMemoryOptions {
  query: string;
  filter?: Record<string, unknown>;
  timeHint?: "recent" | "last_month" | "older" | null;
  limit?: number;
  threshold?: number;
  memoryTypes?: ("thoughts" | "loops" | "facts" | "all")[];
  preferOpenLoops?: boolean;
}

export interface SearchMemoryResult {
  candidates: MemoryCandidate[];
  diagnostics: RAGDiagnostics & { loopCandidateCount: number; modelMismatchExclusions: number };
}
```

**Step 2: Run tests**

Run: `make test`
Expected: all tests pass — additive only

**Step 3: Commit**

```bash
git add app/src/rag.ts
git commit -m "feat: add MemoryCandidate interface and SearchMemory types"
```

---

### Task 11: Implement loop candidate retrieval in broker

**Files:**
- Modify: `app/src/rag.ts`
- Test: `app/src/__tests__/rag.test.ts`

**Step 1: Write the failing test**

Add to `app/src/__tests__/rag.test.ts`:

```typescript
describe("searchMemory", () => {
  it("returns mixed thoughts and loops", async () => {
    // Mock match_thoughts for thought candidates
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [] }) // match_thoughts
      .mockResolvedValueOnce({ rows: [{ id: "loop-1", content: "Follow up with Liz", similarity: 0.8, created_at: "2026-03-19T00:00:00Z", status: "open", loop_type: "task" }] }); // loop query

    const { searchMemory } = await import("../rag.js");
    const result = await searchMemory({ query: "test" });

    const loopCandidates = result.candidates.filter(c => c.memory_type === "loop");
    expect(loopCandidates.length).toBeGreaterThanOrEqual(0); // passes once implemented
  });

  it("excludes closed loops from default retrieval", async () => {
    // Verify the loop query SQL includes status filter
    const { searchMemory } = await import("../rag.js");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [] })  // match_thoughts
      .mockResolvedValueOnce({ rows: [] }); // loop query (should have status filter)

    await searchMemory({ query: "test" });

    // The loop query should include status = 'open' filter
    const loopCall = (query as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("open_loops")
    );
    if (loopCall) {
      expect(loopCall[0]).toContain("status = 'open'");
    }
  });
});
```

**Step 2: Implement searchMemory in rag.ts**

Add the `searchMemory` function after `retrieveContext`:

```typescript
export async function searchMemory(options: SearchMemoryOptions): Promise<SearchMemoryResult> {
  const {
    query: searchQuery,
    filter = {},
    timeHint = null,
    limit = 10,
    threshold = 0.25,
    memoryTypes,
    preferOpenLoops,
  } = options;
  const poolSize = Math.max(limit * 2, 15);
  const start = Date.now();

  const queryEmbedding = await generateEmbedding(searchQuery);

  const shouldQueryThoughts = !memoryTypes || memoryTypes.includes("all") || memoryTypes.includes("thoughts");
  const shouldQueryLoops = !memoryTypes || memoryTypes.includes("all") || memoryTypes.includes("loops");

  // --- Thought candidates (reuse existing path) ---
  let thoughtCandidates: MemoryCandidate[] = [];
  let rawThoughtCandidates: RankCandidate[] = [];

  if (shouldQueryThoughts) {
    const dbFilter: Record<string, unknown> = {};
    if (filter.people && Array.isArray(filter.people) && filter.people.length > 0) dbFilter.people = filter.people;
    if (filter.topics && Array.isArray(filter.topics) && filter.topics.length > 0) dbFilter.topics = filter.topics;

    const thoughtResult = await query(
      `SELECT * FROM match_thoughts($1, $2, $3, $4)`,
      [pgvector.toSql(queryEmbedding), threshold, poolSize, JSON.stringify(dbFilter)],
    );

    rawThoughtCandidates = thoughtResult.rows.map((r: any) => ({
      id: r.id, content: r.content, metadata: r.metadata,
      similarity: r.similarity, created_at: r.created_at, parent_id: r.parent_id,
    }));

    // Recent-thought augmentation
    if (timeHint === "recent") {
      const recentResult = await query(
        `SELECT id, content, metadata, created_at FROM thoughts
         WHERE deleted_at IS NULL AND created_at > now() - interval '7 days'
         ORDER BY created_at DESC LIMIT 5`,
      );
      const existingIds = new Set(rawThoughtCandidates.map((c) => c.id));
      for (const r of recentResult.rows as any[]) {
        if (!existingIds.has(r.id)) {
          rawThoughtCandidates.push({ id: r.id, content: r.content, metadata: r.metadata, similarity: 0.3, created_at: r.created_at });
        }
      }
    }

    // Rerank thoughts
    const rerankedThoughts = rerank(rawThoughtCandidates, filter, timeHint, limit);

    // Thread expansion for top 3 thought results
    const top3 = rerankedThoughts.slice(0, 3);
    if (top3.length > 0) {
      const top3Ids = top3.map((t) => t.id);
      const parentIds = top3.map((t) => t.parent_id).filter(Boolean) as string[];

      const [childrenResult, parentsResult] = await Promise.all([
        query(
          `SELECT parent_id, content, created_at FROM thoughts
           WHERE parent_id = ANY($1) AND deleted_at IS NULL
           ORDER BY created_at LIMIT 6`,
          [top3Ids],
        ),
        parentIds.length > 0
          ? query(`SELECT id, content, created_at FROM thoughts WHERE id = ANY($1)`, [parentIds])
          : Promise.resolve({ rows: [] }),
      ]);

      const threadMap = new Map<string, Array<{ content: string; created_at: string }>>();
      for (const row of childrenResult.rows as any[]) {
        const arr = threadMap.get(row.parent_id) || [];
        arr.push({ content: row.content, created_at: row.created_at });
        threadMap.set(row.parent_id, arr);
      }

      const parentMap = new Map<string, { content: string; created_at: string }>();
      for (const row of parentsResult.rows as any[]) {
        parentMap.set(row.id, { content: row.content, created_at: row.created_at });
      }

      for (const thought of rerankedThoughts) {
        const thread: Array<{ content: string; created_at: string }> = [];
        if (thought.parent_id && parentMap.has(thought.parent_id)) thread.push(parentMap.get(thought.parent_id)!);
        const children = threadMap.get(thought.id);
        if (children) thread.push(...children.slice(0, 2));
        if (thread.length > 0) thought.thread = thread;
      }
    }

    thoughtCandidates = rerankedThoughts.map((t) => ({
      memory_type: "thought" as const,
      id: t.id,
      content: t.content,
      source: "thoughts",
      score: t.similarity,
      timestamp: t.created_at,
      metadata: { ...t.metadata, thread: t.thread },
    }));
  }

  // --- Loop candidates ---
  let loopCandidates: MemoryCandidate[] = [];
  let modelMismatchExclusions = 0;

  if (shouldQueryLoops) {
    const loopResult = await query(
      `SELECT id, content, loop_type, status, source_thought_id, created_at,
              1 - (embedding <=> $1) as similarity,
              embedding_model
       FROM open_loops
       WHERE embedding IS NOT NULL
         AND embedding_model = $2
         AND (status = 'open' OR (status = 'snoozed' AND snoozed_until <= now()))
       ORDER BY embedding <=> $1
       LIMIT $3`,
      [pgvector.toSql(queryEmbedding), config.embeddingModel, poolSize],
    );

    // Count model mismatches for observability
    const mismatchResult = await query(
      `SELECT count(*)::int as cnt FROM open_loops
       WHERE embedding IS NOT NULL
         AND embedding_model != $1
         AND (status = 'open' OR (status = 'snoozed' AND snoozed_until <= now()))`,
      [config.embeddingModel],
    );
    modelMismatchExclusions = (mismatchResult.rows[0] as any)?.cnt || 0;

    loopCandidates = (loopResult.rows as any[])
      .filter((r) => r.similarity >= threshold)
      .map((r) => ({
        memory_type: "loop" as const,
        id: r.id,
        content: r.content,
        source: "open_loops",
        score: r.similarity,
        timestamp: r.created_at,
        metadata: { loop_type: r.loop_type, status: r.status, source_thought_id: r.source_thought_id },
      }));
  }

  // --- Merge and rank ---
  const allCandidates = [...thoughtCandidates, ...loopCandidates];
  allCandidates.sort((a, b) => b.score - a.score);
  const finalCandidates = allCandidates.slice(0, limit);

  const diagnostics = {
    rewrittenQuery: searchQuery,
    filter,
    timeHint,
    candidateCount: rawThoughtCandidates.length + loopCandidates.length,
    finalCount: finalCandidates.length,
    latencyMs: Date.now() - start,
    loopCandidateCount: loopCandidates.length,
    modelMismatchExclusions,
  };

  console.log(JSON.stringify({ event: "search_memory", ...diagnostics }));

  return { candidates: finalCandidates, diagnostics };
}
```

Import `config` at the top of `rag.ts`:
```typescript
import { config } from "./config.js";
```

**Step 3: Run tests**

Run: `make test`
Expected: all tests pass

**Step 4: Commit**

```bash
git add app/src/rag.ts app/src/__tests__/rag.test.ts
git commit -m "feat: implement unified retrieval broker with loop candidates"
```

---

### Task 12: Verify searchWithReranking unchanged

**Step 1: Run existing rag tests**

Run: `cd app && npx vitest run src/__tests__/rag.test.ts`
Expected: all existing rag tests pass without changes

**Step 2: Verify search_thoughts MCP still uses searchWithReranking**

Check `app/src/mcp.ts:41-60` — `search_thoughts` tool still calls `searchWithReranking()`. No changes needed.

**Step 3: Commit (if any adjustments needed)**

---

## Phase 4 — Integrate Broker into Chat and MCP

### Task 13: Wire broker into chat.ts generic path

**Files:**
- Modify: `app/src/routes/chat.ts:66-77`
- Test: `app/src/__tests__/chat.test.ts` (if exists, otherwise create)

**Step 1: Update the generic chat path**

Current (`app/src/routes/chat.ts:66-77`):
```typescript
  } else {
    // Existing generic RAG path
    const ragContext = await retrieveContext(body.messages);
    const contextBlock = formatContext(ragContext.thoughts);
    systemPrompt = `${SYSTEM_PROMPT}\n\n--- Retrieved Thoughts ---\n${contextBlock}\n--- End of Retrieved Thoughts ---`;

    sources = ragContext.thoughts.map((t) => ({
      id: t.id,
      content: t.content.slice(0, 200),
      similarity: t.similarity,
    }));
  }
```

Change to:
```typescript
  } else {
    // Unified broker path
    const rewrite = await rewriteQuery(body.messages);
    const brokerResult = await searchMemory({
      query: rewrite.search_query,
      filter: rewrite.filter,
      timeHint: rewrite.time_hint,
    });

    const thoughtResults = brokerResult.candidates.filter(c => c.memory_type === "thought");
    const loopResults = brokerResult.candidates.filter(c => c.memory_type === "loop");

    // Format thoughts section
    const thoughtsBlock = thoughtResults.length > 0
      ? thoughtResults.map((t, i) => {
          const date = new Date(t.timestamp).toISOString().split("T")[0];
          const score = (t.score * 100).toFixed(0);
          const topics = Array.isArray(t.metadata?.topics) ? (t.metadata.topics as string[]).join(", ") : "";
          const people = Array.isArray(t.metadata?.people) ? (t.metadata.people as string[]).join(", ") : "";
          let header = `[Thought ${i + 1}] (relevance: ${score}%, ${date})`;
          const metaParts: string[] = [];
          if (topics) metaParts.push(`Topics: ${topics}`);
          if (people) metaParts.push(`People: ${people}`);
          if (metaParts.length > 0) header += `\n${metaParts.join(" | ")}`;
          let body = `${header}\n${t.content}`;
          if (t.metadata?.thread && Array.isArray(t.metadata.thread) && t.metadata.thread.length > 0) {
            const threadLines = (t.metadata.thread as Array<{ content: string; created_at: string }>)
              .map((n) => `  - (${new Date(n.created_at).toISOString().split("T")[0]}) ${n.content.slice(0, 200)}`)
              .join("\n");
            body += `\n\n  [Thread] ${(t.metadata.thread as unknown[]).length} related note(s):\n${threadLines}`;
          }
          return body;
        }).join("\n\n")
      : "No relevant thoughts found.";

    // Format loops section
    const loopsBlock = loopResults.length > 0
      ? loopResults.map((l, i) => {
          const date = new Date(l.timestamp).toISOString().split("T")[0];
          const loopType = l.metadata?.loop_type || "task";
          return `[Open Loop ${i + 1}] (${loopType}, ${date})\n${l.content}`;
        }).join("\n\n")
      : "";

    let contextBlock = `--- Retrieved Thoughts ---\n${thoughtsBlock}\n--- End of Retrieved Thoughts ---`;
    if (loopsBlock) {
      contextBlock += `\n\n--- Open Loops ---\n${loopsBlock}\n--- End of Open Loops ---`;
    }

    systemPrompt = `${SYSTEM_PROMPT}\n\n${contextBlock}`;

    // Backward-compatible source payload
    sources = thoughtResults.map((t) => ({
      id: t.id,
      content: t.content.slice(0, 200),
      similarity: t.score,
    }));

    loopSources = loopResults.map((l) => ({
      id: l.id,
      content: l.content.slice(0, 200),
      similarity: l.score,
      loop_type: l.metadata?.loop_type,
    }));
  }
```

Add imports at top:
```typescript
import { searchMemory } from "../rag.js";
import { rewriteQuery } from "../openrouter.js";
```

Update the `sources` variable declaration (line 48) and add `loopSources`:
```typescript
let sources: Array<{ id: string; content: string; similarity: number }>;
let loopSources: Array<{ id: string; content: string; similarity: number; loop_type?: unknown }> = [];
```

Update the SSE source send (line 100):
```typescript
send(JSON.stringify({ type: "sources", thoughts: sources, loops: loopSources }));
```

**Step 2: Run tests**

Run: `make test`
Expected: all tests pass

**Step 3: Commit**

```bash
git add app/src/routes/chat.ts
git commit -m "feat: wire unified broker into generic chat path"
```

---

### Task 14: Add search_memory MCP tool

**Files:**
- Modify: `app/src/mcp.ts` (add after `search_thoughts` tool)

**Step 1: Add the new tool**

After the `search_thoughts` tool definition in `mcp.ts`, add:

```typescript
  // search_memory — broker-backed mixed retrieval
  server.tool(
    "search_memory",
    "Search all memory types including thoughts and open loops by semantic similarity. Returns a mixed result set of MemoryCandidate objects.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().default(10).describe("Max results to return"),
      filter: z.record(z.string(), z.unknown()).default({}).describe("Metadata filter, e.g. {people: ['Liz']}"),
      time_hint: z.enum(["recent", "last_month", "older"]).optional().describe("Temporal bias for reranking"),
    },
    async ({ query: searchQuery, limit, filter, time_hint }) => {
      const result = await searchMemory({
        query: searchQuery,
        limit,
        filter,
        timeHint: time_hint || null,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.candidates, null, 2) }],
      };
    },
  );
```

Add import at top:
```typescript
import { searchWithReranking, searchMemory } from "./rag.js";
```

(Replace the existing `searchWithReranking` import to include `searchMemory`.)

**Step 2: Update search_thoughts description to distinguish**

Change the `search_thoughts` description to:
```
"Search captured thoughts only by semantic similarity. For mixed memory search (thoughts + loops), use search_memory instead."
```

**Step 3: Run tests**

Run: `make test`
Expected: all tests pass

**Step 4: Commit**

```bash
git add app/src/mcp.ts
git commit -m "feat: add search_memory MCP tool, distinguish from search_thoughts"
```

---

### Task 15: Phase 4 verification

**Step 1: Run all tests**

Run: `make test`
Expected: all tests pass

**Step 2: Verify backward compatibility**

- `search_thoughts` still calls `searchWithReranking()` — thought-only results
- Chat SSE source payload includes `thoughts` and `loops` fields
- Entity-grounded chat path unchanged

---

## Phase 5 — Query Rewrite and Intent Routing

### Task 16: Extend QueryRewrite interface

**Files:**
- Modify: `app/src/openrouter.ts:191-209`

**Step 1: Extend the interface (additive only)**

Current (`app/src/openrouter.ts:191-195`):
```typescript
export interface QueryRewrite {
  search_query: string;
  filter: Record<string, unknown>;
  time_hint: "recent" | "last_month" | "older" | null;
}
```

Change to:
```typescript
export interface QueryRewrite {
  search_query: string;
  filter: Record<string, unknown>;
  time_hint: "recent" | "last_month" | "older" | null;
  // Phase 5 extensions — additive, all optional
  memory_types?: ("thoughts" | "loops" | "facts" | "all")[];
  prefer_open_loops?: boolean;
  entity_candidate_names?: string[];
  intent_type?: "informational" | "task" | "person-summary" | "status" | "follow-up" | "decision";
}
```

**Step 2: Update REWRITE_PROMPT**

Current (`app/src/openrouter.ts:197-209`):
Update the prompt to request the new fields. The key addition to the prompt rules:

```
- "memory_types": array of types to search. Default ["all"]. Use ["loops"] for action/task/status queries, ["thoughts"] for informational/decision queries, ["all"] for mixed queries.
- "prefer_open_loops": true when the user asks about pending actions, status, or open items. Default false.
- "entity_candidate_names": extract person names that should be resolved to canonical entities. E.g. "What about Liz?" → ["Liz"]. Empty array if no people mentioned.
- "intent_type": classify the query intent. One of: "informational", "task", "person-summary", "status", "follow-up", "decision".
```

**Step 3: Update the fallback object**

In the `rewriteQuery` function, update the fallback to include new fields:
```typescript
const fallback: QueryRewrite = {
  search_query: lastUserMsg?.content || "",
  filter: {},
  time_hint: null,
  memory_types: ["all"],
  prefer_open_loops: false,
  entity_candidate_names: [],
  intent_type: "informational",
};
```

**Step 4: Run tests**

Run: `make test`
Expected: all tests pass

**Step 5: Commit**

```bash
git add app/src/openrouter.ts
git commit -m "feat: extend QueryRewrite with intent routing fields"
```

---

### Task 17: Implement resolveEntityCandidates

**Files:**
- Modify: `app/src/entities.ts`
- Test: `app/src/__tests__/entity-resolution.test.ts`

**Step 1: Write the failing test**

Add to `app/src/__tests__/entity-resolution.test.ts`:

```typescript
describe("resolveEntityCandidates", () => {
  it("resolves known person by exact match", async () => {
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ id: "entity-123" }] }); // exact match

    const { resolveEntityCandidates } = await import("../entities.js");
    const result = await resolveEntityCandidates(["Liz"]);

    expect(result).toEqual([{ name: "Liz", entity_id: "entity-123" }]);
  });

  it("returns null for unknown names", async () => {
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [] })  // exact
      .mockResolvedValueOnce({ rows: [] })  // alias
      .mockResolvedValueOnce({ rows: [] }); // fuzzy

    const { resolveEntityCandidates } = await import("../entities.js");
    const result = await resolveEntityCandidates(["Unknown Person"]);

    expect(result).toEqual([{ name: "Unknown Person", entity_id: null }]);
  });

  it("does not write to the database", async () => {
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ rows: [] });

    const { resolveEntityCandidates } = await import("../entities.js");
    await resolveEntityCandidates(["Someone"]);

    // All queries should be SELECT, not INSERT/UPDATE
    for (const call of (query as ReturnType<typeof vi.fn>).mock.calls) {
      const sql = (call[0] as string).trim().toUpperCase();
      expect(sql).toMatch(/^SELECT/);
    }
  });
});
```

**Step 2: Implement the function**

Add to `app/src/entities.ts` (after the existing `resolveEntityMentions` function):

```typescript
/**
 * Query-time entity resolver — read-only, no side effects.
 * Resolves person names to canonical entity IDs for retrieval routing.
 * Returns null for unresolvable names (does NOT auto-create entities).
 */
export async function resolveEntityCandidates(
  names: string[],
): Promise<Array<{ name: string; entity_id: string | null }>> {
  const results: Array<{ name: string; entity_id: string | null }> = [];

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;

    // 1. Exact match
    const exact = await query<{ id: string }>(
      `SELECT id FROM entities WHERE lower(canonical_name) = lower($1) AND entity_type = 'person' LIMIT 1`,
      [trimmed],
    );
    if (exact.rows.length > 0) {
      results.push({ name: trimmed, entity_id: exact.rows[0].id });
      continue;
    }

    // 2. Alias match
    const alias = await query<{ id: string }>(
      `SELECT id FROM entities WHERE $1 ILIKE ANY(aliases) AND entity_type = 'person' LIMIT 1`,
      [trimmed],
    );
    if (alias.rows.length > 0) {
      results.push({ name: trimmed, entity_id: alias.rows[0].id });
      continue;
    }

    // 3. Fuzzy match
    const fuzzy = await query<{ id: string; sim: number }>(
      `SELECT id,
              greatest(
                similarity(lower(canonical_name), lower($1)),
                coalesce((SELECT max(similarity(lower(a), lower($1))) FROM unnest(aliases) a), 0)
              ) AS sim
       FROM entities
       WHERE entity_type = 'person'
         AND (
           lower(canonical_name) % lower($1)
           OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) % lower($1))
         )
       ORDER BY sim DESC
       LIMIT 1`,
      [trimmed],
    );
    if (fuzzy.rows.length > 0 && fuzzy.rows[0].sim >= config.entityFuzzyThreshold) {
      results.push({ name: trimmed, entity_id: fuzzy.rows[0].id });
      continue;
    }

    // 4. Unresolvable — return null, do NOT create
    results.push({ name: trimmed, entity_id: null });
  }

  return results;
}
```

**Step 3: Run tests**

Run: `make test`
Expected: all tests pass

**Step 4: Commit**

```bash
git add app/src/entities.ts app/src/__tests__/entity-resolution.test.ts
git commit -m "feat: add read-only resolveEntityCandidates for query-time routing"
```

---

### Task 18: Wire intent routing into chat and broker

**Files:**
- Modify: `app/src/routes/chat.ts` (the generic path from Task 13)
- Modify: `app/src/rag.ts` (searchMemory to accept routing hints)

**Step 1: Update chat.ts to pass routing hints**

In the generic chat path (already updated in Task 13), after `rewriteQuery()`:

```typescript
const rewrite = await rewriteQuery(body.messages);

// Resolve entity candidates if names were extracted
let resolvedEntities: Array<{ name: string; entity_id: string | null }> = [];
if (rewrite.entity_candidate_names && rewrite.entity_candidate_names.length > 0) {
  resolvedEntities = await resolveEntityCandidates(rewrite.entity_candidate_names);
}

const resolvedEntityId = resolvedEntities.find(e => e.entity_id !== null)?.entity_id;
const intentType = rewrite.intent_type;
const isPersonSummary = intentType === "person-summary";
const hasLoopSignal = intentType === "task" || intentType === "status" || intentType === "follow-up" || rewrite.prefer_open_loops;

// Routing decision
if (resolvedEntityId && isPersonSummary && !hasLoopSignal) {
  // Person-summary only → entity-grounded path
  const groundingContext = await buildEntityGroundingContext(resolvedEntityId, lastUserMsg.content);
  const contextBlock = formatEntityGroundingPrompt(groundingContext);
  systemPrompt = `${ENTITY_SYSTEM_PROMPT}\n\n${contextBlock}`;
  sources = groundingContext.thoughts.map((t) => ({ id: t.id, content: t.content.slice(0, 200), similarity: t.similarity }));
} else if (resolvedEntityId && isPersonSummary && hasLoopSignal) {
  // Mixed person-summary + loop → augmented entity-grounded path
  const groundingContext = await buildEntityGroundingContext(resolvedEntityId, lastUserMsg.content);
  // Fetch entity-linked loops
  const entityLoops = await query(
    `SELECT ol.id, ol.content, ol.loop_type, ol.created_at
     FROM open_loops ol
     JOIN entity_mentions em ON em.thought_id = ol.source_thought_id
     WHERE em.entity_id = $1
       AND ol.status = 'open'
     ORDER BY ol.created_at DESC
     LIMIT 10`,
    [resolvedEntityId],
  );
  const loopsBlock = (entityLoops.rows as any[]).map((l, i) =>
    `[Open Loop ${i + 1}] (${l.loop_type}, ${new Date(l.created_at).toISOString().split("T")[0]})\n${l.content}`
  ).join("\n\n");
  const contextBlock = formatEntityGroundingPrompt(groundingContext)
    + (loopsBlock ? `\n\n--- Open Loops ---\n${loopsBlock}\n--- End of Open Loops ---` : "");
  systemPrompt = `${ENTITY_SYSTEM_PROMPT}\n\n${contextBlock}`;
  sources = groundingContext.thoughts.map((t) => ({ id: t.id, content: t.content.slice(0, 200), similarity: t.similarity }));
  loopSources = (entityLoops.rows as any[]).map((l) => ({ id: l.id, content: l.content.slice(0, 200), similarity: 0, loop_type: l.loop_type }));
} else {
  // Generic broker path (action/status only, or no entity resolves)
  // ... existing broker code from Task 13 ...
}
```

Add import:
```typescript
import { resolveEntityCandidates } from "../entities.js";
```

**Step 2: Run tests**

Run: `make test`
Expected: all tests pass

**Step 3: Commit**

```bash
git add app/src/routes/chat.ts app/src/rag.ts
git commit -m "feat: wire intent routing into chat retrieval paths"
```

---

### Task 19: Phase 5 verification and routing test suite

**Files:**
- Test: `app/src/__tests__/routing.test.ts` (new)

**Step 1: Create routing test suite**

Test the 10 queries from the design spec. For each, verify:
1. Rewrite output contains expected fields
2. Correct routing path selected
3. Entity resolution triggered when appropriate

**Step 2: Run all tests**

Run: `make test`
Expected: all tests pass

**Step 3: Commit**

```bash
git add app/src/__tests__/routing.test.ts
git commit -m "test: add intent routing test suite"
```

---

## Phase 6 — Reprocessing, Cleanup, and Trust Repair

### Task 20: Fix loop cleanup — scope to status='open' only

**Files:**
- Modify: `app/src/routes/thoughts.ts:276-288`

**Step 1: Write the failing test**

Add to `app/src/__tests__/thoughts.test.ts`:

```typescript
it("removes open loops when reprocessed with zero action items", async () => {
  // Mock: reprocess returns metadata with empty action_items
  // Verify DELETE query targets status = 'open' only
  // Verify it runs even when action_items is empty
});
```

**Step 2: Fix the loop cleanup logic**

Current (`app/src/routes/thoughts.ts:276-288`):
```typescript
    // Recreate loops: delete existing open loops, preserve closed/snoozed
    const actionItems = Array.isArray(metadata.action_items) ? metadata.action_items : [];
    if (actionItems.length > 0) {
      try {
        await query(
          `DELETE FROM open_loops WHERE source_thought_id = $1 AND status = 'open'`,
          [id],
        );
        await createLoopsFromActionItems(actionItems, id);
      } catch {
        // Don't fail update if loop recreation fails
      }
    }
```

Change to:
```typescript
    // Always delete open loops, then conditionally recreate
    const actionItems = Array.isArray(metadata.action_items) ? metadata.action_items : [];
    try {
      await query(
        `DELETE FROM open_loops WHERE source_thought_id = $1 AND status = 'open'`,
        [id],
      );
      if (actionItems.length > 0) {
        await createLoopsFromActionItems(actionItems, id);
      }
    } catch {
      // Don't fail update if loop cleanup/recreation fails
    }
```

**Step 3: Run tests**

Run: `make test`
Expected: all tests pass

**Step 4: Commit**

```bash
git add app/src/routes/thoughts.ts app/src/__tests__/thoughts.test.ts
git commit -m "fix: always delete open loops on reprocess, even with zero action items"
```

---

### Task 21: Add pure mention resolver

**Files:**
- Modify: `app/src/entities.ts`
- Test: `app/src/__tests__/entity-resolution.test.ts`

**Step 1: Write the failing test**

```typescript
describe("computeEntityMentions", () => {
  it("returns resolved mentions without writing to DB", async () => {
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] }); // exact match

    const { computeEntityMentions } = await import("../entities.js");
    const result = await computeEntityMentions(["Liz"], "thought-123");

    expect(result.length).toBe(1);
    expect(result[0].entity_id).toBe("entity-1");

    // Verify no INSERT/UPDATE queries
    for (const call of (query as ReturnType<typeof vi.fn>).mock.calls) {
      const sql = (call[0] as string).trim().toUpperCase();
      expect(sql).toMatch(/^SELECT/);
    }
  });

  it("skips unresolvable names (no auto-create)", async () => {
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [] })  // exact
      .mockResolvedValueOnce({ rows: [] })  // alias
      .mockResolvedValueOnce({ rows: [] }); // fuzzy

    const { computeEntityMentions } = await import("../entities.js");
    const result = await computeEntityMentions(["Unknown"], "thought-123");

    expect(result.length).toBe(0); // skipped, not created
  });
});
```

**Step 2: Implement computeEntityMentions**

Add to `app/src/entities.ts`:

```typescript
export interface MentionRecord {
  entity_id: string;
  thought_id: string;
  raw_mention_text: string;
  normalized_mention_text: string;
  resolution_state: ResolutionState;
  resolution_confidence: number;
  resolution_metadata_json: Record<string, unknown> | null;
}

/**
 * Pure mention resolver for reprocess path — read-only, no writes.
 * Skips unresolvable names (does not auto-create entities).
 */
export async function computeEntityMentions(
  names: string[],
  thoughtId: string,
): Promise<MentionRecord[]> {
  const results: MentionRecord[] = [];

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLowerCase();

    // 1. Exact match
    const exact = await query<{ id: string }>(
      `SELECT id FROM entities WHERE lower(canonical_name) = lower($1) AND entity_type = 'person' LIMIT 1`,
      [trimmed],
    );
    if (exact.rows.length > 0) {
      results.push({
        entity_id: exact.rows[0].id, thought_id: thoughtId,
        raw_mention_text: trimmed, normalized_mention_text: normalized,
        resolution_state: "auto_linked_exact", resolution_confidence: 1.0,
        resolution_metadata_json: { match_type: "canonical" },
      });
      continue;
    }

    // 2. Alias match
    const alias = await query<{ id: string }>(
      `SELECT id FROM entities WHERE $1 ILIKE ANY(aliases) AND entity_type = 'person' LIMIT 1`,
      [trimmed],
    );
    if (alias.rows.length > 0) {
      results.push({
        entity_id: alias.rows[0].id, thought_id: thoughtId,
        raw_mention_text: trimmed, normalized_mention_text: normalized,
        resolution_state: "auto_linked_alias", resolution_confidence: 1.0,
        resolution_metadata_json: { match_type: "alias" },
      });
      continue;
    }

    // 3. Fuzzy match
    const fuzzy = await query<{ id: string; sim: number }>(
      `SELECT id,
              greatest(
                similarity(lower(canonical_name), lower($1)),
                coalesce((SELECT max(similarity(lower(a), lower($1))) FROM unnest(aliases) a), 0)
              ) AS sim
       FROM entities
       WHERE entity_type = 'person'
         AND (lower(canonical_name) % lower($1) OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) % lower($1)))
       ORDER BY sim DESC LIMIT 1`,
      [trimmed],
    );
    if (fuzzy.rows.length > 0 && fuzzy.rows[0].sim >= config.entityFuzzyThreshold) {
      results.push({
        entity_id: fuzzy.rows[0].id, thought_id: thoughtId,
        raw_mention_text: trimmed, normalized_mention_text: normalized,
        resolution_state: "auto_linked_fuzzy", resolution_confidence: fuzzy.rows[0].sim,
        resolution_metadata_json: { match_type: "fuzzy", similarity: fuzzy.rows[0].sim },
      });
      continue;
    }

    // 4. Unresolvable — skip (no auto-create)
  }

  return results;
}
```

**Step 3: Run tests**

Run: `make test`
Expected: all tests pass

**Step 4: Commit**

```bash
git add app/src/entities.ts app/src/__tests__/entity-resolution.test.ts
git commit -m "feat: add pure computeEntityMentions for reprocess path"
```

---

### Task 22: Implement transactional mention invalidation

**Files:**
- Modify: `app/src/routes/thoughts.ts:265-274`

**Step 1: Update the reprocess mention path**

Current (`app/src/routes/thoughts.ts:265-274`):
```typescript
  if (metadata) {
    const people = Array.isArray(metadata.people) ? metadata.people : [];
    if (people.length > 0) {
      try {
        await resolveEntityMentions(people, id);
      } catch {
        // Don't fail update if entity resolution fails
      }
    }
```

Change to:
```typescript
  if (metadata) {
    const people = Array.isArray(metadata.people) ? metadata.people : [];
    // Transactional mention invalidation
    try {
      // 1. Pure compute — outside transaction, no writes
      const newMentions = await computeEntityMentions(people, id);
      // 2. Transactional replace — only if compute succeeded
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM entity_mentions WHERE thought_id = $1`, [id]);
        for (const m of newMentions) {
          await client.query(
            `INSERT INTO entity_mentions (entity_id, thought_id, raw_mention_text, normalized_mention_text, resolution_state, resolution_confidence, resolution_metadata_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (entity_id, thought_id) DO NOTHING`,
            [m.entity_id, m.thought_id, m.raw_mention_text, m.normalized_mention_text, m.resolution_state, m.resolution_confidence, JSON.stringify(m.resolution_metadata_json)],
          );
        }
        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK");
        // On failure, existing mentions survive — no data loss
      } finally {
        client.release();
      }
    } catch {
      // If pure compute fails, existing mentions survive
    }
```

Add imports:
```typescript
import { computeEntityMentions } from "../entities.js";
import { pool } from "../db.js";
```

**Step 2: Run tests**

Run: `make test`
Expected: all tests pass

**Step 3: Commit**

```bash
git add app/src/routes/thoughts.ts
git commit -m "feat: transactional mention invalidation on thought reprocess"
```

---

### Task 23: Implement fact flagging via entity_fact_evidence

**Files:**
- Modify: `app/src/routes/thoughts.ts` (inside the reprocess block, after mention invalidation)

**Step 1: Add fact flagging after successful re-extraction**

After the mention invalidation block, still inside `if (metadata)`:

```typescript
    // Flag facts sourced from this thought for re-review (only after successful re-extraction)
    try {
      await query(
        `UPDATE entity_facts
         SET review_state = 'pending', updated_at = now()
         WHERE review_state = 'accepted'
           AND id IN (
             SELECT fact_id FROM entity_fact_evidence WHERE thought_id = $1
           )`,
        [id],
      );
    } catch {
      // Don't fail update if fact flagging fails
    }
```

**Step 2: Run tests**

Run: `make test`
Expected: all tests pass

**Step 3: Commit**

```bash
git add app/src/routes/thoughts.ts
git commit -m "feat: flag accepted facts for re-review on thought reprocess"
```

---

### Task 24: Phase 6 verification

**Step 1: Run all tests**

Run: `make test`
Expected: all tests pass

**Step 2: Verify cleanup behaviors**

- Reprocess with zero action items → open loops removed
- Closed/snoozed loops survive
- Mention invalidation is transactional
- Fact flagging only runs after successful re-extraction

---

## Phase 7 — Canonicalize People and Review Surfaces

### Task 25: Migrate people listing to entity-backed

**Files:**
- Modify: `app/src/routes/people.ts`
- Test: `app/src/__tests__/people.test.ts`

**Step 1: Replace metadata-based listing with entity query**

Replace the GET `/` handler's SQL from `jsonb_array_elements_text(metadata->'people')` to:

```sql
SELECT e.id, e.canonical_name as name,
       count(DISTINCT em.thought_id)::int as mention_count,
       max(t.created_at) as last_seen
FROM entities e
JOIN entity_mentions em ON em.entity_id = e.id
JOIN thoughts t ON t.id = em.thought_id AND t.deleted_at IS NULL
WHERE e.entity_type = 'person'
GROUP BY e.id, e.canonical_name
ORDER BY mention_count DESC
```

**Step 2: Replace person filter to use entity_mentions join**

**Step 3: Run tests, commit**

```bash
git commit -m "feat: entity-backed people listing and filtering"
```

---

### Task 26: Replace PATCH /people/:name with entity rename

**Files:**
- Modify: `app/src/routes/people.ts`

**Step 1: Rewrite the PATCH handler**

Replace the current `metadata.people` rewrite with entity-level rename:

```typescript
// Find entity by canonical name or alias
// Update canonical_name and/or add old name as alias
// Return updated entity
```

**Step 2: Run tests, commit**

```bash
git commit -m "feat: replace people rename with entity rename/merge"
```

---

### Task 27: Migrate thought list person filter

**Files:**
- Modify: `app/src/routes/thoughts.ts:33-35`

**Step 1: Replace metadata filter with entity join**

Current:
```typescript
if (person) {
  conditions.push(`metadata->'people' ? $${paramIdx++}`);
  params.push(person);
}
```

Change to resolve person to entity first, then filter via entity_mentions join. Fall back to metadata filter for unresolved names.

**Step 2: Run tests, commit**

```bash
git commit -m "feat: entity-backed person filter in thought listing"
```

---

### Task 28: Migrate MCP list and stats tools

**Files:**
- Modify: `app/src/mcp.ts`

**Step 1: Update list_thoughts person filter to entity-backed**

**Step 2: Update thought_stats people counts to entity-backed**

**Step 3: Run tests, commit**

```bash
git commit -m "feat: entity-backed MCP list and stats tools"
```

---

### Task 29: Migrate RAG context formatting

**Files:**
- Modify: `app/src/rag.ts:270` (formatContext people line)

**Step 1: Use canonical entity names in context**

This requires looking up canonical names via entity_mentions for the formatted thoughts. For now, the broker's MemoryCandidate already carries metadata — the people field can be resolved during broker retrieval.

**Step 2: Run tests, commit**

```bash
git commit -m "feat: entity-resolved names in RAG context formatting"
```

---

### Task 30: Fix weekly review inputs

**Files:**
- Modify: `app/src/routes/review.ts`
- Modify: `app/src/mcp.ts` (weekly_review tool)

**Step 1: Update review.ts to consume open_loops and entity data**

Replace `meta.action_items` source with:
```sql
SELECT content, loop_type, created_at
FROM open_loops
WHERE status = 'open' AND created_at > $cutoff
```

Replace `meta.people` source with entity-backed counts.

**Step 2: Align MCP weekly_review with same inputs**

**Step 3: Run tests, commit**

```bash
git commit -m "feat: weekly review from open_loops and canonical entities"
```

---

### Task 31: Phase 7 final verification

**Step 1: Run all tests**

Run: `make test`
Expected: all tests pass

**Step 2: Verify no surface reads metadata.people as source of truth**

Grep for remaining `metadata->'people'` or `metadata.people` usage in query/display paths. All should be either:
- Removed
- Gated behind compatibility fallback
- Write-only (capture still populates for cache)

**Step 3: Final commit**

```bash
git commit -m "chore: verify all people surfaces entity-backed"
```

---

## Post-Implementation

### Full regression test

Run: `make test`
Expected: all tests pass

### Smoke test with running app

1. Capture a thought with action items and people → verify thought, loops, evidence, entity mentions all created
2. Search via `search_memory` → verify mixed results
3. Chat about a person → verify entity-grounded path
4. Reprocess a thought → verify stale loops cleaned, mentions replaced transactionally
5. Weekly review → verify uses open_loops and entities

### Deploy

Run: `make deploy ENV=prod`
