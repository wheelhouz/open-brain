# Frontend Implementation Session — 2026-03-04

## Overview

Phases 5 (Frontend Core) and 6 (Frontend Complete) implemented in a single session. The backend API was updated in parallel to support the frontend.

---

## Backend Changes

### API Prefix Migration

All authenticated routes moved under `/api/` to separate API from SPA serving:

| Before | After |
|--------|-------|
| `POST /capture` | `POST /api/capture` |
| `POST /search` | `POST /api/search` |
| `GET /thoughts` | `GET /api/thoughts` |
| `GET /stats` | `GET /api/stats` |
| `POST /import` | `POST /api/import` |
| `GET /review` | `GET /api/review` |

Unchanged: `GET /health`, `ALL /mcp` (remain at root).

### New Endpoints

- **`GET /api/topics`** — Aggregates topics with count and last_seen timestamp
- **`GET /api/people`** — Aggregates people with count and last_seen timestamp
- **`GET /api/thoughts/:id/related`** — Reads stored embedding vector, calls `match_thoughts()`, excludes self. No extra OpenRouter API call.
- **`POST /api/chat`** — RAG chat: embeds query, retrieves top 6 thoughts (threshold 0.5), streams response via SSE using `CHAT_MODEL` (default `anthropic/claude-sonnet-4-6`)
- **`PATCH /api/thoughts/:id`** — Update thought content, optionally re-embed and re-extract metadata (`?reprocess=true`)
- **`GET /api/thoughts/:id/thread`** — Fetch sub-thoughts (children) linked to a parent thought
- **`POST /api/capture`** — Extended with optional `parent_id` for creating sub-thoughts in a thread

### Static Serving + SPA Fallback

`app/src/app.ts` now:
1. Serves `/assets/*` from `./static/` via `@hono/node-server/serve-static`
2. Falls back to `./static/index.html` for all non-API `GET` requests (SPA routing)

### Test Updates

All 10 test files updated to use `/api/` prefix. Two new test files added:
- `app/src/__tests__/topics.test.ts` (3 tests)
- `app/src/__tests__/people.test.ts` (3 tests)

Total: **42 tests, all passing**.

---

## Frontend Architecture

### Tech Stack

| Tool | Version | Purpose |
|------|---------|---------|
| Preact | ^10.25 | UI framework (~4KB) |
| @preact/signals | ^2.0 | Reactive state |
| preact-router | ^4.1 | Client-side routing (~1.5KB) |
| Tailwind CSS | v4.1 | Styling (CSS-based config, no JS config file) |
| Vite | ^6.0 | Build tool + dev server |
| marked | ^15.0 | Markdown rendering |
| highlight.js | ^11.11 | Code syntax highlighting (lazy-loaded) |
| lucide-preact | ^0.474 | Icons |

### Bundle Size

| Asset | Size | Gzipped |
|-------|------|---------|
| Main JS | 153 KB | **~45 KB** |
| Main CSS | 51 KB | 10 KB |
| highlight.js core (lazy) | 20.9 KB | 8.4 KB |
| highlight.js languages (lazy) | ~28 KB | ~11.5 KB |
| highlight.js CSS (lazy) | 1.3 KB | 0.6 KB |

highlight.js loaded on demand via `requestIdleCallback`.

### File Structure

```
web/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── src/
    ├── main.tsx                    # Entry point, init shortcuts
    ├── api.ts                      # Typed fetch wrapper, all API methods
    ├── state.ts                    # Signals: auth, theme, selectedThought, toasts
    ├── components/
    │   ├── App.tsx                 # Shell: header, tab nav, router, capture bar
    │   ├── AuthGate.tsx            # Login screen, validates via GET /api/stats
    │   ├── ThemeToggle.tsx         # Dark/light toggle, persists to localStorage
    │   ├── CaptureBar.tsx          # Expandable textarea, Ctrl+Enter submit
    │   ├── Toast.tsx               # Notification overlay
    │   ├── ThoughtCard.tsx         # Card with type icon, preview, chips, similarity
    │   ├── DetailPanel.tsx         # Slide-in panel: markdown, metadata, related, edit, threads
    │   ├── BottomSheet.tsx         # Swipeable mobile sheet (capture, detail)
    │   ├── SwipeableCard.tsx       # Swipe-to-delete card wrapper
    │   ├── FilterBar.tsx           # Type/topic/person/days dropdowns
    │   ├── SearchBar.tsx           # Debounced input with / shortcut
    │   ├── MarkdownRenderer.tsx    # Renders HTML via dangerouslySetInnerHTML
    │   ├── SimilarityBar.tsx       # Colored fill bar with percentage
    │   ├── TopicCloud.tsx          # Chips sized by count
    │   ├── TopicEditor.tsx         # Inline topic add/remove on thoughts
    │   ├── PersonCard.tsx          # Avatar, name, count, last seen
    │   ├── StatCard.tsx            # Big number + label
    │   └── ActivityChart.tsx       # CSS-only 30-day bar chart
    ├── views/
    │   ├── StreamView.tsx          # Chronological feed, grouped by date, filters
    │   ├── SearchView.tsx          # Semantic search, threshold slider
    │   ├── TopicsView.tsx          # Topic cloud + filtered thought list + AI cleanup
    │   ├── PeopleView.tsx          # Person cards + filtered thought list
    │   ├── StatsView.tsx           # 4 metrics, activity chart, breakdowns
    │   └── ChatView.tsx            # RAG chat with source pills
    └── lib/
        ├── markdown.ts             # marked + lazy highlight.js (6 languages)
        ├── format.ts               # Type colors, relative time, date grouping
        ├── route.ts                # RoutableProps type for preact-router
        └── shortcuts.ts            # Keyboard shortcut handler
```

### Features

**5 Views:**
- **Stream** — Chronological feed grouped by date. Filters by type, topic, person, time range. Cursor-based infinite scroll (load more).
- **Search** — Semantic search with debounced input. Adjustable similarity threshold slider (30-90%). Results show similarity bars.
- **Topics** — Tag cloud with chips sized by frequency. Click to filter thoughts by topic.
- **People** — Person cards with mention count and last seen. Click to filter thoughts.
- **Stats** — 4 metric cards (total, active days, topics, people), 30-day activity chart (CSS-only), type breakdown, top topics, sources, top people.

**6 Views** (added since initial launch):
- **Chat** — RAG-powered conversational Q&A over stored thoughts. Embeds query, retrieves top 6 matches (threshold 0.5), streams response via SSE. Source pills link back to referenced thoughts. Smart auto-scroll, pinned composer.

**Detail Panel:**
- Slide-in from right with backdrop
- Full GFM markdown rendering with syntax highlighting
- Code blocks with language labels and copy buttons
- Metadata: type, timestamp, topics, people, action items, source
- Raw/rendered toggle
- Related thoughts (fetched via stored embedding, no extra API call)
- Inline content editing with re-process toggle (re-extracts type, topics, people)
- Inline topic editing (add/remove topic chips directly)
- Expandable width (toggle on left edge, `max-w-xl` → `max-w-4xl`)
- Fullscreen mode (`f` key) with readable-width gutters (`max-w-6xl`, centered)
- Discuss with AI popover (Brain Chat, Claude, ChatGPT)
- Thought threads: linked sub-thoughts with parent breadcrumb navigation
- Add note to thread inline (creates sub-thought linked to parent)
- Delete with confirmation toast
- Swipe-to-delete on feed cards (mobile)

**Capture Bar:**
- Persistent footer textarea, grows 1–6 lines on focus
- Ctrl+Enter / Cmd+Enter to submit
- Success toast shows extracted type
- Half-height bottom sheet on mobile for capture input

**Auth:**
- Access key input validates via `GET /api/stats`
- Stored in `localStorage` as `brain_access_key`
- Sent as `Authorization: Bearer` header on all requests

**Theme:**
- Dark mode default, light mode toggle
- CSS custom properties for all colors
- Persists to `localStorage`

**Keyboard Shortcuts:**
- `/` — Focus search
- `Esc` — Close detail panel or blur input
- `j` / `k` — Navigate thought cards
- `Enter` — Open selected thought
- `n` — Focus capture bar
- `1`–`6` — Switch tabs (includes Chat)
- `f` — Toggle fullscreen in detail panel

---

## Infrastructure Changes

### Dockerfile (moved to project root)

Multi-stage build:
1. **web-build** — Install web deps, run `tsc && vite build`
2. **app-build** — Install app deps, run `tsc`
3. **production** — Install production deps only, copy `dist/` and `static/`

### docker-compose.yml

Changed `build: ./app` → `build: .` to use the root Dockerfile.

### .gitignore

Added `web/dist/`.

### MCP Configuration

MCP server connected to Claude Code via HTTP transport with Bearer auth header using env var expansion:

```json
{
  "type": "http",
  "url": "http://localhost:8420/mcp",
  "headers": {
    "Authorization": "Bearer ${BRAIN_ACCESS_KEY}"
  }
}
```

Avoids leaking secrets in URLs or config files.

---

## Issues Encountered & Fixes

### 1. preact-router `path` prop type error

**Problem:** Components passed to `<Router>` need a `path` prop, but Preact's intrinsic attributes don't include it.

**Fix:** Created `RoutableProps` interface in `lib/route.ts`. All view components accept `_props: RoutableProps`.

### 2. LucideIcon type mismatch

**Problem:** `Record<string, ComponentType<{ class?: string }>>` didn't match Lucide's `LucideIcon` type due to `Signalish` prop types from Preact signals integration.

**Fix:** Used `Record<string, LucideIcon>` with the exported `LucideIcon` type from `lucide-preact`.

### 3. highlight.js CSS module import

**Problem:** TypeScript couldn't resolve `highlight.js/styles/github-dark.min.css` as a module.

**Fix:** Added `@ts-ignore` comment for the dynamic CSS import. Vite handles it correctly at build time.

### 4. Bundle size over 50KB with eager highlight.js

**Problem:** Initial bundle was 48.7KB gzipped — close to the limit and would grow with more code.

**Fix:** Lazy-loaded highlight.js via dynamic `import()`. Languages loaded as separate chunks. Main bundle dropped to 33.7KB gzipped. highlight.js pre-loaded on `requestIdleCallback` so it's ready before user views code blocks.

### 5. Backend port conflict during dev

**Problem:** Docker Compose `app` service was still running on `:8420` with old code (no `/api` prefix), blocking the local `tsx watch` dev server.

**Fix:** Stopped Docker `app` container, ran backend locally with `npm run dev`. Also needed to expose PostgreSQL port (`-p 5432:5432`) since the DB container had no host port mapping.

### 6. MCP secret in URL

**Problem:** Initial MCP config used query param auth (`?key=...`), exposing the secret in config files and process listings.

**Fix:** Switched to Bearer header with env var expansion: `"Authorization": "Bearer ${BRAIN_ACCESS_KEY}"`. Secret resolved at runtime from environment.

---

## Post-Launch Features (2026-03-05 – 2026-03-06)

### RAG Chat Interface
Conversational Q&A over stored thoughts. The backend embeds the user query, retrieves top 6 matching thoughts (cosine similarity >= 0.5), and streams a response via SSE using the configured `CHAT_MODEL`. The frontend shows source pills linking to referenced thoughts. Smart auto-scroll pauses when user scrolls up.

### Thought Editing
Inline content editing in the detail panel with a re-process toggle. When enabled, saving re-embeds the content and re-extracts metadata (type, topics, people). Uses `PATCH /api/thoughts/:id`.

### Inline Topic Editing
Add or remove topic chips directly on a thought in the detail panel without opening an edit mode.

### Thought Threads (Sub-Thoughts)
Thoughts can have linked sub-thoughts (children). The detail panel shows a "Thread" section with child thoughts and an "Add note" inline composer. Parent breadcrumb navigation allows traversing up. Newest thread items shown first. Uses `parent_id` foreign key on the thoughts table.

### Discuss with AI
Popover on detail panel offering three options: Brain Chat (routes to `/chat` with thought context), Claude (opens claude.ai with `get_thought` tool prompt), ChatGPT (opens chatgpt.com similarly).

### Detail Panel Enhancements
- **Expandable width**: Toggle on left edge cycles between `max-w-xl` and `max-w-4xl`
- **Fullscreen mode**: `f` key toggles fullscreen with readable-width gutters (`max-w-6xl`, centered like Obsidian)
- **Swipe-to-delete**: Feed cards support swipe gesture on mobile

### Mobile Improvements
- Half-height bottom sheet for capture input
- Swipeable bottom sheet for detail panel (swipe-up-to-fullscreen from gripper handle only)
- iOS auto-zoom prevention on inputs
- Keyboard-aware layout adjustments

### AI Topic Cleanup
Scan for duplicate/similar topics and batch merge them. Available in Topics view.

### MCP get_thought Tool
New MCP tool allowing AI clients to fetch a specific thought by ID for discussion context.

### Favicon
Brain icon (Lucide) served as `favicon.svg` from static root.
