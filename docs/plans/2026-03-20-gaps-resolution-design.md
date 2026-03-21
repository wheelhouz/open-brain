# Gaps Resolution — Implementation Design

**Date:** 2026-03-20
**Source spec:** `docs/design/open-brain-gaps-resolution-v1.9.md`
**Branch:** `fix-gaps`

---

## Problem

Open Brain writes into four memory layers (thoughts, open_loops, entity_mentions, entity_facts) but retrieval is still thought-centric. Loops are invisible to semantic search, entity facts surface only in special-case paths, person storage is split between `metadata.people` and canonical entities, and edit/reprocess flows leave stale memory artifacts behind.

## Goals

1. Make loops semantically retrievable on par with thoughts
2. Make chat and MCP benefit from structured memory by default
3. Reduce trust erosion from stale loops, mentions, and split-brain person storage
4. Prepare the retrieval layer for future typed entities without blocking on them now

## Non-Goals

- Graph UI, generic typed entities, new product features (briefs, chief-of-staff)
- Full redesign of fact modeling or shared universal embeddings table

---

## Phase 1 — Schema Foundation

**Files:** `db/migrations/002_loop_embeddings.sql` (new), `db/init.sql`

### Sub-tasks

**1.1 — Create migration file `db/migrations/002_loop_embeddings.sql`**
- Add `open_loops` columns: `embedding vector(1536)`, `embedding_model text`, `embedded_at timestamptz` — each as its own `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- Add `thoughts` columns: `embedding_model text`, `embedded_at timestamptz` — same pattern
- Create partial HNSW index: `CREATE INDEX IF NOT EXISTS open_loops_embedding_idx ON open_loops USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL`
- Create `embedding_jobs` table with CHECK constraints on `job_type` and `status` (consistent with existing schema style for loop types, loop status, entity types, fact status, fact review state)
- Columns: `id bigserial PK`, `job_type text NOT NULL`, `payload_json jsonb NOT NULL`, `status text NOT NULL DEFAULT 'pending'`, `attempt_count integer NOT NULL DEFAULT 0`, `available_at timestamptz NOT NULL DEFAULT now()`, `claimed_at timestamptz`, `last_error text`, `created_at timestamptz NOT NULL DEFAULT now()`, `completed_at timestamptz`
- CHECK: `status IN ('pending', 'claimed', 'complete', 'failed')`
- Create status index: `CREATE INDEX IF NOT EXISTS embedding_jobs_status_idx ON embedding_jobs (status, available_at) WHERE status IN ('pending', 'claimed')`
- Create unique partial index: `CREATE UNIQUE INDEX IF NOT EXISTS embedding_jobs_one_active_per_loop ON embedding_jobs ((payload_json->>'loop_id')) WHERE job_type = 'loop_embedding' AND status IN ('pending', 'claimed')`
- Every SQL statement must use `IF NOT EXISTS` — the app re-executes all SQL files on every boot

**1.2 — Update `db/init.sql` with same DDL**
- Mirror all DDL from 1.1 into init.sql so fresh installs get full schema
- All statements idempotent with `IF NOT EXISTS`

**1.3 — Verify idempotence and backward compatibility**
- Run app twice — confirm no errors on second boot
- Confirm `open_loops` accepts NULL embeddings without breaking existing queries
- Smoke-test that current loop creation (`createLoopsFromActionItems`) still works unchanged — a normal capture with action items still produces a thought row, open loop row, and evidence row
- Run existing test suite — no regressions

### Dependencies
None — this is the foundation.

### Acceptance Criteria
- [ ] Migration file exists with all DDL guarded by `IF NOT EXISTS`
- [ ] `db/init.sql` updated with same DDL, also guarded
- [ ] `embedding_jobs` has CHECK constraints on `job_type` and `status`
- [ ] Running the app a second time produces no errors
- [ ] Existing loop creation unchanged and functional
- [ ] All existing tests pass

---

## Phase 2 — Write Path, Worker, and Backfill

**Files:** `app/src/queue.ts` (new), `app/src/index.ts`, `app/src/pipeline.ts`, `app/src/routes/thoughts.ts`

### Sub-tasks

**2.1 — Create `app/src/queue.ts` module**
- New file exporting: `startEmbeddingWorker()`, `enqueueEmbeddingJob(loopId, model)`, `triggerWorker()`, `scheduleBackfillSweep()`
- Polling loop with immediate trigger pattern (drain function with `running` guard)
- Atomic job claiming via `FOR UPDATE SKIP LOCKED`
- Stale claim recovery (lease timeout, re-queue with backoff)
- `failed` as soft terminal state at `MAX_ATTEMPTS`
- Configurable rate limiting for embedding API calls
- `ON CONFLICT DO NOTHING` on enqueue (relies on Phase 1 unique index)
- Imports from `db.ts`, `config.ts`, `openrouter.ts` — no circular risk

**2.2 — Wire worker bootstrap in `app/src/index.ts`**
- Import `startEmbeddingWorker`, `scheduleBackfillSweep` from `queue.ts`
- Call `startEmbeddingWorker()` after `initDb()`, before/alongside `serve()`
- Call `scheduleBackfillSweep()` inside the existing `serve()` server-ready callback — non-blocking
- No new `app.listen()` — hook into existing Hono `serve()` pattern

**2.3 — Update thought insert path in `app/src/pipeline.ts`**
- Write `embedding_model: config.embeddingModel` and `embedded_at: new Date().toISOString()` on every thought INSERT
- Existing metadata/embedding flow unchanged

**2.4 — Update thought update path in `app/src/routes/thoughts.ts` (Phase 2 scope only)**
- Add `embedding_model` and `embedded_at` to the existing PATCH embedding update SQL
- Touch only the embedding update path — leave all other logic untouched for Phase 6

**2.5 — Update loop creation in `app/src/pipeline.ts`**
- Idempotent loop insert with `ON CONFLICT DO NOTHING`
- Resolve effective `loop_id` (returned id if new, query by content hash if existing)
- Always upsert `open_loop_evidence` for effective loop row — even when the loop already existed (evidence repair on reruns)
- Conditional embedding job enqueue: only when loop is new OR present-but-unembedded
- Call `triggerWorker()` after enqueue
- Import `enqueueEmbeddingJob`, `triggerWorker` from `queue.ts`

**2.6 — Implement backfill sweep in `queue.ts`**
- `scheduleBackfillSweep()` scans `open_loops WHERE embedding IS NULL`
- Enqueues one job per row with `ON CONFLICT DO NOTHING`
- Calls `triggerWorker()` once after enqueue batch
- Returns immediately — does not wait for embeddings
- Also backfill thought provenance: `UPDATE thoughts SET embedding_model=$1, embedded_at=created_at WHERE embedding_model IS NULL AND embedding IS NOT NULL`
- **Hard gate:** thought provenance backfill only runs if deployment has used a single embedding model historically (reads from `config.embeddingModel` via `process.env.EMBEDDING_MODEL`). If an instance may have changed models, require operator confirmation before stamping
- Startup sweep must NOT re-enqueue loops that already have a terminal `failed` job unless an operator has explicitly reset the job — prevents infinite retry of exhausted failures across reboots

**2.7 — Tests and verification**
- Unit tests for `queue.ts`: job claiming atomicity, lease recovery, failed state, rate limiting
- Verify `pipeline.ts` → `queue.ts` → no circular dependency with `index.ts`
- Verify capture latency unchanged (async embedding, not blocking)
- Verify backfill is resumable and idempotent
- Smoke test: normal capture with action items still produces thought + open loop + evidence + no visible failure if embedding job runs later or fails
- Run full existing test suite — no regressions

### Dependencies
Phase 1 complete. 2.1 before 2.2, 2.5, 2.6. 2.3 and 2.4 independent of each other, both depend on Phase 1 columns.

### Acceptance Criteria
- [ ] `queue.ts` exists with all four exports; no circular imports
- [ ] Worker starts at app boot; queue drained without manual intervention
- [ ] New thought inserts write `embedding_model` and `embedded_at`
- [ ] Thought embedding updates write `embedding_model` and `embedded_at`
- [ ] Capture completes without waiting for per-loop embedding
- [ ] New loops enqueued for embedding on creation
- [ ] Evidence always upserted for effective loop row, even when loop already existed
- [ ] Embedding job enqueue conditional on new-or-unembedded
- [ ] Job claiming atomic; stale claims recovered; failed jobs stop retrying
- [ ] Failed jobs don't block unique index; startup sweep behavior documented
- [ ] Backfill async and non-blocking; resumable and idempotent
- [ ] Worker respects configurable rate limits
- [ ] All existing tests pass; capture smoke test passes

---

## Phase 3 — Unified Retrieval Broker

**Files:** `app/src/rag.ts`

### Sub-tasks

**3.1 — Define `MemoryCandidate` interface and broker entry point**
- Add `MemoryCandidate` interface: `memory_type ('thought' | 'loop' | 'fact')`, `id`, `content`, `source`, `score` (0–1), `timestamp` (ISO 8601), `metadata`
- Export `searchMemory(options)` as the broker entry point — additive, not a replacement for `retrieveContext()`
- Keep existing `searchWithReranking()` intact and exported — `search_thoughts` MCP tool still needs it
- `searchMemory()` is scoped to retrieval only — does not absorb query rewrite behavior

**3.2 — Implement loop candidate retrieval in broker**
- Query `open_loops` with vector similarity, filtered to:
  - `embedding IS NOT NULL`
  - `embedding_model = $currentModel`
  - `status = 'open' OR (status = 'snoozed' AND snoozed_until <= now())`
- Closed loops excluded from default retrieval
- NULL embeddings skipped silently — no errors, no zero-vector substitution
- Log model mismatch exclusion counts

**3.3 — Implement cross-type merge and ranking**
- Normalize thought and loop similarity scores into common `MemoryCandidate` shape
- Merge on common score but keep per-type metadata intact — thought candidates carry thread context and metadata fields, loops carry different fields; merge unifies ranking without flattening type-specific data
- Conservative normalization first — no type-aware weighting yet

**3.4 — Preserve thought-retrieval parity**
- Recent-thought augmentation: when `time_hint === "recent"`, supplement with recency-ordered thoughts (existing behavior)
- Thread expansion: expand top thought hits to include parent + sibling context (existing behavior)
- Both applied to thought candidates before final merge with loop candidates
- Ranking quality for thought-heavy queries at least as good as current `searchWithReranking()`

**3.5 — Tests and verification**
- Test: broker returns mixed thoughts + loops for relevant queries
- Test: unembedded loops excluded
- Test: closed loops excluded, snoozed-but-due loops included
- Test: incompatible `embedding_model` vectors never merged
- Test: thought-only query returns same quality as `searchWithReranking()`
- Test: `search_thoughts` MCP tool still returns thought-only structure (backward compat)
- Run full existing test suite — no regressions

### Dependencies
Phase 2 complete. 3.1 before 3.2–3.4. 3.2 and 3.4 parallel, then 3.3 merges.

### Acceptance Criteria
- [ ] Single broker call returns mixed thoughts and actionable loops
- [ ] Unembedded loops excluded silently; closed loops excluded
- [ ] Snoozed-but-due loops included
- [ ] Incompatible embedding model vectors never merged
- [ ] Recent-thought augmentation and thread expansion preserved
- [ ] Per-type metadata intact through merge
- [ ] `searchWithReranking()` still available and unchanged
- [ ] Model mismatch exclusions observable in logs
- [ ] All existing tests pass

---

## Phase 4 — Integrate Broker into Chat and MCP

**Files:** `app/src/routes/chat.ts`, `app/src/mcp.ts`

**4A (chat) and 4B (MCP) can be worked in parallel.**

### Sub-tasks

**4.1 — Wire broker into `app/src/routes/chat.ts`**
- Replace `searchWithReranking()` / `retrieveContext()` in the generic chat path with broker `searchMemory()`
- Format mixed broker results into separate labeled sections in system prompt (thoughts section, loops section)
- Entity-grounded chat path (`entity_id` supplied) unchanged — that path is enhanced in Phase 5

**4.2 — Chat source payload backward compatibility**
- Current SSE streams `{ type: "sources", thoughts: sources }`
- Preserve existing `thoughts` field; add parallel `loops` field: `{ type: "sources", thoughts: [...], loops: [...] }`
- Do not silently change the shape

**4.3 — Add `search_memory` MCP tool in `app/src/mcp.ts`**
- New tool calling broker `searchMemory()`, returns JSON array of `MemoryCandidate` objects
- Tool description: "Search all memory types including thoughts and open loops"
- Input schema: `query` (required), `filter` (optional), `time_hint` (optional)
- `enableJsonResponse: true` consistent with all other MCP tools

**4.4 — Verify `search_thoughts` unchanged**
- `search_thoughts` continues to call `searchWithReranking()` — returns thoughts only
- No change to behavior, return shape, or description
- Update MCP tool descriptions to clearly distinguish the two tools

**4.5 — Tests and verification**
- Test: generic chat (no `entity_id`) returns mixed thoughts + loops in context
- Test: entity-grounded chat unchanged
- Test: chat SSE source payload includes both `thoughts` and `loops` fields
- Test: `search_memory` MCP tool returns `MemoryCandidate[]` with mixed types
- Test: `search_thoughts` MCP tool still returns thought-only results
- Test: generic chat and `search_memory` both call broker; `search_thoughts` still calls `searchWithReranking()`; entity-grounded chat still uses its dedicated path
- Frontend smoke test: existing UI handles source payload without errors
- Run full existing test suite — no regressions

### Dependencies
Phase 3 complete. 4.1/4.2 and 4.3/4.4 are parallel tracks. 4.5 after both.

### Acceptance Criteria
- [ ] Generic chat uses broker; entity-grounded path unchanged
- [ ] Chat source payload backward compatible (`thoughts` preserved, `loops` added)
- [ ] `search_memory` tool exists and returns `MemoryCandidate[]`
- [ ] `search_thoughts` unchanged — thought-only, calls `searchWithReranking()`
- [ ] MCP tool descriptions distinguish the two tools
- [ ] `weekly_review` out of scope — unchanged in this phase
- [ ] All existing tests pass

---

## Phase 5 — Query Rewrite and Intent Routing

**Files:** `app/src/openrouter.ts`, `app/src/entities.ts`, `app/src/routes/chat.ts`, `app/src/rag.ts`

**This is the hardest phase. LLM-based intent classification is inherently fallible. Routing signals are hints, not guarantees.**

### Sub-tasks

**5.1 — Extend `QueryRewrite` interface in `app/src/openrouter.ts`**
- Additive only — existing `search_query`, `filter`, `time_hint` unchanged
- Add: `memory_types`, `prefer_open_loops`, `entity_candidate_names`, `intent_type`
- Update rewrite prompt to extract new fields
- `temperature = 0` (already the case, preserve it)
- Graceful fallback: if new fields absent or unparseable, broker uses defaults

**5.2 — Implement `resolveEntityCandidates()` in `app/src/entities.ts`**
- New function: `resolveEntityCandidates(names: string[]) → Array<{ name, entity_id: string | null }>`
- Explicitly **person-only for v1** — matches current schema and resolver behavior
- Read-only query-time resolver — no writes, no side effects
- Resolves via exact match, alias match, fuzzy match on entities table
- Returns `null` for unresolvable names
- Distinct from write-time `resolveEntityMentions()`

**5.3 — Wire intent routing into chat retrieval in `app/src/routes/chat.ts`**
- After rewrite, pass routing hints to broker or entity-grounded path
- Four routing paths:
  - **Person-summary only** → entity-grounded path (facts + thoughts), no broker loops
  - **Person-summary + loop/status signal** → augmented entity-grounded path: resolve person, build existing fact-aware entity context, then add entity-linked loops before single model call. Augments existing entity-grounded assembly, does not replace it
  - **Action/status only** → broker (thoughts + loops), no entity-grounded path
  - **No entity resolves** → broker (thoughts + loops), generic prompt
- Entity-linked loop retrieval via join: `open_loops.source_thought_id → entity_mentions.thought_id → entity_mentions.entity_id` — no reference to non-existent `open_loops.metadata`
- Mixed queries use entity-grounded fact-aware prompt, not generic "Retrieved Thoughts" prompt

**5.4 — Wire intent routing into broker in `app/src/rag.ts`**
- Broker accepts optional `memory_types` and `prefer_open_loops` hints
- When specified, only query those types
- When absent or ambiguous, query all types (graceful degradation)
- Log routing decisions and memory type composition per query

**5.5 — Intent routing test suite**
- Test each query from design's minimum test set (10 queries across open-loop/status, person-summary, decision/history, recent context, mixed categories)
- For each: validate rewrite output stability, correct `memory_types`, entity resolution triggered when appropriate, final result set includes expected object types
- Validate **routing-path stability**: same query reliably selects same downstream path (entity-grounded, augmented entity-grounded, or generic broker) — not just JSON field stability

**5.6 — Tests and verification**
- Test: `resolveEntityCandidates()` resolves known person entities, returns null for unknown
- Test: person-summary queries with resolved entity route to entity-grounded path
- Test: mixed person+loop queries assemble combined context (facts + thoughts + loops) using entity-grounded prompt
- Test: action-only queries route to broker without entity-grounded path
- Test: unresolvable entity names fall back to generic broker gracefully
- Test: missing/malformed routing hints don't cause errors
- Run full existing test suite — no regressions

### Dependencies
Phase 4 complete. 5.1 before 5.3/5.4. 5.2 before 5.3. 5.3 and 5.4 parallel. 5.5/5.6 after all.

### Acceptance Criteria
- [ ] `QueryRewrite` extended additively — existing fields unchanged
- [ ] `resolveEntityCandidates()` exists, person-only, read-only
- [ ] All four routing paths implemented and tested
- [ ] Mixed queries augment entity-grounded path, not replace it
- [ ] Routing decisions observable in logs
- [ ] Routing-path stability validated across repeated runs
- [ ] Graceful degradation on bad/missing routing signals
- [ ] All existing tests pass

---

## Phase 6 — Reprocessing, Cleanup, and Trust Repair

**Files:** `app/src/routes/thoughts.ts`, `app/src/entities.ts`

### Sub-tasks

**6.1 — Fix loop cleanup: scope deletion to `status = 'open'` only**
- Current bug: delete/recreate block only runs when `actionItems.length > 0` — editing to remove all action items leaves stale open loops
- Fix: always call delete before conditionally recreating
- Delete SQL scoped: `DELETE FROM open_loops WHERE source_thought_id = $1 AND status = 'open'`
- Closed and snoozed loops are preserved state — never deleted by reprocessing
- After deletion, if `actionItems.length > 0`, recreate loops using Phase 2 idempotent insert + evidence + embedding enqueue pattern

**6.2 — Add pure mention resolver in `app/src/entities.ts`**
- New function: `computeEntityMentions(names: string[], thoughtId: string) → MentionRecord[]`
- Pure compute only — resolves names via same matching logic (exact, alias, fuzzy) but returns records without inserting
- **Read-only resolution only** — skips unresolved names that would require entity creation. The capture path's `resolveEntityMentions()` (which auto-creates) remains the authority for first-time entity creation. Reprocess is a recompute of known entities, not a creation path
- Used only in reprocess path; existing `resolveEntityMentions()` stays intact for capture

**6.3 — Implement transactional mention invalidation in `app/src/routes/thoughts.ts`**
- On reprocess: call `computeEntityMentions()` first (outside transaction)
- If resolution succeeds, open transaction:
  - Delete existing `entity_mentions WHERE thought_id = $1`
  - Insert new resolved mentions
- If resolution fails, existing mentions survive — no data loss
- Pure compute must complete successfully before transaction opens

**6.4 — Implement fact flagging via `entity_fact_evidence`**
- On reprocess: find facts sourced from this thought via `entity_fact_evidence.thought_id`
- Reset `review_state` from `'accepted'` back to `'pending'` for affected facts — only after successful re-extraction, not merely because the route was invoked
- Do not delete facts — surfaced for re-review, not wiped
- Use correct enums only: `review_state` is `'pending' | 'accepted' | 'rejected'`, `status` is `'active' | 'tentative' | 'disputed' | 'superseded'` — no invented states
- Facts already in `'pending'` or `'rejected'` unchanged

**6.5 — Tests and verification**
- Test: reprocessing thought with zero action items removes associated `open` loops
- Test: closed loops survive reprocessing
- Test: snoozed loops survive reprocessing
- Test: `computeEntityMentions()` returns records without writing to DB
- Test: `computeEntityMentions()` skips unresolvable names (no auto-create)
- Test: mention invalidation is transactional — failed resolution preserves existing mentions
- Test: facts sourced from reprocessed thought have `review_state` reset to `'pending'` only after successful re-extraction
- Test: reprocessing is deterministic — running twice produces same state
- Run full existing test suite — no regressions

### Dependencies
Phase 2 complete. 6.1 independent. 6.2 before 6.3. 6.4 independent of 6.2/6.3. All before 6.5.

### Acceptance Criteria
- [ ] Zero action items → associated open loops removed
- [ ] Closed and snoozed loops never deleted by reprocessing
- [ ] Pure mention resolver exists — read-only, no auto-create
- [ ] Mention invalidation transactional — no data loss on failure
- [ ] Fact reset gated on successful re-extraction
- [ ] Correct enums only — no invented states
- [ ] Reprocessing deterministic
- [ ] All existing tests pass

---

## Phase 7 — Canonicalize People and Review Surfaces

**Files:** `app/src/routes/people.ts`, `app/src/routes/thoughts.ts`, `app/src/routes/review.ts`, `app/src/mcp.ts`, `app/src/rag.ts`

**Broadest phase — touches 6 files. Should land together or in quick succession to avoid mixed-source-of-truth windows.**

### Sub-tasks

**7.1 — Migrate people listing and filtering in `app/src/routes/people.ts`**
- Current: `jsonb_array_elements_text(metadata->'people')` for listing, string match for filtering
- Target: query `entities` table for listing, filter by `entity_mentions.entity_id`
- Entity-backed lookup is the primary path; `metadata.people` only as a temporary fallback during migration window, not an equal second source of truth

**7.2 — Replace `PATCH /people/:name` with entity rename/merge**
- Current: rewrites `thoughts.metadata.people` strings — misleading once entities are authoritative
- Replace with entity rename/merge operating on `entities` table canonical name and aliases
- This is the default path, not just a recommendation — leaving the endpoint in current form after canonicalization is a trust problem

**7.3 — Migrate thought list filter in `app/src/routes/thoughts.ts`**
- Current: `person` query param filters via `metadata->'people'`
- Target: resolve person name to entity via `resolveEntityCandidates()`, filter via `entity_mentions.entity_id` join
- Temporary fallback to `metadata.people` string match for unresolved names during migration window

**7.4 — Migrate MCP list and stats tools in `app/src/mcp.ts`**
- `list_thoughts`: person filter → entity-backed
- `thought_stats`: people counts → entity-backed counts
- Other MCP tools surfacing people data — audit and migrate

**7.5 — Migrate RAG context formatting in `app/src/rag.ts`**
- Current: `metadata.people` names injected into context
- Target: entity-resolved canonical names in context formatting

**7.6 — Fix weekly review inputs in `app/src/routes/review.ts` and MCP `weekly_review`**
- Weekly review must consume:
  - `open_loops` for action item summary (filtered by status + created_at window)
  - Canonical entity data for person summary sections
- Weekly review must stop consuming:
  - `meta.action_items` as primary action item source
  - `meta.people` as primary person tracking source
- Accepted `entity_facts` are secondary enrichment — helpful but not a blocker for core migration
- MCP `weekly_review` aligned with same inputs; remains a synthesis operation, not routed through broker

**7.7 — Tests and verification**
- Test: people listing returns entities, not `metadata.people` aggregation
- Test: people filtering works via entity mentions
- Test: `PATCH /people/:name` operates on entities (rename/merge)
- Test: thought list `person` filter uses entity-backed resolution
- Test: MCP list/stats tools return entity-backed results
- Test: RAG context uses canonical entity names
- Test: weekly review action items reflect `open_loops` state
- Test: weekly review person section is entity-backed
- Test: `metadata.people` still populated on capture (compatibility) but never used as source of truth
- Run full existing test suite — no regressions

### Dependencies
Phases 5 and 6 complete. 7.1–7.6 can be worked in any order but should land together. 7.7 after all.

### Acceptance Criteria
- [ ] All people surfaces entity-backed (listing, filtering, stats, context formatting)
- [ ] `PATCH /people/:name` replaced with entity rename/merge
- [ ] MCP list/stats tools entity-backed
- [ ] Weekly review consumes `open_loops` + canonical entities
- [ ] `metadata.people` demoted to compatibility cache — not authoritative
- [ ] Entity facts as optional review enrichment
- [ ] All existing tests pass

---

## Execution Summary

| Phase | Sub-tasks | Primary files | Key risk |
|---|---|---|---|
| 1. Schema Foundation | 3 | `db/migrations/002_*.sql`, `db/init.sql` | Idempotence on repeated boot |
| 2. Write Path & Worker | 7 | `queue.ts` (new), `index.ts`, `pipeline.ts`, `routes/thoughts.ts` | Circular imports; async embedding lag |
| 3. Retrieval Broker | 5 | `rag.ts` | Thought-retrieval quality regression |
| 4. Chat & MCP Integration | 5 | `routes/chat.ts`, `mcp.ts` | Payload backward compatibility |
| 5. Intent Routing | 6 | `openrouter.ts`, `entities.ts`, `routes/chat.ts`, `rag.ts` | LLM routing misclassification |
| 6. Cleanup & Trust | 5 | `routes/thoughts.ts`, `entities.ts` | Data loss on failed reprocess |
| 7. People Canonicalization | 7 | `routes/people.ts`, `routes/thoughts.ts`, `routes/review.ts`, `mcp.ts`, `rag.ts` | Mixed source-of-truth window |
| **Total** | **38** | | |

### Phase dependencies (strict)
```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5
                                          Phase 6 (depends on Phase 2, parallel with 3-5)
                                                    Phase 7 (depends on Phases 5 + 6)
```

### Rollout safety
- System must remain safe and functional at every partially-migrated state
- NULL embeddings skipped, not errored
- `metadata.people` retained as compatibility cache throughout
- `search_thoughts` backward compatible at every phase
- Existing tests pass at every phase boundary
