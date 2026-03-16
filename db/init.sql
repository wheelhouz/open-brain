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
    entity_id  UUID REFERENCES entities(id) ON DELETE CASCADE,
    thought_id UUID REFERENCES thoughts(id),
    role       TEXT NOT NULL DEFAULT 'mentioned'
        CHECK (role IN ('subject', 'mentioned', 'author')),
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (entity_id, thought_id)
);

-- Phase 2 enrichment: link open loops to blocking entities
ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS blocked_by_entity_id UUID REFERENCES entities(id);

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
