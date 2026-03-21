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
