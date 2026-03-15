# Derived Memory Objects — Design

## What

Promote `metadata.action_items` and `metadata.people` from inert string arrays into first-class relational records. Phase 1 ships open loops (action item tracking). Phase 2 ships entities (people as canonical records with mentions).

## Why

Open Brain extracts action items and people at ingest time but nothing ever happens to them afterward. There's no way to see unresolved commitments across the knowledge base, no concept of age, and no way to mark something done. The weekly review MCP tool already synthesizes "open action items" on demand — the product wants persistent loops, it just doesn't store them.

Similarly, people exist only as deduplicated string arrays. There's no canonical person record, no alias handling, and no way to trace all thoughts about a specific person without scanning metadata JSONB.

ADR source: Open Brain thought `8bb52473-7fd9-4514-b575-3c4c160d109c`

---

## Phase 1 — Open Loops

### Loop types

Four types, classified by the ingest LLM:

- **task** — Discrete work you own. Clear done state. Default when classifier isn't confident.
- **question** — Needs an answer found, not work done. Resolution captures the answer text.
- **decision** — Needs a choice made and rationale captured. Resolution carries the choice and reasoning.
- **waiting_on** — Blocked by something external. Ages differently — two weeks open is someone else's problem, not yours.

**Rejected: follow-up.** A follow-up is structurally a task loop with a person attached. Once entities exist in Phase 2, that relationship is expressed via entity mentions, not loop type.

### Schema

```sql
open_loops(
  id uuid PK DEFAULT gen_random_uuid(),
  content text NOT NULL,
  loop_type text NOT NULL DEFAULT 'task'
    CHECK (loop_type IN ('task', 'question', 'decision', 'waiting_on')),
  source_thought_id uuid FK → thoughts,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'snoozed')),
  resolution text,              -- answer (question), rationale (decision), or closing note
  snoozed_until timestamptz,
  created_at timestamptz DEFAULT now(),
  closed_at timestamptz
)

open_loop_evidence(
  loop_id uuid FK → open_loops ON DELETE CASCADE,
  thought_id uuid FK → thoughts,
  noted_at timestamptz DEFAULT now(),
  PRIMARY KEY (loop_id, thought_id)
)
```

Partial indexes on `status = 'open'`, `status = 'snoozed'`, and `source_thought_id`.

### Ingest changes

The extraction prompt extends to classify each action item by type. The pipeline writes both `metadata.action_items` (compatibility) and `open_loops` rows. One `open_loop_evidence` row is written immediately at loop creation pointing at the source thought — this avoids a single→multi source migration later.

### The blocked-by question

No `blocked_by` column in Phase 1. The `waiting_on` type carries the semantic signal. In Phase 2, `blocked_by_entity_id` is added as a nullable FK to entities — properly typed, joins cleanly against the entity graph.

### Compatibility

`metadata.action_items` continues to be written at ingest. The derived table is the canonical model; metadata is the compatibility cache. No removal until at least one full cycle after loops are stable.

### MCP tools

- `list_open_loops(status?, loop_type?, limit?)` — filterable, sortable by age
- `close_loop(id, resolution?)` — sets status=closed, closed_at=now(), captures resolution text
- `snooze_loop(id, until)` — defers without closing

### API routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/loops` | List loops (status, type filter, cursor pagination) |
| GET | `/api/loops/:id` | Single loop with evidence thoughts |
| POST | `/api/loops` | Create loop manually |
| PATCH | `/api/loops/:id` | Update status (close/snooze/reopen), resolution |
| DELETE | `/api/loops/:id` | Hard delete |
| POST | `/api/loops/:id/evidence` | Link a thought to a loop |

Snoozed loops past their `snoozed_until` date auto-surface in the open query via UNION.

### UI — New "Loops" tab

- Three-tab filter: Open / Snoozed / Closed
- LoopCard: type icon, content, source thought link, age, evidence count badge
- Actions: close (with optional resolution text), snooze (date picker), reopen
- Questions and decisions show resolution text when closed
- Sortable by age

---

## Phase 2 — Entity Foundation

### Schema

```sql
entities(
  id uuid PK DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL,
  entity_type text NOT NULL DEFAULT 'person'
    CHECK (entity_type IN ('person')),
  attributes jsonb DEFAULT '{}',
  aliases text[] DEFAULT '{}',
  embedding vector(1536),       -- nullable, populated lazily
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
)

entity_mentions(
  entity_id uuid FK → entities ON DELETE CASCADE,
  thought_id uuid FK → thoughts,
  role text NOT NULL DEFAULT 'mentioned'
    CHECK (role IN ('subject', 'mentioned', 'author')),
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (entity_id, thought_id)
)
```

Unique index on `(lower(canonical_name), entity_type)`. GIN index on aliases. HNSW on embedding.

Phase 2 also adds `blocked_by_entity_id uuid FK → entities` (nullable) to `open_loops`.

### Entity resolution at ingest

Pure SQL, no LLM calls during capture:
1. Exact match on `lower(canonical_name)` where `entity_type = 'person'`
2. Alias match via `ILIKE ANY(aliases)`
3. No match → create new entity with name as sole alias
4. Upsert `entity_mentions` row

### Backfill

Single idempotent script:
- Phase 1: Query `metadata.action_items` across all thoughts → INSERT into `open_loops` (all as type=task, since historical items lack type classification)
- Phase 2: Query `metadata.people` → run through `resolveEntityMentions()`

### MCP tools

- `get_entity(name)` — lookup by name/alias, return with mention count
- `list_entity_mentions(entity_id, limit?)` — evidence timeline

### API routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/entities` | List entities (type filter) |
| GET | `/api/entities/:id` | Detail with mention count |
| PATCH | `/api/entities/:id` | Rename, manage aliases, attributes |
| POST | `/api/entities/merge` | Merge source into target entity |
| GET | `/api/entities/:id/thoughts` | Thoughts mentioning entity |

### People view evolution

PeopleView starts reading from entities table instead of aggregating metadata JSONB. Adds alias display, merge UI, and entity detail drill-down. The `/api/people` route stays as fallback.

---

## What's excluded

- **Briefs** (Phase 3) — deferred until invalidation behavior is understood in production
- **`follow-up` loop type** — handled by entity mentions on task loops
- **`blocked_by` text field** — wait for proper entity FK in Phase 2
- **`pg_trgm` fuzzy matching** — start with exact + alias; add later if needed
- **Entity embeddings at ingest** — column exists, populated lazily via separate process
