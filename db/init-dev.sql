-- Create the dev database and apply the same schema.
-- Runs after init.sql via docker-entrypoint-initdb.d alphabetical ordering.

SELECT 'CREATE DATABASE open_brain_dev OWNER brain_app'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'open_brain_dev')\gexec

\c open_brain_dev

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS thoughts (
    id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    content    TEXT        NOT NULL,
    embedding  vector(1536),
    metadata   JSONB       DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_thoughts_embedding
    ON thoughts
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_thoughts_metadata
    ON thoughts
    USING gin (metadata jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_thoughts_created_at
    ON thoughts (created_at DESC);

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
