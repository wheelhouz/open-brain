# Thought Editing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add inline content editing to thoughts with re-embedding and optional metadata re-extraction.

**Architecture:** New PATCH endpoint in the thoughts router handles content updates, re-embedding, and optional metadata re-processing via the existing pipeline functions. The DetailPanel gets an edit mode toggle that transforms the content area into a textarea with save/cancel controls and a re-process toggle.

**Tech Stack:** Hono (backend), Preact + Signals (frontend), pgvector, OpenRouter (embedding/metadata)

---

### Task 1: Backend — PATCH /api/thoughts/:id endpoint

**Files:**
- Modify: `app/src/routes/thoughts.ts:128` (add before the topics PATCH route)
- Modify: `app/src/pipeline.ts` (export a new `updatePipeline` function)
- Test: `app/src/__tests__/thoughts.test.ts`

**Step 1: Write the failing tests**

Add to `app/src/__tests__/thoughts.test.ts`:

```typescript
vi.mock("../openrouter.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  extractMetadata: vi.fn().mockResolvedValue({
    type: "idea",
    topics: ["testing"],
    people: [],
    action_items: [],
    dates_mentioned: [],
    source_context: null,
  }),
}));

vi.mock("pgvector", () => ({
  default: { toSql: (v: number[]) => `[${v.join(",")}]` },
}));

describe("PATCH /api/thoughts/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates content and re-embeds", async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        id: "uuid-1", content: "updated text", metadata: { type: "observation", topics: [] },
        created_at: "2026-03-04", updated_at: "2026-03-05",
      }],
    });

    const res = await app.request("/api/thoughts/uuid-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "updated text" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("uuid-1");
    expect(body.content).toBe("updated text");

    // Should have called generateEmbedding
    const { generateEmbedding } = await import("../openrouter.js");
    expect(generateEmbedding).toHaveBeenCalledWith("updated text");
  });

  it("re-processes metadata when reprocess=true", async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        id: "uuid-1", content: "updated", metadata: { type: "idea", topics: ["testing"] },
        created_at: "2026-03-04", updated_at: "2026-03-05",
      }],
    });

    const res = await app.request("/api/thoughts/uuid-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "updated", reprocess: true }),
    });

    expect(res.status).toBe(200);
    const { extractMetadata } = await import("../openrouter.js");
    expect(extractMetadata).toHaveBeenCalledWith("updated");
  });

  it("returns 400 if content is empty", async () => {
    const res = await app.request("/api/thoughts/uuid-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent thought", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/thoughts/uuid-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test" }),
    });
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/leo/Work/src/open-brain && npx vitest run app/src/__tests__/thoughts.test.ts`
Expected: FAIL — PATCH route not found (405)

**Step 3: Add updatePipeline to pipeline.ts**

Add to `app/src/pipeline.ts` after the existing `capturePipeline` function:

```typescript
export interface UpdateResult {
  embedding: number[];
  metadata: ThoughtMetadata | null;
  content_hash: string;
}

export async function updatePipeline(
  content: string,
  reprocess: boolean,
): Promise<UpdateResult> {
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");

  if (reprocess) {
    const [embedding, metadata] = await Promise.all([
      generateEmbedding(content),
      extractMetadata(content).catch(() => null),
    ]);
    return { embedding, metadata, content_hash: contentHash };
  }

  const embedding = await generateEmbedding(content);
  return { embedding, metadata: null, content_hash: contentHash };
}
```

**Step 4: Add PATCH route to thoughts.ts**

Add before the `/:id/topics` route in `app/src/routes/thoughts.ts`:

```typescript
import { updatePipeline } from "../pipeline.js";
import pgvector from "pgvector";

// Update thought content
thoughtsRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ content?: string; reprocess?: boolean }>();
  const content = body.content?.trim();

  if (!content) {
    return c.json({ error: "Content is required" }, 400);
  }

  const { embedding, metadata, content_hash } = await updatePipeline(
    content,
    body.reprocess === true,
  );

  // Build the update query
  let sql: string;
  let params: unknown[];

  if (metadata) {
    // Full re-process: overwrite metadata fields but preserve source_context
    sql = `UPDATE thoughts
      SET content = $1,
          embedding = $2,
          metadata = metadata || $3::jsonb,
          updated_at = now()
      WHERE id = $4 AND deleted_at IS NULL
      RETURNING id, content, metadata, created_at, updated_at`;
    params = [
      content,
      pgvector.toSql(embedding),
      JSON.stringify({
        ...metadata,
        content_hash,
      }),
      id,
    ];
  } else {
    // Embed-only: just update content, embedding, and content_hash
    sql = `UPDATE thoughts
      SET content = $1,
          embedding = $2,
          metadata = jsonb_set(metadata, '{content_hash}', $3::jsonb),
          updated_at = now()
      WHERE id = $4 AND deleted_at IS NULL
      RETURNING id, content, metadata, created_at, updated_at`;
    params = [
      content,
      pgvector.toSql(embedding),
      JSON.stringify(content_hash),
      id,
    ];
  }

  const result = await query<{
    id: string; content: string; metadata: Record<string, unknown>;
    created_at: string; updated_at: string;
  }>(sql, params);

  if (result.rows.length === 0) {
    return c.json({ error: "Thought not found" }, 404);
  }

  return c.json(result.rows[0]);
});
```

**Important:** This route MUST be registered before `/:id/topics` so Hono matches it correctly. The `/:id/topics` route is more specific so it will still match first, but to be safe, place the general PATCH `/:id` after the more specific `/:id/topics` route.

**Step 5: Run tests to verify they pass**

Run: `cd /home/leo/Work/src/open-brain && npx vitest run app/src/__tests__/thoughts.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add app/src/routes/thoughts.ts app/src/pipeline.ts app/src/__tests__/thoughts.test.ts
git commit -m "feat: add PATCH /api/thoughts/:id for content editing with re-embedding"
```

---

### Task 2: Frontend — API client method

**Files:**
- Modify: `web/src/api.ts:136` (add after `updateTopics`)

**Step 1: Add updateThought method**

Add after the `updateTopics` method in `web/src/api.ts`:

```typescript
  updateThought: (id: string, content: string, reprocess?: boolean) =>
    request<Thought>(`/api/thoughts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, reprocess: reprocess || false }),
    }),
```

**Step 2: Commit**

```bash
git add web/src/api.ts
git commit -m "feat: add updateThought API client method"
```

---

### Task 3: Frontend — DetailPanel edit mode

**Files:**
- Modify: `web/src/components/DetailPanel.tsx`

**Step 1: Add edit state and imports**

Add `Pencil` to the lucide-preact import at line 9:

```typescript
import { Trash2, FileText, Code, Pencil } from "lucide-preact";
```

Add edit state signals after the existing `useState` calls (after line 31):

```typescript
const [editing, setEditing] = useState(false);
const [editContent, setEditContent] = useState("");
const [reprocess, setReprocess] = useState(false);
const [saving, setSaving] = useState(false);
const editRef = useRef<HTMLTextAreaElement>(null);
```

**Step 2: Add edit handlers**

Add after the `handleDelete` function (after line 86):

```typescript
const startEdit = () => {
  if (!thought) return;
  setEditContent(thought.content);
  setReprocess(false);
  setEditing(true);
  setTimeout(() => editRef.current?.focus(), 50);
};

const cancelEdit = () => {
  setEditing(false);
  setEditContent("");
};

const saveEdit = async () => {
  if (!thought || saving) return;
  const trimmed = editContent.trim();
  if (!trimmed || trimmed === thought.content) {
    cancelEdit();
    return;
  }

  setSaving(true);
  const original = thought;
  // Optimistic update
  setThought({ ...thought, content: trimmed });
  setEditing(false);

  try {
    const updated = await api.updateThought(thought.id, trimmed, reprocess);
    setThought(updated);
    showToast(
      reprocess ? "Updated & re-extracted metadata" : "Thought updated",
      "success",
    );
  } catch {
    setThought(original);
    showToast("Failed to update", "error");
  } finally {
    setSaving(false);
  }
};
```

**Step 3: Reset edit state when thought changes**

Add to the existing `useEffect` that handles `id` changes (inside the effect, after `setConfirmDelete(false)` at line 42):

```typescript
setEditing(false);
setEditContent("");
```

**Step 4: Add Escape key handler for edit mode**

Add a `useEffect` for keyboard handling:

```typescript
useEffect(() => {
  if (!editing) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      cancelEdit();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [editing]);
```

**Step 5: Update the header section**

Replace the header area (lines 109-128) to handle both view and edit modes:

View mode header — add pencil button next to the raw toggle:

```tsx
{/* Header */}
<div class="flex items-center justify-between mb-5">
  <div class="flex items-center gap-2.5">
    <span
      class="text-sm font-semibold capitalize tracking-wide"
      style={{ color: typeAccent }}
    >
      {typeLabel(thought.metadata?.type)}
    </span>
    <span class="text-xs text-[var(--text-muted)]">
      {relativeTime(thought.created_at)}
    </span>
    {thought.updated_at && new Date(thought.updated_at).getTime() - new Date(thought.created_at).getTime() > 1000 && (
      <span class="text-xs text-[var(--text-muted)] opacity-60">
        · edited {relativeTime(thought.updated_at)}
      </span>
    )}
  </div>
  {editing ? (
    <div class="flex items-center gap-2">
      <button
        onClick={cancelEdit}
        class="px-3 py-1.5 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] transition-colors"
      >
        Cancel
      </button>
      <button
        onClick={saveEdit}
        disabled={saving}
        class="px-4 py-1.5 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
      >
        {saving ? "Saving..." : "Save"}
      </button>
    </div>
  ) : (
    <div class="flex items-center gap-1">
      <button
        onClick={startEdit}
        class="p-2.5 rounded-lg hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover)] text-[var(--text-muted)] transition-colors"
        title="Edit"
      >
        <Pencil class="w-[18px] h-[18px]" />
      </button>
      <button
        onClick={() => setShowRaw(!showRaw)}
        class="p-2.5 rounded-lg hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover)] text-[var(--text-muted)] transition-colors"
        title={showRaw ? "Rendered" : "Raw"}
      >
        {showRaw ? <FileText class="w-[18px] h-[18px]" /> : <Code class="w-[18px] h-[18px]" />}
      </button>
    </div>
  )}
</div>
```

**Step 6: Update the content section**

Replace the content area (lines 131-139) to handle edit mode:

```tsx
{/* Content */}
<div class="detail-content">
  {editing ? (
    <div>
      <textarea
        ref={editRef}
        value={editContent}
        onInput={(e) => setEditContent((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            saveEdit();
          }
        }}
        class="w-full px-3 py-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] resize-none text-sm font-mono leading-relaxed"
        style={{ minHeight: "8rem", fieldSizing: "content" }}
      />
      {/* Re-process toggle */}
      <label class="flex items-center gap-3 mt-3 px-1 cursor-pointer select-none">
        <div
          role="switch"
          aria-checked={reprocess}
          onClick={() => setReprocess(!reprocess)}
          class={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
            reprocess ? "bg-[var(--accent)]" : "bg-[var(--bg-tertiary)]"
          }`}
        >
          <div
            class={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
              reprocess ? "translate-x-5" : ""
            }`}
          />
        </div>
        <span class="text-xs text-[var(--text-secondary)] leading-tight">
          Re-extract type, topics & people from content
        </span>
      </label>
    </div>
  ) : showRaw ? (
    <pre class="text-sm text-[var(--text-primary)] whitespace-pre-wrap font-mono bg-[var(--bg-secondary)] p-4 rounded-lg overflow-x-auto">
      {thought.content}
    </pre>
  ) : (
    <MarkdownRenderer content={thought.content} />
  )}
</div>
```

**Step 7: Dim related thoughts during edit**

Wrap the related thoughts section (lines 203-222) with conditional opacity:

```tsx
<div style={{ opacity: editing ? 0.4 : 1, pointerEvents: editing ? "none" : "auto", transition: "opacity 0.2s" }}>
```

**Step 8: Commit**

```bash
git add web/src/components/DetailPanel.tsx
git commit -m "feat: add inline thought editing with re-process toggle in DetailPanel"
```

---

### Task 4: Integration test — manual verification

**Step 1: Start dev environment**

Run: `cd /home/leo/Work/src/open-brain && make up`

**Step 2: Verify in browser**

1. Open the app, click on a thought to open DetailPanel
2. Click the pencil icon — verify textarea appears with content
3. Edit content, click Save — verify toast "Thought updated"
4. Enable re-process toggle, edit content, Save — verify toast "Updated & re-extracted metadata"
5. Check "edited X ago" appears in header
6. Test Cancel and Escape dismissal
7. Test on mobile viewport (bottom sheet context)
8. Test Ctrl+Enter to save

**Step 3: Run full test suite**

Run: `cd /home/leo/Work/src/open-brain && npx vitest run`
Expected: ALL PASS

**Step 4: Final commit if any fixes needed**

---

### Task 5: Run all tests and verify

**Step 1: Run complete test suite**

Run: `cd /home/leo/Work/src/open-brain && npx vitest run`
Expected: ALL PASS

**Step 2: Verify no TypeScript errors**

Run: `cd /home/leo/Work/src/open-brain && cd app && npx tsc --noEmit && cd ../web && npx tsc --noEmit`
Expected: No errors
