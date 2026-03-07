-- Open Brain: Database initialization
-- Enables pgvector and creates the thoughts table with indexes and search function.
-- Runs against the default POSTGRES_DB (open_brain). A dev database is created at the end.

CREATE EXTENSION IF NOT EXISTS vector;

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

-- Migrations (idempotent, safe to re-run)
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES thoughts(id);

-- Sub-thought linking (partial index on non-null parent_id)
CREATE INDEX IF NOT EXISTS idx_thoughts_parent_id
    ON thoughts (parent_id) WHERE parent_id IS NOT NULL;

-- Chronological retrieval
CREATE INDEX IF NOT EXISTS idx_thoughts_created_at
    ON thoughts (created_at DESC);

-- Vector similarity search with metadata filtering
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
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT
        t.id,
        t.content,
        t.metadata,
        (1 - (t.embedding <=> query_embedding))::float AS similarity,
        t.created_at
    FROM thoughts t
    WHERE
        t.deleted_at IS NULL
        AND 1 - (t.embedding <=> query_embedding) > match_threshold
        AND (filter = '{}'::jsonb OR t.metadata @> filter)
    ORDER BY t.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
