-- Open Brain: Database initialization
-- Enables pgvector and creates the thoughts table with indexes and search function.
-- Runs against the default POSTGRES_DB (open_brain). A dev database is created at the end.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS thoughts (
    id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    content    TEXT        NOT NULL,
    embedding  vector(1536),
    metadata   JSONB       DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    parent_id  UUID        REFERENCES thoughts(id)
);

-- Semantic similarity search (HNSW for approximate nearest neighbor)
CREATE INDEX IF NOT EXISTS idx_thoughts_embedding
    ON thoughts
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Metadata filtering (GIN for JSONB containment queries)
CREATE INDEX IF NOT EXISTS idx_thoughts_metadata
    ON thoughts
    USING gin (metadata jsonb_path_ops);

-- Topic categories (AI-generated groupings)
CREATE TABLE IF NOT EXISTS topic_categories (
    topic       TEXT PRIMARY KEY,
    category    TEXT NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_topic_categories_category
    ON topic_categories(category);

-- Migrations (idempotent, safe to re-run)
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES thoughts(id);

-- Sub-thought linking (partial index on non-null parent_id)
CREATE INDEX IF NOT EXISTS idx_thoughts_parent_id
    ON thoughts (parent_id) WHERE parent_id IS NOT NULL;

-- Chronological retrieval
CREATE INDEX IF NOT EXISTS idx_thoughts_created_at
    ON thoughts (created_at DESC);

-- Open Loops (derived from action_items)
CREATE TABLE IF NOT EXISTS open_loops (
    id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    content           TEXT        NOT NULL,
    loop_type         TEXT        NOT NULL DEFAULT 'task'
        CHECK (loop_type IN ('task', 'question', 'decision', 'waiting_on')),
    source_thought_id UUID        REFERENCES thoughts(id),
    status            TEXT        NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'closed', 'snoozed')),
    resolution        TEXT,
    snoozed_until     TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT now(),
    closed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_open_loops_status_open
    ON open_loops (created_at DESC) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_open_loops_status_snoozed
    ON open_loops (snoozed_until) WHERE status = 'snoozed';

CREATE INDEX IF NOT EXISTS idx_open_loops_source_thought
    ON open_loops (source_thought_id) WHERE source_thought_id IS NOT NULL;

-- Deduplicate open_loops before creating unique index (keeps earliest row per content+source)
DELETE FROM open_loop_evidence WHERE loop_id IN (
    SELECT id FROM open_loops WHERE source_thought_id IS NOT NULL AND id NOT IN (
        SELECT DISTINCT ON (md5(content), source_thought_id) id
        FROM open_loops WHERE source_thought_id IS NOT NULL
        ORDER BY md5(content), source_thought_id, created_at
    )
);
DELETE FROM open_loops WHERE source_thought_id IS NOT NULL AND id NOT IN (
    SELECT DISTINCT ON (md5(content), source_thought_id) id
    FROM open_loops WHERE source_thought_id IS NOT NULL
    ORDER BY md5(content), source_thought_id, created_at
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_open_loops_content_source
    ON open_loops (md5(content), source_thought_id) WHERE source_thought_id IS NOT NULL;

-- Open Loop Evidence (links loops to supporting thoughts)
CREATE TABLE IF NOT EXISTS open_loop_evidence (
    loop_id    UUID REFERENCES open_loops(id) ON DELETE CASCADE,
    thought_id UUID REFERENCES thoughts(id),
    noted_at   TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (loop_id, thought_id)
);

-- Entities (canonical person records, extensible to other types)
CREATE TABLE IF NOT EXISTS entities (
    id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    canonical_name  TEXT        NOT NULL,
    entity_type     TEXT        NOT NULL DEFAULT 'person'
        CHECK (entity_type IN ('person')),
    attributes      JSONB       DEFAULT '{}'::jsonb,
    aliases         TEXT[]      DEFAULT '{}',
    embedding       vector(1536),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_type
    ON entities (lower(canonical_name), entity_type);

CREATE INDEX IF NOT EXISTS idx_entities_aliases
    ON entities USING gin (aliases);

CREATE INDEX IF NOT EXISTS idx_entities_embedding
    ON entities USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_entities_canonical_name_trgm
    ON entities USING gin (canonical_name gin_trgm_ops);

-- Entity Mentions (links entities to thoughts)
CREATE TABLE IF NOT EXISTS entity_mentions (
    entity_id               UUID        REFERENCES entities(id) ON DELETE CASCADE,
    thought_id              UUID        REFERENCES thoughts(id),
    role                    TEXT        NOT NULL DEFAULT 'mentioned'
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

-- Phase 2 enrichment: link open loops to blocking entities
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS blocked_by_entity_id UUID REFERENCES entities(id);

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

-- Vector similarity search with metadata filtering
DROP FUNCTION IF EXISTS match_thoughts;
CREATE OR REPLACE FUNCTION match_thoughts(
    query_embedding  vector(1536),
    match_threshold  float    DEFAULT 0.7,
    match_count      int      DEFAULT 10,
    filter           jsonb    DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    id         UUID,
    content    TEXT,
    metadata   JSONB,
    similarity float,
    created_at TIMESTAMPTZ,
    parent_id  UUID
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT
        t.id,
        t.content,
        t.metadata,
        (1 - (t.embedding <=> query_embedding))::float AS similarity,
        t.created_at,
        t.parent_id
    FROM thoughts t
    WHERE
        t.deleted_at IS NULL
        AND 1 - (t.embedding <=> query_embedding) > match_threshold
        AND (filter = '{}'::jsonb OR t.metadata @> filter)
    ORDER BY t.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
