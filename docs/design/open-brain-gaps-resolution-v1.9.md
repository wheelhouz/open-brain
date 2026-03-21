# Open Brain — Gaps Resolution Plan
**Version:** 1.9
**Repo:** github.com/wheelhouz/open-brain
**Format:** NLSpec — structured implementation specification for Claude Code

---

## Changelog from v1.8

- Replaced literal `app.listen()` bootstrap examples with the current Hono `serve()` pattern from `index.ts` — agents must hook worker startup into the existing server-ready callback, not an Express-style listen call
- Added explicit MCP `search_thoughts` compatibility decision: add a new broker-backed `search_memory` tool; keep `search_thoughts` backward-compatible returning thoughts only; document the distinction in MCP tool descriptions
- Defined `failed` job semantics: `failed` is a soft terminal state — startup sweep intentionally re-enqueues loops whose jobs have reached `MAX_ATTEMPTS`; operators must explicitly reset or tombstone exhausted jobs to prevent infinite retry; clarified in queue contract and unique index scope

## Changelog from v1.7

- Fixed spec/code mismatch: `open_loops` has no `metadata` column — entity-linked loop retrieval must use `source_thought_id → entity_mentions.thought_id` join, not a non-existent metadata field
- Phase 6 mention invalidation: added explicit requirement that the current `resolveEntityMentions()` function writes as a side effect and cannot be used inside a transactional replace — either refactor into a pure compute step + separate persist step, or add a new pure resolver helper

## Changelog from v1.5

- Phase 1 SQL examples are now fully idempotent — every `ALTER TABLE ... ADD COLUMN` uses `IF NOT EXISTS`, every `CREATE INDEX` uses `IF NOT EXISTS`; prose-only guard was not sufficient since agents copy examples literally
- Phase 5: added explicit execution path for mixed fact + loop person queries — augment the existing entity-grounded path to also accept brokered loop candidates for the resolved entity, rather than leaving the combined path undefined
- Startup wording tightened to match actual boot behavior: the app executes both `init.sql` AND every file in `migrations/` on every boot — not one or the other by install type; idempotence is therefore required in both places always

---

## Purpose

This document is the implementation specification for resolving the current system gaps in Open Brain.

This is not a product-direction document. It is a plan to make structured memory that Open Brain already writes actually retrievable, trustworthy, and useful across chat, MCP, and review flows — without a broader redesign.

---

## Core Issue

> Open Brain is good at writing structure but still inconsistent at recalling that structure unless the caller already knows which subsystem to ask.

Capture currently writes into four memory layers:

- `thoughts`
- `open_loops`
- `entity_mentions`
- `entity_facts`

The default retrieval path is still thought-centric. That produces:

- Loops invisible to semantic retrieval
- Entity facts surfaced only in special-case paths
- Two simultaneous person-memory systems (`entities` and `metadata.people`)
- Weekly review running on extraction residue rather than curated memory state
- Edit/reprocess flows leaving stale memory artifacts behind
- MCP agents that can write rich structured memory but retrieve it poorly

**Root cause:** There is no unified memory orchestration layer. The system has multiple structured memory types, but retrieval does not treat them as a combined substrate.

---

## Goals

### Primary

1. Make loops semantically retrievable on par with thoughts.
2. Make generic chat and MCP benefit from structured memory by default — without subsystem-specific calls.
3. Reduce trust erosion from stale loops, stale mentions, and split-brain person storage.
4. Prepare the retrieval layer for future typed entities and richer fact linking without blocking on them now.

### Secondary

5. Preserve backward compatibility where reasonable.
6. Avoid introducing unnecessary schema complexity.
7. Keep rollout safe on existing installs.
8. Keep retrieval quality stable during migration and backfill windows.

---

## Non-Goals

The following are explicitly out of scope for this plan:

- Graph product or graph UI
- Generic typed entities beyond the required enabling schema changes
- New product features: briefs, chief-of-staff mode, proactive synthesis
- Full redesign of fact modeling or object linking
- Shared universal embeddings table for all memory objects

---

## Guiding Principles

**1. Fix recall before adding more extraction.**
The system already extracts more structure than it uses at answer time.

**2. Keep embeddings inline for now.**
`thoughts`, `entities`, and `entity_facts` already use inline embeddings. `open_loops` follows the same pattern. A shared vector table only makes sense when all retrievable memory objects are unified — not as a one-off for loops.

**3. Treat embedding model provenance as operationally required.**
Cross-table retrieval only works if vectors come from compatible embedding spaces. Mixing model versions silently degrades retrieval quality. This is non-negotiable.

**4. Optimize for safe rollout.**
During migration and backfill, the system must degrade gracefully. NULL embeddings are skipped, never treated as zero-vectors or errors.

**5. Prefer unified retrieval over special-case features.**
The fix is a broker that retrieves across memory object types. Not more one-off retrieval paths.

**6. Treat intent routing as a fallible decision layer.**
LLM-based query rewriting can misclassify. The broker and downstream retrieval must degrade gracefully on bad routing signals — not hide relevant memory.

**7. Extend existing contracts, don't rename them.**
Where existing interfaces and field names are consumed by multiple files, add new fields rather than renaming. Renaming creates churn with no architectural gain.

**8. Preserve existing behavioral semantics unless explicitly redesigning them.**
Closed and snoozed loop state represents historical user action. Cleanup operations scope to `status = 'open'` only. Broker default retrieval surfaces actionable loops only.

**9. All schema changes must be idempotent — always.**
On every boot, the app executes `init.sql` and then every `.sql` file it finds in `migrations/`. It does not track which migrations have already been applied. This means every SQL statement in both `init.sql` and every migration file must be idempotent — the app will re-execute them on every startup. Use `IF NOT EXISTS` on every `ALTER TABLE ... ADD COLUMN`, `CREATE INDEX`, `CREATE TABLE`, and `CREATE UNIQUE INDEX`. A statement without a guard will crash the app on the second boot.

---

## Architecture

### Current State

**Write path:**
- `thoughts` — embedded thought record
- `open_loops` — created from extracted action items (no embedding today)
- `entity_mentions` — created from extracted people references
- `entity_facts` — created from extracted fact candidates

**Read path:**
1. Rewrite query → extracts `people`, `topics`, `time_hint`
2. Search `thoughts` only via `match_thoughts()`
3. Rerank thoughts
4. Inject retrieved thoughts into chat / MCP / review surfaces

**Consequence:** The system increasingly writes a structured memory graph, but reads mostly from the thoughts layer. Structured memory is partially write-only.

### Target State

**Unified memory retrieval:**
- A memory broker retrieves from `thoughts` and `open_loops` in a single pass (first release)
- Entity facts integrated next via broker or entity-aware routing
- Broader typed memory after that

**Query-time routing:**
- Query rewrite emits retrieval-scope hints in addition to existing `people`/`topics`/`time_hint` fields
- Intent signals guide which memory object types to query
- Canonical entity resolution triggered automatically when a person name appears in a query, via a new query-time resolver

**Entity-first model:**
- Canonical entities become the source of truth
- `metadata.people` demoted to compatibility/cache status progressively across all surfaces

---

## Execution Order

The following order is binding. Do not refactor consumer files before their dependencies exist.

**Repo paths vs runtime paths:** Schema source files live at `db/init.sql` and `db/migrations/*` in the repository. At runtime, the Docker image copies these to `/app/init.sql` and `/app/migrations/`, and the app reads `./init.sql` and `./migrations/` from its working directory. Always edit the repo source files under `db/` — never write SQL directly to the runtime paths.

```
1. db/init.sql + db/migrations/               (schema + job table — migration file + init.sql update)
2. app/src/queue.ts                            (dedicated worker/queue module — new file)
3. app/src/index.ts                            (worker bootstrap at app startup)
4. app/src/pipeline.ts                         (loop write-path + backfill)
5. app/src/routes/thoughts.ts [Phase 2 scope]  (thought embedding update path — provenance fields)
6. app/src/rag.ts                              (unified retrieval broker)
7. app/src/routes/chat.ts                      (wire broker — parallel with mcp.ts)
8. app/src/mcp.ts                              (wire broker — parallel with chat.ts)
9. app/src/openrouter.ts                       (query intent routing)
10. app/src/entities.ts                        (query-time entity resolver)
11. app/src/routes/thoughts.ts [Phase 6 scope] (cleanup + invalidation)
12. app/src/routes/review.ts                   (weekly review canonicalization)
13. app/src/routes/people.ts                   (entity-backed people surfaces)
```

**Sequencing rules:**
- `chat.ts` and `mcp.ts` must not be meaningfully refactored until `rag.ts` exposes the broker interface.
- `rag.ts` must not be finalized until schema and write-path behavior are defined.
- `openrouter.ts` and `entities.ts` (query-time resolver) are not blockers for schema/broker work but must land before the retrieval path is considered complete.
- `queue.ts` must exist before `index.ts` bootstrap and `pipeline.ts` enqueue logic are written — both import from it.
- Worker startup in `index.ts` must be added in the same release as the job table schema.
- `routes/thoughts.ts` has two separate scopes: Phase 2 (thought provenance update path only) and Phase 6 (cleanup and invalidation). Treat these as distinct changes even though they touch the same file.

---

## Phase 1 — Schema Foundation

**Primary file:** `db/init.sql` + new migration file in `db/migrations/`

**Objective:** Create the minimum schema required for loop retrieval, safe multi-object retrieval, and the async embedding job queue.

### Migration and idempotence requirement

On every boot, the app reads `./init.sql` and every `.sql` file in `./migrations/` from its working directory — in order, unconditionally, with no applied-migration tracking. In the repo, these source files live at `db/init.sql` and `db/migrations/*`. The Docker image copies them: `db/init.sql` → `/app/init.sql`, `db/migrations/` → `/app/migrations/`. Always edit `db/` in the repo — the runtime paths are build artifacts.

Because every file re-executes on every boot, every statement in every file must be idempotent, every time.

All Phase 1 DDL must appear in **both** places:

- A new versioned migration file (e.g. `db/migrations/002_loop_embeddings.sql`) so existing installs pick it up on next boot
- Updated `db/init.sql` so fresh installs get the full schema

Both files re-execute on every startup. Every DDL statement in both must use `IF NOT EXISTS`:

```sql
-- Columns:
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS embedding       vector(1536);
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS embedded_at     timestamptz;

-- Indexes:
CREATE INDEX IF NOT EXISTS ...

-- Tables:
CREATE TABLE IF NOT EXISTS embedding_jobs ( ... );

-- Unique indexes:
CREATE UNIQUE INDEX IF NOT EXISTS embedding_jobs_one_active_per_loop ON ...;
```

Do not write bare DDL without `IF NOT EXISTS` anywhere — not in migration files, not in `init.sql`. The app will crash on the second boot if it tries to add a column or create a table that already exists.

### Changes

#### 1. Add embeddings to `open_loops`

```sql
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS embedding        vector(1536);
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS embedding_model  text;
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS embedded_at      timestamptz;
```

#### 2. Add model provenance to `thoughts`

```sql
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS embedding_model  text;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS embedded_at      timestamptz;
```

Required because the unified broker compares thoughts and loops together. Cross-table reranking is only valid when both result sets share the same embedding model. Without provenance on `thoughts`, model compatibility cannot be enforced at query time.

#### 3. Add partial vector index on `open_loops.embedding`

```sql
CREATE INDEX IF NOT EXISTS open_loops_embedding_idx
  ON open_loops USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
```

Partial index on `IS NOT NULL` enforces exclusion of unembedded rows at the DB layer during rollout and backfill.

#### 4. Add `embedding_jobs` table

The job queue table belongs in the schema phase. It is a DB object and must exist before any application code references it.

```sql
CREATE TABLE IF NOT EXISTS embedding_jobs (
  id            bigserial PRIMARY KEY,
  job_type      text        NOT NULL,
  payload_json  jsonb       NOT NULL,
  status        text        NOT NULL DEFAULT 'pending',
  attempt_count integer     NOT NULL DEFAULT 0,
  available_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS embedding_jobs_status_idx
  ON embedding_jobs (status, available_at)
  WHERE status IN ('pending', 'claimed');
```

`status` values: `pending` | `claimed` | `complete` | `failed`

Payload for `loop_embedding` jobs must include:
- `loop_id` — the `open_loops` row to embed
- `target_model` — the embedding model to use (passed from app config at enqueue time)

#### 5. Add uniqueness constraint on `embedding_jobs` to prevent duplicate jobs

Without a uniqueness rule, repeated startup scans or concurrent enqueue paths can create multiple pending jobs for the same loop — wasting API calls and making queue behavior noisy.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS embedding_jobs_one_active_per_loop
  ON embedding_jobs ((payload_json->>'loop_id'))
  WHERE job_type = 'loop_embedding'
    AND status IN ('pending', 'claimed');
```

Enqueue logic must use `ON CONFLICT DO NOTHING`:

```sql
INSERT INTO embedding_jobs (job_type, payload_json)
VALUES ('loop_embedding', $payload)
ON CONFLICT DO NOTHING;
```

### Why inline, not a separate vector table

- Matches existing pattern on `thoughts`, `entities`, and `entity_facts`
- Avoids two-record consistency problem on loop insert
- Simplifies write-path and broker queries
- Does not prematurely force a polymorphic memory design

A shared vector table is only appropriate later if all retrievable memory objects are unified into a common store.

### Acceptance Criteria

- [ ] Migration file exists in `db/migrations/` with all DDL guarded by `IF NOT EXISTS`
- [ ] `db/init.sql` updated to include all new tables, columns, and indexes — also with `IF NOT EXISTS` guards
- [ ] Running the app a second time after migration (which re-executes all SQL files) produces no errors
- [ ] `open_loops` can store vector, model name, and embedding timestamp
- [ ] `thoughts` can store model name and embedding timestamp
- [ ] Vector queries on `open_loops` exclude `NULL` embedding rows at the index level
- [ ] `embedding_jobs` table exists and is indexed for queue polling
- [ ] At most one active `loop_embedding` job exists per `loop_id` at any time
- [ ] Migration does not break existing functionality when loop rows have `NULL` embeddings

---

## Phase 2 — Write Path, Worker, and Backfill

**Primary files:** `app/src/queue.ts` (new), `app/src/index.ts`, `app/src/pipeline.ts`, `app/src/routes/thoughts.ts` (provenance scope only)

**Objective:** Create the dedicated queue/worker module. Wire up the background worker at app startup. Ensure loops are embedded asynchronously on creation. Write `embedding_model` and `embedded_at` on all new and updated thoughts — including the update path in `routes/thoughts.ts`. Backfill existing loop rows.

### Decision: Loop embeddings are async

Loop embedding is asynchronous. The capture hot path already does enough synchronous work. Async embedding:
- Keeps capture latency low and predictable
- Aligns naturally with backfill infrastructure (same worker, same queue)
- Supports retries and observability without complicating capture
- Accepts eventual consistency for loop retrievability — the correct tradeoff

### Thought write path — model provenance is required

This is a coupling that v1.2 understated. Phase 1 adds `embedding_model` and `embedded_at` columns to `thoughts`, but those columns are only useful if the write path actually populates them.

`pipeline.ts` currently inserts thoughts with `(content, embedding, metadata, parent_id)` and the update path rewrites `embedding` plus metadata/content hash. Neither path writes `embedding_model` or `embedded_at` today.

**Both paths must be updated:**

```typescript
// On thought insert and on thought embedding update, always write:
embedding_model: config.embeddingModel,   // from app config, not DB session
embedded_at:     new Date().toISOString()
```

If this is omitted, the broker's model filter in Phase 3 will exclude newly created and reprocessed thoughts even after migration — silently degrading retrieval for the most recent memory.

### Dedicated queue module: `app/src/queue.ts`

Create a new file `app/src/queue.ts` to own all worker and queue orchestration logic. This module is the single import point for both `index.ts` (startup) and `pipeline.ts` (enqueue/trigger).

**Anti-pattern to avoid:** Do not export `embeddingWorker` from `index.ts` and import it in `pipeline.ts`. `pipeline.ts` is already imported by route handlers; `index.ts` is the app entry point. A direct `pipeline.ts` → `index.ts` import creates a circular dependency that Node will resolve silently but incorrectly.

```
// Correct dependency graph:
index.ts        → imports queue.ts (to start worker)
pipeline.ts     → imports queue.ts (to enqueue + trigger)
queue.ts        → imports db, config (no circular risk)

// Wrong:
index.ts        → exports embeddingWorker
pipeline.ts     → imports embeddingWorker from index.ts  ← circular
```

`queue.ts` must export at minimum:
- `startEmbeddingWorker()` — called once by `index.ts` at boot; starts the polling loop
- `enqueueEmbeddingJob(loopId, model)` — called by `pipeline.ts` after loop insert
- `triggerWorker()` — called by `pipeline.ts` to wake the worker immediately
- `scheduleBackfillSweep()` — called by `index.ts` inside the `serve()` server-ready callback; scans `open_loops WHERE embedding IS NULL` and enqueues jobs asynchronously without blocking server readiness

`index.ts` boot sequence:
```typescript
import { startEmbeddingWorker, scheduleBackfillSweep } from './queue';

await initDb();
startEmbeddingWorker();
// Hook into the existing Hono serve() server-ready callback in index.ts:
serve({ fetch: app.fetch, port: config.port }, () => {
  scheduleBackfillSweep(); // async, does not block
});
```

`scheduleBackfillSweep()` owns the startup scan. `index.ts` calls it inside the existing server-ready callback. `queue.ts` implements it. No other file invents a parallel backfill path.

### Worker architecture

The background worker runs **in-process** — inside the same Node app process as the HTTP server. Do not introduce a separate worker process, an external queue (Redis, SQS, etc.), or a cron job for this workload.

In-process is correct for Open Brain because:
- Zero additional infrastructure for self-hosted deployments
- Loop embedding jobs are small, retryable, and not latency-sensitive
- A single process is easier to reason about, deploy, and observe
- The workload does not justify the operational complexity of process isolation

**Recommended implementation pattern: polling loop with immediate trigger**

Use a polling interval as the baseline heartbeat, and expose a `trigger()` function so the worker can be woken immediately when a job is enqueued. This eliminates polling lag for new loops without requiring any infrastructure beyond a `setInterval`.

```typescript
// Sketch — implementation detail, not prescription
export function startEmbeddingWorker() {
  let running = false;

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      let job;
      while ((job = await claimNextJob('loop_embedding'))) {
        await processEmbeddingJob(job);
      }
    } finally {
      running = false;
    }
  };

  // Baseline: sweep for missed or restarted jobs
  setInterval(drain, WORKER_POLL_INTERVAL_MS);

  // Expose trigger for immediate wakeup on enqueue
  return { trigger: drain };
}
```

Call `worker.trigger()` immediately after enqueueing a job. The poll interval is a safety net for jobs that survive a restart or were enqueued while the worker was mid-drain.

**Alternative: pg_notify / LISTEN + NOTIFY**

A viable upgrade path if polling overhead becomes a concern. The DB emits a notification on insert; the app listens on a dedicated connection and wakes the worker immediately.

If implemented:
- Requires a persistent dedicated DB connection for `LISTEN`
- Notifications can be missed if the listener connection drops — keep the polling sweep as a fallback
- The `trigger()` pattern above already provides most of the benefit; `pg_notify` is an optimization, not a requirement

**What to avoid:**
- Separate worker process — adds operational complexity for self-hosted users without meaningful benefit at this workload
- External queue (Redis, SQS, BullMQ) — wrong dependency for a self-hosted product at this scale
- OS/Docker cron — correct for scheduled synthesis tasks (e.g. nightly review generation), wrong for a queue processor

### Worker bootstrap in `index.ts`

The worker must start at app boot, not lazily. The current app boots via Hono's `serve()`, not Express-style `app.listen()`. Hook worker startup into the existing boot sequence in `index.ts`:

```typescript
import { startEmbeddingWorker, scheduleBackfillSweep } from './queue';

// After initDb(), before or alongside the existing serve() call:
startEmbeddingWorker();

// Inside the existing server-ready callback passed to serve():
serve({ fetch: app.fetch, port: config.port }, () => {
  scheduleBackfillSweep(); // enqueue unembedded loops async after server is ready
});
```

Do not add a new `app.listen()` call — the app does not use Express-style listen. Hook into the callback already passed to `serve()` in `index.ts`. `startEmbeddingWorker()` starts the polling loop. `scheduleBackfillSweep()` enqueues jobs for unembedded loops after the server is listening. Both are exported from `queue.ts`. `pipeline.ts` wakes the worker via `triggerWorker()` from the same module.

Without an explicit bootstrap call in `index.ts`, the queue table exists but no process drains it.

### Job claiming — atomicity and lease semantics

**Atomic claim:**

```sql
UPDATE embedding_jobs
SET
  status        = 'claimed',
  claimed_at    = now(),
  attempt_count = attempt_count + 1
WHERE id = (
  SELECT id FROM embedding_jobs
  WHERE status = 'pending'
    AND available_at <= now()
  ORDER BY available_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` ensures only one worker claims a given job. A non-atomic SELECT-then-UPDATE causes duplicate processing.

**Stale claim / lease recovery:**

A claimed job whose worker crashed will remain in `claimed` status indefinitely without a recovery rule. The worker must re-queue abandoned jobs on each poll sweep:

```sql
UPDATE embedding_jobs
SET
  status       = 'pending',
  claimed_at   = NULL,
  available_at = now() + (attempt_count * RETRY_BACKOFF_INTERVAL)
WHERE status = 'claimed'
  AND claimed_at < now() - CLAIM_LEASE_TIMEOUT
  AND attempt_count < MAX_ATTEMPTS;
```

`CLAIM_LEASE_TIMEOUT` should be conservative enough to allow slow embedding calls to complete (e.g. 5 minutes) while still recovering from crashes in a reasonable time. This keeps queue behavior safe even if future deployments run more than one app instance.

**`failed` job semantics — soft terminal state:**

When a job reaches `MAX_ATTEMPTS` without succeeding, set `status = 'failed'`. The worker stops retrying it. However, `failed` is a **soft** terminal state, not a hard one, because:

- The unique active-job index only covers `status IN ('pending', 'claimed')`
- `scheduleBackfillSweep()` scans `open_loops WHERE embedding IS NULL` unconditionally
- A loop whose job is `failed` still has `embedding IS NULL`, so the startup sweep will re-enqueue it on next boot with a fresh `pending` job (`ON CONFLICT DO NOTHING` allows this since the old job is `failed`, not active)

This is **intentional** — it means a failed loop gets another attempt after each restart, which is appropriate for a self-hosted system where operator restarts are the natural recovery mechanism.

**Operator control for exhausted failures:**

If an operator wants to permanently suppress retry for a specific loop, they must either:
- Update the loop's job to a custom tombstone status (e.g. `'abandoned'`) that the sweep does not re-enqueue, or
- Manually set `embedding` to a sentinel value so the loop no longer matches `WHERE embedding IS NULL`

The spec does not require an automated tombstone mechanism. Document this behavior: after a restart, `failed` loops retry. Operators who want permanent suppression must act explicitly.

**Acceptance criterion:** agents must not implement `failed` as a hard terminal state that permanently blocks re-enqueue — that would silently prevent loop embedding recovery after transient infrastructure failures.

### Loop creation — idempotent insert with evidence repair

`open_loops` already has a unique index on `(md5(content), source_thought_id)`. The insert must be idempotent. But evidence insertion must **always** run for the effective loop row — whether the loop was just created or already existed. The current behavior intentionally allows a rerun to repair a missing evidence edge. Do not regress this.

The correct pattern is: always resolve a `loop_id` for the content/source pair, always upsert `open_loop_evidence`, and only enqueue an embedding job when the loop is new or present-but-unembedded.

```typescript
import { enqueueEmbeddingJob, triggerWorker } from './queue';

// 1. Insert loop — idempotent
const insertResult = await db.query(`
  INSERT INTO open_loops (content, source_thought_id, ...)
  VALUES ($1, $2, ...)
  ON CONFLICT DO NOTHING
  RETURNING id
`, [...]);

// 2. Resolve effective loop_id (new or existing)
const loopId = insertResult.rows.length > 0
  ? insertResult.rows[0].id
  : await db.query(
      `SELECT id FROM open_loops WHERE md5(content) = md5($1) AND source_thought_id = $2`,
      [content, sourceThoughtId]
    ).then(r => r.rows[0].id);

// 3. Always upsert evidence — repairs missing edges on rerun
await db.query(`
  INSERT INTO open_loop_evidence (loop_id, thought_id, ...)
  VALUES ($1, $2, ...)
  ON CONFLICT DO NOTHING
`, [loopId, sourceThoughtId, ...]);

// 4. Enqueue embedding only when loop is new or unembedded
const needsEmbedding = insertResult.rows.length > 0
  || await db.query(
       `SELECT 1 FROM open_loops WHERE id = $1 AND embedding IS NULL`,
       [loopId]
     ).then(r => r.rows.length > 0);

if (needsEmbedding) {
  await enqueueEmbeddingJob(loopId, config.embeddingModel);
  triggerWorker();
}
```

### New loop creation flow

1. Insert loop row with `ON CONFLICT DO NOTHING`
2. Resolve effective `loop_id` — use returned id if new, or query by content hash if existing
3. Always upsert `open_loop_evidence` for the effective `loop_id` (repairs missing edges)
4. Enqueue `embedding_job` if loop is new or present-but-unembedded (`ON CONFLICT DO NOTHING` on job insert)
5. Call `triggerWorker()` from `queue.ts`
6. Background worker claims job atomically, generates embedding, writes `embedding`, `embedding_model`, `embedded_at`, marks job complete
7. On failure: increment `attempt_count`, write `last_error`, reset to `pending` with backoff on `available_at`
8. On abandoned claim: lease recovery re-queues after `CLAIM_LEASE_TIMEOUT`

### Backfill flow

The initial backfill sweep must not block server readiness. `scheduleBackfillSweep()` (exported from `queue.ts`, called by `index.ts` inside the `listen` callback) owns this:

1. Scans `open_loops WHERE embedding IS NULL`
2. Enqueues one `embedding_job` per row (`ON CONFLICT DO NOTHING` — idempotent, safe to re-run)
3. Calls `triggerWorker()` once to wake the drain loop
4. Returns without waiting for embeddings to complete

Already-embedded rows are never re-enqueued. The worker drains backfill jobs at its normal rate. Backfill and new-loop embedding share one worker path. No separate backfill script.

A large install could have thousands of unembedded loops. The enqueue sweep itself is fast (inserts only), but it must still run inside the server-ready callback passed to `serve()` — not before — to preserve the current lightweight boot contract.

### Rate limiting

The worker must respect configurable rate limits on embedding API calls. Bulk MCP imports can produce 50–200+ loop embedding jobs in a short window. The worker should:
- Support a configurable max calls per minute ceiling
- Batch embedding calls where the API supports batching
- Back off and retry on 429 responses rather than failing permanently

### Thought backfill for model provenance

For existing `thoughts` rows, backfill `embedding_model` and `embedded_at` from the application layer:

```typescript
// App-driven backfill — do not use current_setting() in SQL
// The embedding model comes from Node config, not a Postgres session variable
await db.query(`
  UPDATE thoughts
  SET
    embedding_model = $1,
    embedded_at     = created_at
  WHERE embedding_model IS NULL
    AND embedding IS NOT NULL
`, [config.embeddingModel]);
```

**Assumption check — required before running backfill:**

This is only safe if the deployment has never changed embedding models. If an instance may have historically used a different model, do not blindly stamp all rows with the current model. Options:
- Require an operator-supplied legacy model label before running the backfill
- Plan a full re-embed for legacy rows before enabling the broker
- Document this assumption in migration notes and require operator confirmation

Running cross-model comparisons in the broker without correct provenance produces silent retrieval degradation that is difficult to diagnose.

**Future `EMBEDDING_MODEL` changes — affects all embedded objects, not just thoughts:**

The broker filters candidates to `embedding_model = currentModel` at query time. This is by design. It means that if `EMBEDDING_MODEL` is changed in the environment, all previously embedded objects — thoughts, loops, entity facts, entities — will silently fall out of retrieval until re-embedded under the new model.

This is not a bug in the broker; it is the intended behavior to prevent mixed-model scoring. But it means a model change is an operational event that requires a re-embed plan for every embedded object type, not just thoughts. Document this in deployment notes. The same assumption check and re-embed strategy that applies to thoughts applies equally to `open_loops` embeddings added by this plan, and to any other embedded object type added in the future.

### Rollout requirement

During the migration window, many loops will still have `NULL` embeddings. The broker (Phase 3) must:
- Skip loops with `NULL` embeddings
- Not error on `NULL`
- Not treat `NULL` as a zero-vector
- Continue returning thought results normally

### Thought provenance update — `routes/thoughts.ts` (Phase 2 scope)

The thought insert path is in `pipeline.ts`, but the update SQL that rewrites `content`, `embedding`, and `metadata` lives in `routes/thoughts.ts`. Both paths must write `embedding_model` and `embedded_at`.

This is a Phase 2 change to `routes/thoughts.ts`, separate from the Phase 6 cleanup changes to the same file. When working Phase 2, update only the embedding update path in `thoughts.ts`. Leave all other logic in that file untouched until Phase 6.

```typescript
// In routes/thoughts.ts — thought re-embedding update
// Must add alongside existing embedding write:
embedding_model: config.embeddingModel,
embedded_at:     new Date().toISOString()
```

If this is omitted, the broker's model filter will exclude freshly reprocessed thoughts — silently degrading retrieval for the most recently edited memory.

### Phase 2 Acceptance Criteria

- [ ] `queue.ts` module exists and exports `startEmbeddingWorker`, `enqueueEmbeddingJob`, `triggerWorker`, `scheduleBackfillSweep`
- [ ] `pipeline.ts` and `index.ts` both import from `queue.ts` — no direct `index.ts` ↔ `pipeline.ts` coupling
- [ ] Worker starts at app boot via `index.ts` bootstrap (`startEmbeddingWorker()`)
- [ ] `scheduleBackfillSweep()` called from inside the `serve()` server-ready callback in `index.ts` — not before server is ready, and not via a new `app.listen()` call
- [ ] New thought inserts in `pipeline.ts` write `embedding_model` and `embedded_at`
- [ ] Thought embedding updates in `routes/thoughts.ts` write `embedding_model` and `embedded_at`
- [ ] Capture completes without waiting for per-loop embedding calls
- [ ] New loops are enqueued for embedding immediately on creation
- [ ] `open_loop_evidence` is always upserted for the effective loop row, whether new or existing
- [ ] Embedding job enqueue is conditional — only fires when loop is new or present-but-unembedded
- [ ] Job claiming is atomic (`FOR UPDATE SKIP LOCKED`)
- [ ] Stale claimed jobs are re-queued after lease timeout
- [ ] Embedding jobs survive app restarts
- [ ] Failed jobs at `MAX_ATTEMPTS` are set to `status = 'failed'` — worker stops retrying them
- [ ] `failed` jobs do not block the unique active-job index — startup sweep can re-enqueue on next boot
- [ ] Behavior is documented: after restart, loops with `failed` jobs get a new attempt
- [ ] Backfill sweep runs asynchronously — server readiness is not blocked
- [ ] Backfill uses the same worker path as new-loop embedding
- [ ] Backfill is resumable and idempotent
- [ ] Worker respects configurable rate limits on embedding API calls
- [ ] Operators can inspect queue depth, failures, and stuck jobs

---

## Phase 3 — Unified Retrieval Broker

**Primary file:** `app/src/rag.ts`

**Objective:** Replace thought-only semantic retrieval with a broker that retrieves across multiple memory object types in a single call.

### Scope for first release

First broker version combines:
- `thoughts`
- `open_loops`

Entity facts can be added in a second pass once the broker is stable. Do not block Phase 3 on entity fact integration.

### Broker responsibilities

1. Accept a query string and optional filter/routing hints
2. Generate a query embedding
3. Retrieve thought candidates
4. Retrieve loop candidates — actionable loops only by default (see status semantics below)
5. Filter both sets to the currently configured embedding model only
6. Normalize scores into a common candidate shape
7. Rerank across the mixed result set
8. Return one merged ranked list

### Loop retrieval status semantics

The broker must not surface all loops indiscriminately. Including closed loops in generic retrieval would add noise and break user expectations established by `list_open_loops`.

**Default broker loop retrieval:** actionable loops only.

```sql
WHERE embedding IS NOT NULL
  AND embedding_model = $currentModel
  AND (
    status = 'open'
    OR (status = 'snoozed' AND snoozed_until <= now())
  )
```

This matches the existing `list_open_loops` semantics: open loops plus snoozed loops that are now due.

**Historical/closed loops** are excluded by default. A future routing hint (e.g. `include_closed_loops: true`) can override this for explicit history queries. Do not include closed loops in default retrieval.

### Common result shape

```typescript
interface MemoryCandidate {
  memory_type: 'thought' | 'loop' | 'fact';  // extensible
  id:          string;
  content:     string;
  source:      string;
  score:       number;        // normalized 0–1
  timestamp:   string;        // ISO 8601
  metadata:    Record<string, unknown>;
}
```

### Required safeguards

**Skip NULL loop embeddings and enforce model compatibility:**

```sql
WHERE embedding IS NOT NULL
  AND embedding_model = $currentModel
  AND (status = 'open' OR (status = 'snoozed' AND snoozed_until <= now()))
```

Never include unembedded loops. Never merge candidates from different embedding model versions. Log query-time model mismatch exclusions.

### Thought-retrieval parity requirement

The broker must preserve full parity with the current `searchWithReranking()` behavior for thought candidates. The current implementation has two retrieval behaviors beyond basic vector search that are part of existing answer quality — not incidental extras:

1. **Recent-thought augmentation**: when `time_hint === "recent"`, the retrieval path supplements semantic results with a recency-ordered fetch of recent thoughts. The broker must preserve this behavior for thought candidates when the same signal is present.

2. **Thread expansion**: top thought hits are expanded to include nearby thread context (sibling thoughts from the same conversation thread). The broker must apply thread expansion to thought results before merging the final candidate set.

Do not implement the broker as pure mixed vector search and discard these behaviors. Losing them would regress answer quality for thought-heavy queries even if loop retrieval works correctly.

### Ranking

First release: conservative normalization. Validate correctness before enabling type-aware weighting.

Future: type-aware weighting (active loops boosted for action queries, recent thoughts for recency queries, entity facts for "what do I know about X").

### Phase 3 Acceptance Criteria

- [ ] Single broker call returns mixed thoughts and actionable loops
- [ ] Loop results appear in semantically relevant queries
- [ ] Unembedded loop rows excluded silently
- [ ] Closed loops excluded from default retrieval
- [ ] Snoozed-but-due loops included in default retrieval
- [ ] Incompatible embedding model vectors never merged
- [ ] Recent-thought augmentation preserved for thought candidates when `time_hint === "recent"`
- [ ] Thread expansion applied to top thought hits before final merge
- [ ] Ranking quality for thought-heavy queries at least as good as current thought-only path
- [ ] Model mismatch exclusions observable in logs

---

## Phase 4 — Integrate Broker into Chat and MCP

**Primary files:** `app/src/routes/chat.ts`, `app/src/mcp.ts`

**Objective:** Make the default user-facing and agent-facing retrieval paths use the unified broker.

Both files are consumer layers over the same broker. They can be worked in parallel. Neither invents its own retrieval logic.

**Note:** MCP `weekly_review` is not a search tool — it loads a time window of thoughts for synthesis. Do not route it through the broker in this phase. It belongs with the `review.ts` canonicalization work in Phase 7.

### 4A. chat.ts

**Current issue:** Generic chat calls thought-only retrieval and injects only `Retrieved Thoughts`.

**Changes:**
- Replace `searchWithReranking()` / `retrieveContext()` with the broker
- Update prompt/context assembly to accept and inject `MemoryCandidate[]` results
- Structure injected context to distinguish thoughts from loops (e.g. labeled sections in the system prompt)
- Entity-fact blocks when a canonical entity is resolved can be a follow-on

**Chat payload compatibility:** The current chat route streams sources as `{ type: "sources", thoughts: sources }`. When the broker returns mixed memory types, either:
- Preserve the `thoughts` field for backward compatibility and add a parallel `loops` field, or
- Version the payload shape explicitly

Do not silently change the payload shape in a way that breaks existing UI consumers.

**Minimum viable behavior:** A query like "What am I still waiting on from Liz?" must return relevant thoughts mentioning Liz AND open loops related to Liz in a single retrieval pass.

### 4B. mcp.ts

**Current issue:** MCP search tools delegate to the thought-only reranker. MCP `weekly_review` is a synthesis tool, not a search tool, and is out of scope for this phase.

**MCP tool contract decision — `search_thoughts` vs `search_memory`:**

`search_thoughts` is an explicitly named and described tool whose current contract returns thoughts only. Making it start returning loops too is a semantic breaking change for any caller that expects thought-only results. The same care applied to the chat source payload applies here.

**Decision: add a new `search_memory` tool; keep `search_thoughts` backward-compatible.**

```
search_thoughts  — unchanged; continues to call searchWithReranking() returning thoughts only
                   description: "Search captured thoughts by semantic similarity"

search_memory    — new broker-backed tool returning MemoryCandidate[] (thoughts + loops)
                   description: "Search all memory types including thoughts and open loops"
```

This preserves backward compatibility for existing MCP callers while exposing broker-backed retrieval through the new tool. Agents and Claude Code sessions that want mixed memory retrieval call `search_memory`. Existing callers of `search_thoughts` are unaffected.

**Changes:**
- Add `search_memory` tool to `mcp.ts` — calls the broker, returns mixed `MemoryCandidate[]` results
- Keep `search_thoughts` calling `searchWithReranking()` — no change to its behavior or return shape
- Update memory lookup flows in DForge-style agent sessions to use `search_memory`
- Update MCP tool descriptions to clearly distinguish the two tools

**Out of scope for this phase:** MCP `weekly_review` — move to Phase 7.

### Phase 4 Acceptance Criteria

- [ ] `search_memory` tool exists in `mcp.ts` and calls the broker
- [ ] `search_thoughts` tool is unchanged — still calls `searchWithReranking()`, still returns thoughts only
- [ ] Loop results surface via `search_memory` without subsystem-specific calls
- [ ] Structured memory written through MCP is retrievable via `search_memory`
- [ ] Chat source payload shape is backward compatible or explicitly versioned
- [ ] Broker is the single source of retrieval logic — `search_memory` and chat both call it
- [ ] MCP tool descriptions distinguish `search_thoughts` (thought-only) from `search_memory` (all memory types)

---

## Phase 5 — Query Rewrite and Intent Routing

**Primary files:** `app/src/openrouter.ts`, `app/src/entities.ts`

**Objective:** Improve query interpretation so the broker knows what kinds of memory to prioritize, and implement the query-time entity resolver that bridges candidate names to canonical entities.

### Extend existing `QueryRewrite` shape — additive only

The current rewrite contract is `search_query`, `filter`, and `time_hint`. `rag.ts` consumes these exact field names. Do not rename them. Add new fields alongside the existing ones.

```typescript
// Existing fields — do not rename or remove
interface QueryRewrite {
  search_query: string;
  filter:       { people?: string[]; topics?: string[] };
  time_hint?:   string;

  // New fields — additive extension
  memory_types:           ('thoughts' | 'loops' | 'facts' | 'all')[];
  prefer_open_loops:      boolean;
  entity_candidate_names: string[];
  intent_type:            'informational' | 'task' | 'person-summary' | 'status' | 'follow-up' | 'decision';
}
```

### Query-time entity resolver — implementation home: `app/src/entities.ts`

The current codebase has `resolveEntityMentions(names, thoughtId)` for write-time thought mention linking, and a special entity-grounded chat path that requires an explicit `entity_id`. There is no generic query-time resolver today.

A new helper is required. It belongs in `app/src/entities.ts` alongside the existing entity logic:

```typescript
// New function — to be added to entities.ts
async function resolveEntityCandidates(
  names: string[]
): Promise<Array<{ name: string; entity_id: string | null }>>
```

This function takes the `entity_candidate_names` from the rewrite output and resolves each name to a canonical entity ID using the existing entity table (name match, alias match, or fuzzy match as appropriate). Returns `null` for names that cannot be resolved.

The resolved entity IDs are then passed to the broker or to the entity-grounded chat path to enable richer retrieval (entity facts + linked loops + linked thoughts) without requiring the caller to supply an explicit `entity_id`.

**Without this resolver, `entity_candidate_names` in the rewrite output is a dead end.** The rewrite can extract "Liz" as a candidate name, but nothing bridges that to the canonical entity and its associated facts and loops unless this function exists.

### Fact-oriented person queries — use existing entity-grounded chat path

The Phase 3 broker handles thoughts and loops. Entity facts are not broker-native until a later pass. This creates a gap for queries like "What do I know about Liz?" that expect fact retrieval.

The correct bridge for Phase 5 is to route fact-oriented person queries through the **existing entity-grounded chat path** in `chat.ts`, which already has a stricter fact-aware prompt and retrieves entity facts + linked thoughts when an `entity_id` is supplied. The query-time resolver fills the missing piece: it resolves the candidate name to a canonical entity ID, then passes that ID to the existing entity-grounded path rather than the generic broker path.

### Mixed fact + loop person queries — explicit execution path

A query like "What do I know about Maya and what's still open with her?" combines fact retrieval (person-summary) and loop retrieval (open actions) for the same entity. This is the hardest routing case because the current code has two distinct answer paths — generic broker context and entity-grounded context — and neither alone satisfies both halves.

**Required execution path for mixed person-summary + loop queries:**

Augment the existing entity-grounded path so it can also accept brokered loop candidates for the resolved entity. Do not define a third separate path.

```
// Mixed query execution:
1. rewrite → detect person-summary intent + loop/status signals
2. resolveEntityCandidates() → canonical entity_id
3. Run entity-grounded retrieval (facts + entity-linked thoughts) as today
4. Also run broker loop retrieval filtered to loops linked to entity_id:
   JOIN open_loops ol ON ol.source_thought_id = em.thought_id
   JOIN entity_mentions em ON em.entity_id = $entity_id
   (open_loops has no metadata column — source_thought_id is the durable linkage;
    metadata.people is a temporary compatibility fallback only during Phase 7 migration)
5. Assemble combined context: entity facts + entity thoughts + entity-linked loops
6. Use entity-grounded prompt (fact-aware), not generic "Retrieved Thoughts" prompt
7. Single model call with combined context
```

This approach:
- Reuses the existing entity-grounded prompt, which already handles fact status semantics correctly
- Adds loop candidates as an additional context block alongside facts — not a separate call
- Does not require a third combined-path prompt variant

Do not implement the simpler half and silently drop either facts or loops. Both must appear in the assembled context for the query class this spec explicitly promises to support.

```
// Routing summary for person queries:
person-summary only (no loop signal)
  → entity-grounded path (facts + thoughts), no broker loops

person-summary + loop/status signal
  → augmented entity-grounded path (facts + thoughts + entity-linked loops)

action/status only (no person-summary)
  → broker (thoughts + loops), no entity-grounded path

no entity resolves (any intent)
  → broker (thoughts + loops), generic prompt
```

### Example routing behaviors

| Query | Expected routing |
|---|---|
| "What am I still waiting on from Liz?" | action/status intent → broker (thoughts + loops), entity filter for Liz |
| "What do I know about Liz?" | person-summary → entity-grounded path (facts + thoughts) |
| "What do I know about Maya and what's still open?" | person-summary + loop signal → augmented entity-grounded path (facts + thoughts + entity-linked loops) |
| "What did we decide about the work order module?" | `intent_type: 'decision'` → broker (thoughts) |
| "What came up this week about onboarding?" | recency intent → broker (thoughts + loops), recency boost |

### Reliability — this is the hardest phase

Intent classification via LLM rewriting is the hardest reliability problem in this plan. A misclassification does not produce an error — it produces a retrieval result that silently omits the right memory type.

Required mitigations:
- Set `temperature = 0` on the rewrite call
- Treat routing signals as fallible hints — broker must not fail if new fields are absent or ambiguous
- Log routing decisions and resulting memory type composition

### Required test coverage

Define and run a test set before Phase 5 is considered complete. For each query, validate:
1. Rewrite output is stable on repeated runs
2. Correct `memory_types` passed to the broker
3. Entity resolution triggered and returned a canonical ID when a known person name is present
4. Final result set includes expected object types

**Minimum test query set:**

```
// Open-loop / status
"What am I still waiting on from Liz?"
"What tasks are still open from last week?"

// Person-summary
"What do I know about Liz?"
"Catch me up on Maya."

// Decision / history
"What did we decide about the work order module?"
"What was the outcome of the Attractor pipeline discussion?"

// Recent context
"What came up this week about onboarding?"
"What have I been thinking about lately?"

// Mixed
"What do I know about Maya and what's still open with her?"
"Give me a status on the DForge build."
```

### Phase 5 Acceptance Criteria

- [ ] Rewrite output stable across repeated runs (`temperature = 0`)
- [ ] New fields are additive — existing `search_query`, `filter`, `time_hint` unchanged
- [ ] `resolveEntityCandidates()` exists in `entities.ts` and resolves names to canonical entity IDs
- [ ] Person-summary-only queries with a resolved entity ID route to entity-grounded path (facts + thoughts)
- [ ] Mixed person-summary + loop queries with a resolved entity ID route to augmented entity-grounded path (facts + thoughts + entity-linked loops in one context)
- [ ] Mixed queries use the entity-grounded fact-aware prompt — not the generic "Retrieved Thoughts" prompt
- [ ] Person-oriented queries without a resolvable entity fall back to generic broker gracefully
- [ ] Action/status-only queries route to broker (thoughts + loops) — not entity-grounded path
- [ ] Loop-oriented queries reliably return actionable loops via broker
- [ ] Routing decisions observable in logs
- [ ] All test set queries pass routing validation before Phase 5 is closed

---

## Phase 6 — Reprocessing, Cleanup, and Trust Repair

**Primary file:** `app/src/routes/thoughts.ts`

**Objective:** Fix stale memory artifacts left behind by edits and best-effort capture flows. Preserve existing closed/snoozed loop semantics.

### Current problems

**Incomplete cleanup on reprocess:**
- Thought edited to remove all action items → existing `open_loops` with `status = 'open'` survive (the current delete/recreate block only runs when `actionItems.length > 0`)
- Thought edited to remove a person → stale `entity_mentions` may survive

**Best-effort capture failures:**
- Loop creation, entity resolution, and fact processing on capture are best-effort with swallowed failures
- Partial structured memory from failed capture persists indefinitely

### Required fixes

#### Fix 1: Loop cleanup — scope to `status = 'open'` only

The current update path preserves closed and snoozed loops. That is correct behavior. The fix targets only open loops.

```typescript
// Current (broken for empty extraction result):
if (actionItems.length > 0) {
  await deleteOpenLoopsForThought(thoughtId);
  await createLoopsFromActionItems(thoughtId, actionItems);
}

// Required (always recompute open loops from source thought):
await deleteOpenLoopsForThought(thoughtId);  // scope: status = 'open' only
if (actionItems.length > 0) {
  await createLoopsFromActionItems(thoughtId, actionItems);
}
```

```sql
-- deleteOpenLoopsForThought must be scoped:
DELETE FROM open_loops
WHERE source_thought_id = $thoughtId
  AND status = 'open';
```

Do not delete closed or snoozed loops. They represent user-confirmed history.

#### Fix 2: Mention invalidation — transactional replace

The safe pattern is compute-then-replace atomically. Do not delete existing mentions before resolution succeeds.

**Critical: `resolveEntityMentions()` is not usable inside this transaction as-is.**

The current `resolveEntityMentions(names, thoughtId)` function already upserts into `entity_mentions` as part of its normal behavior — it is a side-effecting write function, not a pure resolver. Using it inside the transactional replace flow would double-write mentions and undermine the invalidation guarantee the transaction is trying to establish.

Before implementing Fix 2, one of the following is required:

1. **Refactor `resolveEntityMentions()` into two steps**: a pure compute step that returns resolved mention records without writing, and a separate persist step. The transactional replace uses the pure compute step.
2. **Add a new pure resolver helper** (e.g. `computeEntityMentions(names, thoughtId)`) that returns resolved records without side effects, used only in the reprocess path.

Do not call the current side-effecting `resolveEntityMentions()` inside the transaction. Choose option 1 or 2 explicitly before writing Phase 6 code.

```typescript
// Required pattern — using a pure resolver:
const newMentions = await computeEntityMentions(updatedThought); // pure, no writes
// Only replace if resolution succeeded
await db.transaction(async (tx) => {
  await tx.query(
    `DELETE FROM entity_mentions WHERE thought_id = $1`, [thoughtId]
  );
  if (newMentions.length > 0) {
    await tx.query(`INSERT INTO entity_mentions ...`, newMentions);
  }
});
```

If resolution fails, existing mentions survive. The pure compute step must complete successfully before the transaction opens.

#### Fix 3: Fact invalidation — use existing `entity_fact_evidence` with correct enums

The schema already has `entity_fact_evidence(fact_id, thought_id, excerpt, evidence_type)`. Use this table — do not invent a new source-tracking mechanism.

The actual `entity_facts` enums are:
- `review_state`: `'pending' | 'accepted' | 'rejected'`
- `status`: `'active' | 'tentative' | 'disputed' | 'superseded'`

There is no `needs_review` state. Do not use it.

When a thought is reprocessed, the correct behavior is:

```sql
-- Find facts sourced from this thought via evidence table
SELECT ef.id, ef.review_state, ef.status
FROM entity_facts ef
JOIN entity_fact_evidence efe ON efe.fact_id = ef.id
WHERE efe.thought_id = $thoughtId;

-- Reset accepted facts to pending for re-review
-- Do not delete them — user-accepted facts are surfaced for review, not wiped
UPDATE entity_facts
SET review_state = 'pending'
WHERE id = ANY($affectedFactIds)
  AND review_state = 'accepted';
```

Only reset `review_state = 'accepted'` facts back to `'pending'`. Facts already in `'pending'` or `'rejected'` state do not need to change. Optionally downgrade `status` from `'active'` to `'tentative'` for facts whose sole evidence source was the edited thought — but this is a secondary concern. The primary requirement is that contradicted accepted facts do not silently remain accepted.

### Design principle

For all derived structured data (`open_loops`, `entity_mentions`, `entity_facts`):
> Either fully recompute from the source thought on reprocess, or track explicit source-of-truth and invalidation boundaries. Partial best-effort drift must not be the default behavior.

### Acceptance Criteria

- [ ] Reprocessing a thought with zero action items removes associated `open` loops
- [ ] Closed and snoozed loops are never deleted by reprocessing
- [ ] A pure mention resolver (compute-only, no writes) exists before transactional replace is implemented
- [ ] Mention invalidation is transactional — pure resolver completes before transaction opens; existing mentions survive on failure
- [ ] Facts sourced from a reprocessed thought are flagged via `entity_fact_evidence`, not silently retained or deleted
- [ ] Reprocessing is deterministic — running twice produces the same structured memory state

---

## Phase 7 — Canonicalize People and Review Surfaces

**Primary files:** `app/src/routes/review.ts`, `app/src/routes/people.ts`, `app/src/routes/thoughts.ts`, `app/src/mcp.ts`, `app/src/rag.ts`

**Objective:** Eliminate split-brain person storage across all surfaces, and make the highest-trust user-facing surfaces run on curated memory rather than extraction residue.

### 7A. Full scope of `metadata.people` migration

The split-brain `metadata.people` issue is broader than `review.ts` and `people.ts`. All of the following surfaces must be migrated:

| Surface | File | Current behavior | Target behavior |
|---|---|---|---|
| People listing | `routes/people.ts` | `jsonb_array_elements_text(metadata->'people')` | Query `entities` table |
| People filtering | `routes/people.ts` | String match on metadata | Filter by `entity_mentions.entity_id` |
| Thought list filter | `routes/thoughts.ts` | `person` param against metadata | Entity-linked filter |
| MCP list tools | `mcp.ts` | `metadata.people` arrays | Entity-backed |
| MCP stats tools | `mcp.ts` | Count from `meta.people` | Entity-backed counts |
| RAG context formatting | `rag.ts` | `metadata.people` in context injection | Entity-resolved names |
| Weekly review | `routes/review.ts` | `meta.people` count | Entity-backed |

`metadata.people` may remain as:
- Compatibility layer during migration
- Fallback for unresolved name strings
- Optional denormalized cache

`metadata.people` is no longer authoritative once Phase 7 lands. If retained for compatibility, it must be treated as a cache only — not as a source of truth for any query or display logic.

### 7B. Handle `peopleRouter.patch("/:name")`

The existing `PATCH /people/:name` endpoint is a metadata rewrite: it updates `thoughts.metadata.people` strings in place. Once `metadata.people` is no longer authoritative, this endpoint's behavior becomes misleading — it appears to rename a person but no longer updates the real source of truth.

This endpoint must be explicitly handled. Options:

1. **Replace with entity rename/merge** — redefine the route to operate on canonical entities and aliases in the `entities` table. This is the correct long-term behavior.
2. **Keep as compatibility cache sync** — restrict to updating `metadata.people` only, with a deprecation notice. Pair with a new entity-level rename route.
3. **Retire** — remove the route if no active callers depend on it.

Do not leave the route in place in its current form after Phase 7 lands. An endpoint that appears to rename a person but silently no longer updates the authoritative source is a trust problem.

### 7C. Fix weekly review inputs

Weekly review currently gathers action items from `meta.action_items` and counts people from `meta.people`. It does not consume `open_loops`, `entity_mentions`, or `entity_facts`.

**Weekly review must consume:**
- `open_loops` for action item summary — filtered by `status` and `created_at` window
- Canonical entity-derived information for person summary sections
- Accepted `entity_facts` where relevant

**Weekly review must stop consuming:**
- `meta.action_items` as primary action item source
- `meta.people` as primary person tracking source

### 7D. MCP `weekly_review` alignment

MCP `weekly_review` is a synthesis tool — it loads a time window of content and asks the model to summarize it. It is not a search tool and must not be routed through the broker.

Align MCP `weekly_review` with the `review.ts` changes:
- Feed it from `open_loops` and canonical entity data, not raw thought metadata
- Keep it as a synthesis operation, not a retrieval operation

### Acceptance Criteria

- [ ] People listing and filtering routes are entity-backed across all named surfaces
- [ ] MCP list and stats tools no longer read `metadata.people` as source of truth
- [ ] `rag.ts` context formatting uses entity-resolved names
- [ ] Weekly review action items reflect actual `open_loops` state
- [ ] Weekly review person section is entity-backed
- [ ] MCP `weekly_review` feeds from `open_loops` and entity data
- [ ] `peopleRouter.patch("/:name")` is replaced, retired, or explicitly scoped to cache-sync only — not left as a misleading rename endpoint
- [ ] `metadata.people` is no longer authoritative; if retained, it is a compatibility cache only

---

## File-Level Summary

| File | Phase | Primary Changes |
|---|---|---|
| `db/init.sql` + `db/migrations/002_*.sql` | 1 | `open_loops.embedding` + model metadata; `thoughts` model metadata; partial vector index; `embedding_jobs` table + unique job constraint — all DDL idempotent with `IF NOT EXISTS` |
| `app/src/queue.ts` *(new)* | 2 | Dedicated worker/queue module; exports `startEmbeddingWorker`, `enqueueEmbeddingJob`, `triggerWorker`; owns polling loop, lease recovery, rate limiting |
| `app/src/index.ts` | 2 | Worker bootstrap at app startup via `queue.ts` import |
| `app/src/pipeline.ts` | 2 | Thought insert writes `embedding_model` + `embedded_at`; idempotent loop insert; evidence always upserted; job enqueue + trigger via `queue.ts`; backfill |
| `app/src/routes/thoughts.ts` | 2 + 6 | Phase 2: thought embedding update writes `embedding_model` + `embedded_at`. Phase 6: loop cleanup scoped to `open` status; transactional mention invalidation; fact flagging via `entity_fact_evidence`; entity-backed thought list filter |
| `app/src/rag.ts` | 3 | Unified retrieval broker; actionable-loop-only default filter; `MemoryCandidate` result shape; model compatibility enforcement; NULL skip |
| `app/src/routes/chat.ts` | 4 | Swap thought-only retrieval for broker; mixed context assembly; payload compatibility |
| `app/src/mcp.ts` | 4 + 7 | Add `search_memory` tool calling broker (Ph4); keep `search_thoughts` backward-compatible thought-only (Ph4); align `weekly_review` with `review.ts` (Ph7); entity-backed list/stats (Ph7) |
| `app/src/openrouter.ts` | 5 | Additive `QueryRewrite` extension; retrieval-scope hints; intent signals; `temperature=0` |
| `app/src/entities.ts` | 5 | New `resolveEntityCandidates(names)` query-time resolver function |
| `app/src/routes/review.ts` | 7 | Weekly review from `open_loops` + entity tables; retire `meta.action_items` / `meta.people` |
| `app/src/routes/people.ts` | 7 | Entity-backed people listing and filtering; explicit handling of `PATCH /:name`; demote `metadata.people` |

---

## Operational Plan

### Migration strategy

| Release | Ships |
|---|---|
| R1 | Migration file + `init.sql` update: `open_loops.embedding`, model metadata, partial index, `embedding_jobs` table + unique constraint |
| R2 | `queue.ts` module; worker bootstrap in `index.ts`; thought write-path provenance in `pipeline.ts` + `routes/thoughts.ts`; async loop write-path; backfill |
| R3 | Unified retrieval broker in `rag.ts` (behind feature flag if needed) |
| R4 | Broker wired into `chat.ts` and MCP search tools |
| R5 | Query rewrite extensions, entity resolver, and cleanup fixes |

Can be compressed if the deployment model supports it. System must remain safe and functional at every partially-migrated state.

### Backfill requirements

- **Resumable** — stop and restart without re-embedding already-embedded rows
- **Idempotent** — re-running produces the same result
- **Safe on partial runs** — abandoned claimed jobs recovered via lease timeout
- **Observable** — progress visible in logs or admin surface

During backfill:
- Thought retrieval continues normally
- Loop retrieval returns results only for embedded rows
- No query failures because some loops are still `NULL`

### Observability

Add visibility for the following before Phase 3 ships:

- Count of `open_loops WHERE embedding IS NULL`
- Backfill progress (embedded / total)
- Loop embedding failure rate and last error
- Broker retrieval composition by `memory_type` per query
- Query-time model mismatch exclusion count
- Stale cleanup actions triggered per reprocess
- `embedding_jobs` queue depth by status (pending / claimed / failed)
- Stale claimed jobs recovered by lease timeout

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Mixed embedding models silently degrade retrieval | Store `embedding_model` on all rows; broker filters to current model only; write model on every thought insert/update |
| Newly created thoughts excluded from broker if write path not updated | Phase 2 explicitly requires both `pipeline.ts` insert path and `routes/thoughts.ts` update path to write `embedding_model` |
| Freshly reprocessed thoughts excluded from broker | `routes/thoughts.ts` embedding update path included in Phase 2 scope — same release as broker |
| Loop under-retrieval during backfill window | Skip `NULL` embeddings; degrade gracefully to thought-only |
| Async embedding introduces delayed loop visibility | Accept eventual consistency; `triggerWorker()` minimizes lag for new loops |
| Job claiming race causes double-processing | Atomic `FOR UPDATE SKIP LOCKED`; validate under concurrent load |
| Crashed worker leaves jobs permanently claimed | Lease timeout recovery re-queues stale claimed jobs |
| Duplicate jobs enqueued for same loop | Partial unique index on active jobs per `loop_id`; `ON CONFLICT DO NOTHING` on enqueue |
| Bulk MCP import floods embedding API | Worker enforces configurable rate ceiling; retries on 429 |
| Closed loops appear in broker results | Default broker filter: `status = 'open' OR (status = 'snoozed' AND snoozed_until <= now())` |
| Cleanup deletes user-meaningful closed/snoozed loops | All cleanup deletes scoped to `status = 'open'` only |
| Loop creation duplicates on conflict | `ON CONFLICT DO NOTHING`; evidence always upserted for effective loop row; job enqueue conditional on new-or-unembedded |
| Evidence edge lost when loop already exists | Evidence upserted for effective `loop_id` regardless of whether loop row was newly created |
| Mention invalidation loses valid links on failure | Transactional replace: resolution must succeed before old set deleted |
| Thought backfill stamps wrong model on mixed-model installs | App-driven backfill via `config.embeddingModel`; operator assumption check required |
| Broker ranking regresses for thought-heavy queries | Conservative normalization first; type-aware weighting only after validation |
| Intent routing misclassification hides relevant memory | `temperature=0`; broker degrades gracefully on missing hints; routing logged |
| Chat payload change breaks UI consumer | Preserve existing `thoughts` field; add `loops` field alongside it |
| `PATCH /people/:name` left as misleading rename endpoint | Explicitly replaced, retired, or scoped to cache-sync in Phase 7 |
| Entity candidate names extracted but never resolved to IDs | `resolveEntityCandidates()` in `entities.ts` is a named deliverable, not an implicit behavior |
| Circular dependency between `pipeline.ts` and `index.ts` | All worker/queue exports live in `queue.ts`; neither `pipeline.ts` nor `index.ts` imports the other |
| Migration DDL crashes on second boot | All DDL uses `IF NOT EXISTS` in both `init.sql` and migration files — app re-executes both on every startup |
| Agent uses `app.listen()` instead of Hono `serve()` | Bootstrap examples use `serve({ fetch: app.fetch, port: config.port }, callback)` — no Express-style listen call |
| `search_thoughts` starts returning loops, breaking existing callers | New `search_memory` tool added for broker-backed mixed retrieval; `search_thoughts` kept returning thoughts only |
| `failed` jobs treated as hard terminal — loops never re-embedded after transient failure | `failed` is soft terminal; startup sweep re-enqueues on restart; operators must explicitly tombstone to suppress permanently |
| Side-effecting `resolveEntityMentions()` used inside transactional replace | Refactor into pure compute + separate persist, or add new pure helper before implementing Phase 6 Fix 2 |

---

## System-Level Acceptance Criteria

### Retrieval

- [ ] Open and snoozed-but-due loops are semantically retrievable by default
- [ ] Closed loops are excluded from default retrieval
- [ ] Chat and MCP surface loops without subsystem-specific calls
- [ ] Retrieval path is no longer thought-only by default
- [ ] Recent-thought augmentation and thread expansion preserved for thought candidates
- [ ] Person-summary queries with a resolved entity ID route to entity-grounded path
- [ ] Mixed person-summary + loop queries assemble facts + thoughts + entity-linked loops in one context before a single model call

### Trust

- [ ] Editing a thought does not leave stale open loops behind
- [ ] Closed and snoozed loops survive thought reprocessing
- [ ] Mention invalidation is transactional — no data loss on failure
- [ ] Person-related memory has one authoritative source across all surfaces
- [ ] Weekly review reflects actual loop and entity state
- [ ] `PATCH /people/:name` does not silently update a non-authoritative store

### Write Path

- [ ] Every new thought insert writes `embedding_model` and `embedded_at`
- [ ] Every thought re-embedding in `routes/thoughts.ts` writes `embedding_model` and `embedded_at`
- [ ] `open_loop_evidence` is always upserted for the effective loop row, not gated on new loop creation
- [ ] No circular dependency between `pipeline.ts` and `index.ts` — worker/queue logic lives in `queue.ts`

### Schema

- [ ] All Phase 1 DDL is in both a versioned migration file and `init.sql`
- [ ] All DDL in both files uses `IF NOT EXISTS` — re-executing on every boot is safe
- [ ] Every SQL example block in Phase 1 is itself idempotent, not just the prose description
- [ ] Fact invalidation uses `review_state = 'pending'` — no invented states

### Operations

- [ ] Schema migration is safe on live installs
- [ ] Backfill runs without breaking retrieval
- [ ] Embedding model compatibility enforced at query time
- [ ] Worker starts at app boot; queue drained without manual intervention
- [ ] Stale claimed jobs recovered automatically via lease timeout
- [ ] Broker composition observable per query

### Maintainability

- [ ] Loop embeddings follow the same inline storage pattern as all other retrievable objects
- [ ] Retrieval logic centralized in the broker
- [ ] `QueryRewrite` extensions are additive — no existing field renames
- [ ] `entity_fact_evidence` used as the source linkage mechanism — no parallel tracking invented
- [ ] Query-time entity resolution centralized in `entities.ts`
- [ ] `resolveEntityMentions()` refactored or a pure sibling added before Phase 6 — no side-effecting resolver used in transactional replace
- [ ] Entity-linked loop retrieval uses `source_thought_id → entity_mentions` join — no reference to non-existent `open_loops.metadata`

---

## Deliverables

| # | Deliverable |
|---|---|
| D1 | Versioned migration file + `init.sql` update: `open_loops` embeddings, `thoughts` provenance, `embedding_jobs` table + unique job constraint, partial index — all DDL idempotent |
| D2 | `queue.ts` module; worker bootstrap in `index.ts`; thought provenance write in `pipeline.ts` + `routes/thoughts.ts` update path; idempotent loop insert with evidence repair; rate-limited backfill |
| D3 | Unified `searchMemory()` broker in `rag.ts` with actionable-loop-only default filter |
| D4 | Broker integration in `chat.ts` (with payload compatibility); new `search_memory` MCP tool calling broker; `search_thoughts` kept backward-compatible |
| D5 | Additive `QueryRewrite` extension + `resolveEntityCandidates()` in `entities.ts` + intent routing test suite |
| D6 | Thought edit/reprocess cleanup: scoped loop deletion, transactional mention replace, fact flagging via `entity_fact_evidence` with correct `review_state = 'pending'` |
| D7 | Weekly review, MCP `weekly_review`, all `metadata.people` surfaces canonicalized, `PATCH /people/:name` explicitly handled |

---

## Final Recommendation

The next move is not more analysis.

Treat Open Brain as a memory system with multiple object types. Make retrieval reflect that reality.

Start with the migration file. Create `db/migrations/002_loop_embeddings.sql` with fully idempotent DDL — `IF NOT EXISTS` on every statement. Update `db/init.sql` in the same commit. Both files re-execute on every boot; both must be safe to re-run. That is the correct first commit.
