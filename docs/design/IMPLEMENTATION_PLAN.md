# Open Brain — Phased Implementation Plan

> Derived from SPEC.md, ARCHITECTURE.md, FRONTEND_DESIGN.md, and OpenBrainUX.md.
> Each phase produces a working, testable artifact before proceeding.

---

## Phase 0: Project Scaffold & Infrastructure

**Goal:** Docker Compose stack boots, database accepts connections, app server responds to health check.

| # | Task | Details |
|---|------|---------|
| 0.1 | Repository structure | Create `docker-compose.yml`, `Dockerfile`, `.env.example`, `src/`, `web/`, `sql/` directories |
| 0.2 | Docker Compose | `db` service (PostgreSQL 16 + pgvector), `app` service (Python or TS), `brain-net` bridge network. DB **not** exposed to host |
| 0.3 | Database init | SQL migration: enable `pgvector` extension, create `thoughts` table (id UUID PK, content TEXT, embedding vector(1536), metadata JSONB, created_at, updated_at) |
| 0.4 | Indexes | HNSW on embedding (cosine), GIN on metadata, B-tree on created_at |
| 0.5 | `match_thoughts()` | SQL function: cosine similarity search with threshold (default 0.7), optional JSONB filter, limit, returns id/content/metadata/similarity |
| 0.6 | App server skeleton | HTTP server on `:8420`, `GET /health` returns `{ status: "ok" }` |
| 0.7 | Auth middleware | Bearer token from `BRAIN_KEY` env var, 401 on mismatch. Applied to all routes except `/health` |
| 0.8 | Environment config | `.env` with `BRAIN_KEY`, `OPENROUTER_API_KEY`, `DATABASE_URL`, `EMBEDDING_MODEL` (default `text-embedding-3-small`) |

**Exit criteria:** `docker compose up` → `curl localhost:8420/health` returns 200.

---

## Phase 1: Ingestion Pipeline

**Goal:** `POST /capture` accepts a thought, generates embedding + metadata in parallel, stores in DB, returns confirmation.

| # | Task | Details |
|---|------|---------|
| 1.1 | OpenRouter client | Wrapper for OpenRouter API: `generate_embedding(text)` → vector(1536), `extract_metadata(text)` → JSONB |
| 1.2 | Embedding generation | Call `text-embedding-3-small` via OpenRouter, return 1536-dim vector |
| 1.3 | Metadata extraction | Call `gpt-4o-mini` via OpenRouter with structured prompt from SPEC.md §Metadata-Extraction-Prompt. Returns `{ type, topics, people, action_items, dates_mentioned, source_context }` |
| 1.4 | Parallel pipeline | Run embedding + metadata extraction concurrently, merge results, INSERT into `thoughts` |
| 1.5 | `POST /capture` | Accept `{ content, source? }`, run pipeline, return `{ id, metadata, created_at }` |
| 1.6 | Input sanitization | Trim whitespace, enforce max content length (50KB), reject empty content (security gap S5) |
| 1.7 | Error handling | Graceful degradation: if metadata extraction fails, store with `metadata: {}` and embedding only |

**Exit criteria:** `curl -X POST /capture -d '{"content":"..."}' -H 'Authorization: Bearer $KEY'` → thought stored, metadata returned.

---

## Phase 2: Query & Search API

**Goal:** Full read API: semantic search, listing, stats.

| # | Task | Details |
|---|------|---------|
| 2.1 | `POST /search` | Accept `{ query, threshold?, filter?, limit? }`, embed query, call `match_thoughts()`, return ranked results with similarity scores |
| 2.2 | `GET /thoughts` | List thoughts with pagination (cursor-based on `created_at`), optional filters: `type`, `topic`, `person`, `days`, `source` |
| 2.3 | `GET /thoughts/:id` | Single thought by UUID |
| 2.4 | `GET /stats` | Aggregate stats: total count, type breakdown, topic frequency (top 20), people frequency (top 20), source breakdown, thoughts-per-day (last 30 days) |
| 2.5 | `DELETE /thoughts/:id` | Soft-delete: set `deleted_at` timestamp, exclude from all queries (security gap S7, structural gap G5) |
| 2.6 | Pagination | Cursor-based pagination for `/thoughts` and `/search` (structural gap G7) |

**Exit criteria:** All endpoints return correct data. Semantic search returns relevant results ranked by similarity.

---

## Phase 3: Bulk Import & Weekly Review

**Goal:** Mass ingest existing notes and generate periodic synthesis.

| # | Task | Details |
|---|------|---------|
| 3.1 | `POST /import` | Accept `{ thoughts: [{ content, source?, created_at? }], normalize? }`. Process sequentially or batched |
| 3.2 | Normalization | When `normalize: true`, rewrite each thought via LLM to add context (per SPEC.md §Bulk-Import). Preserve original as `metadata.original_content` |
| 3.3 | Deduplication | Content hash check before insert, skip exact duplicates (structural gap G2) |
| 3.4 | Progress reporting | Return `{ imported, skipped, errors }` counts |
| 3.5 | Weekly review | `GET /review` → LLM-generated synthesis: themes, open action items, people frequency, cross-topic connections, suggested follow-ups (per SPEC.md §Weekly-Review tool) |
| 3.6 | Source field | Track origin of each thought: `web`, `mcp`, `slack`, `import`, `api` (structural gap G1) |

**Exit criteria:** Import 100+ notes from a markdown/JSON export. Weekly review returns coherent synthesis.

---

## Phase 4: MCP Server

**Goal:** Expose Open Brain as an MCP tool server consumable by Claude Desktop, Claude Code, Cursor, and ChatGPT.

| # | Task | Details |
|---|------|---------|
| 4.1 | MCP transport | HTTP+SSE transport on `/mcp` path (same `:8420` server). Also support stdio for local clients |
| 4.2 | `search_thoughts` | Semantic search tool: `query` (required), `threshold` (optional, 0.0-1.0), `filter` (optional JSONB) |
| 4.3 | `list_thoughts` | Chronological listing: `type`, `topic`, `person`, `days`, `limit` filters |
| 4.4 | `thought_stats` | Return aggregate statistics |
| 4.5 | `capture_thought` | Capture a new thought from AI client context: `content` (required), `source` (auto-set to `mcp`) |
| 4.6 | `bulk_import` | Import array of thoughts with optional normalization |
| 4.7 | `weekly_review` | Generate synthesis report |
| 4.8 | Client configs | Generate config snippets for Claude Desktop (`claude_desktop_config.json`), Claude Code (`claude_code_config.json`), Cursor/VS Code (via `mcp-remote`) |

**Exit criteria:** Claude Desktop can `search_thoughts`, `capture_thought`, and `weekly_review` via MCP.

---

## Phase 5: Frontend — Core Views

**Goal:** Web UI on `localhost:8420` with Stream, Search, and Detail Panel.

| # | Task | Details |
|---|------|---------|
| 5.1 | Build toolchain | Vite + SolidJS (or Preact), Tailwind CSS, output to `dist/` → served as static from app container |
| 5.2 | API client | `api.ts`: typed fetch wrapper using Bearer auth, endpoints for search/thoughts/stats/capture |
| 5.3 | Auth gate | Login screen: access key input → validate via `GET /stats` → store in `localStorage` as `brain_access_key` |
| 5.4 | App shell | Persistent top search bar, 5-tab nav (Stream, Search, Topics, People, Stats), responsive layout |
| 5.5 | ThoughtCard | Type icon, timestamp, 3-line content preview, topic/people chips, action item indicator, source badge |
| 5.6 | Stream view | Reverse-chronological feed grouped by date, infinite scroll with cursor pagination |
| 5.7 | Search view | Semantic search with similarity bars (color-coded: green >90%, yellow 70-90%, gray <70%), threshold slider |
| 5.8 | Detail panel | Slide-in from right: full markdown content (GFM + syntax highlighting + copy button), metadata bar, action items, related thoughts (auto-query top 3-5) |
| 5.9 | Markdown renderer | `marked` + `highlight.js`, task lists, tables, code blocks with language badge and copy button, lazy images |
| 5.10 | Dark/light theme | Dark default, toggle in header, CSS variables, `prefers-color-scheme` support |

**Exit criteria:** Browse thoughts, search semantically, read full content with rich rendering, navigate via chips.

---

## Phase 6: Frontend — Remaining Views & Capture

**Goal:** Complete all 5 views, add Quick Capture bar, keyboard navigation.

| # | Task | Details |
|---|------|---------|
| 6.1 | Topics view | Topic cloud (sized by frequency), click to filter thought list below |
| 6.2 | People view | Person cards (name, count, last-seen), click to filter |
| 6.3 | Stats view | 4 metric cards, 30-day activity chart, type breakdown pie, top topics bar, source breakdown |
| 6.4 | Quick Capture bar | Persistent footer textarea (grows 1-6 lines), Ctrl+Enter submit, markdown preview toggle, metadata confirmation on submit |
| 6.5 | Filter bar | Structured filter mode: `type:task topic:api person:Sarah days:7`, AND logic for multiple chips |
| 6.6 | Keyboard shortcuts | `/` focus search, `Escape` close panel, `j`/`k` navigate, `Enter` open, `n` new capture, `1-5` switch tabs |
| 6.7 | Responsive design | Desktop two-column, tablet sheet overlay, mobile full-screen |
| 6.8 | URL routing | All views bookmarkable: `/`, `/search?q=...&threshold=`, `/topics?selected=`, `/people?selected=`, `/stats`, `/thought/:id` |
| 6.9 | Empty states | Contextual messages per view guiding new users |
| 6.10 | Microinteractions | Card slide on capture, staggered result fade-in, delete undo toast, similarity bar animation |

**Exit criteria:** Full SPA operational. All keyboard shortcuts work. Responsive across breakpoints. <50KB gzipped, <500ms FCP.

---

## Phase 7: Hardening & Security

**Goal:** Close all identified security and structural gaps.

| # | Task | Details |
|---|------|---------|
| 7.1 | Rate limiting | Per-IP and per-token rate limits on all endpoints (security gap S1) |
| 7.2 | Key rotation | Support `BRAIN_KEY_OLD` for graceful key rotation (security gap S2) |
| 7.3 | Audit logging | Log all write operations with timestamp, source, action (security gap S6) |
| 7.4 | DB role restrictions | App connects with limited-privilege role, no DDL permissions (security gap S4) |
| 7.5 | Health check | `GET /health` includes DB connectivity and OpenRouter reachability checks (structural gap G3) |
| 7.6 | Migration system | Versioned SQL migrations with up/down, tracked in `schema_migrations` table (structural gap G4) |
| 7.7 | Retry logic | Exponential backoff for OpenRouter API failures (structural gap G5) |
| 7.8 | Embedding model tracking | Store model name in metadata for future-proofing (structural gap G6) |
| 7.9 | Content-Security-Policy | CSP headers for frontend, prevent XSS via served content |

**Exit criteria:** All S1-S8 and G1-G7 gaps from ARCHITECTURE.md resolved.

---

## Phase 8: Chat Adapters & Extensions (Optional)

**Goal:** Multi-channel capture beyond web and MCP.

| # | Task | Details |
|---|------|---------|
| 8.1 | Adapter interface | Common adapter interface: `receive(message) → capture`, `send(response) → channel` |
| 8.2 | Telegram adapter | Long-polling bot, capture on message, reply with metadata confirmation |
| 8.3 | Slack adapter | Socket Mode or Events API, capture on DM, thread-aware |
| 8.4 | Discord adapter | Bot with slash commands: `/capture`, `/search`, `/review` |
| 8.5 | Backup/export | `GET /export` → full JSON dump. Scheduled backup to local file |
| 8.6 | Capture templates | Pre-built prompts: Decision, Person Note, Insight, Meeting Debrief, AI Save (per SPEC.md §Capture-Templates) |

**Exit criteria:** At least one chat adapter functional. Export produces valid JSON restorable via `/import`.

---

## Dependency Graph

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3
                │                       │
                ▼                       ▼
             Phase 4              Phase 7
                │
                ▼
             Phase 5 ──► Phase 6
                            │
                            ▼
                         Phase 8
```

- **Phases 0→1→2** are strictly sequential (each builds on prior)
- **Phase 3** (bulk import/review) requires Phase 2 (query API)
- **Phase 4** (MCP) requires Phase 1 (ingestion) but can parallel Phase 2-3
- **Phase 5→6** (frontend) requires Phase 2 (all API endpoints)
- **Phase 7** (hardening) can begin after Phase 2, runs in parallel with frontend
- **Phase 8** (chat adapters) is optional and independent after Phase 1

---

## Tech Stack Summary

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Database | PostgreSQL 16 + pgvector | Vector search + relational in one DB |
| App server | Python (FastAPI) or TypeScript (Hono/Express) | Single process, async-capable |
| AI gateway | OpenRouter | Model-agnostic, single API key |
| Embedding | text-embedding-3-small (1536-dim) | Cost-effective, good quality |
| Metadata LLM | gpt-4o-mini | Fast, cheap structured extraction |
| MCP | HTTP+SSE + stdio | Compatible with all major AI clients |
| Frontend | SolidJS + Tailwind + Vite | <10KB bundle, reactive, fast |
| Container | Docker Compose | Single-command deploy, data sovereignty |

---

## Estimated Effort

| Phase | Scope | Relative Size |
|-------|-------|---------------|
| 0 | Infrastructure | Small |
| 1 | Ingestion | Small |
| 2 | Query API | Medium |
| 3 | Import/Review | Medium |
| 4 | MCP Server | Medium |
| 5 | Frontend Core | Large |
| 6 | Frontend Complete | Large |
| 7 | Hardening | Medium |
| 8 | Extensions | Variable |

---

*This plan is a living document. Update as implementation reveals new constraints or opportunities.*
