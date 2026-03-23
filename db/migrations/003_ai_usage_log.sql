-- AI usage tracking (spend visibility for OpenRouter calls)
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id                  BIGSERIAL       PRIMARY KEY,
    operation           TEXT            NOT NULL,
    model               TEXT            NOT NULL,
    source              TEXT            NOT NULL DEFAULT 'rest',
    prompt_tokens       INTEGER         NOT NULL DEFAULT 0,
    completion_tokens   INTEGER         NOT NULL DEFAULT 0,
    total_tokens        INTEGER         NOT NULL DEFAULT 0,
    estimated_cost_usd  NUMERIC(10,8)   NOT NULL DEFAULT 0,
    latency_ms          INTEGER,
    success             BOOLEAN         NOT NULL DEFAULT true,
    error_code          TEXT,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_operation ON ai_usage_log (operation, created_at DESC);
