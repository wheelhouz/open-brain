# Derived Memory Objects — Implementation Plan

Design: `docs/plans/2026-03-14-derived-memory-objects-design.md`

---

## Step 1: Schema ✅

Add new tables and indexes to `db/init.sql` after the existing `topic_categories` block.

**Tables:**
- `open_loops` — with `loop_type` CHECK, `status` CHECK, `resolution` text, partial indexes
- `open_loop_evidence` — composite PK, CASCADE delete
- `entities` — unique index on `(lower(canonical_name), entity_type)`, GIN on aliases, HNSW on embedding
- `entity_mentions` — composite PK, CASCADE delete

**Also:**
- `ALTER TABLE open_loops ADD COLUMN blocked_by_entity_id UUID REFERENCES entities(id)` — nullable, Phase 2 enrichment

All DDL uses `IF NOT EXISTS` for safe re-runs on the existing deployment.

**Files:** `db/init.sql`

---

## Step 2: Extraction prompt update ✅

Extend the LLM extraction prompt in `app/src/openrouter.ts` to classify each action item by loop type.

**Current output:** `action_items: string[]`
**New output:** `action_items: Array<{ content: string, loop_type: "task" | "question" | "decision" | "waiting_on" }>`

Update `ThoughtMetadata` interface to reflect the new shape. The extraction prompt gets examples for each type to guide classification. Default to `"task"` if the model returns a bare string (backwards compatibility with any cached/retry responses).

**Files:** `app/src/openrouter.ts`

---

## Step 3: Open Loops backend ✅

### 3a: Route — `app/src/routes/loops.ts`

New Hono router with endpoints:

- `GET /` — List loops. Query params: `status` (default 'open'), `loop_type`, `limit` (default 50), `cursor`. Open query UNIONs snoozed loops past `snoozed_until`. Returns `{ loops, next_cursor }`.
- `GET /:id` — Single loop + evidence thoughts (JOIN through `open_loop_evidence` → `thoughts`).
- `POST /` — Create loop manually. Body: `{ content, loop_type?, source_thought_id? }`. Returns 201.
- `PATCH /:id` — Update status/resolution. Body: `{ status?, resolution?, snoozed_until? }`. Validates transitions: close sets `closed_at`, snooze requires `snoozed_until`, reopen clears both.
- `DELETE /:id` — Hard delete. Returns `{ deleted: true }`.
- `POST /:id/evidence` — Link thought. Body: `{ thought_id }`. Returns `{ linked: true }`.

### 3b: Wire into app

Import `loopsRouter` in `app/src/app.ts`, mount at `/api/loops`.

**Files:** `app/src/routes/loops.ts`, `app/src/app.ts`

---

## Step 4: Pipeline integration (loops) ✅

Modify `capturePipeline` in `app/src/pipeline.ts`:

After the thought INSERT, iterate `metadata.action_items`. For each item:
1. INSERT into `open_loops` (content, loop_type, source_thought_id)
2. INSERT into `open_loop_evidence` (loop_id, thought_id) with the same source thought

Wrap in try/catch — best-effort, same pattern as topic auto-categorization. Handle both the new object format `{ content, loop_type }` and legacy string format (default to task).

**Files:** `app/src/pipeline.ts`

---

## Step 5: Open Loops MCP tools ✅

Add three tools to `app/src/mcp.ts`:

- `list_open_loops` — params: `status?` (enum), `loop_type?` (enum), `limit?` (number, default 20)
- `close_loop` — params: `id` (string), `resolution?` (string)
- `snooze_loop` — params: `id` (string), `until` (string, ISO 8601)

**Files:** `app/src/mcp.ts`

---

## Step 6: Open Loops frontend ✅

### 6a: API client

Add to `web/src/api.ts`:
- `Loop` interface (id, content, loop_type, status, resolution, source_thought_id, snoozed_until, created_at, closed_at, evidence_count)
- `api.loops(status?, loopType?)`, `api.loop(id)`, `api.closeLoop(id, resolution?)`, `api.snoozeLoop(id, until)`, `api.reopenLoop(id)`, `api.createLoop(content, loopType?)`, `api.deleteLoop(id)`

### 6b: LoopCard component

New file `web/src/components/LoopCard.tsx`:
- Type icon (task=checkbox, question=?, decision=scale, waiting_on=clock)
- Content text
- Age display (relative time)
- Source thought link
- Evidence count badge
- Action buttons: close (with resolution input for question/decision types), snooze, reopen

### 6c: LoopsView

New file `web/src/views/LoopsView.tsx`:
- Three-tab status filter: Open / Snoozed / Closed
- Optional type filter pills
- Loop cards list
- Empty state messaging per status

### 6d: Navigation

Update `web/src/components/App.tsx`:
- Add Loops tab (icon: CircleDot or similar) between Stats and Chat
- Update keyboard shortcut mapping

**Files:** `web/src/api.ts`, `web/src/components/LoopCard.tsx`, `web/src/views/LoopsView.tsx`, `web/src/components/App.tsx`

---

## Step 7: Open Loops tests ✅

New file `app/src/__tests__/loops.test.ts`:
- Mock db.js, follow existing pattern
- Test GET /api/loops with status filter
- Test PATCH /api/loops/:id for close (with resolution), snooze, reopen transitions
- Test POST /api/loops creation
- Test DELETE /api/loops/:id
- Test POST /api/loops/:id/evidence
- Test 401 without auth, 404 for missing loops

**Files:** `app/src/__tests__/loops.test.ts`

---

## Step 8: Entity resolution module ✅

New file `app/src/entities.ts`:

`resolveEntityMentions(names: string[], thoughtId: string)`:
1. For each name: exact match on `lower(canonical_name)` → alias match → create new
2. Upsert `entity_mentions` row
3. Pure SQL, no LLM calls

**Files:** `app/src/entities.ts`

---

## Step 9: Entities backend ✅

### 9a: Route — `app/src/routes/entities.ts`

- `GET /` — List entities with mention count + last_seen. Params: `type`, `limit`.
- `GET /:id` — Entity detail with mention count, last_seen.
- `PATCH /:id` — Update canonical_name, aliases, attributes. When renaming, also update `metadata.people` across linked thoughts (reuse people.ts rename pattern).
- `POST /merge` — Body: `{ source_id, target_id }`. Reassign all mentions from source to target, merge aliases, delete source.
- `GET /:id/thoughts` — Thoughts mentioning entity, cursor paginated.

### 9b: Wire into app

Import `entitiesRouter` in `app/src/app.ts`, mount at `/api/entities`.

**Files:** `app/src/routes/entities.ts`, `app/src/app.ts`

---

## Step 10: Pipeline integration (entities) ✅

Modify `capturePipeline` in `app/src/pipeline.ts`:

After the thought INSERT, if `metadata.people.length > 0`, call `resolveEntityMentions(metadata.people, thoughtId)`. Best-effort try/catch.

Also update `updatePipeline` path: when reprocess=true and metadata is re-extracted, the PATCH handler in `thoughts.ts` calls `resolveEntityMentions` with the new metadata.

**Files:** `app/src/pipeline.ts`, `app/src/routes/thoughts.ts`

---

## Step 11: Entities MCP tools ✅

Add two tools to `app/src/mcp.ts`:

- `get_entity` — params: `name` (string). Search by canonical_name or aliases. Return entity + mention count.
- `list_entity_mentions` — params: `entity_id` (string), `limit?` (number, default 10). Return linked thoughts.

**Files:** `app/src/mcp.ts`

---

## Step 12: People view evolution ✅

Update `web/src/views/PeopleView.tsx` to read from `/api/entities?type=person` instead of `/api/people`. Show aliases as sub-labels, mention count from entities table. Add merge button when two cards are selected.

Keep `/api/people` route working as fallback — no deletion.

**Files:** `web/src/views/PeopleView.tsx`, `web/src/api.ts`

---

## Step 13: Entities tests ✅

New file `app/src/__tests__/entities.test.ts`:
- Test GET /api/entities list
- Test PATCH /api/entities/:id rename + alias management
- Test POST /api/entities/merge
- Test GET /api/entities/:id/thoughts

New file `app/src/__tests__/entity-resolution.test.ts`:
- Unit test `resolveEntityMentions` function
- Test exact match, alias match, new entity creation
- Test case insensitivity, idempotency

**Files:** `app/src/__tests__/entities.test.ts`, `app/src/__tests__/entity-resolution.test.ts`

---

## Step 14: Backfill script ✅

New file `scripts/backfill-derived.ts`:

- Connects using `DATABASE_URL` from env
- Phase 1: Query all thoughts with action_items → INSERT into open_loops (type=task for all historical items) + evidence rows. ON CONFLICT DO NOTHING.
- Phase 2: Query all thoughts with people → call resolveEntityMentions. Idempotent.
- Run: `npx tsx scripts/backfill-derived.ts`
- Run on dev stack first, then prod.

**Files:** `scripts/backfill-derived.ts`

---

## Verification

1. `make test` — all existing tests pass, new tests pass
2. `make dev` — start dev stack
3. Capture a thought with action items via MCP → verify open_loops rows created with correct types
4. Capture a thought mentioning people → verify entities and entity_mentions created
5. Open Loops tab in UI → verify loops display, close/snooze/reopen work
6. MCP: `list_open_loops` → verify loops returned
7. MCP: `close_loop` with resolution → verify status + resolution text saved
8. People view → verify it reads from entities table
9. Run backfill script on dev → verify historical data populated
10. `make deploy ENV=prod` after all verification passes
