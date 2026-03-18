# Entity Facts — Implementation Design

Date: 2026-03-17
Status: Approved
Reference: `docs/design/entity_memory_contracts.md`

---

## Overview

Add fact memory to entities: structured claims with evidence, lifecycle status, conflict handling, and review flow. Facts are extracted automatically during thought capture and manageable through both UI and MCP.

This builds on the existing entity/mention infrastructure without modifying current behavior.

---

## Section 1: Schema

### New table: `entity_facts`

```sql
CREATE TABLE entity_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_value_json JSONB,
  object_display_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'tentative'
    CHECK (status IN ('active','tentative','disputed','superseded')),
  review_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending','accepted','rejected')),
  confidence REAL,
  source_kind TEXT NOT NULL DEFAULT 'extracted'
    CHECK (source_kind IN ('extracted','manual','chat','agent')),
  valid_at_start TIMESTAMPTZ,
  valid_at_end TIMESTAMPTZ,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

Indexes:
- `(entity_id, predicate)` — conflict/duplicate lookup
- HNSW on `embedding` — semantic retrieval for entity chat
- `review_state` — pending suggestion queue
- `entity_id` — general entity-scoped queries

Notes:
- `object_value_json` is nullable. Simple string facts use `object_display_text` alone. Application layer must never insert a fact with both fields null.
- `source_kind` includes `'agent'` for MCP adds where `source_kind` is not explicitly `'manual'`.

### New table: `entity_fact_evidence`

```sql
CREATE TABLE entity_fact_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id UUID NOT NULL REFERENCES entity_facts(id) ON DELETE CASCADE,
  thought_id UUID REFERENCES thoughts(id) ON DELETE CASCADE,
  excerpt TEXT,
  evidence_type TEXT NOT NULL DEFAULT 'extraction'
    CHECK (evidence_type IN ('extraction','manual','conversation')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (fact_id, thought_id)
);
```

Indexes:
- `(fact_id)` — evidence lookup for fact card click-through (hot path)

Notes:
- `thought_id` is nullable. Manual facts get an evidence row with `thought_id = NULL`, `evidence_type = 'manual'`, and `excerpt` containing the user's context text.
- `UNIQUE (fact_id, thought_id)` prevents duplicate evidence rows on reprocessing. For manual evidence where `thought_id` is NULL, the unique constraint does not apply (NULL != NULL in SQL), which is correct — multiple manual evidence entries on the same fact are valid.

### Altered table: `entity_mentions`

```sql
ALTER TABLE entity_mentions
  ADD COLUMN raw_mention_text TEXT,
  ADD COLUMN normalized_mention_text TEXT,
  ADD COLUMN resolution_state TEXT DEFAULT 'auto_linked_exact'
    CHECK (resolution_state IN (
      'auto_linked_exact', 'auto_linked_alias', 'auto_linked_fuzzy',
      'new_entity_created', 'pending_review', 'merged_after_review', 'rejected'
    )),
  ADD COLUMN resolution_confidence REAL,
  ADD COLUMN resolution_metadata_json JSONB;
```

Notes:
- Default `auto_linked_exact` for existing rows. Migration comment must note that historical rows lack resolution provenance and may have been fuzzy-matched — the default does not imply exact matching for pre-migration rows.
- `auto_linked_exact`, `auto_linked_alias`, `auto_linked_fuzzy` are distinct states because fuzzy matches mutate the entity record by auto-adding the mention as an alias. That behavioral distinction must be preserved in resolution state, not buried in metadata JSON.

### Migration strategy

- `db/migrations/001_entity_facts.sql` — additive migration for existing deployments
- `db/init.sql` — updated with all new tables/columns for fresh installs
- All changes are additive (new tables, new columns with defaults). No destructive changes.

---

## Section 2: Fact Extraction in Pipeline

Fact extraction runs during the existing thought capture pipeline as part of the same LLM call that extracts metadata (people, topics, etc).

### Prompt changes

The metadata extraction prompt in `openrouter.ts` adds `fact_candidates` to the JSON output schema:

```json
{
  "topics": [...],
  "people": [...],
  "fact_candidates": [
    {
      "entity": "Maya Patel",
      "predicate": "from",
      "value": "Porto",
      "display": "Porto",
      "confidence": 0.85,
      "excerpt": "Maya mentioned she grew up in Porto"
    }
  ]
}
```

Prompt instructions:
- Only emit facts explicitly stated in the text
- Do not infer facts not directly supported by the content
- Confidence reflects how explicitly the fact is stated

### Pipeline flow

```
capturePipeline(content)
  ├── parallel: embed + extractMetadata (now returns fact_candidates)
  ├── insert thought
  ├── categorize topics
  ├── create open_loops
  ├── mentionMap = resolveEntityMentions(people, thoughtId)
  └── processFactCandidates(fact_candidates, thoughtId, mentionMap)
```

### `processFactCandidates` (new function in `app/src/facts.ts`)

1. Filter candidates below confidence threshold (`FACT_CONFIDENCE_THRESHOLD` env var, default `0.80`)
2. For each candidate:
   - Look up entity in `mentionMap` by normalized name
   - Skip if entity not in mention map OR resolution state is not one of `auto_linked_exact`, `auto_linked_alias`, `auto_linked_fuzzy`
   - Normalize predicate and value
   - Run fact insertion contract (Section 3)

### `ThoughtMetadata` interface

Extended with optional `fact_candidates` array. Backwards compatible — old thoughts without facts have no candidates.

---

## Section 3: Fact Insertion Contract

Core logic inside `processFactCandidates` for each candidate. Lives in `app/src/facts.ts`.

### Step 1: Normalize

- **Predicate:** lowercase, trim, collapse whitespace, strip trailing punctuation
- **`object_value_json`:** attempt structured parsing for known patterns (dates → ISO, numbers → numeric), otherwise `{"value": "raw string"}`
- **`object_display_text`:** preserved as human-readable original, always populated

### Step 2: Duplicate/conflict check

Query existing facts for the same entity:

```sql
SELECT id, predicate, object_display_text, object_value_json, status
FROM entity_facts
WHERE entity_id = $1
  AND review_state != 'rejected'
```

Classify in application code:

- **Same-meaning:** predicate matches AND (`object_value_json` deep-equals OR normalized `object_display_text` string match). No embedding similarity — deterministic only in v1.
- **Conflicting:** predicate matches, value differs, AND existing fact `status` is `active`, `tentative`, or `disputed` (explicitly check `status != 'superseded'` before entering conflict branch)
- **Superseded-only conflict:** predicate matches, value differs, existing fact is `superseded` — not a live conflict

### Step 3: Apply insertion behavior

| Scenario | Action |
|----------|--------|
| Same-meaning fact exists | Attach new evidence to existing fact. Refresh `updated_at`. |
| No conflict | Insert as `status = 'tentative'`, `review_state = 'pending'` |
| Conflicts with active/tentative/disputed fact | Insert new fact as `status = 'disputed'`, `review_state = 'pending'`. Set existing fact `status = 'disputed'`. |
| Conflicts only with superseded | Insert normally (tentative/pending, no dispute) |

### Step 4: Attach evidence

Always create an `entity_fact_evidence` row:
- `fact_id` — the new or existing fact
- `thought_id` — the source thought
- `excerpt` — from the candidate's excerpt field
- `evidence_type = 'extraction'`

The `UNIQUE (fact_id, thought_id)` constraint prevents duplicates on reprocessing.

### Step 5: Embed

After insertion, generate and store the fact embedding (see Section 8).

---

## Section 4: API Routes

New routes in `app/src/routes/facts.ts`, mounted under `/api/entities/:entityId/facts`.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/entities/:entityId/facts` | List facts. Filters: `status`, `review_state`. Default: excludes `rejected`. |
| `GET` | `/api/entities/:entityId/facts/:factId` | Single fact with evidence array. |
| `POST` | `/api/entities/:entityId/facts` | Manual fact creation. `source_kind = 'manual'`, `status = 'active'`, `review_state = 'accepted'`. Runs insertion contract. |
| `PATCH` | `/api/entities/:entityId/facts/:factId` | Edit predicate, display text, temporal bounds. Only for `pending` or `accepted` facts. Returns 409 for `disputed` or `superseded`. |
| `POST` | `/api/entities/:entityId/facts/:factId/accept` | Accept pending suggestion. Returns 409 with conflict details if active or disputed fact exists for same predicate. |
| `POST` | `/api/entities/:entityId/facts/:factId/reject` | Set `review_state = 'rejected'`. Fact stays in DB for audit. |
| `POST` | `/api/entities/:entityId/facts/:factId/resolve-conflict` | Resolve disputed pair. Body: `{ action, note? }` |
| `GET` | `/api/facts/pending` | Cross-entity pending suggestions. Limit + cursor pagination. Joined with entity name. |

### Accept flow

1. Check for `active` OR `disputed` facts with same predicate on entity
2. No conflict → set `status = 'active'`, `review_state = 'accepted'`
3. Conflict exists → return `409 Conflict` with `{ conflict_with: existingFact }`
4. If the user edited the fact before accepting, conflict check runs against modified values

### Resolve conflict actions

| Action | Behavior |
|--------|----------|
| `replace_existing_with_new` | New fact → `active/accepted`. Old fact → `superseded`, `valid_at_end = now()`. |
| `mark_old_as_past` | Same as replace, but semantically: old fact was true, now outdated. |
| `mark_old_as_wrong` | New fact → `active/accepted`. Old fact → `rejected`. |
| `keep_both_disputed` | Both remain `disputed`. No state change. |
| `cancel` | No state change. Dismiss UI. |

Optional `note` field on resolve — stored as metadata for audit trail.

### PATCH guards

Enforced at route level:
- `pending` or `accepted` facts: editable
- `disputed` or `superseded` facts: return 409, direct user to resolve-conflict

### Merge extension

Existing `POST /api/entities/merge` in `routes/entities.ts` extended to:
- Move all facts from source entity to target entity
- Deduplicate same-meaning facts, merge evidence, keep stronger status
- Status precedence (code comment referencing contracts doc): `active > tentative > disputed > superseded`

---

## Section 5: MCP Tools

New tools in `app/src/mcp.ts`. All call shared functions in `facts.ts` — no duplicate business logic.

### `list_entity_facts`

Parameters:
- `entity_id` or `entity_name` (resolved internally)
- `status?` — filter by fact status
- `review_state?` — filter (e.g., `pending` for suggestion review)
- `include_evidence?` — boolean, default false
- `limit?` — default 20

### `add_entity_fact`

Parameters:
- `entity_name` — resolved to entity_id with disambiguation (if multiple matches, returns disambiguation response instead of picking silently)
- `predicate`
- `value`
- `display_text?` — defaults to `value`
- `source_kind?` — `'manual'` | `'agent'`, default `'agent'`
- `confidence?`

Behavior:
- `source_kind = 'manual'` → `status = 'active'`, `review_state = 'accepted'`
- `source_kind = 'agent'` → `status = 'tentative'`, `review_state = 'pending'`
- Runs full insertion contract (duplicate/conflict checks)
- If conflict detected, returns conflict details in response text

### `review_entity_fact`

Parameters:
- `fact_id`
- `action`: `'accept'` | `'reject'`
- `note?` — audit trail

Accept triggers same conflict check as API. If conflict exists, returns conflict details and instructs client to use `resolve_fact_conflict`.

### `resolve_fact_conflict`

Parameters:
- `fact_id`
- `action`: `'replace_existing_with_new'` | `'mark_old_as_past'` | `'mark_old_as_wrong'` | `'keep_both_disputed'`
- `note?` — audit trail

---

## Section 6: Frontend

### 6a: Entity Page — Fact Cards

The existing `EntityDetailPanel.tsx` gains a facts section between the entity header and the thoughts list.

**Loading state:** Render a skeleton immediately when entity detail opens. Facts are fetched separately from the entity header. Reserve space to avoid layout shift.

**Fact cards layout:**
- Grouped by predicate, sorted by status weight: active first, then tentative, disputed, superseded
- Each card shows: predicate label, display text, status badge, confidence indicator for tentative facts
- Active facts: clean, no extra chrome
- Tentative facts: subtle "unconfirmed" badge
- Disputed facts: warning treatment with "conflicting" badge — clicking expands to show both sides, grouped as conflict pair
- Superseded facts: dimmed with "past" label

**Fact card interactions:**
- Tap/click → expand: evidence list (excerpts linking to source thoughts), timestamps, edit/actions
- Edit (accepted/pending only) → inline edit of predicate, display text, temporal bounds
- Mark as past → `status = 'superseded'`, prompts for `valid_at_end`
- Mark as wrong → `review_state = 'rejected'`

**Manual fact entry:**
- "Add fact" button at top of facts section
- Inline form: predicate, value, optional date range
- Runs insertion contract via `POST /api/entities/:entityId/facts`
- Enters as `status = 'active'`, `review_state = 'accepted'`, `source_kind = 'manual'`

### 6b: Suggestion/Review Flow

**Per-entity suggestion tray:**
- Below active facts, a collapsible "Suggestions" area shows pending facts
- Each suggestion card: predicate, value, confidence score, excerpt preview
- Actions: Accept / Reject
- Accept calls `POST .../accept` — if 409, transitions to conflict resolution (6c)
- Reject → card animates out
- "Edit before accept" — edit fields inline, then accept. Conflict check runs against modified values, not originals.

**Suggestion count badges:**
- Entity card in PeopleView shows badge with pending suggestion count per entity
- Global pending count indicator on People nav item — review queue visibility without browsing entity cards

### 6c: Conflict Resolution UI

Triggered on 409 from accept, or when viewing disputed fact pair on entity page.

**Conflict card (inline, not modal):**
- Both facts side by side (stacked on mobile)
- Each side: value, evidence excerpts, timestamps, status
- Actions:
  - "Accept new, mark old as past" → `mark_old_as_past`
  - "Accept new, mark old as wrong" → accept new, reject old
  - "Keep both as uncertain" → `keep_both_disputed`
  - "Keep existing, reject new" → reject incoming fact
  - "Cancel" → dismiss without action

**Disputed facts on entity page:**
- Disputed pairs visually grouped with conflict indicator
- Clicking either fact expands inline conflict resolution card

### New components

- `FactCard.tsx` — single fact with expand/collapse and actions
- `FactSection.tsx` — facts list with skeleton, status grouping, "Add fact"
- `SuggestionTray.tsx` — collapsible pending suggestions with accept/reject/edit
- `ConflictCard.tsx` — inline conflict resolution for disputed pairs and 409 responses

### API client extensions (`api.ts`)

- `entityFacts(entityId, filters?)`
- `createFact(entityId, data)`
- `acceptFact(entityId, factId)`
- `rejectFact(entityId, factId)`
- `resolveConflict(entityId, factId, action, note?)`
- `pendingFacts(cursor?, limit?)`

### State

Signals for facts list and pending count, fetched when entity detail opens. Not global — scoped to entity detail lifecycle.

---

## Section 7: Entity Chat Grounding

### Route change

`POST /api/chat` gains an optional `entity_id` field. When absent: existing generic RAG, unchanged. When present: entity-grounded path.

Validate entity exists. Return error if not — do not silently fall back to generic RAG.

### Grounding stack

When `entity_id` is present, build context in order:

**1. Entity identity** — canonical name, aliases, entity type

**2. Fact retrieval**
- Always include all disputed facts regardless of match score
- Embed the user query
- Retrieve top matching facts by query-to-fact embedding similarity (using stored `entity_facts.embedding`)
- Fill remaining slots with results
- Cap total at 8–12 facts
- Include active, tentative, superseded in retrieval pool — do not filter by status before embedding match

**3. Evidence retrieval**
- For each selected fact, include 1–2 strongest evidence excerpts from `entity_fact_evidence`
- Disputed facts may include one excerpt per side
- Do not load evidence for unselected facts

**4. Recent thoughts**
- Filter `match_thoughts` to thoughts mentioning this entity
- Rank semantically within filtered set
- Top 3–5 results
- Provide nuance not yet crystallized into facts

**5. Epistemic prompt instructions**
```
You are answering a question about a specific entity. Use only the provided facts, evidence, and thoughts. Apply these rules:

- Active facts: state directly ("Maya is from Porto")
- Tentative facts: hedge ("Maya may have been born on May 12, 1991")
- Disputed facts: present as unresolved conflict ("Maya's current city is unclear — one note supports Seattle, a newer note suggests Portland")
- Superseded facts: frame as past ("Maya previously lived in Seattle")
- Thoughts without a corresponding fact: frame as unconfirmed ("A recent note suggests she may be considering a move, but this has not been confirmed")
- If no fact or thought exists for what the user asked about: say so directly. Do not speculate.
```

### Implementation notes

- Entity-grounded path replaces retrieval entirely — does not supplement generic RAG
- Fact relevance retrieval implemented as swappable strategy. Cap and always-include-disputed rules separated in code for independent tuning.
- No MCP chat tool in v1. MCP clients use `list_entity_facts` for grounding data.

---

## Section 8: Fact Embeddings

### When to embed

- On fact creation (pipeline extraction or manual)
- On fact edit, only when `predicate` or `object_display_text` changes
- Skip re-embedding for status, review_state, valid_at_start, valid_at_end changes

### Embedding text format

Single canonical rendering function used by all creation paths:

```ts
renderFactEmbeddingText(entityCanonicalName, predicate, objectDisplayText)
// returns: "<entity canonical name> — <predicate> — <object display text>"
```

Examples:
- `Maya Patel — from — Porto`
- `Maya Patel — born_on — May 12, 1991`
- `Maya Patel — works_at — Anthropic`

Do not append status, lifecycle state, or temporal suffixes in v1. Status is handled by structured fields and prompt logic, not the vector.

This function must be used by all three creation paths: pipeline extraction, manual API create, and PATCH edit handler. No ad hoc embedding text construction.

### Embedding sequence

For each fact:
1. Normalize predicate and value
2. Resolve duplicate/conflict behavior
3. Determine final canonical text via `renderFactEmbeddingText()`
4. Call `generateEmbedding()` with that text
5. Persist fact row with embedding

The embedding reflects final normalized state, not raw extracted values. Generated after normalization and conflict handling, before the fact is considered ready for retrieval.

### Implementation

- Reuse existing `generateEmbedding()` in `openrouter.ts`
- Store in `entity_facts.embedding`
- PATCH handler re-embeds when predicate or display text changes, explicitly skips for other field changes

### Cost

- 0–3 facts per thought — negligible alongside thought embedding
- No batching in v1

---

## Section 9: Entity Mentions Enrichment

### Overview

Refactor `resolveEntityMentions` in `app/src/entities.ts` from void resolver to inspectable pipeline step returning a typed mention map.

### Return type

```ts
type MentionResolution = {
  raw_mention_text: string;
  normalized_mention_text: string;
  entity_id: string;
  resolution_state: ResolutionState;
  resolution_confidence: number;
  resolution_metadata: Record<string, unknown> | null;
};

type MentionMap = Record<string, MentionResolution>; // keyed by normalized mention text
```

### Resolution states

| Resolution path | `resolution_state` | `confidence` | `resolution_metadata_json` |
|---|---|---|---|
| Exact canonical name match | `auto_linked_exact` | `1.0` | `{ match_type: 'canonical' }` |
| Exact alias match | `auto_linked_alias` | `1.0` | `{ match_type: 'alias', matched_alias: '...' }` |
| Fuzzy match above threshold | `auto_linked_fuzzy` | trigram similarity | `{ match_type: 'fuzzy', similarity: 0.82 }` |
| No match → new entity | `new_entity_created` | `1.0` | `null` |

States not set during pipeline capture:
- `pending_review` — future ambiguous match flagging
- `merged_after_review` — set by merge flow
- `rejected` — set by manual review

### Confidence semantics

- Exact/alias: `1.0` means resolution decision is certain
- Fuzzy: trigram similarity score — match closeness, not probabilistic entity correctness
- New entity: `1.0` means absence-of-match decision is certain, not global uniqueness

### Backwards compatibility

Existing rows get `resolution_state = 'auto_linked_exact'` as default. Migration comment notes historical rows lack resolution provenance — default does not imply exact matching for pre-migration rows.

### Impact on fact processing

`processFactCandidates` receives `MentionMap` directly. Skip fact insertion for any mention where `resolution_state` is not one of `auto_linked_exact`, `auto_linked_alias`, `auto_linked_fuzzy`. Covers both unresolved mentions and future `pending_review` cases.
