# Open Brain UX — User Experience Research

> 2026-03-04
> Companion to [FRONTEND_DESIGN.md](./FRONTEND_DESIGN.md)

---

## 1. User Profile

**Primary persona:** A knowledge worker who captures thoughts throughout the
day from multiple channels (AI chat, messaging apps, web UI) and
periodically explores, searches, and reviews what they've stored.

**Key behaviors:**
- Captures in bursts — quick, low-friction, mid-conversation
- Retrieves via natural language questions ("what did I think about X?")
- Browses to rediscover forgotten connections
- Reviews action items to stay accountable

**Mental model:** The brain is a personal second memory. The UI should feel
like leafing through a well-organized notebook, not operating a database.

---

## 2. Core UX Flows

### 2.1 Flow: Quick Capture

```
User has a thought
    │
    ├─ Path A: Already in an AI client ──> MCP capture_thought (no UI needed)
    ├─ Path B: In a chat app ──────────> Message the bot (Telegram/Slack/etc.)
    └─ Path C: At the computer ────────> Open Brain web UI
                                             │
                                             ▼
                                        Capture bar at bottom
                                             │
                                        Type thought, Ctrl+Enter
                                             │
                                        See confirmation card animate
                                        into the stream with extracted
                                        metadata (type, topics, people)
```

**UX goals:**
- Capture-to-confirmation in < 2 seconds (latency is embedding + extraction)
- No form fields — just a text box. All structure is extracted automatically.
- Confirmation shows what the system "understood" (metadata) so the user can
  correct misclassifications early

### 2.2 Flow: Semantic Search

```
User has a question
    │
    ▼
Search bar (always visible, press `/` to focus)
    │
    ▼
Type natural language: "ideas about clustering"
    │
    ▼
Results appear ranked by similarity
    │
    ├── Each result shows a similarity bar (93%, 87%, 71%...)
    ├── Content preview (3 lines, markdown rendered)
    └── Click to open full detail panel
            │
            ▼
        Detail panel shows:
            - Full rendered content
            - Metadata chips (clickable)
            - Related thoughts (auto-queried)
                  │
                  └── Click related thought ──> navigates detail panel
                       (creates a browsing chain)
```

**UX goals:**
- Search results feel "smart" — semantic matching surfaces things keyword
  search would miss
- Similarity bars give confidence calibration ("is this a strong or weak match?")
- Related thoughts enable serendipitous discovery without explicit queries

### 2.3 Flow: Browsing & Discovery

```
User wants to review / explore
    │
    ├─ Stream view ──── Scroll through recent thoughts chronologically
    │                    Filter by type/topic/person/date range
    │
    ├─ Topics view ──── See all topics as a cloud sized by frequency
    │                    Click a topic to see all thoughts tagged with it
    │
    ├─ People view ──── See all people mentioned, sorted by frequency
    │                    Click a person to see all notes about them
    │
    └─ Stats view ───── Dashboard: totals, activity chart, type breakdown
                         Answers "how much have I captured? what about?"
```

**UX goals:**
- Multiple entry points into the same data — different lenses for different
  intents (time-based, topic-based, person-based, quantitative)
- Every chip, tag, and name is clickable — navigation through the data
  should feel like following a thread

### 2.4 Flow: Review & Edit

```
User opens a thought in the detail panel
    │
    ├── Reads the full rendered content (markdown, code, etc.)
    ├── Sees action items extracted from the thought
    ├── Sees related thoughts (discovery)
    │
    ├── Wants to correct metadata ──> Edit button ──> inline edit
    ├── Wants to remove thought ────> Delete button ──> soft-delete with undo
    └── Wants to see raw text ──────> Raw/Rendered toggle
```

---

## 3. Interaction Patterns

### 3.1 Card Expansion

Thought cards in the stream show a 3-line preview. The full thought opens
in the detail panel, not by expanding the card inline. This keeps the
stream scannable and gives the detail panel room to render rich content.

```
Stream (scannable)              Detail Panel (immersive)
┌──────────────────────┐       ┌──────────────────────┐
│ 💡 idea      2:30 PM │       │ Full markdown render  │
│                      │       │ with code blocks,     │
│ We should build a    │ ───>  │ headings, lists...    │
│ semantic layer on... │       │                       │
│                      │       │ Related thoughts      │
│ #arch  #semantic     │       │ Action items          │
└──────────────────────┘       └──────────────────────┘
```

### 3.2 Chip Navigation

Every metadata chip (topic, person, type) is a navigation affordance:

```
Click "#roadmap" on a thought card
    │
    ▼
Stream view filters to: topic = "roadmap"
Active filter shown as removable chip in filter bar
```

This creates a fluid drill-down experience. Multiple chips can be stacked
(AND logic). The URL updates to reflect filters, making views bookmarkable.

### 3.3 Related Thoughts Chain

The detail panel's "Related Thoughts" section creates a browsing chain:

```
Open Thought A
    └── Related: Thought B (93%)
            └── Click ──> Detail panel shows Thought B
                    └── Related: Thought C (88%)
                            └── Click ──> shows Thought C
                                    └── Back button returns to B, then A
```

Browser history tracks each step. This is the core discovery mechanic —
following semantic threads through the brain.

### 3.4 Keyboard-Driven Navigation

For power users who want to stay on the keyboard:

| Action | Key | Context |
|--------|-----|---------|
| Focus search | `/` | Global |
| Navigate list | `j` / `k` | Stream, Search results |
| Open thought | `Enter` | Highlighted card |
| Close panel | `Escape` | Detail panel open |
| New capture | `n` | Global |
| Submit capture | `Ctrl+Enter` | Capture bar focused |
| Switch tabs | `1`–`5` | Global |

Visual focus indicator (subtle border highlight) shows which card is
selected when navigating with `j`/`k`.

---

## 4. Content Display Strategy

### 4.1 Content Types and Rendering

Thoughts are freeform text, but the content often falls into recognizable
patterns. The renderer handles them uniformly through markdown.

| Content Pattern | How It Appears | Rendering |
|-----------------|----------------|-----------|
| Short note | "Sarah prefers async standups" | Plain text, single paragraph |
| Structured list | "Key takeaways:\n- point 1\n- point 2" | Rendered markdown list |
| Code snippet | ````python\nimport foo\n```` | Syntax-highlighted code block with copy button |
| Link reference | "Good article: https://..." | Clickable link, opens in new tab |
| Long-form reflection | Multiple paragraphs with headings | Full markdown with heading hierarchy |
| Meeting notes | Mix of text, names, action items | Markdown body + extracted metadata below |

### 4.2 Artifact Display

When a thought contains substantial structured content (code blocks > 5
lines, tables, long lists), the detail panel renders it as a visually
distinct artifact:

```
┌─ Content ─────────────────────────────────────────────┐
│                                                       │
│  Talked to Mike about the new API schema:             │
│                                                       │
│  ┌─ json ───────────────────────────────── [Copy] ─┐  │
│  │                                                 │  │
│  │  {                                              │  │
│  │    "thoughts": [{                               │  │
│  │      "id": "uuid",                              │  │
│  │      "content": "string",                       │  │
│  │      "metadata": {                              │  │
│  │        "type": "string",                        │  │
│  │        "topics": ["string"]                     │  │
│  │      }                                          │  │
│  │    }]                                           │  │
│  │  }                                              │  │
│  │                                                 │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  He wants to add pagination before launch.            │
│                                                       │
└───────────────────────────────────────────────────────┘
```

Artifact blocks get:
- Distinct background color (`--bg-elevated`)
- Rounded corners and subtle border
- Language badge (top-left)
- Copy button (top-right)
- Horizontal scroll for wide content
- Max height with scroll for very long blocks (> 30 lines)

### 4.3 Document-Length Thoughts

Some thoughts may be long (multi-paragraph notes, pasted documents). The
detail panel handles these with:

- A floating table-of-contents sidebar (extracted from markdown headings)
  when the thought has 3+ headings
- Smooth scroll-to-heading on TOC click
- A reading progress bar at the top of the panel

```
┌─ Detail Panel ──────────────────────────────────────┐
│ [████████████████████░░░░░░░░░░░░░] 65% read        │
│                                                      │
│ ┌─ TOC ──┐  ┌─ Content ─────────────────────────┐   │
│ │ Intro  │  │                                   │   │
│ │ Setup ◀│  │  ## Setup                         │   │
│ │ Config │  │                                   │   │
│ │ Deploy │  │  First install the dependencies:  │   │
│ │ Notes  │  │                                   │   │
│ └────────┘  │  ```bash                          │   │
│             │  npm install open-brain            │   │
│             │  ```                               │   │
│             │                                   │   │
│             └───────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

The TOC sidebar only appears on desktop (>= 1024px) and only for thoughts
with sufficient heading structure.

---

## 5. Empty States

Every view needs a meaningful empty state — the UI should never feel broken.

| View | Empty State |
|------|-------------|
| **Stream** (first run) | "Your brain is empty. Capture your first thought below, or connect an AI client via MCP." + arrow pointing to capture bar |
| **Search** (no results) | "No thoughts matched your search. Try broadening your query or lowering the similarity threshold." + threshold slider |
| **Topics** (no data) | "Topics will appear here as you capture thoughts. The system automatically extracts 1-3 topic tags from each thought." |
| **People** (no data) | "People will appear here when they're mentioned in your thoughts." |
| **Stats** (no data) | Stat cards show "0" with muted styling. Activity chart shows empty bars. |

---

## 6. Feedback & Microinteractions

| Interaction | Feedback |
|-------------|----------|
| Thought captured | Card slides into stream from bottom with a brief green border flash |
| Search submitted | Results fade in staggered (50ms delay each) |
| Thought deleted | Card fades out + "Undo" toast (5 seconds) |
| Filter applied | List transitions smoothly (layout animation) |
| Similarity bar | Fills from left on mount (300ms ease-out) |
| Theme toggle | Smooth 200ms color transition on all elements |
| Keyboard nav | Selected card gets a subtle left-border accent |
| Copy code | Button text changes to "Copied!" for 2 seconds |
| API error | Red toast at top: "Failed to [action]. Retrying..." with auto-retry |

---

## 7. Accessibility

| Requirement | Implementation |
|-------------|----------------|
| Keyboard navigation | Full tab order; `j`/`k` navigation; all interactive elements focusable |
| Screen reader | Semantic HTML (`article`, `nav`, `main`, `aside`); `aria-label` on icon-only buttons |
| Color contrast | All text meets WCAG AA (4.5:1 for body, 3:1 for large text) in both themes |
| Reduced motion | `prefers-reduced-motion` media query disables all animations |
| Focus indicators | Visible focus ring on all interactive elements (not just browser default) |

---

## 8. Information Density Modes

Users can toggle between two density modes (stored in `localStorage`):

| Mode | Card Height | Content Preview | Use Case |
|------|-------------|-----------------|----------|
| **Comfortable** (default) | ~120px | 3-line preview + metadata chips | Casual browsing, reading |
| **Compact** | ~60px | 1-line preview, metadata as inline text | Scanning large volumes, power users |

```
── Comfortable ──────────────────────────
┌──────────────────────────────────────┐
│ 💡 idea                     2:30 PM │
│                                      │
│ We should build a semantic layer on  │
│ top of the raw thought stream —      │
│ something that clusters related...   │
│                                      │
│ #arch  #semantic                     │
└──────────────────────────────────────┘

── Compact ──────────────────────────────
┌──────────────────────────────────────┐
│ 💡 We should build a semantic la...  │
│    #arch #semantic         2:30 PM  │
└──────────────────────────────────────┘
```

---

## 9. URL Structure

All views are bookmarkable and shareable (on the same machine). URL
reflects current state.

| URL | View |
|-----|------|
| `/` | Stream (default) |
| `/?type=task&days=7` | Stream filtered to tasks from last 7 days |
| `/search?q=career+changes&threshold=0.5` | Search results |
| `/topics` | Topic cloud |
| `/topics?selected=architecture` | Topic cloud with "architecture" selected |
| `/people` | People directory |
| `/people?selected=Sarah` | People with "Sarah" selected |
| `/stats` | Dashboard |
| `/thought/:id` | Direct link to a thought (opens in detail panel) |

---

## 10. Summary of UX Priorities

| Priority | Principle | Implementation |
|----------|-----------|----------------|
| **1** | Fast capture, zero friction | Persistent capture bar, Ctrl+Enter submit, auto-classification |
| **2** | Semantic search as primary navigation | Always-visible search bar, similarity bars, natural language input |
| **3** | Rich content rendering | Full GFM markdown, syntax-highlighted code, artifact blocks, TOC for long content |
| **4** | Serendipitous discovery | Related thoughts on every detail view, chip-based navigation, topic/people views |
| **5** | Keyboard-first power use | Full shortcut set, j/k navigation, focus management |
| **6** | Honest empty states | Guide new users, explain what the system does, point to next action |
