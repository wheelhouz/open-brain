# Open Brain — Frontend Design Specification

> NLSpec v1 | 2026-03-04
> Companion to [SPEC.md](./SPEC.md) and [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## 0. Context

The brain's primary interface is MCP — AI clients talk to it directly. This
frontend is the **human-facing complement**: a local web UI for browsing,
searching, capturing, and visually exploring your brain without an AI
intermediary. It runs inside the same Docker stack, served by the existing
app container on `localhost:8420`.

---

## 1. Design Principles

| Principle | Rationale |
|-----------|-----------|
| **Read-heavy, write-light** | Most captures come through MCP/chat adapters; the UI is primarily for exploration and review |
| **Search is the home screen** | Mirrors how you interact via AI — ask a question, get relevant thoughts |
| **Content is king** | Thoughts can contain markdown, code, links, structured data — render them richly |
| **Zero config** | Ships with the Docker stack; no separate build step, no Node runtime on host |
| **Dark-first, light available** | Personal tool, likely used alongside code editors and terminals |

---

## 2. Technology Choice

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | **SolidJS** or **Preact** | Tiny bundle (<10KB), fast, no hydration overhead; ships as static assets from app container |
| Styling | **Tailwind CSS** (compiled) | Utility-first, dark mode built-in, no runtime CSS-in-JS |
| Markdown | **marked** + **highlight.js** | Lightweight rendering with syntax highlighting for code blocks |
| Build | **Vite** | Fast dev, single `dist/` output copied into Docker image |
| Icons | **Lucide** (tree-shaken) | Clean, consistent, MIT licensed |
| State | URL search params + minimal local state | Bookmarkable views, no state management library needed |

The frontend SHALL be built as a static SPA, bundled into the app container's
Docker image at `/app/static/`. The app server serves it at `GET /`.

---

## 3. Information Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Open Brain                                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Search Bar (always visible)                        │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐            │
│  │Stream│ │Search│ │Topics│ │People│ │ Stats│             │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘            │
│                                                             │
│  ┌─────────────────────────┐ ┌─────────────────────────┐   │
│  │                         │ │                         │   │
│  │  Content Area           │ │  Detail Panel           │   │
│  │  (list / grid / graph)  │ │  (thought viewer)       │   │
│  │                         │ │                         │   │
│  └─────────────────────────┘ └─────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Quick Capture Bar                                  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Navigation Model

Five views accessible via top-level tabs. The search bar persists across
all views. The detail panel slides in from the right when a thought is
selected.

| View | Purpose | Data Source |
|------|---------|-------------|
| **Stream** | Chronological feed of recent thoughts | `list_thoughts` (default view) |
| **Search** | Semantic search results with similarity scores | `search_thoughts` |
| **Topics** | Thoughts grouped by extracted topic tags | `list_thoughts` filtered by topic |
| **People** | Thoughts grouped by mentioned people | `list_thoughts` filtered by person |
| **Stats** | Dashboard with aggregate brain metrics | `thought_stats` |

---

## 4. Views

### 4.1 Stream View (Home)

The default landing page. A reverse-chronological feed of thoughts, similar
to a journal or activity feed.

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌─ Filters ──────────────────────────────────────────────────┐ │
│  │  [All Types ▾]  [All Topics ▾]  [All People ▾]  [7 days ▾]│ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ── Today ──────────────────────────────────────────────────    │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 💡 idea                                          2:30 PM  │ │
│  │                                                            │ │
│  │ We should build a **semantic layer** on top of the raw     │ │
│  │ thought stream — something that clusters related ideas...  │ │
│  │                                                            │ │
│  │ ┌────────┐ ┌───────────┐                                  │ │
│  │ │ #arch  │ │ #semantic │                                  │ │
│  │ └────────┘ └───────────┘                                  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 👤 person_note                                  11:15 AM  │ │
│  │                                                            │ │
│  │ Met with **Sarah** about the Q2 roadmap. She thinks we    │ │
│  │ should prioritize the API rewrite.                         │ │
│  │                                                            │ │
│  │ ┌──────────┐ ┌─────┐    ☑ Prioritize API rewrite         │ │
│  │ │ #roadmap │ │ @Sarah│                                    │ │
│  │ └──────────┘ └─────┘                                      │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ── Yesterday ──────────────────────────────────────────────    │
│  ...                                                            │
│                                                                 │
│  [Load more]                                                    │
└─────────────────────────────────────────────────────────────────┘
```

**Card anatomy:**

| Element | Source | Rendering |
|---------|--------|-----------|
| Type badge | `metadata.type` | Icon + label (color-coded) |
| Timestamp | `created_at` | Relative ("2h ago") with absolute on hover |
| Content | `content` | Rendered as markdown (see Section 6) |
| Topic chips | `metadata.topics` | Clickable — filters stream to that topic |
| People chips | `metadata.people` | Clickable — filters to that person |
| Action items | `metadata.action_items` | Checkbox-style list (display-only, not interactive) |
| Source badge | `source_channel` | Small icon (telegram/slack/mcp/web) — only if multi-channel is enabled |

**Type color mapping:**

| Type | Color | Icon |
|------|-------|------|
| `observation` | Blue | Eye |
| `task` | Orange | CheckSquare |
| `idea` | Yellow | Lightbulb |
| `reference` | Green | BookOpen |
| `person_note` | Purple | User |

### 4.2 Search View

Activated when the user types in the search bar. Results ranked by semantic
similarity.

```
┌─────────────────────────────────────────────────────────────────┐
│  🔍  "career changes and future planning"          [Search]    │
│                                                                 │
│  12 results (semantic search, threshold: 0.50)                  │
│  ┌─ Threshold ────────────────────┐                             │
│  │  ○───────────●─────────────○   │  0.50                      │
│  │  0.3        0.5           0.9  │                             │
│  └────────────────────────────────┘                             │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ ██████████████████████████████░░░░  93%  Mar 2            │   │
│  │                                                          │   │
│  │ Had a long conversation about **career direction**...    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ ███████████████████████████░░░░░░░  87%  Feb 28           │   │
│  │                                                          │   │
│  │ Reading about **career transitions** in tech — the key   │   │
│  │ insight is that lateral moves...                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ ████████████████████░░░░░░░░░░░░░░  71%  Feb 15           │   │
│  │                                                          │   │
│  │ **Future planning** session — mapped out three possible  │   │
│  │ paths for the next two years...                          │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

Key elements:
- **Similarity bar** — horizontal fill bar showing % match, color-graded from green (>90%) to yellow (>70%) to gray (<70%)
- **Threshold slider** — adjustable, defaults to 0.50, updates results live
- **Result count** — shown above results
- Cards are the same component as Stream view, with the similarity bar prepended

### 4.3 Topics View

A tag cloud / grouped view of all topics extracted from thoughts.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌─ Topic Cloud ───────────────────────────────────────────┐   │
│  │                                                         │   │
│  │   architecture ████████  (24)     api ██████  (18)     │   │
│  │   roadmap █████  (15)     hiring ████  (12)            │   │
│  │   security ███  (9)     performance ███  (8)           │   │
│  │   testing ██  (6)     design ██  (5)     ...           │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ── Selected: architecture (24 thoughts) ───────────────────   │
│                                                                 │
│  [Standard thought cards filtered to this topic]                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

- Topic sizes proportional to thought count
- Clicking a topic filters the card list below
- Topics are clickable chips — multiple can be selected (AND filter)

### 4.4 People View

Same structure as Topics, but grouped by `metadata.people`.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌─ People ────────────────────────────────────────────────┐   │
│  │                                                         │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐             │   │
│  │  │ 👤 Sarah │  │ 👤 Mike  │  │ 👤 Alex  │             │   │
│  │  │ 18 notes │  │ 12 notes │  │ 7 notes  │             │   │
│  │  │ Mar 2    │  │ Feb 28   │  │ Feb 20   │             │   │
│  │  └──────────┘  └──────────┘  └──────────┘             │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ── Sarah (18 thoughts) ───────────────────────────────────    │
│                                                                 │
│  [Thought cards filtered to this person]                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Each person card shows:
- Name
- Total thought count
- Last mentioned date
- Clicking filters the list below

### 4.5 Stats View (Dashboard)

Aggregate metrics — the visual equivalent of the `thought_stats` MCP tool,
plus time-series data.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐      │
│  │    247    │ │     5     │ │    23     │ │    14     │      │
│  │  thoughts │ │   types   │ │  topics   │ │  people   │      │
│  │   total   │ │   used    │ │  tracked  │ │ mentioned │      │
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘      │
│                                                                 │
│  ┌─ Capture Activity ──────────────────────────────────────┐   │
│  │                                                         │   │
│  │  ▁▃▅▇█▇▅▃▁▃▅▇▅▃▁▁▃▅█▇▅▃▁▃▅▇█                        │   │
│  │  Feb 1                                        Mar 4    │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ By Type ───────────────────┐ ┌─ Top Topics ───────────┐   │
│  │                             │ │                         │   │
│  │  observation  ████████  42% │ │  1. architecture  (24) │   │
│  │  idea         █████     26% │ │  2. api           (18) │   │
│  │  task         ███       15% │ │  3. roadmap       (15) │   │
│  │  person_note  ██        10% │ │  4. hiring        (12) │   │
│  │  reference    █          7% │ │  5. security       (9) │   │
│  │                             │ │                         │   │
│  └─────────────────────────────┘ └─────────────────────────┘   │
│                                                                 │
│  ┌─ Sources ──────────────────────────────────────────────┐    │
│  │  mcp ████████████  62%   web ████  20%                 │    │
│  │  telegram ███  15%       slack █  3%                   │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Stats SHALL be derived from a new API endpoint `GET /api/stats` that wraps
the `thought_stats` logic and adds time-series data (thoughts per day for
the last 30 days).

---

## 5. Detail Panel

Clicking any thought card opens a slide-in detail panel on the right side
(or full-screen on mobile). This is the primary content rendering surface.

```
┌──────────────────────────────────────────────────────────┐
│  ← Back                              ✏️ Edit  🗑️ Delete │
│                                                          │
│  ┌─ Metadata Bar ──────────────────────────────────────┐ │
│  │  💡 idea  ·  Mar 4, 2026 2:30 PM  ·  via mcp      │ │
│  │  #architecture  #semantic                           │ │
│  │  @Sarah  @Mike                                      │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─ Content ───────────────────────────────────────────┐ │
│  │                                                     │ │
│  │  We should build a **semantic layer** on top of     │ │
│  │  the raw thought stream — something that clusters   │ │
│  │  related ideas automatically.                       │ │
│  │                                                     │ │
│  │  Key requirements:                                  │ │
│  │  - Must work incrementally (no full reindex)        │ │
│  │  - Should surface connections the user didn't       │ │
│  │    explicitly make                                  │ │
│  │  - Could use UMAP or t-SNE for 2D projection       │ │
│  │                                                     │ │
│  │  ```python                                          │ │
│  │  from sklearn.manifold import UMAP                  │ │
│  │  reducer = UMAP(n_components=2, metric='cosine')    │ │
│  │  coords = reducer.fit_transform(embeddings)         │ │
│  │  ```                                                │ │
│  │                                                     │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─ Action Items ──────────────────────────────────────┐ │
│  │  ☐ Research UMAP integration options                │ │
│  │  ☐ Prototype clustering with existing embeddings    │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─ Related Thoughts ─────────────────────────────────┐  │
│  │  93%  "Looked into clustering algorithms for..."   │  │
│  │  87%  "The embedding space has natural clusters..." │  │
│  │  81%  "Sarah mentioned we should group related..."  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 5.1 Detail Panel Sections

| Section | Content | Notes |
|---------|---------|-------|
| **Header** | Back button, edit/delete actions | Delete triggers soft-delete (ARCHITECTURE.md S7) |
| **Metadata bar** | Type badge, timestamp, source, topic chips, people chips | All chips are clickable — navigate to filtered Stream view |
| **Content** | Full thought rendered as markdown | See Section 6 for rendering rules |
| **Action items** | Extracted to-dos displayed as checklist | Display-only in v1; interactive toggle could write back to metadata in v2 |
| **Related thoughts** | Top 3–5 semantically similar thoughts | Uses `search_thoughts` with the current thought's embedding as input; excludes self |

### 5.2 Related Thoughts

This is the key discovery feature. When viewing any thought, the system
automatically queries for semantically similar thoughts and displays them
as compact cards with similarity percentages. Clicking one navigates the
detail panel to that thought (with browser history support for back/forward).

Implementation: `GET /api/thoughts/:id/related?limit=5` — the server uses
the stored embedding of the current thought as the query vector.

---

## 6. Content Rendering

Thought content is freeform text that may contain markdown, code, links,
or structured data. The renderer SHALL handle all of these gracefully.

### 6.1 Markdown Rendering

The content area SHALL render full GitHub-Flavored Markdown:

| Feature | Support | Library |
|---------|---------|---------|
| Headings, bold, italic, lists | Yes | marked |
| Fenced code blocks with syntax highlighting | Yes | highlight.js (auto-detect language) |
| Tables | Yes | marked GFM extension |
| Links | Yes, open in new tab | marked with `target="_blank"` |
| Images (URL references) | Yes | marked, lazy-loaded |
| Task lists (`- [ ]`) | Yes (display-only) | marked |
| Math/LaTeX | No (v1) — MAY add in v2 | — |

### 6.2 Code Blocks

Code blocks SHALL receive:
- Syntax highlighting with language auto-detection
- A "Copy" button in the top-right corner
- Language label badge
- Horizontal scroll (not line wrap) for long lines

```
┌─ python ────────────────────────────────── [Copy] ┐
│                                                    │
│  from sklearn.manifold import UMAP                 │
│  reducer = UMAP(n_components=2, metric='cosine')   │
│  coords = reducer.fit_transform(embeddings)        │
│                                                    │
└────────────────────────────────────────────────────┘
```

### 6.3 Long Content Handling

For thoughts longer than ~500 characters:
- **In cards (Stream/Search):** Truncate at 3 lines with a "Show more" expansion
- **In detail panel:** Full render, no truncation
- **In related thoughts list:** Single-line truncation with ellipsis

### 6.4 Link Previews

URLs in thought content SHOULD be rendered as clickable links. The system
MAY add lightweight link preview cards (favicon + title) in a future version.
For v1, plain underlined links are sufficient.

### 6.5 Raw Mode Toggle

The detail panel SHALL include a "Raw / Rendered" toggle to switch between
markdown-rendered and plain-text views. This is useful for debugging
metadata extraction or seeing exactly what was captured.

---

## 7. Quick Capture

A persistent input bar at the bottom of the screen for capturing thoughts
directly from the UI.

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────┐ [Capture] │
│  │  Type a thought... (Ctrl+Enter to submit)       │           │
│  │                                                  │           │
│  │                                                  │           │
│  └─────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

- Expandable textarea — grows from 1 line to up to 6 lines as content is typed
- Supports markdown preview (toggle with a small button)
- `Ctrl+Enter` or the Capture button submits
- On submit: calls `POST /capture` with `source_channel: "web"`
- Shows inline confirmation with the extracted metadata (same as the MCP confirmation)
- New thought animates into the Stream if that view is active

---

## 8. Search Bar

The global search bar is always visible in the top navigation area.

### 8.1 Behavior

| State | Behavior |
|-------|----------|
| Empty | Shows placeholder "Search your brain..." |
| Typing | Debounced (300ms) — no results until user pauses or hits Enter |
| Submitted | Navigates to Search view with results |
| With filters | Shows active filter chips next to the search input |

### 8.2 Search Modes

The search bar SHALL support two modes, toggled with a small switch:

| Mode | Behavior | When to Use |
|------|----------|-------------|
| **Semantic** (default) | Sends query to `search_thoughts` — vector similarity | Natural language questions ("what did I think about career changes?") |
| **Filter** | Structured query parsed into metadata filters | Precise lookups ("type:task topic:api person:Sarah") |

Filter mode syntax:
```
type:task topic:api person:Sarah days:7
```

This is parsed client-side into the `list_thoughts` filter parameters.

---

## 9. Responsive Layout

### 9.1 Breakpoints

| Breakpoint | Layout |
|------------|--------|
| >= 1024px (desktop) | Two-column: content list + detail panel side-by-side |
| 768–1023px (tablet) | Single column: detail panel overlays as a sheet |
| < 768px (mobile) | Single column: full-screen detail view, bottom nav |

### 9.2 Desktop Layout

```
┌──────────────────────────────────────────────────────────────┐
│  [Logo]  [Search Bar                        ]  [☀/🌙]       │
│  [Stream] [Search] [Topics] [People] [Stats]                │
├──────────────────────────────┬───────────────────────────────┤
│                              │                               │
│  Content List                │  Detail Panel                 │
│  (scrollable)                │  (scrollable)                 │
│                              │                               │
│                              │                               │
│                              │                               │
│                              │                               │
│                              │                               │
├──────────────────────────────┴───────────────────────────────┤
│  [Quick Capture Bar                                 ] [Send] │
└──────────────────────────────────────────────────────────────┘
```

### 9.3 Mobile Layout

```
┌────────────────────────┐
│  [☰]  Open Brain  [🔍] │
├────────────────────────┤
│                        │
│  Content List          │
│  (full width)          │
│                        │
│                        │
│                        │
├────────────────────────┤
│  [Quick Capture    ][+]│
├────────────────────────┤
│ [Stream][Topics][Stats]│
└────────────────────────┘
```

---

## 10. API Endpoints (Frontend-Specific)

The frontend communicates with the app server over REST. These endpoints
wrap the same logic as the MCP tools but are shaped for UI consumption.

| Method | Path | Maps To | Notes |
|--------|------|---------|-------|
| `GET` | `/api/thoughts` | `list_thoughts` | Query params: `limit`, `offset`, `type`, `topic`, `person`, `days`, `cursor` |
| `GET` | `/api/thoughts/:id` | Direct DB lookup | Full thought with all fields |
| `GET` | `/api/thoughts/:id/related` | `search_thoughts` (using stored embedding) | Returns top N similar thoughts |
| `GET` | `/api/search` | `search_thoughts` | Query params: `q`, `limit`, `threshold` |
| `POST` | `/api/capture` | `capture_thought` | Body: `{ content }`, adds `source_channel: "web"` |
| `GET` | `/api/stats` | `thought_stats` | Extended with time-series (daily counts for last 30d) |
| `GET` | `/api/topics` | Aggregate query | Returns `[{ topic, count, last_seen }]` |
| `GET` | `/api/people` | Aggregate query | Returns `[{ person, count, last_seen }]` |
| `PATCH` | `/api/thoughts/:id` | Update thought | Body: partial update (content, metadata) |
| `DELETE` | `/api/thoughts/:id` | Soft-delete | Sets `deleted_at` timestamp |

All endpoints require `Authorization: Bearer <BRAIN_ACCESS_KEY>`.

The frontend stores the key in `localStorage` after the user enters it once
on first visit (a simple login gate — not a session, just local key storage).

---

## 11. Authentication Gate

On first visit, the frontend SHALL display a minimal auth screen:

```
┌────────────────────────────────────────┐
│                                        │
│           🧠 Open Brain                │
│                                        │
│   Enter your access key to continue    │
│                                        │
│   ┌──────────────────────────────┐     │
│   │  ••••••••••••••••••••••••••  │     │
│   └──────────────────────────────┘     │
│                                        │
│            [ Connect ]                 │
│                                        │
└────────────────────────────────────────┘
```

- Key is validated with a `GET /api/stats` call
- On success, stored in `localStorage` as `brain_access_key`
- Sent as `Authorization: Bearer` header on all subsequent requests
- "Disconnect" option in a minimal settings dropdown clears the key

---

## 12. Theme

### 12.1 Color Palette (Dark Mode — Default)

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-primary` | `#0f0f0f` | Page background |
| `--bg-card` | `#1a1a1a` | Card / panel background |
| `--bg-elevated` | `#252525` | Hover states, active elements |
| `--border` | `#2a2a2a` | Card borders, dividers |
| `--text-primary` | `#e5e5e5` | Body text |
| `--text-secondary` | `#888888` | Timestamps, labels |
| `--accent` | `#6366f1` | Links, active tab, primary actions (indigo) |
| `--type-observation` | `#3b82f6` | Blue |
| `--type-task` | `#f59e0b` | Orange |
| `--type-idea` | `#eab308` | Yellow |
| `--type-reference` | `#22c55e` | Green |
| `--type-person_note` | `#a855f7` | Purple |
| `--similarity-high` | `#22c55e` | >90% match |
| `--similarity-mid` | `#eab308` | 70–90% match |
| `--similarity-low` | `#6b7280` | <70% match |

### 12.2 Typography

| Element | Font | Size | Weight |
|---------|------|------|--------|
| Body | System stack (`-apple-system, ...`) | 14px | 400 |
| Card content | Same | 14px | 400 |
| Headings (in markdown) | Same | 16–20px | 600 |
| Code blocks | `"JetBrains Mono", "Fira Code", monospace` | 13px | 400 |
| Metadata labels | Same as body | 12px | 500 |
| Stats numbers | Same as body | 28px | 700 |

### 12.3 Light Mode

Inverted palette with `--bg-primary: #ffffff`, `--bg-card: #f9f9f9`,
`--text-primary: #171717`. Toggle via sun/moon icon in top nav. Preference
stored in `localStorage`.

---

## 13. Component Inventory

Minimal component set — no component library dependency.

| Component | Used In | Notes |
|-----------|---------|-------|
| `ThoughtCard` | Stream, Search, Topics, People | Core reusable card; accepts `thought` + optional `similarity` prop |
| `DetailPanel` | All views | Slide-in panel; renders full thought with markdown |
| `MarkdownRenderer` | DetailPanel, ThoughtCard (expanded) | Wraps `marked` + `highlight.js` |
| `SearchBar` | Global nav | Debounced input with mode toggle |
| `FilterBar` | Stream view | Dropdowns for type, topic, person, date range |
| `TopicCloud` | Topics view | Sized chips by count |
| `PersonCard` | People view | Avatar placeholder + name + count |
| `StatCard` | Stats view | Number + label |
| `ActivityChart` | Stats view | Simple bar/spark chart (30-day) — CSS-only or tiny lib |
| `TypeBreakdown` | Stats view | Horizontal stacked bar |
| `CaptureBar` | Global footer | Expandable textarea + submit |
| `AuthGate` | Root | Key entry screen |
| `SimilarityBar` | Search results | Colored fill bar with percentage |
| `ThemeToggle` | Nav | Sun/moon toggle |

---

## 14. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search bar |
| `Escape` | Close detail panel / clear search |
| `j` / `k` | Navigate thought list (down / up) |
| `Enter` | Open selected thought in detail panel |
| `n` | Focus quick capture bar |
| `Ctrl+Enter` | Submit capture |
| `1–5` | Switch tabs (Stream, Search, Topics, People, Stats) |

---

## 15. Performance Budget

| Metric | Target |
|--------|--------|
| Initial bundle (gzipped) | < 50KB |
| First Contentful Paint | < 500ms (local network) |
| Time to Interactive | < 800ms |
| Thought card render | < 2ms per card |
| Search round-trip | < 300ms (embedding generation is the bottleneck) |

The frontend is served from the same Docker container over localhost. There
is no CDN, no external asset loading (except fonts if not using system
stack). Performance should be excellent by default.

---

## 16. File Structure

```
app/
├── src/
│   ├── server/          # Existing app server code
│   └── ...
├── web/                 # Frontend source
│   ├── index.html
│   ├── main.ts          # Entry point, router
│   ├── api.ts           # API client (fetch wrapper with auth)
│   ├── state.ts         # Minimal reactive state (URL params + selected thought)
│   ├── components/
│   │   ├── AuthGate.tsx
│   │   ├── SearchBar.tsx
│   │   ├── ThoughtCard.tsx
│   │   ├── DetailPanel.tsx
│   │   ├── MarkdownRenderer.tsx
│   │   ├── CaptureBar.tsx
│   │   ├── FilterBar.tsx
│   │   ├── TopicCloud.tsx
│   │   ├── PersonCard.tsx
│   │   ├── StatCard.tsx
│   │   ├── ActivityChart.tsx
│   │   ├── SimilarityBar.tsx
│   │   └── ThemeToggle.tsx
│   ├── views/
│   │   ├── StreamView.tsx
│   │   ├── SearchView.tsx
│   │   ├── TopicsView.tsx
│   │   ├── PeopleView.tsx
│   │   └── StatsView.tsx
│   ├── styles/
│   │   └── globals.css  # Tailwind imports + CSS custom properties
│   └── lib/
│       ├── markdown.ts  # marked + highlight.js setup
│       └── shortcuts.ts # Keyboard shortcut handler
├── vite.config.ts
├── tailwind.config.ts
└── package.json
```

Build output (`web/dist/`) is copied into the Docker image at `/app/static/`.
The app server serves `GET /` → `static/index.html` and
`GET /assets/*` → `static/assets/*`.

---

## 17. Future Extensions (v2+)

| Feature | Description | Complexity |
|---------|-------------|------------|
| **Thought graph** | 2D force-directed graph of thoughts using embedding distances as edge weights; zoomable, pannable | High — needs UMAP projection server-side |
| **Inline editing** | Edit thought content directly in the detail panel; re-triggers embedding + metadata extraction | Medium |
| **Action item tracker** | Aggregate all action items across thoughts into a dedicated kanban/list view | Medium |
| **Timeline view** | Horizontal timeline with thoughts plotted by date, colored by type | Medium |
| **Export** | Download filtered thoughts as Markdown file, JSON, or PDF | Low |
| **LaTeX/Math** | Add KaTeX rendering for math expressions in thoughts | Low |
| **Link graph** | Detect URL references across thoughts and visualize which thoughts reference the same resources | Medium |
| **Bulk operations** | Multi-select thoughts for batch tagging, deletion, or export | Medium |

---

## 18. References

| ID | Source |
|----|--------|
| [1] | [SPEC.md](./SPEC.md) — Open Brain system specification |
| [2] | [ARCHITECTURE.md](./ARCHITECTURE.md) — Architecture research and gap analysis |
| [3] | [SolidJS](https://www.solidjs.com/) — Reactive UI framework |
| [4] | [Preact](https://preactjs.com/) — Lightweight React alternative |
| [5] | [Tailwind CSS](https://tailwindcss.com/) — Utility-first CSS |
| [6] | [marked](https://github.com/markedjs/marked) — Markdown parser |
| [7] | [highlight.js](https://highlightjs.org/) — Syntax highlighting |
| [8] | [Lucide Icons](https://lucide.dev/) — Icon library |
| [9] | [Vite](https://vite.dev/) — Frontend build tool |
