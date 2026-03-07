# Open Brain — Architecture Research

> Compiled 2026-03-04
> Source: [Open Brain Guide](https://promptkit.natebjones.com/20260224_uq1_guide_main) by Nate B. Jones

---

## 1. Original Design (Guide Summary)

Open Brain is a personal knowledge management system: capture thoughts,
embed them semantically, extract structured metadata, and expose unified
search to any AI client via MCP.

### 1.1 Original Stack

| Component | Technology | Role |
|-----------|------------|------|
| Database | Supabase (hosted PostgreSQL + pgvector) | Storage, vector search, JSONB filtering |
| Processing | Supabase Edge Functions (Deno) | Ingestion pipeline, MCP server |
| AI Gateway | OpenRouter | Single key for embeddings + LLM extraction |
| Input | Slack bot | Primary capture channel |
| Retrieval | MCP server (4 tools) | AI client interface |

### 1.2 Data Model

```sql
CREATE TABLE thoughts (
    id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    content    TEXT        NOT NULL,
    embedding  vector(1536),
    metadata   JSONB       DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

Metadata fields extracted by LLM:
- `type`: observation | task | idea | reference | person_note
- `topics`: 1–3 subject tags
- `people`: named individuals
- `action_items`: implied to-dos
- `dates_mentioned`: YYYY-MM-DD format

### 1.3 Indexes

- **HNSW** on `embedding` (cosine, m=16, ef_construction=64) — semantic search
- **GIN** on `metadata` (jsonb_path_ops) — structured filtering
- **B-tree** on `created_at DESC` — chronological retrieval

### 1.4 Search Function

`match_thoughts(query_embedding, match_threshold=0.7, match_count=10, filter='{}')`
returns `(id, content, metadata, similarity, created_at)` ordered by cosine distance.

### 1.5 Ingestion Pipeline

Parallel execution on capture:
1. Generate 1536d embedding via `text-embedding-3-small`
2. Extract metadata via `gpt-4o-mini` with JSON schema prompt
3. Await both, INSERT, return confirmation

### 1.6 MCP Tools

| Tool | Purpose | Key Params |
|------|---------|------------|
| `search_thoughts` | Semantic similarity search | `query`, `limit=10`, `threshold=0.5` |
| `list_thoughts` | Recent thoughts + filters | `limit`, `type`, `topic`, `person`, `days` |
| `thought_stats` | Aggregate counts | (none) |
| `capture_thought` | Write from any AI client | `content` |

### 1.7 Supported AI Clients

Claude Desktop, ChatGPT (Developer Mode), Claude Code, Cursor, VS Code
Copilot, Windsurf — via direct HTTP MCP or `mcp-remote` bridge.

### 1.8 Cost

~$0.10–0.30/month for 20 daily captures (embedding + extraction API costs only).

---

## 2. Local-First Adaptation

### 2.1 Key Changes from Original

| Concern | Original | Local Adaptation | Rationale |
|---------|----------|------------------|-----------|
| Database | Supabase cloud | PostgreSQL 16 + pgvector in Docker | Data sovereignty |
| Processing | Edge Functions (Deno) | Single app server (Python/TS) in Docker | Simpler ops |
| Input | Slack (required) | HTTP API primary, Slack optional | Remove hard dependency |
| MCP Server | Separate Edge Function | Built into app server | Single process, lower latency |
| Auth | Supabase service role + `x-brain-key` | `Authorization: Bearer` + Docker network isolation | Standard auth, local security |
| Network | Public Supabase URL | `127.0.0.1:8420` only, DB not exposed to host | Minimize attack surface |

### 2.2 Docker Topology

```
Host Machine
    │
    │  127.0.0.1:8420 (only published port)
    ▼
┌──────────────────────────────────┐
│  Docker Network: brain-net       │
│                                  │
│  app:8420  ◄──────►  db:5432    │
│  (server)             (postgres) │
│                                  │
│  db NOT published to host        │
└──────────────────────────────────┘
```

### 2.3 Environment

```
DB_PASSWORD=          # openssl rand -hex 32
OPENROUTER_API_KEY=   # from openrouter.ai
BRAIN_ACCESS_KEY=     # openssl rand -hex 32
EMBEDDING_MODEL=      # default: openai/text-embedding-3-small
EXTRACTION_MODEL=     # default: openai/gpt-4o-mini
```

---

## 3. Security Analysis

### 3.1 Strengths

- DB bound to Docker internal network only — not reachable from host
- App server bound to `127.0.0.1` — not reachable from LAN
- Least-privilege DB role: `SELECT, INSERT, UPDATE` only (no `DELETE`, no DDL)
- 256-bit entropy access key
- Secrets in `.env`, not hardcoded

### 3.2 Gaps Identified

| ID | Gap | Severity | Recommendation |
|----|-----|----------|----------------|
| S1 | No rate limiting | Medium | Add 60 req/min limit + `max_results` ceiling server-side |
| S2 | No key rotation | Medium | Support multiple active keys (hashed in DB); add `open-brain keys rotate/revoke` CLI |
| S3 | Query-param auth leaks key | Medium | Deprecate `?key=` — key appears in logs, history; log warning when used; truncate key in logs |
| S4 | No TLS on localhost | Low | Offer self-signed cert option for shared machines |
| S5 | No input sanitization | High | Add `MAX_THOUGHT_SIZE` (10k chars); validate JSONB filter keys; harden extraction prompt against injection |
| S6 | No audit log | Medium | Add `access_log` table: `{timestamp, action, tool, key_prefix, result_count}` |
| S7 | No delete capability | Medium | Add soft-delete (`deleted_at` timestamp) via `delete_thought` tool; keeps no-DELETE DB policy |
| S8 | `.env` file permissions | Low | Document `chmod 600 .env`; support Docker secrets as alternative |

---

## 4. Structural Gaps

| ID | Gap | Impact | Recommendation |
|----|-----|--------|----------------|
| G1 | No `source` field | Can't distinguish capture channel | Add `source_channel` + `source_message_id` columns |
| G2 | No deduplication | Same thought stored multiple times | Unique constraint on `(source_channel, source_message_id)` + content hash |
| G3 | No app healthcheck | Docker can't detect app crashes | Add `/health` endpoint + container healthcheck |
| G4 | No migration strategy | Can't evolve schema after first run | Use migration tool (dbmate/alembic); run on startup |
| G5 | No retry on API failure | Lost thoughts on OpenRouter outage | Store with `embedding=NULL`, `status: pending_embedding`; background retry job |
| G6 | Embedding model lock-in | Can't switch models without losing all vectors | Add `embedding_model` column; document re-embedding migration path |
| G7 | No pagination | Unbounded result sets at scale | Cursor-based pagination on `created_at`; return `next_cursor` |

---

## 5. Chat App Extensibility

### 5.1 Adapter Architecture

```
Telegram Bot ──────┐
Slack Events ──────┤
Discord Bot ───────┤──> Adapter Router ──> Capture Pipeline ──> DB
Signal Bridge ─────┤    (normalize,        (embed + classify)
HTTP POST ─────────┤     tag source,
MCP capture ───────┘     dedup)
```

Each adapter handles:
1. Platform auth (bot token, webhook signature verification)
2. Message normalization (strip platform formatting, extract text)
3. Source tagging (`source.channel`, `source.message_id`)
4. Deduplication (check `source_message_id` before forwarding)
5. In-platform acknowledgment (reply with confirmation)

### 5.2 Platform-Specific Notes

| Platform | Transport | Local-Friendly? | Key Considerations |
|----------|-----------|-----------------|-------------------|
| **Telegram** | Long-polling (preferred) or webhook | Yes (long-poll) | Bot API supports long-polling natively — no public URL needed; media messages need separate handling |
| **Discord** | WebSocket gateway | Yes | Gateway connection is outbound; rich embeds for confirmations |
| **Signal** | signald / signal-cli bridge | Yes | No bot API — requires linked phone number; strongest privacy fit |
| **Matrix** | Client-Server API (polling) | Yes | Federated, self-hosted; natural fit; E2EE room support |
| **Slack** | Socket Mode (preferred) or webhook | Yes (Socket Mode) | Socket Mode avoids public URL requirement; original guide's primary channel |
| **WhatsApp** | Business API or Baileys | Partial | Official API needs business account; unofficial libs are fragile |

### 5.3 The Webhook Problem

Webhooks (Telegram, Discord, Slack) require a public HTTPS URL. For local-only:

| Option | Approach | Trade-off |
|--------|----------|-----------|
| **Long-polling / WebSocket** | Outbound connection from adapter; no inbound port | Preferred — no external dependency |
| **Tunnel** | `cloudflared`, `ngrok`, `tailscale funnel` | Adds operational complexity |
| **Hybrid** | Tiny cloud relay forwards to local via tunnel | Keeps DB local but partially defeats local-only |

**Recommendation:** Default to long-polling/WebSocket adapters. Document tunnels as advanced option.

### 5.4 Schema Extensions for Multi-Channel

```sql
ALTER TABLE thoughts ADD COLUMN source_channel TEXT;
ALTER TABLE thoughts ADD COLUMN source_message_id TEXT;
ALTER TABLE thoughts ADD CONSTRAINT uq_source_message
    UNIQUE (source_channel, source_message_id);
```

### 5.5 Media Handling

| Option | Approach | Complexity |
|--------|----------|------------|
| **A — Text only** | Ignore non-text messages | Lowest; matches original guide |
| **B — Transcribe first** | Voice→Whisper, Image→vision model, then store as text thought | Medium; high value for voice memos |
| **C — Store media** | Blob storage volume + richer data model | Highest; full multimedia brain |

**Recommendation:** Start with A, design for B. Voice-to-text is highest ROI extension.

---

## 6. Priority Actions

| Priority | Item | Sections |
|----------|------|----------|
| **P0** | Add `source_channel` + `source_message_id` to schema | G1, 5.4 |
| **P0** | Add input sanitization + content size limits | S5 |
| **P0** | Define adapter interface for chat platform inputs | 5.1 |
| **P0** | Add schema migration strategy | G4 |
| **P1** | Add rate limiting + max result ceiling | S1 |
| **P1** | Add key rotation / multi-key support | S2 |
| **P1** | Add retry + pending-embedding state | G5 |
| **P1** | Deprecate query-param auth | S3 |
| **P1** | Add audit logging | S6 |
| **P1** | Add soft-delete capability | S7 |
| **P2** | Add TLS option for localhost | S4 |
| **P2** | Add pagination cursors | G7 |
| **P2** | Track embedding model per thought | G6 |
| **P2** | Define media handling strategy | 5.5 |

---

## 7. References

| ID | Source |
|----|--------|
| [1] | [Open Brain Guide](https://promptkit.natebjones.com/20260224_uq1_guide_main) — Nate B. Jones |
| [2] | [pgvector](https://github.com/pgvector/pgvector) — PostgreSQL vector similarity extension |
| [3] | [MCP Specification](https://modelcontextprotocol.io) — Model Context Protocol |
| [4] | [OpenRouter](https://openrouter.ai) — Unified AI API gateway |
| [5] | [Telegram Bot API — Long Polling](https://core.telegram.org/bots/api#getupdates) |
| [6] | [Discord Gateway](https://discord.com/developers/docs/events/gateway) |
| [7] | [Slack Socket Mode](https://api.slack.com/apis/socket-mode) |
| [8] | [signald](https://signald.org) — Signal daemon bridge |
| [9] | [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/) |
