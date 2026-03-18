# Entity Facts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add fact memory to entities — structured claims with evidence, lifecycle status, conflict handling, and review flow — extractable from thoughts and manageable through both UI and MCP.

**Architecture:** Facts are extracted during the existing thought capture pipeline (same LLM call as metadata), stored with status/review lifecycle, and surfaced through API routes, MCP tools, and frontend components. Entity chat is grounded in facts + evidence instead of raw thought RAG.

**Tech Stack:** TypeScript ESM, Hono, PostgreSQL + pgvector, Preact + @preact/signals, Vitest

**Design doc:** `docs/plans/2026-03-17-entity-facts-design.md`

---

## Phase 1: Schema & Migration [DONE]

### Task 1: Create migration file and update init.sql [DONE]

**Files:**
- Create: `db/migrations/001_entity_facts.sql`
- Modify: `db/init.sql:101-134`

**Step 1: Create the migration file**

Create `db/migrations/001_entity_facts.sql`:

```sql
-- Entity Facts Migration
-- Adds entity_facts, entity_fact_evidence tables and enriches entity_mentions
-- For existing deployments. Fresh installs get everything from init.sql.

BEGIN;

-- entity_facts: memory claims about entities
CREATE TABLE IF NOT EXISTS entity_facts (
    id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    entity_id           UUID        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    predicate           TEXT        NOT NULL,
    object_value_json   JSONB,
    object_display_text TEXT        NOT NULL,
    status              TEXT        NOT NULL DEFAULT 'tentative'
        CHECK (status IN ('active', 'tentative', 'disputed', 'superseded')),
    review_state        TEXT        NOT NULL DEFAULT 'pending'
        CHECK (review_state IN ('pending', 'accepted', 'rejected')),
    confidence          REAL,
    source_kind         TEXT        NOT NULL DEFAULT 'extracted'
        CHECK (source_kind IN ('extracted', 'manual', 'chat', 'agent')),
    valid_at_start      TIMESTAMPTZ,
    valid_at_end        TIMESTAMPTZ,
    embedding           vector(1536),
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entity_facts_entity_predicate
    ON entity_facts (entity_id, predicate);
CREATE INDEX IF NOT EXISTS idx_entity_facts_review_state
    ON entity_facts (review_state);
CREATE INDEX IF NOT EXISTS idx_entity_facts_entity_id
    ON entity_facts (entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_facts_embedding
    ON entity_facts USING hnsw (embedding vector_cosine_ops);

-- entity_fact_evidence: links facts to supporting thoughts/sources
CREATE TABLE IF NOT EXISTS entity_fact_evidence (
    id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    fact_id         UUID        NOT NULL REFERENCES entity_facts(id) ON DELETE CASCADE,
    thought_id      UUID        REFERENCES thoughts(id) ON DELETE CASCADE,
    excerpt         TEXT,
    evidence_type   TEXT        NOT NULL DEFAULT 'extraction'
        CHECK (evidence_type IN ('extraction', 'manual', 'conversation')),
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (fact_id, thought_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_fact_evidence_fact_id
    ON entity_fact_evidence (fact_id);

-- entity_mentions enrichment
-- Note: historical rows get 'auto_linked_exact' as default. Pre-migration rows
-- may have been fuzzy-matched — the default does not imply exact matching.
ALTER TABLE entity_mentions
    ADD COLUMN IF NOT EXISTS raw_mention_text TEXT,
    ADD COLUMN IF NOT EXISTS normalized_mention_text TEXT,
    ADD COLUMN IF NOT EXISTS resolution_state TEXT DEFAULT 'auto_linked_exact'
        CHECK (resolution_state IN (
            'auto_linked_exact', 'auto_linked_alias', 'auto_linked_fuzzy',
            'new_entity_created', 'pending_review', 'merged_after_review', 'rejected'
        )),
    ADD COLUMN IF NOT EXISTS resolution_confidence REAL,
    ADD COLUMN IF NOT EXISTS resolution_metadata_json JSONB;

COMMIT;
```

**Step 2: Update `db/init.sql`**

Add the `entity_facts` and `entity_fact_evidence` table definitions after the existing `entity_mentions` table (after line 134). Add the new columns to the `entity_mentions` table definition inline. The init.sql should represent the complete schema for fresh installs.

Add after entity_mentions (after line 134):

```sql
-- entity_facts: memory claims about entities
CREATE TABLE IF NOT EXISTS entity_facts (
    id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    entity_id           UUID        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    predicate           TEXT        NOT NULL,
    object_value_json   JSONB,
    object_display_text TEXT        NOT NULL,
    status              TEXT        NOT NULL DEFAULT 'tentative'
        CHECK (status IN ('active', 'tentative', 'disputed', 'superseded')),
    review_state        TEXT        NOT NULL DEFAULT 'pending'
        CHECK (review_state IN ('pending', 'accepted', 'rejected')),
    confidence          REAL,
    source_kind         TEXT        NOT NULL DEFAULT 'extracted'
        CHECK (source_kind IN ('extracted', 'manual', 'chat', 'agent')),
    valid_at_start      TIMESTAMPTZ,
    valid_at_end        TIMESTAMPTZ,
    embedding           vector(1536),
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entity_facts_entity_predicate
    ON entity_facts (entity_id, predicate);
CREATE INDEX IF NOT EXISTS idx_entity_facts_review_state
    ON entity_facts (review_state);
CREATE INDEX IF NOT EXISTS idx_entity_facts_entity_id
    ON entity_facts (entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_facts_embedding
    ON entity_facts USING hnsw (embedding vector_cosine_ops);

-- entity_fact_evidence: links facts to supporting thoughts/sources
CREATE TABLE IF NOT EXISTS entity_fact_evidence (
    id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    fact_id         UUID        NOT NULL REFERENCES entity_facts(id) ON DELETE CASCADE,
    thought_id      UUID        REFERENCES thoughts(id) ON DELETE CASCADE,
    excerpt         TEXT,
    evidence_type   TEXT        NOT NULL DEFAULT 'extraction'
        CHECK (evidence_type IN ('extraction', 'manual', 'conversation')),
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (fact_id, thought_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_fact_evidence_fact_id
    ON entity_fact_evidence (fact_id);
```

Also modify the `entity_mentions` table definition (lines 127-134) to include the new columns inline for fresh installs:

```sql
CREATE TABLE IF NOT EXISTS entity_mentions (
    entity_id               UUID        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    thought_id              UUID        NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    role                    TEXT        DEFAULT 'mentioned'
        CHECK (role IN ('subject', 'mentioned', 'author')),
    raw_mention_text        TEXT,
    normalized_mention_text TEXT,
    resolution_state        TEXT        DEFAULT 'auto_linked_exact'
        CHECK (resolution_state IN (
            'auto_linked_exact', 'auto_linked_alias', 'auto_linked_fuzzy',
            'new_entity_created', 'pending_review', 'merged_after_review', 'rejected'
        )),
    resolution_confidence   REAL,
    resolution_metadata_json JSONB,
    created_at              TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (entity_id, thought_id)
);
```

**Step 3: Apply migration to dev database**

Run: `psql $DATABASE_URL -f db/migrations/001_entity_facts.sql`

Verify: `psql $DATABASE_URL -c "\d entity_facts"` — should show all columns.
Verify: `psql $DATABASE_URL -c "\d entity_fact_evidence"` — should show all columns.
Verify: `psql $DATABASE_URL -c "\d entity_mentions"` — should show new columns.

**Step 4: Commit**

```bash
git add db/migrations/001_entity_facts.sql db/init.sql
git commit -m "feat: add entity_facts schema, evidence table, and mentions enrichment"
```

---

## Phase 2: Entity Resolution Enrichment [DONE]

### Task 2: Refactor resolveEntityMentions to return MentionMap [DONE]

**Files:**
- Modify: `app/src/entities.ts:1-90`
- Test: `app/src/__tests__/entity-resolution.test.ts`

**Step 1: Write failing tests for the new return type**

Add tests to `app/src/__tests__/entity-resolution.test.ts`. The existing tests verify query calls via `mockQuery` — new tests verify the return value and new column population.

```typescript
it("returns MentionMap with exact match resolution", async () => {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] }) // exact match
    .mockResolvedValueOnce({ rows: [] }); // upsert mention

  const result = await resolveEntityMentions(["Alice"], "thought-1");

  expect(result).toHaveLength(1);
  expect(result[0]).toEqual({
    raw_mention_text: "Alice",
    normalized_mention_text: "alice",
    entity_id: "entity-1",
    resolution_state: "auto_linked_exact",
    resolution_confidence: 1.0,
    resolution_metadata: { match_type: "canonical" },
  });
});

it("returns MentionMap with alias match resolution", async () => {
  mockQuery
    .mockResolvedValueOnce({ rows: [] }) // no exact
    .mockResolvedValueOnce({ rows: [{ id: "entity-2" }] }) // alias match
    .mockResolvedValueOnce({ rows: [] }); // upsert mention

  const result = await resolveEntityMentions(["Al"], "thought-1");

  expect(result[0]).toEqual(
    expect.objectContaining({
      resolution_state: "auto_linked_alias",
      resolution_confidence: 1.0,
      resolution_metadata: expect.objectContaining({ match_type: "alias" }),
    }),
  );
});

it("returns MentionMap with fuzzy match resolution", async () => {
  mockQuery
    .mockResolvedValueOnce({ rows: [] }) // no exact
    .mockResolvedValueOnce({ rows: [] }) // no alias
    .mockResolvedValueOnce({ rows: [{ id: "entity-3", sim: 0.72 }] }) // fuzzy
    .mockResolvedValueOnce({ rows: [] }) // append alias
    .mockResolvedValueOnce({ rows: [] }); // upsert mention

  const result = await resolveEntityMentions(["Bobby"], "thought-1");

  expect(result[0]).toEqual(
    expect.objectContaining({
      resolution_state: "auto_linked_fuzzy",
      resolution_confidence: 0.72,
      resolution_metadata: { match_type: "fuzzy", similarity: 0.72 },
    }),
  );
});

it("returns MentionMap with new_entity_created resolution", async () => {
  mockQuery
    .mockResolvedValueOnce({ rows: [] }) // no exact
    .mockResolvedValueOnce({ rows: [] }) // no alias
    .mockResolvedValueOnce({ rows: [] }) // no fuzzy
    .mockResolvedValueOnce({ rows: [{ id: "new-entity" }] }) // create entity
    .mockResolvedValueOnce({ rows: [] }); // upsert mention

  const result = await resolveEntityMentions(["Zara"], "thought-1");

  expect(result[0]).toEqual(
    expect.objectContaining({
      resolution_state: "new_entity_created",
      resolution_confidence: 1.0,
      resolution_metadata: null,
    }),
  );
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run app/src/__tests__/entity-resolution.test.ts`
Expected: FAIL — `resolveEntityMentions` currently returns `void`, not an array.

**Step 3: Define MentionResolution type and refactor resolveEntityMentions**

Modify `app/src/entities.ts`:

```typescript
import { query } from "./db.js";
import { config } from "./config.js";

export type ResolutionState =
  | "auto_linked_exact"
  | "auto_linked_alias"
  | "auto_linked_fuzzy"
  | "new_entity_created"
  | "pending_review"
  | "merged_after_review"
  | "rejected";

export interface MentionResolution {
  raw_mention_text: string;
  normalized_mention_text: string;
  entity_id: string;
  resolution_state: ResolutionState;
  resolution_confidence: number;
  resolution_metadata: Record<string, unknown> | null;
}

export async function resolveEntityMentions(
  names: string[],
  thoughtId: string,
): Promise<MentionResolution[]> {
  const results: MentionResolution[] = [];

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLowerCase();

    let entityId: string | null = null;
    let resolutionState: ResolutionState = "new_entity_created";
    let confidence = 1.0;
    let metadata: Record<string, unknown> | null = null;

    // Step 1: Exact canonical name match
    const exact = await query<{ id: string }>(
      `SELECT id FROM entities WHERE lower(canonical_name) = lower($1) AND entity_type = 'person' LIMIT 1`,
      [trimmed],
    );
    if (exact.rows.length > 0) {
      entityId = exact.rows[0].id;
      resolutionState = "auto_linked_exact";
      confidence = 1.0;
      metadata = { match_type: "canonical" };
    }

    // Step 2: Alias match
    if (!entityId) {
      const alias = await query<{ id: string }>(
        `SELECT id FROM entities WHERE $1 ILIKE ANY(aliases) AND entity_type = 'person' LIMIT 1`,
        [trimmed],
      );
      if (alias.rows.length > 0) {
        entityId = alias.rows[0].id;
        resolutionState = "auto_linked_alias";
        confidence = 1.0;
        metadata = { match_type: "alias", matched_alias: trimmed };
      }
    }

    // Step 3: Fuzzy pg_trgm match
    if (!entityId) {
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
        entityId = fuzzy.rows[0].id;
        resolutionState = "auto_linked_fuzzy";
        confidence = fuzzy.rows[0].sim;
        metadata = { match_type: "fuzzy", similarity: fuzzy.rows[0].sim };

        // Auto-add as alias for future exact lookups
        await query(
          `UPDATE entities SET aliases = array_append(aliases, $1), updated_at = now()
           WHERE id = $2 AND NOT ($1 = ANY(aliases))`,
          [trimmed, entityId],
        );
      }
    }

    // Step 4: Create new entity
    if (!entityId) {
      const created = await query<{ id: string }>(
        `INSERT INTO entities (canonical_name, entity_type, aliases)
         VALUES ($1, 'person', ARRAY[$1])
         ON CONFLICT (lower(canonical_name), entity_type) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [trimmed],
      );
      entityId = created.rows[0].id;
      resolutionState = "new_entity_created";
      confidence = 1.0;
      metadata = null;
    }

    // Step 5: Upsert mention with enrichment columns
    await query(
      `INSERT INTO entity_mentions (entity_id, thought_id, raw_mention_text, normalized_mention_text, resolution_state, resolution_confidence, resolution_metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (entity_id, thought_id) DO NOTHING`,
      [entityId, thoughtId, trimmed, normalized, resolutionState, confidence, metadata ? JSON.stringify(metadata) : null],
    );

    results.push({
      raw_mention_text: trimmed,
      normalized_mention_text: normalized,
      entity_id: entityId,
      resolution_state: resolutionState,
      resolution_confidence: confidence,
      resolution_metadata: metadata,
    });
  }

  return results;
}
```

**Step 4: Update existing tests that assert on mockQuery call args**

The upsert mention query now includes new columns. Update existing test assertions that check the mention upsert SQL and parameters to match the new query shape. Existing tests that check other query calls (exact, alias, fuzzy, create) should not need changes — only the final mention upsert call per name changes.

**Step 5: Run all tests**

Run: `npx vitest run app/src/__tests__/entity-resolution.test.ts`
Expected: All tests pass.

**Step 6: Update pipeline to use MentionMap**

Modify `app/src/pipeline.ts:109-116`. Change from:

```typescript
if (metadata.people.length > 0) {
  try {
    await resolveEntityMentions(metadata.people, thoughtId);
  } catch {
    // Don't fail capture if entity resolution fails
  }
}
```

To:

```typescript
let mentionMap: MentionResolution[] = [];
if (metadata.people.length > 0) {
  try {
    mentionMap = await resolveEntityMentions(metadata.people, thoughtId);
  } catch {
    // Don't fail capture if entity resolution fails
  }
}
```

Add the import at top of pipeline.ts: `import { resolveEntityMentions, type MentionResolution } from "./entities.js";`

Note: `mentionMap` is captured but not used yet — it will be passed to `processFactCandidates` in Task 4.

**Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests pass. The pipeline change is backwards-compatible (just captures the return value).

**Step 8: Commit**

```bash
git add app/src/entities.ts app/src/__tests__/entity-resolution.test.ts app/src/pipeline.ts
git commit -m "feat: refactor resolveEntityMentions to return typed MentionMap"
```

---

## Phase 3: Fact Insertion Contract

### Task 3: Add config value for fact confidence threshold [DONE]

**Files:**
- Modify: `app/src/config.ts`

**Step 1: Add the config value**

Add to the config object in `app/src/config.ts` (line 10, before the closing brace):

```typescript
factConfidenceThreshold: parseFloat(process.env.FACT_CONFIDENCE_THRESHOLD || "0.80"),
```

**Step 2: Commit**

```bash
git add app/src/config.ts
git commit -m "feat: add FACT_CONFIDENCE_THRESHOLD config"
```

### Task 4: Implement fact insertion contract and processFactCandidates [DONE]

**Files:**
- Create: `app/src/facts.ts`
- Create: `app/src/__tests__/facts.test.ts`

**Step 1: Write failing tests for fact insertion**

Create `app/src/__tests__/facts.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockGenerateEmbedding = vi.fn();

vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}));

vi.mock("../config.js", () => ({
  config: { factConfidenceThreshold: 0.80 },
}));

vi.mock("pgvector", () => ({
  default: { toSql: (v: number[]) => `[${v.join(",")}]` },
}));

import { processFactCandidates, normalizePredicate, renderFactEmbeddingText } from "../facts.js";
import type { MentionResolution } from "../entities.js";

describe("normalizePredicate", () => {
  it("lowercases and trims", () => {
    expect(normalizePredicate("  Birthday  ")).toBe("birthday");
  });

  it("collapses whitespace", () => {
    expect(normalizePredicate("works  at")).toBe("works at");
  });

  it("strips trailing punctuation", () => {
    expect(normalizePredicate("from:")).toBe("from");
    expect(normalizePredicate("born_on.")).toBe("born_on");
  });
});

describe("renderFactEmbeddingText", () => {
  it("renders canonical format", () => {
    expect(renderFactEmbeddingText("Maya Patel", "from", "Porto"))
      .toBe("Maya Patel — from — Porto");
  });
});

describe("processFactCandidates", () => {
  const mentionMap: MentionResolution[] = [
    {
      raw_mention_text: "Maya",
      normalized_mention_text: "maya",
      entity_id: "entity-1",
      resolution_state: "auto_linked_exact",
      resolution_confidence: 1.0,
      resolution_metadata: { match_type: "canonical" },
    },
  ];

  beforeEach(() => {
    mockQuery.mockReset();
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it("skips candidates below confidence threshold", async () => {
    await processFactCandidates(
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 0.5, excerpt: "..." }],
      "thought-1",
      mentionMap,
    );

    // No DB queries for fact insertion
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("skips candidates for unresolved entities", async () => {
    const unresolvedMap: MentionResolution[] = [
      { ...mentionMap[0], resolution_state: "new_entity_created" },
    ];

    await processFactCandidates(
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 0.9, excerpt: "..." }],
      "thought-1",
      unresolvedMap,
    );

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("inserts new fact as tentative/pending when no conflict", async () => {
    // Existing facts query returns empty
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no existing facts
      .mockResolvedValueOnce({ rows: [{ id: "fact-1" }] }) // insert fact
      .mockResolvedValueOnce({ rows: [] }); // insert evidence

    await processFactCandidates(
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 0.9, excerpt: "grew up in Porto" }],
      "thought-1",
      mentionMap,
    );

    // Verify fact insert
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO entity_facts");
    expect(insertCall[1]).toContain("entity-1"); // entity_id
    expect(insertCall[1]).toContain("from"); // predicate
    expect(insertCall[1]).toContain("tentative"); // status
    expect(insertCall[1]).toContain("pending"); // review_state

    // Verify evidence insert
    const evidenceCall = mockQuery.mock.calls[2];
    expect(evidenceCall[0]).toContain("INSERT INTO entity_fact_evidence");
    expect(evidenceCall[1]).toContain("fact-1");
    expect(evidenceCall[1]).toContain("thought-1");
  });

  it("attaches evidence to existing same-meaning fact instead of duplicating", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: "existing-fact", predicate: "from", object_display_text: "Porto", object_value_json: null, status: "active" }],
      }) // existing facts
      .mockResolvedValueOnce({ rows: [] }) // update updated_at
      .mockResolvedValueOnce({ rows: [] }); // insert evidence

    await processFactCandidates(
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 0.9, excerpt: "born in Porto" }],
      "thought-1",
      mentionMap,
    );

    // Should NOT insert a new fact
    const calls = mockQuery.mock.calls.map((c) => c[0]);
    expect(calls.filter((sql: string) => sql.includes("INSERT INTO entity_facts"))).toHaveLength(0);
    // Should update updated_at on existing fact
    expect(calls[1]).toContain("UPDATE entity_facts");
    // Should insert evidence for existing fact
    expect(mockQuery.mock.calls[2][1]).toContain("existing-fact");
  });

  it("marks both facts disputed on conflict with active fact", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: "existing-fact", predicate: "lives_in", object_display_text: "Seattle", object_value_json: null, status: "active" }],
      }) // existing facts
      .mockResolvedValueOnce({ rows: [{ id: "new-fact" }] }) // insert new fact as disputed
      .mockResolvedValueOnce({ rows: [] }) // mark existing as disputed
      .mockResolvedValueOnce({ rows: [] }); // insert evidence

    await processFactCandidates(
      [{ entity: "Maya", predicate: "lives_in", value: "Portland", display: "Portland", confidence: 0.9, excerpt: "moved to Portland" }],
      "thought-1",
      mentionMap,
    );

    // New fact inserted as disputed
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[1]).toContain("disputed");

    // Existing fact updated to disputed
    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[0]).toContain("UPDATE entity_facts");
    expect(updateCall[0]).toContain("disputed");
    expect(updateCall[1]).toContain("existing-fact");
  });

  it("inserts normally when conflict only with superseded fact", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: "old-fact", predicate: "lives_in", object_display_text: "Seattle", object_value_json: null, status: "superseded" }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "new-fact" }] }) // insert as tentative (not disputed)
      .mockResolvedValueOnce({ rows: [] }); // insert evidence

    await processFactCandidates(
      [{ entity: "Maya", predicate: "lives_in", value: "Portland", display: "Portland", confidence: 0.9, excerpt: "now in Portland" }],
      "thought-1",
      mentionMap,
    );

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[1]).toContain("tentative"); // not disputed
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run app/src/__tests__/facts.test.ts`
Expected: FAIL — `facts.ts` does not exist yet.

**Step 3: Implement facts.ts**

Create `app/src/facts.ts`:

```typescript
import { query } from "./db.js";
import { config } from "./config.js";
import { generateEmbedding } from "./openrouter.js";
import pgvector from "pgvector";
import type { MentionResolution } from "./entities.js";

export interface FactCandidate {
  entity: string;
  predicate: string;
  value: string;
  display: string;
  confidence: number;
  excerpt: string;
}

export function normalizePredicate(predicate: string): string {
  return predicate
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.:;,!?]+$/, "");
}

export function renderFactEmbeddingText(
  entityCanonicalName: string,
  predicate: string,
  objectDisplayText: string,
): string {
  return `${entityCanonicalName} — ${predicate} — ${objectDisplayText}`;
}

interface ExistingFact {
  id: string;
  predicate: string;
  object_display_text: string;
  object_value_json: unknown;
  status: string;
}

function isSameMeaning(candidate: { predicate: string; display: string }, existing: ExistingFact): boolean {
  if (normalizePredicate(candidate.predicate) !== normalizePredicate(existing.predicate)) return false;
  const normalizedNew = candidate.display.trim().toLowerCase();
  const normalizedExisting = existing.object_display_text.trim().toLowerCase();
  if (normalizedNew === normalizedExisting) return true;
  if (existing.object_value_json && typeof existing.object_value_json === "object") {
    const val = (existing.object_value_json as Record<string, unknown>).value;
    if (typeof val === "string" && val.trim().toLowerCase() === normalizedNew) return true;
  }
  return false;
}

function isConflicting(candidate: { predicate: string; display: string }, existing: ExistingFact): boolean {
  if (normalizePredicate(candidate.predicate) !== normalizePredicate(existing.predicate)) return false;
  if (isSameMeaning(candidate, existing)) return false;
  // Only active, tentative, or disputed facts create live conflicts
  return existing.status !== "superseded";
}

async function embedFact(
  entityName: string,
  predicate: string,
  displayText: string,
): Promise<string> {
  const text = renderFactEmbeddingText(entityName, predicate, displayText);
  const embedding = await generateEmbedding(text);
  return pgvector.toSql(embedding);
}

export async function processFactCandidates(
  candidates: FactCandidate[],
  thoughtId: string,
  mentionMap: MentionResolution[],
): Promise<void> {
  const autoLinkedStates = new Set(["auto_linked_exact", "auto_linked_alias", "auto_linked_fuzzy"]);
  const mentionLookup = new Map(mentionMap.map((m) => [m.normalized_mention_text, m]));

  for (const candidate of candidates) {
    // Filter below threshold
    if (candidate.confidence < config.factConfidenceThreshold) continue;

    // Resolve entity from mention map
    const normalized = candidate.entity.trim().toLowerCase();
    const mention = mentionLookup.get(normalized);
    if (!mention || !autoLinkedStates.has(mention.resolution_state)) continue;

    const entityId = mention.entity_id;
    const predicate = normalizePredicate(candidate.predicate);
    const displayText = candidate.display || candidate.value;
    let objectValueJson: unknown = null;

    // Attempt structured parsing for known patterns
    const dateMatch = candidate.value.match(/^\d{4}-\d{2}-\d{2}$/);
    if (dateMatch) {
      objectValueJson = { value: candidate.value, type: "date" };
    } else {
      const numMatch = candidate.value.match(/^-?\d+(\.\d+)?$/);
      if (numMatch) {
        objectValueJson = { value: parseFloat(candidate.value), type: "number" };
      } else {
        objectValueJson = { value: candidate.value };
      }
    }

    // Check existing facts for this entity
    const existing = await query<ExistingFact>(
      `SELECT id, predicate, object_display_text, object_value_json, status
       FROM entity_facts
       WHERE entity_id = $1 AND review_state != 'rejected'`,
      [entityId],
    );

    // Classify against existing facts
    const sameMeaning = existing.rows.find((f) => isSameMeaning({ predicate, display: displayText }, f));
    const conflicting = existing.rows.find((f) => isConflicting({ predicate, display: displayText }, f));

    let factId: string;

    if (sameMeaning) {
      // Attach evidence to existing fact, refresh timestamp
      factId = sameMeaning.id;
      await query(
        `UPDATE entity_facts SET updated_at = now() WHERE id = $1`,
        [factId],
      );
    } else if (conflicting) {
      // Insert new fact as disputed
      const embeddingVal = await embedFact(mention.raw_mention_text, predicate, displayText);
      const result = await query<{ id: string }>(
        `INSERT INTO entity_facts (entity_id, predicate, object_value_json, object_display_text, status, review_state, confidence, source_kind, embedding)
         VALUES ($1, $2, $3, $4, 'disputed', 'pending', $5, 'extracted', $6)
         RETURNING id`,
        [entityId, predicate, JSON.stringify(objectValueJson), displayText, candidate.confidence, embeddingVal],
      );
      factId = result.rows[0].id;

      // Mark existing fact as disputed too
      await query(
        `UPDATE entity_facts SET status = 'disputed', updated_at = now() WHERE id = $1 AND status != 'disputed'`,
        [conflicting.id],
      );
    } else {
      // No conflict — insert as tentative/pending
      const embeddingVal = await embedFact(mention.raw_mention_text, predicate, displayText);
      const result = await query<{ id: string }>(
        `INSERT INTO entity_facts (entity_id, predicate, object_value_json, object_display_text, status, review_state, confidence, source_kind, embedding)
         VALUES ($1, $2, $3, $4, 'tentative', 'pending', $5, 'extracted', $6)
         RETURNING id`,
        [entityId, predicate, JSON.stringify(objectValueJson), displayText, candidate.confidence, embeddingVal],
      );
      factId = result.rows[0].id;
    }

    // Attach evidence
    await query(
      `INSERT INTO entity_fact_evidence (fact_id, thought_id, excerpt, evidence_type)
       VALUES ($1, $2, $3, 'extraction')
       ON CONFLICT (fact_id, thought_id) DO NOTHING`,
      [factId, thoughtId, candidate.excerpt],
    );
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run app/src/__tests__/facts.test.ts`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add app/src/facts.ts app/src/__tests__/facts.test.ts
git commit -m "feat: implement fact insertion contract with conflict detection"
```

---

## Phase 4: Extraction Pipeline Integration

### Task 5: Extend metadata extraction to include fact_candidates [DONE]

**Files:**
- Modify: `app/src/openrouter.ts:37-71, 317-346`
- Test: `app/src/__tests__/openrouter.test.ts`

**Step 1: Extend ThoughtMetadata interface**

In `app/src/openrouter.ts`, add to the `ThoughtMetadata` interface (line 37-44):

```typescript
export interface ThoughtMetadata {
  type: string;
  topics: string[];
  people: string[];
  action_items: ActionItem[];
  dates_mentioned: string[];
  source_context: string | null;
  fact_candidates?: FactCandidateRaw[];
}

export interface FactCandidateRaw {
  entity: string;
  predicate: string;
  value: string;
  display: string;
  confidence: number;
  excerpt: string;
}
```

**Step 2: Update EXTRACTION_PROMPT**

Extend the extraction prompt (lines 46-71) to include `fact_candidates` in the JSON schema:

Add to the schema description in the prompt:

```
    "fact_candidates": array of factual claims about named entities found in the text. Each object has:
        "entity": name of the person/entity this fact is about (must match a name from the "people" array),
        "predicate": the relationship or attribute (e.g. "from", "born_on", "works_at", "lives_in"),
        "value": the structured value (use YYYY-MM-DD for dates),
        "display": human-readable display text for the value,
        "confidence": 0.0-1.0 how explicitly the fact is stated (1.0 = directly stated, 0.5 = implied),
        "excerpt": the specific text that supports this fact
    Only include facts explicitly stated in the text. Do not infer unstated facts. Empty array if none.
```

**Step 3: Update extractMetadata parsing**

In the `extractMetadata` function (lines 317-346), add parsing for `fact_candidates` with safe defaults:

```typescript
fact_candidates: Array.isArray(parsed.fact_candidates)
  ? parsed.fact_candidates.map((fc: any) => ({
      entity: String(fc.entity || ""),
      predicate: String(fc.predicate || ""),
      value: String(fc.value || ""),
      display: String(fc.display || fc.value || ""),
      confidence: typeof fc.confidence === "number" ? fc.confidence : 0,
      excerpt: String(fc.excerpt || ""),
    })).filter((fc: any) => fc.entity && fc.predicate && fc.value)
  : [],
```

**Step 4: Add test for fact_candidates extraction**

Add to `app/src/__tests__/openrouter.test.ts`:

```typescript
it("extracts fact_candidates from metadata response", async () => {
  // Mock the chat completions API to return fact_candidates
  // Follow existing test patterns in this file for mocking fetch/openrouter
  // Verify that the returned ThoughtMetadata includes fact_candidates array
  // Verify malformed candidates are filtered out (missing entity/predicate/value)
  // Verify fact_candidates defaults to empty array when not present in response
});
```

**Step 5: Run tests**

Run: `npx vitest run app/src/__tests__/openrouter.test.ts`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add app/src/openrouter.ts app/src/__tests__/openrouter.test.ts
git commit -m "feat: extend metadata extraction prompt to include fact_candidates"
```

### Task 6: Wire processFactCandidates into pipeline [DONE]

**Files:**
- Modify: `app/src/pipeline.ts:109-116`
- Test: `app/src/__tests__/capture.test.ts`

**Step 1: Add processFactCandidates call to pipeline**

In `app/src/pipeline.ts`, after the entity resolution block (around line 116), add:

```typescript
import { processFactCandidates } from "./facts.js";

// ... inside capturePipeline, after mentionMap is populated:

// Process fact candidates (best-effort, don't fail capture)
if (metadata.fact_candidates && metadata.fact_candidates.length > 0 && mentionMap.length > 0) {
  try {
    await processFactCandidates(metadata.fact_candidates, thoughtId, mentionMap);
  } catch {
    // Don't fail capture if fact processing fails
  }
}
```

**Step 2: Add test for pipeline fact processing**

Add to `app/src/__tests__/capture.test.ts` — a test that verifies fact candidates from metadata are passed through to `processFactCandidates`. Follow the existing test pattern of mocking `../openrouter.js` and `../db.js`. The test should verify:
- When `extractMetadata` returns `fact_candidates`, they are processed
- When `fact_candidates` is empty or absent, no fact processing happens
- Fact processing errors don't fail the capture

**Step 3: Run tests**

Run: `npx vitest run app/src/__tests__/capture.test.ts`
Expected: All tests pass.

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. No regressions.

**Step 5: Commit**

```bash
git add app/src/pipeline.ts app/src/__tests__/capture.test.ts
git commit -m "feat: wire fact extraction into capture pipeline"
```

---

## Phase 5: Fact API Routes

### Task 7: Implement fact CRUD routes [DONE]

**Files:**
- Create: `app/src/routes/facts.ts`
- Modify: `app/src/app.ts` (mount route)
- Create: `app/src/__tests__/facts-routes.test.ts`

**Step 1: Write failing tests for fact routes**

Create `app/src/__tests__/facts-routes.test.ts`. Follow the existing test pattern from `app/src/__tests__/entities.test.ts`:
- Mock `../db.js`, `../openrouter.js`, `pgvector`
- Import `app` from `../app.js`
- Set env vars: `BRAIN_ACCESS_KEY`, `DATABASE_URL`, `OPENROUTER_API_KEY`
- Use `/api/entities/:entityId/facts` prefix

Test cases:

```typescript
describe("GET /api/entities/:entityId/facts", () => {
  it("returns facts for an entity, excluding rejected by default");
  it("filters by status when provided");
  it("filters by review_state when provided");
});

describe("GET /api/entities/:entityId/facts/:factId", () => {
  it("returns single fact with evidence array");
  it("returns 404 when fact not found");
});

describe("POST /api/entities/:entityId/facts", () => {
  it("creates manual fact as active/accepted");
  it("runs insertion contract — deduplicates same-meaning fact");
  it("runs insertion contract — returns 409 on conflict with active fact");
});

describe("PATCH /api/entities/:entityId/facts/:factId", () => {
  it("updates predicate and display text for accepted fact");
  it("re-embeds when display text changes");
  it("returns 409 for disputed fact");
  it("returns 409 for superseded fact");
});

describe("POST /api/entities/:entityId/facts/:factId/accept", () => {
  it("accepts pending fact when no conflict");
  it("returns 409 with conflict details when active fact conflicts");
  it("returns 409 when disputed fact exists for same predicate");
});

describe("POST /api/entities/:entityId/facts/:factId/reject", () => {
  it("sets review_state to rejected");
});

describe("POST /api/entities/:entityId/facts/:factId/resolve-conflict", () => {
  it("replace_existing_with_new: new active, old superseded");
  it("mark_old_as_past: old superseded with valid_at_end");
  it("mark_old_as_wrong: old rejected, new active");
  it("keep_both_disputed: no state change");
});

describe("GET /api/facts/pending", () => {
  it("returns cross-entity pending facts with entity name");
  it("supports cursor pagination");
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run app/src/__tests__/facts-routes.test.ts`
Expected: FAIL — route file doesn't exist.

**Step 3: Implement routes**

Create `app/src/routes/facts.ts`:

```typescript
import { Hono } from "hono";
import { query } from "../db.js";
import { generateEmbedding } from "../openrouter.js";
import { normalizePredicate, renderFactEmbeddingText } from "../facts.js";
import pgvector from "pgvector";

export const factsRouter = new Hono();

// GET /api/entities/:entityId/facts
factsRouter.get("/", async (c) => {
  const entityId = c.req.param("entityId");
  const status = c.req.query("status");
  const reviewState = c.req.query("review_state");

  let sql = `SELECT * FROM entity_facts WHERE entity_id = $1`;
  const params: unknown[] = [entityId];
  let paramIdx = 2;

  if (!reviewState) {
    sql += ` AND review_state != 'rejected'`;
  } else {
    sql += ` AND review_state = $${paramIdx}`;
    params.push(reviewState);
    paramIdx++;
  }

  if (status) {
    sql += ` AND status = $${paramIdx}`;
    params.push(status);
  }

  sql += ` ORDER BY
    CASE status
      WHEN 'active' THEN 0
      WHEN 'tentative' THEN 1
      WHEN 'disputed' THEN 2
      WHEN 'superseded' THEN 3
    END,
    updated_at DESC`;

  const result = await query(sql, params);
  return c.json({ facts: result.rows });
});

// GET /api/entities/:entityId/facts/:factId
factsRouter.get("/:factId", async (c) => {
  const factId = c.req.param("factId");
  const entityId = c.req.param("entityId");

  const factResult = await query(
    `SELECT * FROM entity_facts WHERE id = $1 AND entity_id = $2`,
    [factId, entityId],
  );
  if (factResult.rows.length === 0) return c.json({ error: "Fact not found" }, 404);

  const evidenceResult = await query(
    `SELECT efe.*, t.content as thought_content
     FROM entity_fact_evidence efe
     LEFT JOIN thoughts t ON t.id = efe.thought_id
     WHERE efe.fact_id = $1
     ORDER BY efe.created_at DESC`,
    [factId],
  );

  return c.json({ fact: factResult.rows[0], evidence: evidenceResult.rows });
});

// POST /api/entities/:entityId/facts — manual creation
factsRouter.post("/", async (c) => {
  const entityId = c.req.param("entityId");
  const body = await c.req.json<{
    predicate: string;
    value: string;
    display_text?: string;
    valid_at_start?: string;
    valid_at_end?: string;
  }>();

  if (!body.predicate || !body.value) {
    return c.json({ error: "predicate and value are required" }, 400);
  }

  const predicate = normalizePredicate(body.predicate);
  const displayText = body.display_text || body.value;
  const objectValueJson = { value: body.value };

  // Get entity canonical name for embedding
  const entityResult = await query<{ canonical_name: string }>(
    `SELECT canonical_name FROM entities WHERE id = $1`,
    [entityId],
  );
  if (entityResult.rows.length === 0) return c.json({ error: "Entity not found" }, 404);

  // Check for conflicts
  const existing = await query<{ id: string; predicate: string; object_display_text: string; status: string }>(
    `SELECT id, predicate, object_display_text, status FROM entity_facts
     WHERE entity_id = $1 AND lower(predicate) = lower($2) AND review_state != 'rejected'`,
    [entityId, predicate],
  );

  const activeConflict = existing.rows.find(
    (f) => f.object_display_text.toLowerCase() !== displayText.toLowerCase()
      && (f.status === "active" || f.status === "disputed"),
  );

  if (activeConflict) {
    return c.json({
      error: "Conflicts with existing fact",
      conflict_with: activeConflict,
    }, 409);
  }

  // Check for same-meaning (deduplicate)
  const sameMeaning = existing.rows.find(
    (f) => f.object_display_text.toLowerCase() === displayText.toLowerCase(),
  );

  if (sameMeaning) {
    return c.json({ fact: sameMeaning, deduplicated: true });
  }

  // Embed and insert
  const embeddingText = renderFactEmbeddingText(entityResult.rows[0].canonical_name, predicate, displayText);
  const embedding = await generateEmbedding(embeddingText);

  const result = await query(
    `INSERT INTO entity_facts (entity_id, predicate, object_value_json, object_display_text, status, review_state, confidence, source_kind, valid_at_start, valid_at_end, embedding)
     VALUES ($1, $2, $3, $4, 'active', 'accepted', 1.0, 'manual', $5, $6, $7)
     RETURNING *`,
    [entityId, predicate, JSON.stringify(objectValueJson), displayText, body.valid_at_start || null, body.valid_at_end || null, pgvector.toSql(embedding)],
  );

  // Create manual evidence row (no thought_id)
  await query(
    `INSERT INTO entity_fact_evidence (fact_id, excerpt, evidence_type)
     VALUES ($1, $2, 'manual')`,
    [result.rows[0].id, `Manual entry: ${predicate} = ${displayText}`],
  );

  return c.json({ fact: result.rows[0] }, 201);
});

// PATCH /api/entities/:entityId/facts/:factId
factsRouter.patch("/:factId", async (c) => {
  const factId = c.req.param("factId");
  const entityId = c.req.param("entityId");
  const body = await c.req.json<{
    predicate?: string;
    object_display_text?: string;
    valid_at_start?: string | null;
    valid_at_end?: string | null;
  }>();

  // Check fact exists and is editable
  const factResult = await query<{ id: string; status: string; review_state: string; predicate: string; object_display_text: string }>(
    `SELECT id, status, review_state, predicate, object_display_text FROM entity_facts WHERE id = $1 AND entity_id = $2`,
    [factId, entityId],
  );
  if (factResult.rows.length === 0) return c.json({ error: "Fact not found" }, 404);

  const fact = factResult.rows[0];
  if (fact.status === "disputed" || fact.status === "superseded") {
    return c.json({ error: `Cannot edit ${fact.status} fact. Use resolve-conflict endpoint.` }, 409);
  }

  // Build update
  const updates: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  let paramIdx = 1;

  const newPredicate = body.predicate ? normalizePredicate(body.predicate) : fact.predicate;
  const newDisplayText = body.object_display_text || fact.object_display_text;
  let needsReembed = false;

  if (body.predicate) {
    updates.push(`predicate = $${paramIdx}`);
    params.push(newPredicate);
    paramIdx++;
    needsReembed = true;
  }
  if (body.object_display_text) {
    updates.push(`object_display_text = $${paramIdx}`);
    params.push(newDisplayText);
    paramIdx++;
    updates.push(`object_value_json = $${paramIdx}`);
    params.push(JSON.stringify({ value: newDisplayText }));
    paramIdx++;
    needsReembed = true;
  }
  if (body.valid_at_start !== undefined) {
    updates.push(`valid_at_start = $${paramIdx}`);
    params.push(body.valid_at_start);
    paramIdx++;
  }
  if (body.valid_at_end !== undefined) {
    updates.push(`valid_at_end = $${paramIdx}`);
    params.push(body.valid_at_end);
    paramIdx++;
  }

  // Re-embed if predicate or display text changed
  if (needsReembed) {
    const entityResult = await query<{ canonical_name: string }>(
      `SELECT canonical_name FROM entities WHERE id = $1`, [entityId],
    );
    const embeddingText = renderFactEmbeddingText(entityResult.rows[0].canonical_name, newPredicate, newDisplayText);
    const embedding = await generateEmbedding(embeddingText);
    updates.push(`embedding = $${paramIdx}`);
    params.push(pgvector.toSql(embedding));
    paramIdx++;
  }

  params.push(factId);
  const result = await query(
    `UPDATE entity_facts SET ${updates.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
    params,
  );

  return c.json({ fact: result.rows[0] });
});

// POST /api/entities/:entityId/facts/:factId/accept
factsRouter.post("/:factId/accept", async (c) => {
  const factId = c.req.param("factId");
  const entityId = c.req.param("entityId");

  const factResult = await query<{ id: string; predicate: string; review_state: string }>(
    `SELECT id, predicate, review_state FROM entity_facts WHERE id = $1 AND entity_id = $2`,
    [factId, entityId],
  );
  if (factResult.rows.length === 0) return c.json({ error: "Fact not found" }, 404);
  if (factResult.rows[0].review_state !== "pending") {
    return c.json({ error: "Only pending facts can be accepted" }, 400);
  }

  // Check for conflicts (active OR disputed with same predicate)
  const conflicts = await query<{ id: string; predicate: string; object_display_text: string; status: string }>(
    `SELECT id, predicate, object_display_text, status FROM entity_facts
     WHERE entity_id = $1 AND lower(predicate) = lower($2) AND id != $3
       AND (status = 'active' OR status = 'disputed')
       AND review_state != 'rejected'`,
    [entityId, factResult.rows[0].predicate, factId],
  );

  if (conflicts.rows.length > 0) {
    return c.json({
      error: "Conflicts with existing fact",
      conflict_with: conflicts.rows[0],
    }, 409);
  }

  await query(
    `UPDATE entity_facts SET status = 'active', review_state = 'accepted', updated_at = now() WHERE id = $1`,
    [factId],
  );

  return c.json({ accepted: true });
});

// POST /api/entities/:entityId/facts/:factId/reject
factsRouter.post("/:factId/reject", async (c) => {
  const factId = c.req.param("factId");
  const entityId = c.req.param("entityId");

  const result = await query(
    `UPDATE entity_facts SET review_state = 'rejected', updated_at = now()
     WHERE id = $1 AND entity_id = $2 RETURNING id`,
    [factId, entityId],
  );

  if (result.rows.length === 0) return c.json({ error: "Fact not found" }, 404);
  return c.json({ rejected: true });
});

// POST /api/entities/:entityId/facts/:factId/resolve-conflict
factsRouter.post("/:factId/resolve-conflict", async (c) => {
  const factId = c.req.param("factId");
  const entityId = c.req.param("entityId");
  const body = await c.req.json<{
    action: "replace_existing_with_new" | "mark_old_as_past" | "mark_old_as_wrong" | "keep_both_disputed" | "cancel";
    note?: string;
  }>();

  if (!body.action) return c.json({ error: "action is required" }, 400);
  if (body.action === "cancel") return c.json({ cancelled: true });

  // Get the new fact and find the conflicting old fact
  const newFact = await query<{ id: string; predicate: string; entity_id: string }>(
    `SELECT id, predicate, entity_id FROM entity_facts WHERE id = $1 AND entity_id = $2`,
    [factId, entityId],
  );
  if (newFact.rows.length === 0) return c.json({ error: "Fact not found" }, 404);

  const oldFact = await query<{ id: string }>(
    `SELECT id FROM entity_facts
     WHERE entity_id = $1 AND lower(predicate) = lower($2) AND id != $3
       AND status = 'disputed' AND review_state != 'rejected'
     LIMIT 1`,
    [entityId, newFact.rows[0].predicate, factId],
  );

  if (oldFact.rows.length === 0 && body.action !== "keep_both_disputed") {
    return c.json({ error: "No conflicting fact found" }, 404);
  }

  const oldFactId = oldFact.rows[0]?.id;

  switch (body.action) {
    case "replace_existing_with_new":
    case "mark_old_as_past":
      // New → active/accepted, Old → superseded
      await query(
        `UPDATE entity_facts SET status = 'active', review_state = 'accepted', updated_at = now() WHERE id = $1`,
        [factId],
      );
      await query(
        `UPDATE entity_facts SET status = 'superseded', valid_at_end = now(), updated_at = now() WHERE id = $1`,
        [oldFactId],
      );
      break;

    case "mark_old_as_wrong":
      // New → active/accepted, Old → rejected
      await query(
        `UPDATE entity_facts SET status = 'active', review_state = 'accepted', updated_at = now() WHERE id = $1`,
        [factId],
      );
      await query(
        `UPDATE entity_facts SET review_state = 'rejected', updated_at = now() WHERE id = $1`,
        [oldFactId],
      );
      break;

    case "keep_both_disputed":
      // No state change
      break;
  }

  return c.json({ resolved: true, action: body.action });
});
```

**Step 4: Create the cross-entity pending facts route**

Create a separate router or add to existing. The simplest approach: add a standalone route in `app/src/routes/facts.ts` as a second export:

```typescript
export const pendingFactsRouter = new Hono();

// GET /api/facts/pending
pendingFactsRouter.get("/", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);
  const cursor = c.req.query("cursor");

  let sql = `SELECT ef.*, e.canonical_name as entity_name
     FROM entity_facts ef
     JOIN entities e ON e.id = ef.entity_id
     WHERE ef.review_state = 'pending'`;
  const params: unknown[] = [];

  if (cursor) {
    sql += ` AND ef.created_at < $${params.length + 1}`;
    params.push(cursor);
  }

  sql += ` ORDER BY ef.created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit + 1);

  const result = await query(sql, params);
  const hasMore = result.rows.length > limit;
  const facts = hasMore ? result.rows.slice(0, limit) : result.rows;
  const nextCursor = hasMore ? facts[facts.length - 1].created_at : null;

  return c.json({ facts, next_cursor: nextCursor });
});
```

**Step 5: Mount routes in app.ts**

In `app/src/app.ts`, add the imports and mount:

```typescript
import { factsRouter, pendingFactsRouter } from "./routes/facts.js";

// Inside the api router setup (around line 40-56):
api.route("/facts", pendingFactsRouter); // must be before the parameterized entity route
// The entity-scoped facts route needs to be mounted as a sub-route of entities:
```

For the entity-scoped facts, mount inside the entities router. In `app/src/routes/entities.ts`, import and mount:

```typescript
import { factsRouter } from "./facts.js";

// At the end of the entities router:
entitiesRouter.route("/:entityId/facts", factsRouter);
```

Note: Hono handles path params correctly through nested routers. The `entityId` param will be available via `c.req.param("entityId")` in the facts router because Hono propagates parent route params.

Verify this by checking that `c.req.param("entityId")` works in a quick test. If Hono doesn't propagate params through `.route()` nesting, use `c.req.param("entityId")` from the parent or pass it explicitly. Check the Hono docs.

**Step 6: Run tests**

Run: `npx vitest run app/src/__tests__/facts-routes.test.ts`
Expected: All tests pass.

**Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. No regressions.

**Step 8: Commit**

```bash
git add app/src/routes/facts.ts app/src/routes/entities.ts app/src/app.ts app/src/__tests__/facts-routes.test.ts
git commit -m "feat: add fact CRUD routes with accept/reject/resolve-conflict"
```

---

## Phase 6: Merge Extension

### Task 8: Extend entity merge to unify facts [DONE]

**Files:**
- Modify: `app/src/routes/entities.ts:173-246` (merge endpoint)
- Test: `app/src/__tests__/entities.test.ts`

**Step 1: Write failing tests for fact unification during merge**

Add to `app/src/__tests__/entities.test.ts`:

```typescript
describe("POST /api/entities/merge — fact unification", () => {
  it("moves facts from source to target entity");
  it("deduplicates same-meaning facts and merges evidence");
  it("keeps stronger status on deduplicated facts (active > tentative > disputed > superseded)");
  it("does not collapse similar-but-not-identical facts");
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run app/src/__tests__/entities.test.ts`
Expected: FAIL — merge doesn't touch facts yet.

**Step 3: Implement fact unification in merge**

After the existing mention reassignment in the merge endpoint (around line 216), add:

```typescript
// Status precedence for fact unification
// Reference: docs/plans/2026-03-17-entity-facts-design.md — Merge Contract
const STATUS_PRECEDENCE: Record<string, number> = {
  active: 0,
  tentative: 1,
  disputed: 2,
  superseded: 3,
};

// Get facts from both entities
const [sourceFacts, targetFacts] = await Promise.all([
  query(`SELECT * FROM entity_facts WHERE entity_id = $1 AND review_state != 'rejected'`, [body.source_id]),
  query(`SELECT * FROM entity_facts WHERE entity_id = $1 AND review_state != 'rejected'`, [body.target_id]),
]);

// For each source fact, check if target has a same-meaning fact
for (const sourceFact of sourceFacts.rows) {
  const targetMatch = targetFacts.rows.find(
    (tf: any) =>
      normalizePredicate(tf.predicate) === normalizePredicate(sourceFact.predicate) &&
      tf.object_display_text.trim().toLowerCase() === sourceFact.object_display_text.trim().toLowerCase(),
  );

  if (targetMatch) {
    // Same-meaning: merge evidence onto target fact, keep stronger status
    await query(
      `UPDATE entity_fact_evidence SET fact_id = $1 WHERE fact_id = $2`,
      [targetMatch.id, sourceFact.id],
    );

    const keepStatus = (STATUS_PRECEDENCE[targetMatch.status] ?? 3) <= (STATUS_PRECEDENCE[sourceFact.status] ?? 3)
      ? targetMatch.status
      : sourceFact.status;

    if (keepStatus !== targetMatch.status) {
      await query(
        `UPDATE entity_facts SET status = $1, updated_at = now() WHERE id = $2`,
        [keepStatus, targetMatch.id],
      );
    }

    // Delete the source fact (evidence already moved)
    await query(`DELETE FROM entity_facts WHERE id = $1`, [sourceFact.id]);
  } else {
    // Different fact: move to target entity
    await query(
      `UPDATE entity_facts SET entity_id = $1, updated_at = now() WHERE id = $2`,
      [body.target_id, sourceFact.id],
    );
  }
}
```

Import `normalizePredicate` from `../facts.js` at top of file.

**Step 4: Run tests**

Run: `npx vitest run app/src/__tests__/entities.test.ts`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add app/src/routes/entities.ts app/src/__tests__/entities.test.ts
git commit -m "feat: extend entity merge to unify facts and evidence"
```

---

## Phase 7: MCP Tools

### Task 9: Add fact-related MCP tools [DONE]

**Files:**
- Modify: `app/src/mcp.ts`
- Test: `app/src/__tests__/mcp.test.ts`

**Step 1: Write failing tests**

Add to `app/src/__tests__/mcp.test.ts`:

```typescript
describe("list_entity_facts", () => {
  it("lists facts for an entity by name");
  it("filters by review_state when provided");
  it("respects limit parameter");
});

describe("add_entity_fact", () => {
  it("adds manual fact as active/accepted with source_kind=manual");
  it("adds agent fact as tentative/pending with source_kind=agent");
  it("returns disambiguation when multiple entities match");
  it("returns conflict details when conflicting fact exists");
});

describe("review_entity_fact", () => {
  it("accepts a pending fact");
  it("rejects a pending fact");
  it("returns conflict details on accept when conflict exists");
});

describe("resolve_fact_conflict", () => {
  it("replaces existing with new");
  it("marks old as past");
  it("marks old as wrong");
  it("keeps both disputed");
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run app/src/__tests__/mcp.test.ts`
Expected: FAIL — tools don't exist.

**Step 3: Implement MCP tools**

Add to `app/src/mcp.ts` after the existing `list_entity_mentions` tool (line ~433):

```typescript
// list_entity_facts
server.tool(
  "list_entity_facts",
  "List memory facts about an entity. Facts are structured claims like 'from Porto' or 'works at Anthropic'.",
  {
    entity_name: z.string().optional().describe("Entity name to look up (checks canonical name and aliases)"),
    entity_id: z.string().optional().describe("Entity UUID (alternative to entity_name)"),
    status: z.enum(["active", "tentative", "disputed", "superseded"]).optional().describe("Filter by fact status"),
    review_state: z.enum(["pending", "accepted", "rejected"]).optional().describe("Filter by review state"),
    include_evidence: z.boolean().optional().default(false).describe("Include supporting evidence for each fact"),
    limit: z.number().optional().default(20).describe("Maximum facts to return"),
  },
  async ({ entity_name, entity_id, status, review_state, include_evidence, limit }) => {
    // Resolve entity
    let resolvedId = entity_id;
    if (!resolvedId && entity_name) {
      const entityResult = await query(
        `SELECT id FROM entities WHERE (lower(canonical_name) = lower($1) OR $1 ILIKE ANY(aliases)) LIMIT 1`,
        [entity_name],
      );
      if (entityResult.rows.length === 0) {
        return { content: [{ type: "text", text: `No entity found matching "${entity_name}"` }] };
      }
      resolvedId = entityResult.rows[0].id;
    }
    if (!resolvedId) {
      return { content: [{ type: "text", text: "Provide entity_name or entity_id" }] };
    }

    let sql = `SELECT * FROM entity_facts WHERE entity_id = $1`;
    const params: unknown[] = [resolvedId];
    let idx = 2;

    if (review_state) {
      sql += ` AND review_state = $${idx}`;
      params.push(review_state);
      idx++;
    } else {
      sql += ` AND review_state != 'rejected'`;
    }

    if (status) {
      sql += ` AND status = $${idx}`;
      params.push(status);
      idx++;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
    params.push(limit);

    const facts = await query(sql, params);

    let result = facts.rows;

    if (include_evidence && result.length > 0) {
      const factIds = result.map((f: any) => f.id);
      const evidence = await query(
        `SELECT * FROM entity_fact_evidence WHERE fact_id = ANY($1) ORDER BY created_at DESC`,
        [factIds],
      );
      const evidenceMap = new Map<string, any[]>();
      for (const e of evidence.rows) {
        const arr = evidenceMap.get(e.fact_id) || [];
        arr.push(e);
        evidenceMap.set(e.fact_id, arr);
      }
      result = result.map((f: any) => ({ ...f, evidence: evidenceMap.get(f.id) || [] }));
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// add_entity_fact
server.tool(
  "add_entity_fact",
  "Add a fact about an entity. Example: 'Maya Patel works at Anthropic'. Use source_kind='manual' for user-confirmed facts, 'agent' for AI-derived.",
  {
    entity_name: z.string().describe("Entity name"),
    predicate: z.string().describe("The relationship/attribute (e.g. 'from', 'works_at', 'born_on')"),
    value: z.string().describe("The fact value"),
    display_text: z.string().optional().describe("Human-readable display text (defaults to value)"),
    source_kind: z.enum(["manual", "agent"]).optional().default("agent").describe("'manual' for user-confirmed, 'agent' for AI-derived"),
    confidence: z.number().optional().describe("Confidence 0.0-1.0"),
    note: z.string().optional().describe("Optional context note"),
  },
  async ({ entity_name, predicate, value, display_text, source_kind, confidence, note }) => {
    // Resolve entity with disambiguation
    const entityResult = await query(
      `SELECT id, canonical_name FROM entities WHERE (lower(canonical_name) = lower($1) OR $1 ILIKE ANY(aliases)) AND entity_type = 'person'`,
      [entity_name],
    );

    if (entityResult.rows.length === 0) {
      return { content: [{ type: "text", text: `No entity found matching "${entity_name}"` }] };
    }

    if (entityResult.rows.length > 1) {
      const names = entityResult.rows.map((r: any) => `- ${r.canonical_name} (${r.id})`).join("\n");
      return {
        content: [{
          type: "text",
          text: `Multiple entities match "${entity_name}". Please specify:\n${names}\n\nUse the exact canonical name or provide entity_id via list_entity_facts.`,
        }],
      };
    }

    const entity = entityResult.rows[0];
    const normalizedPredicate = normalizePredicate(predicate);
    const displayText = display_text || value;
    const isManual = source_kind === "manual";

    // Check for conflicts
    const existing = await query(
      `SELECT id, predicate, object_display_text, status FROM entity_facts
       WHERE entity_id = $1 AND lower(predicate) = lower($2) AND review_state != 'rejected'`,
      [entity.id, normalizedPredicate],
    );

    const sameMeaning = existing.rows.find(
      (f: any) => f.object_display_text.trim().toLowerCase() === displayText.trim().toLowerCase(),
    );

    if (sameMeaning) {
      return {
        content: [{
          type: "text",
          text: `This fact already exists: ${entity.canonical_name} — ${normalizedPredicate} — ${sameMeaning.object_display_text} (status: ${sameMeaning.status})`,
        }],
      };
    }

    const conflict = existing.rows.find(
      (f: any) => f.status === "active" || f.status === "disputed",
    );

    if (conflict) {
      return {
        content: [{
          type: "text",
          text: `Conflict: existing fact "${entity.canonical_name} — ${conflict.predicate} — ${conflict.object_display_text}" (${conflict.status}). Use review_entity_fact or resolve_fact_conflict to handle this.`,
        }],
      };
    }

    // Embed and insert
    const embeddingText = renderFactEmbeddingText(entity.canonical_name, normalizedPredicate, displayText);
    const embedding = await generateEmbedding(embeddingText);

    const status = isManual ? "active" : "tentative";
    const reviewState = isManual ? "accepted" : "pending";

    const result = await query(
      `INSERT INTO entity_facts (entity_id, predicate, object_value_json, object_display_text, status, review_state, confidence, source_kind, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [entity.id, normalizedPredicate, JSON.stringify({ value }), displayText, status, reviewState, confidence || (isManual ? 1.0 : 0.8), source_kind, pgvector.toSql(embedding)],
    );

    // Add evidence if note provided
    if (note) {
      await query(
        `INSERT INTO entity_fact_evidence (fact_id, excerpt, evidence_type)
         VALUES ($1, $2, $3)`,
        [result.rows[0].id, note, isManual ? "manual" : "extraction"],
      );
    }

    return {
      content: [{
        type: "text",
        text: `Added fact: ${entity.canonical_name} — ${normalizedPredicate} — ${displayText} (${status}/${reviewState})`,
      }],
    };
  },
);

// review_entity_fact
server.tool(
  "review_entity_fact",
  "Accept or reject a pending fact suggestion.",
  {
    fact_id: z.string().describe("The fact UUID to review"),
    action: z.enum(["accept", "reject"]).describe("Accept or reject the fact"),
    note: z.string().optional().describe("Optional note for audit trail"),
  },
  async ({ fact_id, action, note }) => {
    const fact = await query(
      `SELECT ef.*, e.canonical_name FROM entity_facts ef JOIN entities e ON e.id = ef.entity_id WHERE ef.id = $1`,
      [fact_id],
    );
    if (fact.rows.length === 0) {
      return { content: [{ type: "text", text: "Fact not found" }] };
    }

    const f = fact.rows[0];
    if (f.review_state !== "pending") {
      return { content: [{ type: "text", text: `Fact is already ${f.review_state}, not pending` }] };
    }

    if (action === "reject") {
      await query(`UPDATE entity_facts SET review_state = 'rejected', updated_at = now() WHERE id = $1`, [fact_id]);
      return { content: [{ type: "text", text: `Rejected: ${f.canonical_name} — ${f.predicate} — ${f.object_display_text}` }] };
    }

    // Accept: check for conflicts
    const conflicts = await query(
      `SELECT id, predicate, object_display_text, status FROM entity_facts
       WHERE entity_id = $1 AND lower(predicate) = lower($2) AND id != $3
         AND (status = 'active' OR status = 'disputed') AND review_state != 'rejected'`,
      [f.entity_id, f.predicate, fact_id],
    );

    if (conflicts.rows.length > 0) {
      const c = conflicts.rows[0];
      return {
        content: [{
          type: "text",
          text: `Cannot accept — conflicts with existing fact: "${f.canonical_name} — ${c.predicate} — ${c.object_display_text}" (${c.status}). Use resolve_fact_conflict with fact_id="${fact_id}" to resolve.`,
        }],
      };
    }

    await query(`UPDATE entity_facts SET status = 'active', review_state = 'accepted', updated_at = now() WHERE id = $1`, [fact_id]);
    return { content: [{ type: "text", text: `Accepted: ${f.canonical_name} — ${f.predicate} — ${f.object_display_text}` }] };
  },
);

// resolve_fact_conflict
server.tool(
  "resolve_fact_conflict",
  "Resolve a disputed fact conflict. Actions: 'replace_existing_with_new' (existing was true, now outdated), 'mark_old_as_past' (same), 'mark_old_as_wrong' (existing was incorrect), 'keep_both_disputed' (no change).",
  {
    fact_id: z.string().describe("The new/incoming fact UUID"),
    action: z.enum(["replace_existing_with_new", "mark_old_as_past", "mark_old_as_wrong", "keep_both_disputed"]).describe("How to resolve"),
    note: z.string().optional().describe("Optional note for audit trail"),
  },
  async ({ fact_id, action, note }) => {
    const newFact = await query(
      `SELECT ef.*, e.canonical_name FROM entity_facts ef JOIN entities e ON e.id = ef.entity_id WHERE ef.id = $1`,
      [fact_id],
    );
    if (newFact.rows.length === 0) {
      return { content: [{ type: "text", text: "Fact not found" }] };
    }

    const f = newFact.rows[0];

    if (action === "keep_both_disputed") {
      return { content: [{ type: "text", text: `Kept both facts as disputed for "${f.canonical_name} — ${f.predicate}"` }] };
    }

    const oldFact = await query(
      `SELECT id, object_display_text FROM entity_facts
       WHERE entity_id = $1 AND lower(predicate) = lower($2) AND id != $3
         AND status = 'disputed' AND review_state != 'rejected'
       LIMIT 1`,
      [f.entity_id, f.predicate, fact_id],
    );

    if (oldFact.rows.length === 0) {
      return { content: [{ type: "text", text: "No conflicting fact found to resolve against" }] };
    }

    const old = oldFact.rows[0];

    switch (action) {
      case "replace_existing_with_new":
      case "mark_old_as_past":
        await query(`UPDATE entity_facts SET status = 'active', review_state = 'accepted', updated_at = now() WHERE id = $1`, [fact_id]);
        await query(`UPDATE entity_facts SET status = 'superseded', valid_at_end = now(), updated_at = now() WHERE id = $1`, [old.id]);
        return { content: [{ type: "text", text: `Resolved: "${f.object_display_text}" is now active, "${old.object_display_text}" superseded` }] };

      case "mark_old_as_wrong":
        await query(`UPDATE entity_facts SET status = 'active', review_state = 'accepted', updated_at = now() WHERE id = $1`, [fact_id]);
        await query(`UPDATE entity_facts SET review_state = 'rejected', updated_at = now() WHERE id = $1`, [old.id]);
        return { content: [{ type: "text", text: `Resolved: "${f.object_display_text}" is now active, "${old.object_display_text}" rejected` }] };
    }
  },
);
```

Import `normalizePredicate` and `renderFactEmbeddingText` from `./facts.js` at top of `mcp.ts`.

**Step 4: Run tests**

Run: `npx vitest run app/src/__tests__/mcp.test.ts`
Expected: All tests pass.

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add app/src/mcp.ts app/src/__tests__/mcp.test.ts
git commit -m "feat: add MCP tools for entity facts (list, add, review, resolve)"
```

---

## Phase 8: Entity Chat Grounding

### Task 10: Implement entity-grounded chat [DONE]

**Files:**
- Modify: `app/src/routes/chat.ts`
- Create: `app/src/entity-chat.ts`
- Test: `app/src/__tests__/entity-chat.test.ts`

**Step 1: Write failing tests**

Create `app/src/__tests__/entity-chat.test.ts`:

```typescript
describe("buildEntityGroundingContext", () => {
  it("includes entity identity (name, aliases, type)");
  it("retrieves facts by embedding similarity to query");
  it("always includes disputed facts regardless of match score");
  it("caps total facts at configured limit");
  it("loads evidence for selected facts only");
  it("retrieves recent entity-filtered thoughts");
  it("returns error when entity does not exist");
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run app/src/__tests__/entity-chat.test.ts`
Expected: FAIL.

**Step 3: Implement entity chat grounding**

Create `app/src/entity-chat.ts`:

```typescript
import { query } from "./db.js";
import { generateEmbedding } from "./openrouter.js";
import pgvector from "pgvector";

interface EntityIdentity {
  id: string;
  canonical_name: string;
  entity_type: string;
  aliases: string[];
}

interface GroundingFact {
  id: string;
  predicate: string;
  object_display_text: string;
  status: string;
  confidence: number | null;
  valid_at_start: string | null;
  valid_at_end: string | null;
  evidence: Array<{ excerpt: string | null; evidence_type: string }>;
}

interface GroundingThought {
  id: string;
  content: string;
  created_at: string;
  similarity: number;
}

export interface EntityGroundingContext {
  entity: EntityIdentity;
  facts: GroundingFact[];
  thoughts: GroundingThought[];
}

const FACT_LIMIT = 12;
const THOUGHT_LIMIT = 5;

export async function buildEntityGroundingContext(
  entityId: string,
  userQuery: string,
): Promise<EntityGroundingContext> {
  // 1. Entity identity
  const entityResult = await query<EntityIdentity>(
    `SELECT id, canonical_name, entity_type, aliases FROM entities WHERE id = $1`,
    [entityId],
  );
  if (entityResult.rows.length === 0) {
    throw new Error("Entity not found");
  }
  const entity = entityResult.rows[0];

  // 2. Embed user query for fact matching
  const queryEmbedding = await generateEmbedding(userQuery);
  const embeddingSql = pgvector.toSql(queryEmbedding);

  // 2a. Always include disputed facts
  const disputedFacts = await query(
    `SELECT id, predicate, object_display_text, status, confidence, valid_at_start, valid_at_end
     FROM entity_facts
     WHERE entity_id = $1 AND status = 'disputed' AND review_state != 'rejected'`,
    [entityId],
  );

  // 2b. Retrieve remaining facts by embedding similarity
  const disputedIds = disputedFacts.rows.map((f: any) => f.id);
  const remainingSlots = FACT_LIMIT - disputedFacts.rows.length;

  let semanticFacts: any[] = [];
  if (remainingSlots > 0) {
    const result = await query(
      `SELECT id, predicate, object_display_text, status, confidence, valid_at_start, valid_at_end,
              1 - (embedding <=> $1) as similarity
       FROM entity_facts
       WHERE entity_id = $2 AND review_state != 'rejected'
         AND embedding IS NOT NULL
         ${disputedIds.length > 0 ? `AND id != ALL($4)` : ""}
       ORDER BY embedding <=> $1
       LIMIT $3`,
      disputedIds.length > 0
        ? [embeddingSql, entityId, remainingSlots, disputedIds]
        : [embeddingSql, entityId, remainingSlots],
    );
    semanticFacts = result.rows;
  }

  const allFacts = [...disputedFacts.rows, ...semanticFacts];

  // 3. Load evidence for selected facts
  const factIds = allFacts.map((f: any) => f.id);
  let evidenceMap = new Map<string, any[]>();

  if (factIds.length > 0) {
    const evidenceResult = await query(
      `SELECT fact_id, excerpt, evidence_type FROM entity_fact_evidence
       WHERE fact_id = ANY($1) ORDER BY created_at DESC`,
      [factIds],
    );
    for (const e of evidenceResult.rows) {
      const arr = evidenceMap.get(e.fact_id) || [];
      // Limit evidence per fact: 2 normally, 1 per side for disputed
      if (arr.length < 2) arr.push(e);
      evidenceMap.set(e.fact_id, arr);
    }
  }

  const groundingFacts: GroundingFact[] = allFacts.map((f: any) => ({
    ...f,
    evidence: evidenceMap.get(f.id) || [],
  }));

  // 4. Recent entity-filtered thoughts
  const thoughtResult = await query(
    `SELECT t.id, t.content, t.created_at,
            1 - (t.embedding <=> $1) as similarity
     FROM thoughts t
     JOIN entity_mentions em ON em.thought_id = t.id
     WHERE em.entity_id = $2 AND t.deleted_at IS NULL AND t.embedding IS NOT NULL
     ORDER BY t.embedding <=> $1
     LIMIT $3`,
    [embeddingSql, entityId, THOUGHT_LIMIT],
  );

  return {
    entity,
    facts: groundingFacts,
    thoughts: thoughtResult.rows,
  };
}

export function formatEntityGroundingPrompt(ctx: EntityGroundingContext): string {
  const parts: string[] = [];

  // Entity identity
  parts.push(`Entity: ${ctx.entity.canonical_name} (${ctx.entity.entity_type})`);
  if (ctx.entity.aliases.length > 0) {
    parts.push(`Also known as: ${ctx.entity.aliases.join(", ")}`);
  }

  // Facts
  if (ctx.facts.length > 0) {
    parts.push("\n--- Facts ---");
    for (const fact of ctx.facts) {
      let line = `[${fact.status}] ${fact.predicate}: ${fact.object_display_text}`;
      if (fact.valid_at_end) line += ` (until ${fact.valid_at_end})`;
      if (fact.confidence && fact.confidence < 0.9) line += ` (confidence: ${(fact.confidence * 100).toFixed(0)}%)`;
      parts.push(line);

      for (const e of fact.evidence) {
        if (e.excerpt) parts.push(`  Evidence: ${e.excerpt}`);
      }
    }
  }

  // Thoughts
  if (ctx.thoughts.length > 0) {
    parts.push("\n--- Recent Mentions ---");
    for (const t of ctx.thoughts) {
      const date = new Date(t.created_at).toISOString().split("T")[0];
      parts.push(`[${date}] ${t.content.slice(0, 500)}`);
    }
  }

  return parts.join("\n");
}
```

**Step 4: Modify chat route to support entity_id**

In `app/src/routes/chat.ts`, add the entity-grounded branch:

```typescript
import { buildEntityGroundingContext, formatEntityGroundingPrompt } from "../entity-chat.js";

const ENTITY_SYSTEM_PROMPT = `You are answering a question about a specific entity from the user's personal knowledge base "Open Brain". Use only the provided facts, evidence, and thoughts. Apply these rules:

- Active facts: state directly ("Maya is from Porto")
- Tentative facts: hedge ("Maya may have been born on May 12, 1991")
- Disputed facts: present as unresolved conflict ("Maya's current city is unclear — one note supports Seattle, a newer note suggests Portland")
- Superseded facts: frame as past ("Maya previously lived in Seattle")
- Thoughts without a corresponding fact: frame as unconfirmed ("A recent note suggests she may be considering a move, but this has not been confirmed")
- If no fact or thought exists for what the user asked about: say so directly. Do not speculate.

Use markdown formatting for readability.`;

chatRouter.post("/", async (c) => {
  const body = await c.req.json<{
    messages?: Array<{ role: "user" | "assistant"; content: string }>;
    entity_id?: string;
  }>();

  // ... existing validation ...

  let systemPrompt: string;
  let sources: any[];

  if (body.entity_id) {
    // Entity-grounded path
    const entity = await query(`SELECT id FROM entities WHERE id = $1`, [body.entity_id]);
    if (entity.rows.length === 0) {
      return c.json({ error: "Entity not found" }, 404);
    }

    const groundingContext = await buildEntityGroundingContext(body.entity_id, lastUserMsg!.content);
    const contextBlock = formatEntityGroundingPrompt(groundingContext);
    systemPrompt = `${ENTITY_SYSTEM_PROMPT}\n\n${contextBlock}`;

    sources = groundingContext.thoughts.map((t) => ({
      id: t.id,
      content: t.content.slice(0, 200),
      similarity: t.similarity,
    }));
  } else {
    // Existing generic RAG path (unchanged)
    const ragContext = await retrieveContext(body.messages!);
    const contextBlock = formatContext(ragContext.thoughts);
    systemPrompt = `${SYSTEM_PROMPT}\n\n--- Retrieved Thoughts ---\n${contextBlock}\n--- End of Retrieved Thoughts ---`;

    sources = ragContext.thoughts.map((t) => ({
      id: t.id,
      content: t.content.slice(0, 200),
      similarity: t.similarity,
    }));
  }

  // ... rest of streaming code uses systemPrompt and sources ...
});
```

**Step 5: Run tests**

Run: `npx vitest run app/src/__tests__/entity-chat.test.ts`
Expected: All tests pass.

**Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add app/src/entity-chat.ts app/src/routes/chat.ts app/src/__tests__/entity-chat.test.ts
git commit -m "feat: add entity-grounded chat with fact/evidence retrieval"
```

---

## Phase 9: Frontend — API Client & State

### Task 11: Extend frontend API client

**Files:**
- Modify: `web/src/api.ts`

**Step 1: Add Fact interfaces and API methods**

Add to `web/src/api.ts` after the Entity interface (around line 89):

```typescript
export interface EntityFact {
  id: string;
  entity_id: string;
  predicate: string;
  object_value_json: unknown;
  object_display_text: string;
  status: "active" | "tentative" | "disputed" | "superseded";
  review_state: "pending" | "accepted" | "rejected";
  confidence: number | null;
  source_kind: string;
  valid_at_start: string | null;
  valid_at_end: string | null;
  created_at: string;
  updated_at: string;
}

export interface FactEvidence {
  id: string;
  fact_id: string;
  thought_id: string | null;
  excerpt: string | null;
  evidence_type: string;
  created_at: string;
  thought_content?: string;
}

export interface FactWithEvidence extends EntityFact {
  evidence: FactEvidence[];
}

export interface PendingFact extends EntityFact {
  entity_name: string;
}
```

Add API methods to the `api` object:

```typescript
entityFacts: async (entityId: string, filters?: { status?: string; review_state?: string }) => {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.review_state) params.set("review_state", filters.review_state);
  const qs = params.toString();
  const res = await fetch(`${base}/api/entities/${entityId}/facts${qs ? `?${qs}` : ""}`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to fetch facts");
  return res.json() as Promise<{ facts: EntityFact[] }>;
},

entityFactDetail: async (entityId: string, factId: string) => {
  const res = await fetch(`${base}/api/entities/${entityId}/facts/${factId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to fetch fact detail");
  return res.json() as Promise<{ fact: EntityFact; evidence: FactEvidence[] }>;
},

createFact: async (entityId: string, data: { predicate: string; value: string; display_text?: string; valid_at_start?: string; valid_at_end?: string }) => {
  const res = await fetch(`${base}/api/entities/${entityId}/facts`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (res.status === 409) {
    const body = await res.json();
    const err = new Error("Conflict") as Error & { conflict: typeof body };
    err.conflict = body;
    throw err;
  }
  if (!res.ok) throw new Error("Failed to create fact");
  return res.json();
},

acceptFact: async (entityId: string, factId: string) => {
  const res = await fetch(`${base}/api/entities/${entityId}/facts/${factId}/accept`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (res.status === 409) {
    const body = await res.json();
    const err = new Error("Conflict") as Error & { conflict: typeof body };
    err.conflict = body;
    throw err;
  }
  if (!res.ok) throw new Error("Failed to accept fact");
  return res.json();
},

rejectFact: async (entityId: string, factId: string) => {
  const res = await fetch(`${base}/api/entities/${entityId}/facts/${factId}/reject`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to reject fact");
  return res.json();
},

updateFact: async (entityId: string, factId: string, data: { predicate?: string; object_display_text?: string; valid_at_start?: string | null; valid_at_end?: string | null }) => {
  const res = await fetch(`${base}/api/entities/${entityId}/facts/${factId}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update fact");
  return res.json();
},

resolveConflict: async (entityId: string, factId: string, action: string, note?: string) => {
  const res = await fetch(`${base}/api/entities/${entityId}/facts/${factId}/resolve-conflict`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ action, note }),
  });
  if (!res.ok) throw new Error("Failed to resolve conflict");
  return res.json();
},

pendingFacts: async (cursor?: string, limit?: number) => {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  const res = await fetch(`${base}/api/facts/pending${qs ? `?${qs}` : ""}`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to fetch pending facts");
  return res.json() as Promise<{ facts: PendingFact[]; next_cursor: string | null }>;
},
```

**Step 2: Commit**

```bash
git add web/src/api.ts
git commit -m "feat: extend API client with fact CRUD methods"
```

---

## Phase 10: Frontend — Fact Components

### Task 12: Build FactCard component

**Files:**
- Create: `web/src/components/FactCard.tsx`

**Step 1: Implement FactCard**

Build the component with:
- Status badge (active: green, tentative: amber, disputed: red/warning, superseded: gray)
- Predicate label and display text
- Confidence indicator for tentative facts
- Expand/collapse for evidence list
- Action buttons in expanded state: Edit (if editable), Mark as past, Mark as wrong
- Evidence items show excerpt and link to source thought

Follow existing component patterns from `ThoughtCard.tsx` and `PersonCard.tsx` for styling (Tailwind classes, dark mode via CSS custom properties).

**Step 2: Commit**

```bash
git add web/src/components/FactCard.tsx
git commit -m "feat: add FactCard component with status badges and evidence"
```

### Task 13: Build FactSection component

**Files:**
- Create: `web/src/components/FactSection.tsx`

**Step 1: Implement FactSection**

Build with:
- Skeleton loading state (reserve space to avoid layout shift)
- Facts grouped by predicate, sorted by status weight
- "Add fact" button → inline form (predicate, value, optional dates)
- Creates manual facts via `api.createFact()`
- Handles 409 conflict response from creation

**Step 2: Commit**

```bash
git add web/src/components/FactSection.tsx
git commit -m "feat: add FactSection with loading skeleton and manual entry"
```

### Task 14: Build SuggestionTray component

**Files:**
- Create: `web/src/components/SuggestionTray.tsx`

**Step 1: Implement SuggestionTray**

Build with:
- Collapsible area showing pending facts for an entity
- Each suggestion: predicate, value, confidence, excerpt preview
- Accept button → calls `api.acceptFact()`, handles 409 → transitions to ConflictCard
- Reject button → calls `api.rejectFact()`, animate out
- Edit-before-accept: inline field editing, then accept with modified values
- Hidden when no pending suggestions

**Step 2: Commit**

```bash
git add web/src/components/SuggestionTray.tsx
git commit -m "feat: add SuggestionTray for pending fact review"
```

### Task 15: Build ConflictCard component

**Files:**
- Create: `web/src/components/ConflictCard.tsx`

**Step 1: Implement ConflictCard**

Build with:
- Inline conflict resolution (not modal)
- Side by side (stacked on mobile) fact comparison
- Each side: value, evidence excerpts, timestamps
- Actions:
  - "Accept new, mark old as past" → `mark_old_as_past`
  - "Accept new, mark old as wrong" → `mark_old_as_wrong`
  - "Keep both as uncertain" → `keep_both_disputed`
  - "Keep existing, reject new" → reject new fact
  - "Cancel" → dismiss

**Step 2: Commit**

```bash
git add web/src/components/ConflictCard.tsx
git commit -m "feat: add ConflictCard for inline conflict resolution"
```

---

## Phase 11: Frontend — Integration

### Task 16: Integrate facts into EntityDetailPanel

**Files:**
- Modify: `web/src/components/EntityDetailPanel.tsx`

**Step 1: Add FactSection and SuggestionTray between header and thoughts**

In `EntityDetailPanel.tsx`, after the aliases section (around line 275) and before the thoughts section (around line 278):

```tsx
<FactSection entityId={entity.id} />
<SuggestionTray entityId={entity.id} onConflict={handleConflict} />
```

Add state for facts loading and conflict handling. When a conflict is triggered from SuggestionTray, render ConflictCard inline.

Fetch facts when entity loads (parallel with thoughts):

```typescript
const [facts, setFacts] = useState<EntityFact[]>([]);
const [factsLoading, setFactsLoading] = useState(true);

// In the load effect, add to Promise.all:
api.entityFacts(id).then(r => { setFacts(r.facts); setFactsLoading(false); })
```

**Step 2: Commit**

```bash
git add web/src/components/EntityDetailPanel.tsx
git commit -m "feat: integrate fact section and suggestion tray into entity detail"
```

### Task 17: Add pending suggestion badges

**Files:**
- Modify: `web/src/views/PeopleView.tsx`

**Step 1: Fetch pending counts and display badges**

Modify PeopleView to:
- After loading entities, fetch pending counts per entity (use `/api/entities/:id/facts?review_state=pending` or batch)
- Show badge on entity cards with pending count
- Add global pending count to the People nav item

For the entity card badge, modify the `EntityCard` component in `PeopleView.tsx`:

```tsx
{pendingCount > 0 && (
  <span class="bg-amber-500 text-white text-xs rounded-full px-1.5 py-0.5 ml-2">
    {pendingCount}
  </span>
)}
```

For the nav badge, the simplest approach: fetch `/api/facts/pending?limit=1` and check if results exist. Pass count up via a callback or global signal.

**Step 2: Commit**

```bash
git add web/src/views/PeopleView.tsx
git commit -m "feat: add pending suggestion badges to entity cards and nav"
```

### Task 18: Wire entity chat to pass entity_id

**Files:**
- Modify: `web/src/views/ChatView.tsx`

**Step 1: Add entity_id to chat requests when entity context exists**

If the chat view is accessed from an entity page or has entity context, include `entity_id` in the POST body:

```typescript
const chatBody: any = { messages };
if (entityId) chatBody.entity_id = entityId;
```

The exact UX for triggering entity-scoped chat depends on how the ChatView is navigated to from EntityDetailPanel. Options:
- Add a "Chat about this entity" button in EntityDetailPanel that navigates to `/chat?entity_id=<id>`
- ChatView reads the query param and passes it through

**Step 2: Commit**

```bash
git add web/src/views/ChatView.tsx web/src/components/EntityDetailPanel.tsx
git commit -m "feat: wire entity-scoped chat with entity_id context"
```

---

## Phase 12: Final Integration & Verification

### Task 19: Run full test suite and fix any failures

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

**Step 2: Fix any failures**

Address any test failures introduced by the changes. Common issues:
- Mock shape changes (new columns in queries)
- Import path issues with new modules
- TypeScript type errors from interface changes

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve test failures from entity facts integration"
```

### Task 20: Manual smoke test

**Step 1: Start dev server**

Run: `make dev`

**Step 2: Verify fact extraction**

Capture a thought mentioning a person with explicit facts (e.g., "Had coffee with Maya today. She mentioned she's from Porto and works at Anthropic now."). Verify:
- Thought captured successfully
- Entity resolved
- Fact candidates extracted and visible on entity page as pending suggestions

**Step 3: Verify fact review**

- Accept a pending fact → verify it becomes active
- Reject a pending fact → verify it disappears from suggestions
- Create a conflicting fact manually → verify conflict UI appears

**Step 4: Verify entity chat**

Navigate to entity chat. Ask a question about the entity. Verify the response references facts with appropriate hedging for tentative claims.

**Step 5: Verify MCP tools**

Test via MCP client:
- `list_entity_facts` with entity name
- `add_entity_fact` with a new claim
- `review_entity_fact` to accept/reject

### Task 21: Commit and finalize

**Step 1: Final commit**

If any smoke test issues were found and fixed:

```bash
git add -A
git commit -m "fix: address smoke test issues from entity facts feature"
```

**Step 2: Verify clean state**

Run: `git status`
Run: `npx vitest run`

All clean, all passing.
