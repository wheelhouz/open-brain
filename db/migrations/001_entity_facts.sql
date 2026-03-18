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
