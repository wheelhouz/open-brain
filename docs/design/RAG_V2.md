# RAG v2 — Retrieval Pipeline

## Overview

RAG v2 replaces the inline embed-and-match pattern with a shared retrieval module (`app/src/rag.ts`) used by all three consumption paths: Chat UI, Search API, and MCP tools.

## Architecture

```
CHAT PATH:  conversation → rewriteQuery (gpt-4o-mini) ─┐
                                                         ├→ embed → match_thoughts (wider pool)
MCP/SEARCH: direct query ────────────────────────────────┘   → rerank → expand threads → return
```

### Layered API

- **`searchWithReranking(options)`** — Low-level retrieval for MCP and Search. Caller provides the query string directly. No query rewriting.
- **`retrieveContext(messages)`** — High-level retrieval for Chat. Rewrites the query from conversation context, then calls `searchWithReranking`.
- **`formatContext(thoughts)`** — Formats retrieved thoughts with metadata and thread context for the Chat LLM system prompt.

## Key Components

### Query Rewriting (`openrouter.ts`)

For the Chat path only. Takes the last 5 conversation turns and produces:
- `search_query` — standalone search string with conversation context resolved
- `filter` — optional `{ people: [...], topics: [...] }` extracted from the query
- `time_hint` — `"recent"`, `"last_month"`, `"older"`, or `null`

Uses `config.extractionModel` (gpt-4o-mini) with `response_format: { type: "json_object" }`. Falls back to the raw last user message on failure.

### Wider Candidate Pool

- Threshold lowered from 0.5 to 0.25 (catches more moderately relevant results)
- Pool size scales with requested limit: `max(limit * 2, 15)`
- Metadata filter passed to `match_thoughts` for DB-level filtering via JSONB containment (`@>`)

### Heuristic Reranking

Candidates are scored and sorted by a weighted formula:

| Signal | Default Weight | Time-Oriented Weight |
|--------|---------------|---------------------|
| Cosine similarity | 0.60 | 0.50 |
| Recency (exponential decay) | 0.20 | 0.30 |
| Metadata overlap with filter | 0.15 | 0.15 |
| Thread bonus (has parent) | 0.05 | 0.05 |

- Recency uses exponential decay with a 30-day half-life (14 days when `time_hint` is present)
- Time-oriented weights activate when any `time_hint` is set

### Recency Slice

When `time_hint === "recent"`, a chronological query fetches the last 7 days of thoughts. These are merged into the candidate pool with a synthetic similarity of 0.3, deduplicated by ID, then reranked normally.

### Thread Expansion

For the top 3 reranked results, two queries fetch thread context:
- **Children:** thoughts with `parent_id` matching any of the top 3 IDs (up to 2 per parent)
- **Parents:** if any top result has a `parent_id`, fetch that parent thought

Thread context is attached to each thought and rendered in `formatContext()`.

### Diagnostics

Every retrieval logs structured JSON to stdout:

```json
{
  "event": "rag_retrieval",
  "rewrittenQuery": "...",
  "filter": {},
  "timeHint": null,
  "candidateCount": 20,
  "finalCount": 10,
  "latencyMs": 420
}
```

## Schema Change

`match_thoughts` now returns `parent_id` as a column (in addition to `id`, `content`, `metadata`, `similarity`, `created_at`). This requires dropping and recreating the function on existing databases:

```sql
DROP FUNCTION match_thoughts(vector, double precision, integer, jsonb);
-- Then re-run init.sql or the CREATE OR REPLACE from db/init.sql
```

## Consumer Integration

### Chat (`routes/chat.ts`)
- Calls `retrieveContext(messages)` — gets query rewriting + full pipeline
- Uses `formatContext()` to build the system prompt context block
- SSE contract unchanged: sources → chunks → done

### Search API (`routes/search.ts`)
- Calls `searchWithReranking({ query, filter, threshold, limit })`
- Returns `result.thoughts` as `{ results: [...] }`

### MCP `search_thoughts` (`mcp.ts`)
- Calls `searchWithReranking()` with new optional `filter` and `time_hint` params
- Tool signature backward-compatible (new params have defaults)

## Latency Budget

| Step | Time |
|------|------|
| Query rewrite (Chat only) | ~200-300ms |
| Embedding | ~100-150ms |
| DB query | ~10-20ms |
| Rerank + thread expansion | ~10-20ms |
| **Chat total** | **~350-500ms** |
| **Search/MCP total** | **~120-190ms** |
