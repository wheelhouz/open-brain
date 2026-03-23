# Development

Run the dev server with `make dev`. This starts the database, Vite frontend, and app server.

Run tests with `make test`. Tests mock the database and external APIs — no running DB needed.

## Architecture

- `app/src/app.ts` — Hono app: API routes under `/api`, static serving, SPA fallback
- `app/src/routes/` — Route handlers (capture, search, thoughts, chat, topics, people, etc.)
- `app/src/pipeline.ts` — Capture pipeline: parallel embedding + metadata extraction
- `app/src/openrouter.ts` — OpenRouter client (embeddings, metadata, chat)
- `app/src/mcp.ts` — MCP server (6 tools)
- `web/src/` — Preact SPA (components/, views/, lib/)
- `db/init.sql` — Schema, indexes, match_thoughts function
- `deploy/synology/` — Synology NAS deployment config

## Testing

- Mock `../db.js` with `query: vi.fn()` and `isHealthy: vi.fn()`
- Mock `../openrouter.js` for embedding/metadata/chat functions
- Mock `pgvector` with `{ default: { toSql: ... } }`
- Import `app` from `../app.js` (not index.js to avoid port binding)
- All test paths use `/api/` prefix

## Code Style

- Backend: TypeScript ESM (`"type": "module"`, `.js` extensions in imports)
- Frontend: Preact with @preact/signals for state, Tailwind v4 for styling
- Prefer Hono's built-in helpers over raw Node APIs

# Deployment

When asked to deploy, always commit and push all changes first, then run `make deploy`. This waits for CI to publish the image, then redeploys via Portainer using `.env.prod`.

For a clean rebuild (no Docker cache): `docker compose -p open-brain --env-file .env build --no-cache` then `make push`.
