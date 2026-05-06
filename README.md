# Open Brain

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A self-hosted personal knowledge base that captures your thoughts and makes them searchable through vector similarity. Drop in a thought -- a note, idea, link, code snippet -- and Open Brain embeds it, extracts metadata with an LLM, and stores it in PostgreSQL with pgvector. Find anything later through semantic search, topic browsing, or RAG-powered chat.

## Features

- **Semantic search** -- find thoughts by meaning, not just keywords
- **Auto-extracted metadata** -- topics, people, sentiment, and type detected automatically by LLM
- **Entity facts** -- structured memory about people (e.g. "works at Anthropic", "from Estonia") with conflict detection, review workflow, and evidence linking
- **Open loops** -- action items, questions, and decisions extracted from thoughts with snooze/close lifecycle
- **Thought threads** -- link related thoughts into chains
- **RAG chat** -- ask questions across your entire knowledge base, with entity-grounded chat for person-specific conversations
- **MCP server** -- capture, search, manage facts, and review loops from Claude, Claude Code, or any MCP client
- **Web UI** -- stream, search, browse topics/people, review pending facts, stats dashboard
- **Self-hosted** -- your data stays on your hardware

## Quick Start

The fastest way to try Open Brain — pull the pre-built image from GitHub Container Registry:

```bash
# Clone and set up environment
git clone https://github.com/wheelhouz/open-brain.git
cd open-brain
make setup

# Add your OpenRouter API key
vim .env

# Start the full stack
make up

# Verify
curl http://localhost:8420/health
```

To build from source instead:

```bash
make setup
vim .env    # add your OpenRouter API key
make dev        # local dev with hot reload
```

### Prerequisites

- Docker & Docker Compose
- Node.js 22+ (for local development only)

## Make Targets

All local commands use `.env`. Deployment (`make deploy`) uses `.env.prod` for Portainer credentials.

| Target | Description |
|--------|-------------|
| `make setup` | Create `.env` from template with generated secrets |
| `make install` | Install npm dependencies for both frontend and backend |
| `make dev` | Start DB + local Vite + tsx watch |
| `make build` | Build the Docker image |
| `make push` | Build and push to GHCR locally (CI does this automatically) |
| `make deploy` | Wait for CI publish, then redeploy via Portainer API |
| `make up` | Start the full stack (DB + app) in detached mode |
| `make down` | Stop containers |
| `make logs` | Tail the app container logs |
| `make test` | Run backend tests (no DB needed) |
| `make clean` | Stop containers and remove volumes |

## Development

```bash
# Local dev with hot reload (Vite + tsx watch, DB on port 5433)
make dev
```

This starts the dev PostgreSQL container on port 5433, the Vite dev server on `:5173`, and the backend on `:8420`.

Dev and prod use separate Docker project names (`open-brain-dev` / `open-brain-prod`) so their databases and volumes are fully isolated.

## Deployment

Pre-built images are available at `ghcr.io/wheelhouz/open-brain:latest`. Running `make up ENV=prod` will pull the latest image automatically. Use `make build ENV=prod` to build from source instead.

For Synology NAS-specific instructions (Portainer, HTTPS, reverse proxy), see [deploy/synology/README.md](deploy/synology/README.md).

### Observability

The app exposes a Prometheus-compatible `/metrics` endpoint and writes structured JSON logs to stdout (via pino), making it straightforward to plug into any external monitoring stack (Prometheus, Loki/Promtail, Grafana, OpenTelemetry collectors, etc.). No monitoring stack is bundled with this repo — wire it up to whatever observability infrastructure you already run.

## MCP Server

The MCP endpoint is available at `/mcp` and supports two auth methods:

- **Bearer token** (for CLI/local use): pass `BRAIN_ACCESS_KEY` as `Authorization: Bearer <key>` or `?key=<key>` query param
- **OAuth 2.1** (for Claude web portal and other OAuth clients): auto-discovered via `/.well-known/oauth-authorization-server`

### Connecting from Claude web portal

1. In Claude's MCP settings, add server URL: `https://brain.yourdomain.com/mcp`
2. Claude auto-discovers OAuth endpoints and registers as a client
3. You'll be redirected to a login page -- enter your `BRAIN_ACCESS_KEY`
4. Claude exchanges the auth code for a bearer token and connects

If Open Brain runs behind a TLS-terminating reverse proxy, set `PUBLIC_ORIGIN=https://brain.yourdomain.com` so OAuth discovery always advertises public HTTPS URLs.

### Connecting from Claude Code (CLI)

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "open-brain": {
      "type": "streamablehttp",
      "url": "https://brain.yourdomain.com/mcp?key=YOUR_BRAIN_ACCESS_KEY"
    }
  }
}
```

## Architecture

- **Backend**: TypeScript + Hono (port 8420)
- **Frontend**: Preact + Tailwind v4 + Vite
- **Database**: PostgreSQL 16 + pgvector
- **AI**: OpenRouter (embeddings + metadata extraction + chat)

When a thought is captured, the system runs embedding generation and LLM metadata extraction in parallel, then stores the thought with its vector and extracted topics/people/sentiment in PostgreSQL. The pipeline also resolves person mentions to canonical entities (with fuzzy matching and alias support) and extracts structured fact candidates about those people. Facts go through a lifecycle: tentative claims are surfaced for review, conflicts with existing facts are flagged, and accepted facts build up a structured memory profile for each person.

Search uses pgvector's cosine similarity to find semantically related thoughts. Chat uses RAG -- embedding the query, retrieving relevant thoughts, and streaming an LLM response grounded in your knowledge base. Entity-specific chat enriches the context with the person's facts and evidence before querying.

## Acknowledgments

Inspired by [Nate B. Jones](https://natesnewsletter.substack.com/p/every-ai-you-use-forgets-you-heres) and the idea that every AI you use forgets you -- so you should build your own memory layer.

## License

[MIT](LICENSE)
