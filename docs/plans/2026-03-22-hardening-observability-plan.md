# Hardening & Observability Plan

**Date:** 2026-03-22 | **Revised:** 2026-03-22 (v2 — MCP-first review)
**Scope:** Security hardening, structured logging, metrics, AI spend tracking, monitoring stack
**Constraint:** Self-hosted on Synology NAS via Docker — all solutions must be lightweight, Docker-native, and single-user appropriate

---

## Overview

Open Brain has a rich feature set (Phases 0–6 complete) but lacks operational confidence. Enrichment steps fail silently, there's no request logging, no spend visibility, and several security gaps appropriate to address before wider use or internet exposure. This plan covers four workstreams:

1. **Security Hardening** — fix vulnerabilities, add input validation, harden containers
2. **Structured Logging** — replace bare `console.log` with pino, eliminate silent failures
3. **AI Spend Tracking** — instrument all OpenRouter calls, store usage, build dashboard
4. **Monitoring Stack** — lightweight Prometheus + Grafana + Uptime Kuma for the NAS

> **Critical design principle:** MCP is the primary interface for AI clients (Claude Desktop, Claude Code, Cursor). The MCP endpoint is mounted at `/mcp` *before* the `/api` auth middleware group in `app.ts`. Any hardening applied only to `/api/*` routes does NOT protect MCP. Every security, validation, logging, and spend-tracking measure must explicitly account for the MCP path.

---

## Review Findings & Plan Gaps (v2)

The following gaps were identified during expert review. Each is addressed in the revised task list below.

### MCP-Specific Gaps (the plan was REST-biased)

| # | Gap | Impact | Resolution |
|---|-----|--------|------------|
| G1 | **Rate limiting only covers `/api/*`** — the plan's `hono-rate-limiter` on `/api/*` does not protect `/mcp`, which is mounted before the API group. An MCP client can make unlimited requests. | Runaway spend, DoS | Add rate limiter to `/mcp` route separately (new task 12b) |
| G2 | **No MCP tool invocation logging** — HTTP request logging sees `/mcp` as a single POST. Individual tool calls (capture, search, bulk_import) are invisible. This is the biggest observability blind spot. | Can't audit what AI agents did | Add MCP tool-level audit logging (new task 35b) |
| G3 | **Content length not enforced in MCP tools** — `config.maxContentLength` (50KB) is checked only in `routes/capture.ts`. The MCP `capture_thought` and `add_note` tools accept arbitrarily large content. | Token waste, prompt overflow | Add content length check to MCP capture tools (new task 11b) |
| G4 | **`weekly_review` days param uncapped in MCP** — the plan clamps `days` to 365 in REST routes but `weekly_review` MCP tool has no cap. `days: 36500` pulls entire DB into one LLM prompt. | Unbounded token spend | Clamp `weekly_review` days to max 90 (new task 11c) |
| G5 | **Operation taxonomy missing `weekly_review`** — the spend tracking table lists 11 operations but omits `weekly_review`, which calls `chatCompletion` (non-streaming). This is an MCP-exclusive code path with no REST equivalent. | Spend tracking gap | Add `weekly_review` to taxonomy and instrument `chatCompletion` (updated task 47) |
| G6 | **No budget enforcement (circuit breaker)** — the plan has budget *alerting* but no actual spend *blocking*. A runaway MCP client (or prompt-injected AI agent) can blow through the budget. | Financial risk | Add hard budget cutoff in `openrouterRequest` (new task 43b) |
| G7 | **Queue flooding from MCP `bulk_import`** — 500 thoughts × 3 action items = 1,500 background embedding jobs. No queue depth limit exists. | Worker backlog, sustained AI spend | Add queue depth cap (new task 13b) |
| G8 | **MCP auth improvements won't propagate** — any enhancement to `middleware/auth.ts` (logging, brute-force protection) does not apply to MCP, which has its own inline auth check in `routes/mcp.ts`. | Security bypass | Unify auth into a shared function called by both paths (new task 1b) |

### Correctness Bugs Found During Review

| # | Bug | Location |
|---|-----|----------|
| B1 | `resolve_fact_conflict` MCP tool doesn't destructure `note` param — schema accepts it, handler ignores it | `mcp.ts:780` |
| B2 | `bulk_import` `normalize` param is accepted but never used (dead code) | `mcp.ts:261` |
| B3 | `snooze_loop` MCP tool passes unvalidated date string to PostgreSQL — invalid dates cause raw 500 | `mcp.ts` snooze handler |
| B4 | OAuth `redirect_uri` is never validated against an allowlist — open redirect possible | `routes/oauth.ts:143-147` |
| B5 | OAuth registered client data (`registeredClients` map) is written but never read — registration is a no-op | `routes/oauth.ts:37-54` |

### Architecture Observations

| # | Observation | Recommendation |
|---|-------------|----------------|
| A1 | MCP is the *only* path to `weekly_review` and the full `searchMemory` broker. These are the most expensive operations. Yet MCP has the *least* guardrails. | Prioritize MCP hardening over REST hardening |
| A2 | `capture_thought` via MCP triggers 2 + N_topics + N_facts OpenRouter calls, all synchronous. A thought with 5 topics and 5 facts = 12 API calls from one tool invocation. | Document per-tool cost profile; consider async extraction |
| A3 | The `ai_usage_log` schema has no `source` column to distinguish REST vs MCP vs queue origins | Add `source TEXT` column |
| A4 | Prometheus `open_brain_http_requests_total` won't capture MCP tool granularity — it sees one POST to `/mcp` | Add `open_brain_mcp_tool_calls_total{tool, status}` counter |
| A5 | The plan's success criteria say "Every HTTP request produces a structured JSON log line" — but MCP tool invocations are not HTTP requests | Update success criteria for MCP |

---

## Workstream 1: Security Hardening

### Phase 1A — Critical Fixes (Day 1)

| # | Task | File(s) | Priority |
|---|------|---------|----------|
| 1 | **Timing-safe token comparison** — Replace `!==` with `crypto.timingSafeEqual` in all three auth check locations | `middleware/auth.ts:8`, `routes/mcp.ts:17`, `routes/oauth.ts:119` | CRITICAL |
| 1b | **Unify auth into shared function** — Extract token validation into a shared `validateAccessKey(token): boolean` used by both `middleware/auth.ts` and `routes/mcp.ts`. This ensures future auth enhancements (logging, brute-force protection) apply to both REST and MCP paths. *(Resolves G8)* | `app/src/auth.ts` (new), `middleware/auth.ts`, `routes/mcp.ts` | CRITICAL |
| 2 | **Non-root container** — Add `USER` instruction to Dockerfile | `Dockerfile` | HIGH |
| 3 | **Startup env validation** — Fail fast if `DATABASE_URL`, `BRAIN_ACCESS_KEY`, or `OPENROUTER_API_KEY` are unset | `config.ts` or `index.ts` | HIGH |
| 4 | **Fix broken SQL syntax** — Remove stray `)` in ~7 queries with `replace(lower(predicate)...)` pattern | `mcp.ts`, `routes/facts.ts` | HIGH |
| 4b | **Fix MCP correctness bugs** — (a) Destructure `note` in `resolve_fact_conflict` handler, (b) remove dead `normalize` param from `bulk_import` or wire it up, (c) validate `until` date format in `snooze_loop` before DB call *(Resolves B1, B2, B3)* | `mcp.ts` | HIGH |
| 5 | **Bind Synology port to localhost** — Change `"8420:8420"` to `"127.0.0.1:8420:8420"` | `deploy/synology/docker-compose.yml` | HIGH |

### Phase 1B — Input Validation (Day 2)

> **Principle:** Every validation applied to a REST route MUST also be applied to the equivalent MCP tool. The table below marks MCP-applicable tasks.

| # | Task | File(s) | MCP? |
|---|------|---------|------|
| 6 | Validate `loop_type` ∈ `{task,question,decision,waiting_on}` and `status` ∈ `{open,closed,snoozed}` before DB insert | `routes/loops.ts` | N/A (no MCP equivalent) |
| 7 | Clamp `days` parameter to max 365 | `routes/review.ts`, `routes/thoughts.ts` | See 11c |
| 8 | Validate `parent_id` as UUID format before pipeline | `routes/capture.ts` | See 11d |
| 9 | Add `messages.length <= 50` guard | `routes/chat.ts` | N/A (no MCP chat) |
| 10 | Add `thoughts.length <= 500` guard on import | `routes/import.ts` | See 11 |
| 11 | Add `thoughts.length <= 100` cap on MCP `bulk_import` | `mcp.ts` | Yes |
| 11b | **Enforce `maxContentLength` in MCP capture tools** — Add content length check (`config.maxContentLength`, 50KB) to `capture_thought` and `add_note` MCP tools. Currently only REST capture validates this. *(Resolves G3)* | `mcp.ts` | Yes |
| 11c | **Clamp `weekly_review` days to max 90** — This MCP-exclusive tool has no REST equivalent. `days: 36500` pulls entire DB into one LLM prompt. Also add a `LIMIT 500` to the thought query to bound prompt size regardless of time window. *(Resolves G4)* | `mcp.ts` | Yes |
| 11d | **Validate `parent_id` UUID format in MCP `add_note`** — Invalid UUIDs cause raw PostgreSQL errors that propagate as unstructured MCP errors. | `mcp.ts` | Yes |
| 11e | **Validate `snooze_loop` date format** — Parse `until` as ISO date before passing to DB. Return structured error on invalid date. *(Resolves B3)* | `mcp.ts` | Yes |

### Phase 1C — Infrastructure Hardening (Day 3)

| # | Task | File(s) |
|---|------|---------|
| 12 | **Rate limiting on `/api/*`** — Add `hono-rate-limiter` middleware: 60 req/min on `/api/*`, 10 req/min on `/oauth/*` | `app.ts` |
| 12b | **Rate limiting on `/mcp`** — Apply separate rate limiter to the MCP endpoint: 30 req/min. This is critical because MCP is mounted before `/api` middleware and tools like `bulk_import` and `weekly_review` are the most expensive operations in the system. *(Resolves G1)* | `app.ts` or `routes/mcp.ts` |
| 13 | **MCP session bounds** — Cap `sessions.size` at 50, add session TTL (24h) with cleanup interval | `routes/mcp.ts` |
| 13b | **Queue depth cap** — Reject `enqueueEmbeddingJob` when `embedding_jobs` pending count exceeds 500. Log warning. This prevents `bulk_import` from flooding the background worker with thousands of jobs. *(Resolves G7)* | `queue.ts` |
| 14 | **Security headers** — `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` | `app.ts` (middleware) |
| 15 | **Global error handler** — Catch all errors, log full details server-side, return generic `{ error: "Internal server error" }` to client | `app.ts` |
| 16 | **Sanitize OpenRouter errors** — Don't forward raw error bodies to clients, especially in SSE stream | `openrouter.ts` |
| 17 | **DB pool timeouts** — Add `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 5000` | `db.ts` |
| 18 | **Container resource limits** — `mem_limit: 512m`, `cpus: 1.0` on app; `mem_limit: 256m` on db | `deploy/synology/docker-compose.yml` |
| 19 | **Gate OAuth `/register`** — Require `BRAIN_ACCESS_KEY` as registration access token per RFC 7591 §3.1 | `routes/oauth.ts` |
| 19b | **Validate OAuth `redirect_uri`** — Add configurable allowlist (`OAUTH_REDIRECT_ALLOWLIST` env var). Reject authorize requests with unrecognized redirect URIs. Default: `http://localhost:*` patterns only. *(Resolves B4)* | `routes/oauth.ts` |

### Phase 1D — Stretch (Optional)

| # | Task | Notes |
|---|------|-------|
| 20 | Pin base image to digest (`node:22.15.0-alpine@sha256:...`) | Reproducible builds |
| 21 | Add `read_only: true` + tmpfs to app container | Reduce container attack surface |
| 22 | Create `brain_readonly` DB role for search-only queries | Least privilege |
| 23 | Move `DELETE` dedup statements from `init.sql` to a one-time migration | Prevent accidental data loss on restart |
| 24 | Log deprecation warning when MCP `?key=` query param is used | Keys in URLs leak to proxy logs |
| 24b | Clean up OAuth dead code — `registeredClients` map is written but never read *(Resolves B5)* | `routes/oauth.ts` |

---

## Workstream 2: Structured Logging

### Why pino

- Zero-dep, fastest JSON logger for Node.js
- Docker log-driver compatible (JSON to stdout)
- `pino-pretty` for dev, raw JSON for prod
- Hono middleware integration is trivial

### Phase 2A — Logger Setup (Day 4)

| # | Task | Details |
|---|------|---------|
| 25 | `npm install pino` (prod), `pino-pretty` (dev) | |
| 26 | Create `app/src/logger.ts` — singleton pino instance, `LOG_LEVEL` from env (default `info`) | |
| 27 | **Request logging middleware** — log every request: `{ event: "http_request", reqId, method, path, status, latencyMs }` | `app.ts` |
| 28 | Add `reqId` (8-char UUID prefix) to Hono context for correlation | |

### Phase 2B — Eliminate Silent Failures (Day 4–5)

Replace all bare `catch {}` blocks in `pipeline.ts` with structured warnings:

| # | Silent Failure | Current Location |
|---|---------------|------------------|
| 29 | `extractMetadata` failure during capture | `pipeline.ts` — `Promise.all` catch |
| 30 | Category assignment failure | `pipeline.ts:104-134` |
| 31 | Loop creation failure | `pipeline.ts:138-144` |
| 32 | Entity resolution failure | `pipeline.ts:148-154` |
| 33 | Fact processing failure | `pipeline.ts:157-165` |
| 34 | Loop embedding enqueue failure | `pipeline.ts:51-58` |

Each becomes:
```typescript
} catch (err) {
  logger.warn({ event: "pipeline_enrichment_failed", step: "entity_resolution", thoughtId, err: String(err) });
}
```

Also add a `capture_pipeline_result` summary event per thought:
```json
{ "event": "capture_result", "thoughtId": "...", "metadata": true, "loops": true, "entities": false, "facts": true }
```

### Phase 2C — Operational Logging (Day 5)

| # | Area | Events to Add |
|---|------|--------------|
| 35 | Auth | `{ event: "auth_failure", path, ip }` on 401 — must fire for **both** REST auth middleware and MCP inline auth check (see task 1b for unified auth) |
| 35b | **MCP tool audit log** — Wrap every MCP tool handler to emit: `{ event: "mcp_tool_call", tool, sessionId, latencyMs, success, error? }`. This is the **highest-priority observability gap** — without it, you cannot know what any AI agent did, which tools were called, or how much each session cost. HTTP request logging only sees `POST /mcp`. *(Resolves G2)* | |
| 36 | Queue | `{ event: "job_completed", jobId, loopId, latencyMs }` and `{ event: "job_permanently_failed", jobId, loopId, attempts }` |
| 37 | Entity resolution | `{ event: "entity_resolved", name, state: "exact"\|"alias"\|"fuzzy"\|"new", score? }` |
| 38 | RAG | Enhance existing diagnostics with `lexicalFallbackFired`, `scoreDistribution: { min, max, avg }`, `zeroResults: boolean` |
| 39 | Startup | Log all config values (redact secrets) at boot for reproducibility |
| 40 | DB health | Log pool stats (`total`, `idle`, `waiting`) every 60s at `debug` level |

**Implementation note for 35b:** The MCP SDK's `McpServer` supports `server.setRequestHandler` or middleware-like hooks. Alternatively, wrap each tool's callback function with a timing/logging decorator at registration time in `mcp.ts`. Example pattern:

```typescript
function withAudit<T>(tool: string, fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    const start = Date.now();
    try {
      const result = await fn(args);
      logger.info({ event: "mcp_tool_call", tool, latencyMs: Date.now() - start, success: true });
      return result;
    } catch (err) {
      logger.error({ event: "mcp_tool_call", tool, latencyMs: Date.now() - start, success: false, err: String(err) });
      throw err;
    }
  };
}
```

---

## Workstream 3: AI Spend Tracking

### Architecture

Instrument at `openrouterRequest` (the single choke point) — capture token usage from response, write to PostgreSQL. No external services needed.

### Phase 3A — Schema & Core Module (Day 6)

**41. Add `ai_usage_log` table to `db/init.sql`:**

```sql
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id                  BIGSERIAL       PRIMARY KEY,
    operation           TEXT            NOT NULL,
    model               TEXT            NOT NULL,
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
```

**42. Create `app/src/spend.ts`:**

- `MODEL_PRICING` map with per-1K-token rates for all configured models
- `estimateCost(model, promptTokens, completionTokens): number`
- `recordUsage(event: UsageEvent): Promise<void>` — fire-and-forget INSERT, never throws

**43. Extend `config.ts`:**

```typescript
monthlyBudgetUsd: parseFloat(process.env.MONTHLY_BUDGET_USD || "0"),
spendAlertThresholdPct: parseFloat(process.env.SPEND_ALERT_THRESHOLD_PCT || "80"),
spendHardCutoffUsd: parseFloat(process.env.SPEND_HARD_CUTOFF_USD || "0"), // 0 = no cutoff
```

**43b. Budget enforcement (hard cutoff)** — Add `checkBudget(): Promise<boolean>` to `spend.ts`. Called by `openrouterRequest` before every AI call. If `spendHardCutoffUsd > 0` and month-to-date spend exceeds it, throw a `BudgetExceededError` that propagates as a structured error to both REST and MCP callers. Cache the result for 60 seconds to avoid a DB query on every AI call. *(Resolves G6)*

> **Why this matters:** MCP clients (especially AI agents like Claude) can autonomously chain tool calls. A prompt injection in retrieved context could instruct the AI to call `bulk_import` with large payloads. Without a hard cutoff, budget alerts are just advisory — the spend has already happened by the time you see the alert.

**43c. Add `source` column to `ai_usage_log`** — Track where each AI call originated: `'rest'`, `'mcp'`, `'queue'`, `'startup'`. This enables per-interface spend breakdowns and answers "how much does MCP usage cost vs. direct API usage?" *(Resolves A3)*

Updated schema:
```sql
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id                  BIGSERIAL       PRIMARY KEY,
    operation           TEXT            NOT NULL,
    model               TEXT            NOT NULL,
    source              TEXT            NOT NULL DEFAULT 'rest',  -- rest|mcp|queue|startup
    prompt_tokens       INTEGER         NOT NULL DEFAULT 0,
    completion_tokens   INTEGER         NOT NULL DEFAULT 0,
    total_tokens        INTEGER         NOT NULL DEFAULT 0,
    estimated_cost_usd  NUMERIC(10,8)   NOT NULL DEFAULT 0,
    latency_ms          INTEGER,
    success             BOOLEAN         NOT NULL DEFAULT true,
    error_code          TEXT,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);
```

### Phase 3B — Instrument OpenRouter (Day 6–7)

**Operation taxonomy — every AI call in the codebase:**

| Operation | Function | Model | Called From | Path |
|-----------|----------|-------|-------------|------|
| `embed_thought` | `generateEmbedding` | embeddingModel | `pipeline.ts` capture + update | REST + MCP |
| `embed_search` | `generateEmbedding` | embeddingModel | `rag.ts` search + searchMemory | REST + MCP |
| `embed_loop` | `generateEmbedding` | embeddingModel | `queue.ts` background worker | Background |
| `embed_fact` | `generateEmbedding` | embeddingModel | `facts.ts` per-fact embedding | REST + MCP |
| `embed_entity_query` | `generateEmbedding` | embeddingModel | `entity-chat.ts` | REST only |
| `extract_metadata` | `extractMetadata` | extractionModel | `pipeline.ts` | REST + MCP |
| `normalize` | `normalizeContent` | extractionModel | `pipeline.ts` | REST + MCP |
| `rewrite_query` | `rewriteQuery` | extractionModel | `rag.ts` | REST + MCP |
| `categorize_topics` | `categorizeTopics` | extractionModel | `openrouter.ts` | REST + MCP |
| `assign_category` | `assignCategory` | extractionModel | `pipeline.ts` | REST + MCP |
| `chat_stream` | `chatCompletionStream` | chatModel | `routes/chat.ts` | REST only |
| `weekly_review` | `chatCompletion` | extractionModel | `mcp.ts` | **MCP only** |

> **Note:** `weekly_review` was missing from v1 of this plan. It uses non-streaming `chatCompletion` (not `chatCompletionStream`), so the streaming SSE instrumentation in task 45 does not cover it. Task 44 must also instrument `chatCompletion` (the non-streaming wrapper). *(Resolves G5)*

**Per-tool worst-case AI call count (for spend estimation):**

| MCP Tool | Min Calls | Worst Case | Dominant Cost |
|----------|-----------|------------|---------------|
| `capture_thought` / `add_note` | 2 | 2 + T + F (topics + facts) | Metadata extraction |
| `bulk_import` (N items) | 2N | (2+T+F) × N | Scales with array size |
| `weekly_review` | 1 | 1 (but token count scales with DB size) | Chat completion on large context |
| `search_thoughts` | 1 | 1 | Embedding only |
| `search_memory` | 1 | 1 | Embedding only |
| `add_entity_fact` | 1 | 1 | Embedding only |
| All others | 0 | 0 | — |

**44. Modify `openrouterRequest`:**
- Add `operation` parameter (default `"unknown"`)
- Capture `Date.now()` start time
- Extract `usage` from response body (currently cast away)
- Fire-and-forget `recordUsage(...)` after every call
- On error (`!res.ok`), record failure event with `errorCode: res.status`

**45. Modify `chatCompletionStream`:**
- Add `operation` parameter (default `"chat_stream"`)
- Parse `usage` from final SSE chunk before `[DONE]` (OpenRouter embeds it there)
- Call `recordUsage(...)` after stream closes

**46. Add `operation` param to `generateEmbedding`** (default `"embed_search"`).

**46b. Instrument `chatCompletion` (non-streaming)** — This function is used by `weekly_review` (MCP-only). Same pattern as `openrouterRequest`: extract `usage` from response, fire-and-forget `recordUsage`. *(Resolves G5)*

**47. Propagate operation tags at all 13 call sites:**
- `pipeline.ts` → `"embed_thought"`, `"extract_metadata"`, `"normalize"`, `"assign_category"`
- `facts.ts` → `"embed_fact"`
- `entity-chat.ts` → `"embed_entity_query"`
- `queue.ts` → `"embed_loop"`
- `rag.ts` → `"embed_search"`, `"rewrite_query"`
- `routes/chat.ts` → `"chat_stream"`
- `mcp.ts` (weekly_review) → `"weekly_review"` *(new — MCP-only path)*

**47b. Propagate `source` context** — Thread a `source` string (`'rest'` | `'mcp'` | `'queue'`) through to `recordUsage`. Options:
- **Option A (simple):** Add `source` param to `generateEmbedding`, `extractMetadata`, etc. Verbose but explicit.
- **Option B (cleaner):** Use Node.js `AsyncLocalStorage` to set source context at the HTTP handler level. MCP route sets `'mcp'`, API routes set `'rest'`, queue worker sets `'queue'`. `recordUsage` reads from AsyncLocalStorage automatically. No function signature changes needed.
- **Recommended:** Option B — avoids threading a param through 13+ call sites and ensures future call sites inherit the source automatically.

### Phase 3C — API Endpoints (Day 7)

**48. Create `app/src/routes/spend.ts`** with three endpoints:

`GET /api/spend/summary`
```json
{
  "today": { "calls": 42, "tokens": 125000, "estimated_usd": 0.031 },
  "this_month": { "calls": 890, "tokens": 2450000, "estimated_usd": 0.614 },
  "all_time": { "calls": 4200, "tokens": 12000000, "estimated_usd": 3.02 }
}
```

`GET /api/spend/breakdown?period=30`
```json
{
  "period_days": 30,
  "by_operation": [{ "operation": "embed_thought", "calls": 420, "tokens": 840000, "estimated_usd": 0.034 }],
  "by_model": [{ "model": "openai/text-embedding-3-small", "calls": 640, "tokens": 1280000, "estimated_usd": 0.026 }],
  "daily": [{ "date": "2026-03-22", "calls": 38, "tokens": 96000, "estimated_usd": 0.024 }]
}
```

`GET /api/spend/budget`
```json
{
  "monthly_budget_usd": 5.0,
  "month_to_date_usd": 1.23,
  "percent_used": 24.6,
  "alert_threshold_pct": 80,
  "alert_triggered": false
}
```

**49. Register in `app.ts`** — `api.route("/spend", spendRouter)`

### Phase 3D — Frontend (Day 8)

**50. Create `web/src/views/SpendView.tsx`:**
- Header stat cards: Today / This Month / All Time (reuse `StatCard` pattern from StatsView)
- Budget progress bar (only if `monthly_budget_usd > 0`)
- Budget alert banner when `alert_triggered: true`
- Operation breakdown table (sortable by calls/tokens/cost)
- Model breakdown table
- Daily spend bar chart (reuse `ActivityChart` pattern)

**51. Add API methods to `web/src/api.ts`** — `spendSummary()`, `spendBreakdown(days)`, `spendBudget()`

**52. Add nav entry** — "Spend" tab with dollar icon in `App.tsx`, route `/spend`

### Phase 3E — Tests (Day 8)

**53.** Unit test `spend.ts` — verify `recordUsage` INSERT shape, verify it swallows DB errors
**54.** Route test `routes/spend.ts` — verify aggregation queries return correct shapes
**55.** Integration: capture a thought, verify `ai_usage_log` rows created with correct operation tags

---

## Workstream 4: Monitoring Stack

### Recommended Stack for Synology NAS

| Service | Purpose | RAM | Docker Image |
|---------|---------|-----|-------------|
| **Prometheus** | Metrics scraping + storage | ~100–150MB | `prom/prometheus` |
| **Grafana** | Dashboards + alerting | ~200–300MB | `grafana/grafana-oss` |
| **Uptime Kuma** | Health check + push notifications | ~80–100MB | `louislam/uptime-kuma` |

**Total overhead:** ~400–550MB. Acceptable on any NAS with 4GB+ RAM.

**Why this stack:**
- All three are single-container, zero-external-dependency Docker images
- Prometheus + Grafana is the de facto standard — massive community dashboard library
- Uptime Kuma adds push notifications (Telegram, Discord, email) that Prometheus/Grafana can't do natively without Alertmanager
- All persist to Docker volumes, no additional DB needed

**Alternatives considered:**
- **Beszel** (~30MB) — lighter but no custom app metrics support, only infrastructure
- **VictoriaMetrics** — Prometheus-compatible but overkill for single-app monitoring
- **Loki** for log aggregation — add later if searching pino JSON logs in Docker becomes painful

### Phase 4A — App Metrics Endpoint (Day 9)

**56. `npm install prom-client`**

**57. Create `app/src/metrics.ts`** — expose Prometheus metrics:

```
# Counters
open_brain_http_requests_total{method, route, status}
open_brain_captures_total{status, source}         # source=rest|mcp
open_brain_openrouter_calls_total{operation, model, status, source}
open_brain_tokens_total{operation, model, type, source}  # type=prompt|completion
open_brain_facts_total{outcome}                   # inserted|skipped|dedup|flagged
open_brain_entity_resolutions_total{state}        # exact|alias|fuzzy|new
open_brain_queue_jobs_total{status}               # complete|failed
open_brain_mcp_tool_calls_total{tool, status}     # NEW — per-tool invocation count (Resolves A4)
open_brain_mcp_sessions_created_total             # NEW — session lifecycle
open_brain_budget_cutoff_total                    # NEW — how often hard cutoff fires

# Gauges
open_brain_db_pool_total
open_brain_db_pool_idle
open_brain_db_pool_waiting
open_brain_queue_pending_jobs
open_brain_mcp_active_sessions                    # NEW — current session count
open_brain_spend_month_to_date_usd                # NEW — updated on each recordUsage call

# Histograms (bucket boundaries tuned for this app)
open_brain_http_duration_ms{method, route}
open_brain_openrouter_latency_ms{operation}
open_brain_rag_latency_ms
open_brain_rag_candidate_count
open_brain_rag_top_similarity_score
open_brain_mcp_tool_duration_ms{tool}             # NEW — per-tool latency
```

**58. Add `GET /metrics` route** (unauthenticated — only reachable from Docker network):
```typescript
app.get("/metrics", async (c) => {
  c.header("Content-Type", register.contentType);
  return c.text(await register.metrics());
});
```

**59. Instrument middleware** — increment counters in the existing request logging middleware (Phase 2A task 27).

### Phase 4B — Deploy Monitoring Stack (Day 10)

**60. Create `deploy/monitoring/docker-compose.yml`:**

```yaml
services:
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    networks: [brain-net]
    restart: unless-stopped

  grafana:
    image: grafana/grafana-oss:latest
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD}
      GF_USERS_ALLOW_SIGN_UP: "false"
    volumes:
      - grafana_data:/var/lib/grafana
    ports:
      - "127.0.0.1:3001:3000"
    networks: [brain-net]
    restart: unless-stopped

  uptime-kuma:
    image: louislam/uptime-kuma:latest
    volumes:
      - uptime_data:/app/data
    ports:
      - "127.0.0.1:3002:3001"
    networks: [brain-net]
    restart: unless-stopped

volumes:
  prometheus_data:
  grafana_data:
  uptime_data:

networks:
  brain-net:
    external: true
```

**61. Create `deploy/monitoring/prometheus.yml`:**

```yaml
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: open-brain
    static_configs:
      - targets: ["open-brain-app:8420"]
```

**62. Configure Uptime Kuma:**
- Monitor `http://open-brain-app:8420/health` every 60s
- Push notification via Telegram bot (or Discord webhook)

### Phase 4C — Grafana Dashboards (Day 10–11)

**63. Build three dashboard sections:**

**Section 1 — Knowledge Health**
- Total thoughts gauge + daily capture rate (30-day sparkline)
- Enrichment success rate: % of captures with full metadata vs degraded
- Open loops count + age distribution
- Pending fact review queue depth

**Section 2 — AI Spend**
- Cost today / this week / this month (stat panels)
- Daily cost bar chart (last 30 days) broken down by model
- Token usage by operation (stacked area chart)
- Cost per capture (derived: daily cost / daily captures)

**Section 3 — MCP Activity** *(new — MCP is a first-class citizen)*
- MCP tool call frequency by tool name (bar chart, last 7 days)
- MCP tool latency p50/p95 by tool (heatmap)
- MCP tool error rate (should be ~0; spikes indicate bugs or prompt injection)
- Active MCP sessions gauge
- MCP vs REST spend ratio (pie chart from `ai_usage_log.source`)
- `bulk_import` items per invocation (detect runaway imports)

**Section 4 — System Health**
- OpenRouter call rate + error rate by operation (time series)
- OpenRouter latency p50/p95 by operation (heatmap)
- RAG top similarity score trend (declining = model drift)
- Lexical fallback rate
- DB pool utilization gauge (total/idle/waiting)
- Queue depth + failed jobs
- HTTP request rate + error rate by route
- Budget cutoff events (should be 0; any > 0 means a client hit the hard limit)
- Uptime Kuma status embed (via iframe or link)

---

## Implementation Schedule

| Day | Workstream | Tasks | Deliverable |
|-----|-----------|-------|-------------|
| 1 | Security | 1, 1b, 2–5, 4b | Critical fixes + unified auth + MCP bug fixes |
| 2 | Security | 6–11, 11b–11e | Input validation (REST + MCP parity) |
| 3 | Security | 12, 12b, 13, 13b, 14–19, 19b | Rate limiting (REST + MCP), session bounds, queue cap, headers, OAuth hardening |
| 4 | Logging | 25–28, 29–34 | pino installed, request logging, silent failures eliminated |
| 5 | Logging | 35, 35b, 36–40 | Auth logging, **MCP tool audit log**, queue/entity/RAG logging |
| 6 | AI Spend | 41–43, 43b–43c, 44–47, 47b | Schema (with source column), budget enforcement, OpenRouter instrumented (incl. `chatCompletion` + `weekly_review`) |
| 7 | AI Spend | 48–49 | API endpoints (with source breakdown) |
| 8 | AI Spend | 50–55 | Frontend dashboard + tests |
| 9 | Monitoring | 56–59 | Prometheus metrics endpoint (with MCP counters) |
| 10 | Monitoring | 60–62 | Monitoring stack deployed on NAS |
| 11 | Monitoring | 63 | Grafana dashboards (4 sections incl. MCP Activity) |

---

## Key Design Decisions

### Why PostgreSQL for spend tracking (not Prometheus)

Prometheus is great for real-time metrics but poor for historical aggregation queries like "total cost this month by model." The `ai_usage_log` table in PostgreSQL gives us:
- SQL aggregation with `date_trunc` for any time window
- JOIN capability with thoughts table if we ever want per-thought cost
- No additional infrastructure beyond what's already deployed
- Easy backup as part of the existing DB volume

Prometheus still captures the *rate* metrics (calls/sec, latency percentiles) that it excels at.

### Why pino (not winston, not console.log)

- 5–10x faster than winston in benchmarks
- Zero-config JSON output (Docker log drivers parse it natively)
- `pino-pretty` for human-readable dev output
- Tiny footprint (~150KB) vs winston (~1.5MB with transports)

### Why Uptime Kuma alongside Prometheus

Prometheus detects problems; Uptime Kuma notifies you. Prometheus's native Alertmanager is heavy and complex for a single-app deployment. Uptime Kuma is purpose-built for "is it up?" with 30+ notification integrations built in.

### AI cost estimation vs exact cost

OpenRouter provides exact cost via `GET /api/v1/generation?id=gen-xxx`, but this requires a separate HTTP call per AI operation. For a single-user app, the estimated cost from `MODEL_PRICING` lookup is accurate enough (< 1% variance). Exact cost can be added as a Phase 2 enhancement via a background job that backfills `actual_cost_usd` using generation IDs.

---

## Files Created / Modified Summary

### New Files
| File | Purpose |
|------|---------|
| `app/src/auth.ts` | Shared `validateAccessKey` with `timingSafeEqual` (used by REST + MCP) |
| `app/src/logger.ts` | Pino logger singleton |
| `app/src/spend.ts` | AI spend tracking module (pricing, recordUsage, checkBudget) |
| `app/src/metrics.ts` | Prometheus metrics definitions (incl. MCP counters) |
| `app/src/middleware/requestLog.ts` | HTTP request logging + metrics middleware |
| `app/src/routes/spend.ts` | Spend API endpoints (with source breakdown) |
| `web/src/views/SpendView.tsx` | Spend dashboard view |
| `deploy/monitoring/docker-compose.yml` | Prometheus + Grafana + Uptime Kuma |
| `deploy/monitoring/prometheus.yml` | Scrape config |

### Modified Files
| File | Changes |
|------|---------|
| `app/src/app.ts` | Add rate limiter, security headers, error handler, request logger, metrics route, spend route |
| `app/src/openrouter.ts` | Capture token usage, record spend, add operation param, sanitize errors |
| `app/src/pipeline.ts` | Replace bare `catch {}` with logged warnings, propagate operation tags |
| `app/src/config.ts` | Add budget config, startup validation |
| `app/src/db.ts` | Add pool timeouts, export pool stats for metrics |
| `app/src/index.ts` | Startup config log, env validation |
| `app/src/middleware/auth.ts` | timingSafeEqual |
| `app/src/routes/mcp.ts` | timingSafeEqual, session bounds |
| `app/src/routes/oauth.ts` | timingSafeEqual, gate /register |
| `app/src/routes/loops.ts` | Validate loop_type, status |
| `app/src/routes/capture.ts` | Validate parent_id |
| `app/src/routes/chat.ts` | Message count limit, operation tag |
| `app/src/routes/import.ts` | Batch size limit |
| `app/src/routes/review.ts` | Clamp days |
| `app/src/routes/thoughts.ts` | Clamp days |
| `app/src/mcp.ts` | Fix SQL syntax, bulk_import cap, session cleanup |
| `app/src/routes/facts.ts` | Fix SQL syntax |
| `app/src/facts.ts` | Operation tag for embed_fact |
| `app/src/entity-chat.ts` | Operation tag for embed_entity_query |
| `app/src/queue.ts` | Operation tag for embed_loop, job lifecycle logging |
| `app/src/rag.ts` | Operation tag for embed_search, enhanced diagnostics |
| `app/src/entities.ts` | Resolution outcome logging |
| `web/src/api.ts` | Spend API methods |
| `web/src/components/App.tsx` | Spend nav entry |
| `db/init.sql` | ai_usage_log table |
| `Dockerfile` | Non-root USER |
| `deploy/synology/docker-compose.yml` | Localhost port binding, resource limits |

---

## Success Criteria

After implementation:

**Security:**
- [ ] `timingSafeEqual` used in all auth check locations via shared `validateAccessKey` function
- [ ] Dockerfile runs as non-root user
- [ ] Rate limiter covers both `/api/*` (60/min) and `/mcp` (30/min)
- [ ] MCP `capture_thought` and `add_note` enforce `maxContentLength`
- [ ] MCP `weekly_review` days capped at 90, query limited to 500 thoughts
- [ ] MCP `bulk_import` capped at 100 items
- [ ] Hard budget cutoff blocks AI calls when `SPEND_HARD_CUTOFF_USD` exceeded
- [ ] OAuth `redirect_uri` validated against allowlist
- [ ] All broken SQL syntax (stray `)`) fixed and tested

**Observability:**
- [ ] Zero bare `catch {}` blocks in pipeline.ts — every failure is logged
- [ ] Every HTTP request produces a structured JSON log line with method, path, status, latency
- [ ] Every MCP tool invocation produces a structured log line with tool name, latency, success/failure
- [ ] Every OpenRouter call records operation, model, **source**, tokens, latency, success to `ai_usage_log`
- [ ] `weekly_review` (MCP-only, non-streaming) spend is tracked *(was missing in v1)*

**Frontend:**
- [ ] `/api/spend/summary` returns accurate today/month/all-time cost figures
- [ ] SpendView shows cost breakdown by operation, model, **and source (REST vs MCP)**
- [ ] Budget alert banner appears when spend exceeds threshold

**Monitoring:**
- [ ] Prometheus scrapes `/metrics` every 15s, including MCP-specific counters
- [ ] Uptime Kuma sends notification within 60s of service down
- [ ] Grafana dashboard shows four sections (Knowledge Health, AI Spend, **MCP Activity**, System Health)
