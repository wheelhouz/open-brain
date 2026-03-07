# Open Brain — Local-First Design Specification

> NLSpec v1.1 | 2026-03-04
> Adapted from the [Open Brain Guide](https://promptkit.natebjones.com/20260224_uq1_guide_main) by Nate B. Jones

---

## 0. Document Conventions

This specification uses NLSpec (Natural Language Specification) format:

- **SHALL** — mandatory requirement
- **SHOULD** — recommended but not required
- **MAY** — optional capability
- **[REF:x]** — reference to source material (see Section 11)

All design decisions trace back to the original Open Brain guide unless
explicitly marked as **[ADAPTATION]** — meaning a deliberate change for the
local-first architecture.

---

## 1. Purpose

Open Brain is a personal knowledge management system that captures thoughts,
generates semantic embeddings, extracts structured metadata, and exposes a
unified search interface to any AI client via MCP (Model Context Protocol).

The original guide runs on Supabase cloud infrastructure. This spec adapts
that design for **local-only execution** inside Docker, keeping all brain
data on the user's machine. [REF:1]

### 1.1 Design Principles

| Principle | Description |
|-----------|-------------|
| Local-first | All data stays on the user's machine. No cloud database. |
| One database | Single PostgreSQL + pgvector instance. [REF:2] |
| One AI gateway | Single API key provides access to embedding + LLM models. [REF:2] |
| MCP-native | Any AI client with MCP support can read/write the brain. [REF:3] |
| Minimal stack | No middleware, no SaaS chains, no orchestrators. [REF:4] |
| Cross-pollination | Every connected AI shares the same memory — a thought captured in Claude is searchable from ChatGPT, Cursor, or any other client. [REF:15] |

### 1.2 Onboarding Sequence

The companion prompt kit defines a five-step onboarding workflow that
SHOULD be followed during initial setup. [REF:15]

| Step | Prompt | Purpose |
|------|--------|---------|
| 1 | Memory Migration | Extract accumulated memories from existing AI tools into the brain |
| 2 | Second Brain Migration | Import notes from Notion, Obsidian, Apple Notes, etc. |
| 3 | Open Brain Spark | Interview-based discovery of personalized use cases |
| 4 | Quick Capture Templates | Learn structured capture patterns for daily use |
| 5 | Weekly Review | Ongoing synthesis ritual (recurring) |

Steps 1–4 run once during setup week. Step 5 becomes a recurring workflow.

---

## 2. Architecture Overview

```
+----------------------------------------------------------+
|  Docker Compose Stack                                    |
|                                                          |
|  +------------------+    +----------------------------+  |
|  |  PostgreSQL 16   |    |  open-brain-server         |  |
|  |  + pgvector      |<-->|  (capture + MCP endpoint)  |  |
|  |  port: 5432      |    |  port: 8420                |  |
|  +------------------+    +----------------------------+  |
|           |                        |                     |
|           |              +---------+---------+           |
|           |              |                   |           |
|           v              v                   v           |
|     [HNSW index]   [OpenRouter]       [MCP clients]     |
|     [GIN index]    (AI gateway)       via HTTP/stdio     |
+----------------------------------------------------------+
```

### 2.1 Components

| Component | Original (Guide) | Local Adaptation | Rationale |
|-----------|-------------------|------------------|-----------|
| Database | Supabase (hosted PostgreSQL) | PostgreSQL 16 + pgvector in Docker | Data sovereignty [ADAPTATION] |
| Processing | Supabase Edge Functions (Deno) | Single application server (Python or TypeScript) in Docker | Simpler ops, no Deno runtime needed [ADAPTATION] |
| AI Gateway | OpenRouter | OpenRouter (unchanged) | Model flexibility [REF:2] |
| Input | Slack bot | HTTP API (Slack remains optional integration) | Remove hard Slack dependency [ADAPTATION] |
| MCP Server | Supabase Edge Function | Built into application server | Single process, lower latency [ADAPTATION] |
| Auth | Supabase service role + MCP access key | Bearer token + Docker network isolation | Local security model [ADAPTATION] |

---

## 3. Data Model

### 3.1 `thoughts` Table

The system SHALL implement the following schema, matching the original guide. [REF:5]

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE thoughts (
    id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    content    TEXT        NOT NULL,
    embedding  vector(1536),
    metadata   JSONB       DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

### 3.2 Indexes

The system SHALL create these indexes for search performance. [REF:5]

```sql
-- Semantic similarity search (HNSW for approximate nearest neighbor)
CREATE INDEX idx_thoughts_embedding
    ON thoughts
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Metadata filtering (GIN for JSONB containment queries)
CREATE INDEX idx_thoughts_metadata
    ON thoughts
    USING gin (metadata jsonb_path_ops);

-- Chronological retrieval
CREATE INDEX idx_thoughts_created_at
    ON thoughts (created_at DESC);
```

### 3.3 Metadata Structure

The metadata JSONB column SHALL contain the following fields, extracted by
LLM during ingestion. [REF:6]

```json
{
    "type": "observation | task | idea | reference | person_note | decision | meeting_note",
    "topics": ["topic1", "topic2"],
    "people": ["Alice", "Bob"],
    "action_items": ["Follow up on X"],
    "dates_mentioned": ["2026-03-04"],
    "source_context": "ai_save | meeting | migration | manual"
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `type` | string | One of: `observation`, `task`, `idea`, `reference`, `person_note`, `decision`, `meeting_note` [REF:15] |
| `topics` | string[] | 1–3 subject tags |
| `people` | string[] | Named individuals mentioned |
| `action_items` | string[] | Implied to-dos |
| `dates_mentioned` | string[] | YYYY-MM-DD format |
| `source_context` | string | Optional. Capture context hint: `ai_save` (saved from AI conversation), `meeting` (meeting debrief), `migration` (imported from another system), `manual` (direct capture). Inferred from content patterns or set explicitly. [REF:15] |

The `decision` and `meeting_note` types are additions derived from the
companion prompt kit's capture templates, which demonstrate that these are
distinct thought patterns with different retrieval needs. [REF:15]

### 3.4 Search Function

The system SHALL implement a `match_thoughts` function for vector similarity
search with metadata filtering. [REF:7]

```sql
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
        1 - (t.embedding <=> query_embedding) AS similarity,
        t.created_at
    FROM thoughts t
    WHERE
        1 - (t.embedding <=> query_embedding) > match_threshold
        AND (filter = '{}'::jsonb OR t.metadata @> filter)
    ORDER BY t.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
```

---

## 4. Ingestion Pipeline

When a thought is submitted, the system SHALL process it through parallel
embedding and metadata extraction — matching the original guide's approach
of simultaneous processing to reduce latency. [REF:8]

### 4.1 Flow

```
Input (HTTP POST /capture)
    │
    ├──> [1] Generate embedding ──────────> text-embedding-3-small (1536d)
    │                                        via OpenRouter
    ├──> [2] Extract metadata ────────────> gpt-4o-mini with JSON schema
    │                                        via OpenRouter
    │
    └──> [3] Await both, INSERT into DB ──> Return confirmation
```

Steps [1] and [2] SHALL execute concurrently. [REF:8]

### 4.2 Capture Endpoint

```
POST /capture
Authorization: Bearer <BRAIN_ACCESS_KEY>
Content-Type: application/json

{
    "content": "Met with Sarah about the Q2 roadmap. She thinks we should prioritize the API rewrite."
}
```

Response:

```json
{
    "id": "a1b2c3d4-...",
    "metadata": {
        "type": "person_note",
        "topics": ["roadmap", "api"],
        "people": ["Sarah"],
        "action_items": ["Prioritize API rewrite"],
        "dates_mentioned": []
    },
    "created_at": "2026-03-04T14:22:00Z"
}
```

### 4.3 Metadata Extraction Prompt

The system SHALL use a structured prompt to extract metadata, sending it to
the LLM with a JSON schema constraint. [REF:6]

```
You are a thought classifier. Given the following thought, extract structured
metadata. Respond ONLY with valid JSON matching this schema:

{
    "type": one of "observation", "task", "idea", "reference", "person_note", "decision", "meeting_note",
    "topics": 1-3 subject tags as strings,
    "people": names of individuals mentioned (empty array if none),
    "action_items": implied to-dos (empty array if none),
    "dates_mentioned": dates in YYYY-MM-DD format (empty array if none),
    "source_context": one of "ai_save", "meeting", "migration", "manual" or null
}

Classification hints:
- "Decision: ..." → type: decision
- "Meeting with ..." → type: meeting_note, source_context: meeting
- "Saving from [tool]: ..." → source_context: ai_save
- "Insight: ..." → type: idea
- "[Name] — ..." → type: person_note

Thought: <content>
```

### 4.4 Embedding Model

| Parameter | Value |
|-----------|-------|
| Model | `openai/text-embedding-3-small` (via OpenRouter) |
| Dimensions | 1536 |
| Similarity metric | Cosine distance |

The system SHOULD allow the embedding model to be configurable via
environment variable, supporting future model changes. [ADAPTATION]

### 4.5 Capture Templates

The companion prompt kit defines structured sentence patterns that optimize
metadata extraction. The system SHOULD document these as recommended input
formats. [REF:15]

| Template | Pattern | Extracted Metadata |
|----------|---------|-------------------|
| **Decision** | `Decision: [outcome]. Context: [why]. Owner: [who].` | `type: decision`, people from Owner, topics from context |
| **Person Note** | `[Name] — [what you learned].` | `type: person_note`, people from Name |
| **Insight** | `Insight: [realization]. Triggered by: [origin].` | `type: idea`, topics from origin |
| **Meeting Debrief** | `Meeting with [who] about [topic]. Key points: [details]. Action items: [next steps].` | `type: meeting_note`, people, topics, action_items |
| **AI Save** | `Saving from [tool]: [takeaway].` | `source_context: ai_save`, content from takeaway |

These templates are not enforced — freeform text remains the primary input
mode. The templates help users develop muscle memory for captures that
produce richer metadata. The extraction prompt (Section 4.3) SHALL
recognize these patterns and extract metadata accordingly.

### 4.6 Bulk Import Pipeline

The system SHALL support batch import of multiple thoughts in a single
request, enabling migration from existing knowledge systems. [REF:15]

#### 4.6.1 Import Endpoint

```
POST /import
Authorization: Bearer <BRAIN_ACCESS_KEY>
Content-Type: application/json

{
    "thoughts": [
        { "content": "...", "source_context": "migration" },
        { "content": "...", "source_context": "migration" }
    ],
    "options": {
        "normalize": true,
        "source_label": "obsidian"
    }
}
```

Response:

```json
{
    "imported": 42,
    "failed": 1,
    "errors": [
        { "index": 17, "error": "content exceeds max length" }
    ]
}
```

#### 4.6.2 Content Normalization

When `normalize: true` is set, each thought SHALL be passed through an LLM
rewriting step before storage. The normalization prompt ensures that
imported content is self-contained — another AI reading the thought with
zero prior context should understand what it means. [REF:15]

Normalization prompt:

```
Rewrite the following note as a standalone statement. Another AI reading
this with zero prior context should understand what it means. Preserve all
factual content, names, dates, and specifics. Do not add information that
is not present. If the note is already self-contained, return it unchanged.

Note: <content>
```

This adds a third LLM call per imported thought (normalization + embedding
+ metadata extraction). For large imports, the system SHOULD process
thoughts in configurable batches (default: 10 concurrent) with progress
reporting.

#### 4.6.3 Supported Import Sources

The import endpoint accepts raw text. Source-specific parsing (CSV rows,
markdown files, JSON exports) is handled client-side by AI clients using
the companion prompts. The system provides the bulk endpoint; the AI
provides the transformation logic. [REF:15]

| Source | Parsing Strategy | Companion Prompt |
|--------|------------------|-----------------|
| AI memories (Claude, ChatGPT) | AI extracts its own stored memories via conversation, categorizes by type, sends each as a separate thought | Memory Migration (Prompt 1) |
| Notion | Export as markdown/CSV, AI chunks by block/row, rewrites for context | Second Brain Migration (Prompt 2) |
| Obsidian | Export vault as markdown, AI chunks by note/heading, rewrites for context | Second Brain Migration (Prompt 2) |
| Apple Notes | Export as text, AI chunks by note, rewrites for context | Second Brain Migration (Prompt 2) |

---

## 5. MCP Server

The system SHALL expose an MCP-compliant server that AI clients can connect
to for searching, listing, aggregating, and capturing thoughts. [REF:3]

### 5.1 Transport

| Method | Endpoint | Use Case |
|--------|----------|----------|
| HTTP (Streamable HTTP) | `http://localhost:8420/mcp` | Claude Desktop, ChatGPT, remote clients |
| stdio | `open-brain-mcp` binary/script | Claude Code, Cursor, VS Code, local CLI tools |

The HTTP transport SHALL be the primary interface. The system SHOULD also
provide a stdio wrapper for clients that require it. [ADAPTATION]

### 5.2 Authentication

Every MCP request SHALL be authenticated. [REF:9]

| Method | Mechanism |
|--------|-----------|
| HTTP header | `Authorization: Bearer <BRAIN_ACCESS_KEY>` |
| Query parameter | `?key=<BRAIN_ACCESS_KEY>` (fallback for clients that cannot set headers) |

The original guide uses `x-brain-key` header. This spec uses standard
`Authorization: Bearer` as primary and retains query-param as fallback.
[ADAPTATION]

### 5.3 MCP Tools

The system SHALL expose six tools — the four from the original guide plus
two additions derived from the companion prompt kit. [REF:3] [REF:15]

#### 5.3.1 `search_thoughts`

Semantic search over the brain.

```json
{
    "name": "search_thoughts",
    "description": "Search thoughts by semantic similarity to a natural language query.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "query":     { "type": "string", "description": "Natural language search query" },
            "limit":     { "type": "number", "default": 10, "description": "Max results to return" },
            "threshold": { "type": "number", "default": 0.5, "description": "Minimum similarity score (0-1)" }
        },
        "required": ["query"]
    }
}
```

Implementation: embed the query string, call `match_thoughts()`, return
ranked results with similarity percentages.

#### 5.3.2 `list_thoughts`

Recent thoughts with optional metadata filters.

```json
{
    "name": "list_thoughts",
    "description": "List recent thoughts with optional filters.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "limit":  { "type": "number", "default": 20 },
            "type":   { "type": "string", "description": "Filter by thought type" },
            "topic":  { "type": "string", "description": "Filter by topic" },
            "person": { "type": "string", "description": "Filter by mentioned person" },
            "days":   { "type": "number", "description": "Only thoughts from last N days" }
        }
    }
}
```

#### 5.3.3 `thought_stats`

Aggregate statistics across the brain.

```json
{
    "name": "thought_stats",
    "description": "Get aggregate statistics about captured thoughts.",
    "inputSchema": {
        "type": "object",
        "properties": {}
    }
}
```

Returns: counts by type, top topics, top people, date range, total count.

#### 5.3.4 `capture_thought`

Write a thought from any connected AI client — same pipeline as the HTTP
capture endpoint. [REF:3]

```json
{
    "name": "capture_thought",
    "description": "Capture a new thought. Generates embedding and extracts metadata automatically.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "content": { "type": "string", "description": "The thought to capture" }
        },
        "required": ["content"]
    }
}
```

#### 5.3.5 `bulk_import`

Batch import thoughts from external sources — used during migration
workflows. [REF:15]

```json
{
    "name": "bulk_import",
    "description": "Import multiple thoughts at once. Used for migrating from other knowledge systems (Notion, Obsidian, AI memories, etc.). Each thought is embedded and classified automatically.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "thoughts": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Array of thought content strings to import"
            },
            "normalize": {
                "type": "boolean",
                "default": true,
                "description": "Rewrite each thought to be self-contained before storing"
            },
            "source_label": {
                "type": "string",
                "description": "Origin system label (e.g., 'obsidian', 'notion', 'claude_memory')"
            }
        },
        "required": ["thoughts"]
    }
}
```

Implementation: calls `POST /import` internally. Returns count of
imported/failed thoughts. When `normalize` is true, each thought is
rewritten for standalone clarity before embedding and classification.

#### 5.3.6 `weekly_review`

Generate a synthesis of the past week's thoughts — themes, open action
items, patterns, and suggested focus areas. [REF:15]

```json
{
    "name": "weekly_review",
    "description": "Synthesize the past week's captured thoughts into themes, open action items, mention frequency, cross-topic connections, and suggested focus areas.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "days": {
                "type": "number",
                "default": 7,
                "description": "Number of days to review (default: 7)"
            }
        }
    }
}
```

Implementation:

1. Retrieve all thoughts from the last N days via `list_thoughts`
2. Cluster by topic — group thoughts that share topic tags or have high
   pairwise semantic similarity (>0.8)
3. Scan for unresolved action items across all thoughts
4. Rank people by mention frequency
5. Detect cross-topic connections — thoughts that bridge two otherwise
   separate topic clusters
6. Return structured review data:

```json
{
    "period": { "from": "2026-02-25", "to": "2026-03-04" },
    "total_thoughts": 28,
    "themes": [
        { "topic": "architecture", "count": 8, "summary": "..." },
        { "topic": "hiring", "count": 5, "summary": "..." }
    ],
    "open_action_items": [
        { "item": "Prioritize API rewrite", "from_thought": "a1b2c3...", "age_days": 3 }
    ],
    "top_people": [
        { "name": "Sarah", "mentions": 6 },
        { "name": "Mike", "mentions": 4 }
    ],
    "connections": [
        { "between": ["architecture", "hiring"], "bridging_thought": "d4e5f6..." }
    ],
    "suggested_focus": ["Resolve API rewrite decision", "Follow up with Sarah"]
}
```

The `summary` field within each theme is generated by sending the cluster's
thoughts to the extraction LLM with a summarization prompt. The
`suggested_focus` field is derived from high-frequency unresolved action
items and recently active topics.

---

## 6. AI Client Integration

The system SHALL be connectable from any MCP-capable AI client. [REF:3]

### 6.1 Claude Desktop

```json
// Settings → MCP Servers (or claude_desktop_config.json)
{
    "mcpServers": {
        "open-brain": {
            "url": "http://localhost:8420/mcp",
            "headers": {
                "Authorization": "Bearer <BRAIN_ACCESS_KEY>"
            }
        }
    }
}
```

### 6.2 Claude Code

```bash
claude mcp add --transport http open-brain \
    http://localhost:8420/mcp \
    --header "Authorization: Bearer <BRAIN_ACCESS_KEY>"
```

### 6.3 Cursor / VS Code Copilot / Windsurf

These editors require `mcp-remote` as a stdio-to-HTTP bridge when they do
not natively support HTTP MCP transport. [REF:10]

```json
{
    "mcpServers": {
        "open-brain": {
            "command": "npx",
            "args": [
                "mcp-remote",
                "http://localhost:8420/mcp",
                "--header",
                "Authorization: Bearer <BRAIN_ACCESS_KEY>"
            ]
        }
    }
}
```

### 6.4 ChatGPT

Requires paid plan with Developer Mode enabled. Configure as a custom
connector pointing to the MCP endpoint with the access key as a query
parameter. [REF:10]

---

## 7. Security Model

### 7.1 Requirements

| Requirement | Implementation |
|-------------|----------------|
| Brain data SHALL NOT leave the local machine | PostgreSQL bound to Docker internal network only [ADAPTATION] |
| MCP endpoint SHALL require authentication | Bearer token on every request [REF:9] |
| Database SHALL NOT be exposed to host network | Docker network isolation; only the app server port (8420) is published [ADAPTATION] |
| Access key SHALL be cryptographically random | 64-character hex string (256-bit entropy) [REF:9] |
| Secrets SHALL NOT be hardcoded | Loaded from `.env` file, never committed to VCS [ADAPTATION] |

### 7.2 Docker Network Topology

```
Host Machine
    │
    │  localhost:8420 (published)
    │
    ▼
┌──────────────────────────────┐
│  Docker Network: brain-net   │
│  (internal bridge)           │
│                              │
│  app:8420 ◄──► db:5432      │
│                              │
│  db is NOT published to host │
└──────────────────────────────┘
```

- The PostgreSQL container SHALL only be accessible within the Docker
  network. [ADAPTATION]
- The application server SHALL be the only container with a published port.
- The application server MAY optionally bind to `127.0.0.1` only (not
  `0.0.0.0`) for additional host-level isolation.

### 7.3 Database Roles

```sql
-- Application role with minimum required privileges
CREATE ROLE brain_app WITH LOGIN PASSWORD '<generated>';
GRANT USAGE ON SCHEMA public TO brain_app;
GRANT SELECT, INSERT, UPDATE ON thoughts TO brain_app;
GRANT EXECUTE ON FUNCTION match_thoughts TO brain_app;
```

The system SHOULD NOT use the PostgreSQL superuser for application queries. [ADAPTATION]

### 7.4 Data at Rest

- The PostgreSQL data directory SHALL be stored in a named Docker volume
  (`brain-data`).
- The system SHOULD document how to enable PostgreSQL TDE (Transparent Data
  Encryption) or LUKS-encrypted volume mounts for users who require
  encryption at rest. [ADAPTATION]

---

## 8. Deployment

### 8.1 Docker Compose

```yaml
# docker-compose.yml
services:
  db:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_DB: open_brain
      POSTGRES_USER: brain_app
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - brain-data:/var/lib/postgresql/data
      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    networks:
      - brain-net
    # No 'ports:' — intentionally not exposed to host

  app:
    build: ./app
    restart: unless-stopped
    ports:
      - "127.0.0.1:8420:8420"
    environment:
      DATABASE_URL: postgresql://brain_app:${DB_PASSWORD}@db:5432/open_brain
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
      BRAIN_ACCESS_KEY: ${BRAIN_ACCESS_KEY}
      EMBEDDING_MODEL: ${EMBEDDING_MODEL:-openai/text-embedding-3-small}
      EXTRACTION_MODEL: ${EXTRACTION_MODEL:-openai/gpt-4o-mini}
    depends_on:
      db:
        condition: service_healthy
    networks:
      - brain-net

volumes:
  brain-data:

networks:
  brain-net:
    driver: bridge
```

### 8.2 Environment Variables

```bash
# .env (NEVER commit this file)
DB_PASSWORD=            # Generated: openssl rand -hex 32
OPENROUTER_API_KEY=     # From openrouter.ai dashboard
BRAIN_ACCESS_KEY=       # Generated: openssl rand -hex 32
EMBEDDING_MODEL=        # Optional override (default: openai/text-embedding-3-small)
EXTRACTION_MODEL=       # Optional override (default: openai/gpt-4o-mini)
```

### 8.3 Initialization Script

The file `db/init.sql` SHALL contain:
- The `CREATE EXTENSION vector` statement
- The `thoughts` table definition (Section 3.1)
- All indexes (Section 3.2)
- The `match_thoughts` function (Section 3.4)

### 8.4 Startup

```bash
# Generate secrets (first time only)
echo "DB_PASSWORD=$(openssl rand -hex 32)" >> .env
echo "BRAIN_ACCESS_KEY=$(openssl rand -hex 32)" >> .env

# Add your OpenRouter key
echo "OPENROUTER_API_KEY=sk-or-..." >> .env

# Launch
docker compose up -d
```

---

## 9. Cost Estimate

Matching the original guide's estimate for ~20 thoughts per day. [REF:11]

| Resource | Cost |
|----------|------|
| PostgreSQL (local Docker) | $0.00 |
| Embeddings (~20/day via OpenRouter) | ~$0.02/mo |
| Metadata extraction (~20/day via OpenRouter) | ~$0.15/mo |
| Docker runtime | Negligible (local CPU/RAM) |
| **Total** | **~$0.10–0.30/mo** |

The only ongoing cost is the OpenRouter API usage for embeddings and
metadata extraction. The database and compute are free since they run
locally. [ADAPTATION]

---

## 10. Optional Extensions

These capabilities are NOT required for the core system but MAY be
implemented to extend functionality.

### 10.1 Slack Integration

The original guide uses Slack as the primary input channel. [REF:2] This
system MAY support Slack by adding a webhook listener to the application
server.

| Config | Value |
|--------|-------|
| Slack Bot Token | `SLACK_BOT_TOKEN` (xoxb- prefix) |
| Capture Channel | `SLACK_CAPTURE_CHANNEL` (C- prefix) |
| Required Scopes | `channels:history`, `groups:history`, `chat:write` |

### 10.2 Backup & Export

The system SHOULD provide a mechanism to export all thoughts as JSON or CSV:

```bash
docker compose exec db pg_dump -U brain_app -t thoughts --data-only open_brain > backup.sql
```

### 10.3 Web UI

The system MAY include a lightweight web interface for browsing and
searching thoughts outside of AI clients.

### 10.4 Usage Patterns

The Open Brain Spark companion prompt identifies five core usage patterns
that inform system design and help users discover personalized workflows.
[REF:15]

| Pattern | Description | System Implication |
|---------|-------------|-------------------|
| **Save This** | Preserve valuable AI-generated insights mid-conversation | `capture_thought` with `source_context: ai_save`; low-friction capture is critical |
| **Before I Forget** | Capture fresh context, observations, and fleeting ideas | Quick capture (web UI, chat apps) must be < 2 seconds to confirmation |
| **Cross-Pollinate** | Search thoughts from Tool A while working in Tool B | MCP multi-client support is the core enabler; every client sees the same brain |
| **Build the Thread** | Compound insight over time — connect today's thought to last month's | `search_thoughts` similarity matching + `weekly_review` pattern detection |
| **People Context** | Store relationship details, preferences, and conversation history per person | `person_note` type + People view in UI + `list_thoughts` person filter |

These patterns are NOT features to implement — they are user behaviors the
system already supports through its existing tools. The Spark prompt helps
users recognize and adopt them.

### 10.5 Local Embedding Models

For fully offline operation, the system MAY support local embedding models
(e.g., via Ollama) as an alternative to OpenRouter. This would require
changing the embedding dimension and rebuilding the HNSW index. [ADAPTATION]

---

## 11. References

| ID | Source | Description |
|----|--------|-------------|
| REF:1 | [Open Brain Guide — Main](https://promptkit.natebjones.com/20260224_uq1_guide_main) | Primary source for all architecture and design decisions |
| REF:2 | Guide, Part 1: Capture | "One database, one AI gateway, one chat channel. Any AI you use can plug in." |
| REF:3 | Guide, Part 2: Retrieval | MCP server design with four tools: search, list, stats, capture |
| REF:4 | Guide, Key Design Decisions | "No middleware, SaaS chains, or Zapier — everything runs directly" |
| REF:5 | Guide, Database Schema | `thoughts` table with UUID, content, vector(1536), JSONB metadata, timestamps |
| REF:6 | Guide, Metadata Structure | Type classification, topics, people, action items, dates |
| REF:7 | Guide, match_thoughts() | Vector similarity function with cosine distance and JSONB filtering |
| REF:8 | Guide, Processing Pipeline | Parallel embedding generation and metadata extraction |
| REF:9 | Guide, Security | Access key validation via header (`x-brain-key`) or query parameter |
| REF:10 | Guide, AI Client Integration | Claude Desktop, ChatGPT, Claude Code, Cursor, VS Code, Windsurf |
| REF:11 | Guide, Cost Economics | ~$0.10–0.30/month for 20 daily captures |
| REF:12 | [pgvector](https://github.com/pgvector/pgvector) | PostgreSQL vector similarity search extension |
| REF:13 | [MCP Specification](https://modelcontextprotocol.io) | Model Context Protocol standard |
| REF:14 | [OpenRouter](https://openrouter.ai) | Unified AI API gateway |
| REF:15 | [Open Brain Companion Prompts](https://promptkit.natebjones.com/20260224_uq1_promptkit_1) | Five companion prompts: Memory Migration, Second Brain Migration, Open Brain Spark, Quick Capture Templates, Weekly Review |

---

## 12. Glossary

| Term | Definition |
|------|------------|
| **Thought** | A single captured unit of knowledge — an observation, task, idea, reference, decision, meeting note, or person note |
| **Embedding** | A 1536-dimensional vector representing the semantic meaning of a thought |
| **MCP** | Model Context Protocol — a standard for AI clients to interact with external tools and data |
| **HNSW** | Hierarchical Navigable Small World — an approximate nearest neighbor index algorithm |
| **pgvector** | PostgreSQL extension for vector similarity search |
| **OpenRouter** | AI API gateway that provides access to multiple model providers through a single key |
| **Brain** | The entire collection of thoughts and their semantic index |
| **Normalization** | Rewriting imported content so it is self-contained and understandable with zero prior context [REF:15] |
| **Capture Template** | A structured sentence pattern (e.g., "Decision: ... Context: ... Owner: ...") that produces richer metadata extraction [REF:15] |
| **Weekly Review** | A periodic synthesis of captured thoughts — themes, open action items, patterns, and focus areas [REF:15] |
| **Cross-Pollination** | The ability to search thoughts captured in one AI tool from a different AI tool, enabled by the shared MCP brain [REF:15] |
