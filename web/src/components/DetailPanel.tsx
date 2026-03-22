import { useState, useEffect, useRef } from "preact/hooks";
import { route } from "preact-router";
import { selectedThoughtId, selectedLoopId, selectedEntityName, lastDeletedId, showToast, nextOverlayZ, openOverlays } from "../state";
import { api, type Thought, type Loop } from "../api";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ThoughtCard } from "./ThoughtCard";
import { BottomSheet } from "./BottomSheet";
import { typeColor, typeLabel, relativeTime } from "../lib/format";
import { Trash2, FileText, Code, Pencil, ChevronsLeft, ChevronsRight, Maximize2, Minimize2, MessageCircle, ExternalLink, ArrowLeft, Plus, Copy, Check } from "lucide-preact";
import { TopicEditor } from "./TopicEditor";

function useMobileDetect() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isMobile;
}

export function DetailPanel() {
  const id = selectedThoughtId.value;
  const [thought, setThought] = useState<Thought | null>(null);
  const [related, setRelated] = useState<(Thought & { similarity: number })[]>([]);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isMobile = useMobileDetect();
  const contentRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [reprocess, setReprocess] = useState(false);
  const [saving, setSaving] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [discussOpen, setDiscussOpen] = useState(false);
  const discussRef = useRef<HTMLDivElement>(null);
  const [thread, setThread] = useState<Thought[]>([]);
  const [loops, setLoops] = useState<Loop[]>([]);
  const [addingNote, setAddingNote] = useState(false);
  const [noteContent, setNoteContent] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [linkLoopOpen, setLinkLoopOpen] = useState(false);
  const [allLoops, setAllLoops] = useState<Loop[]>([]);
  const [loopFilter, setLoopFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const loopFilterRef = useRef<HTMLInputElement>(null);
  const [zIndex, setZIndex] = useState(50);
  const [showScrim, setShowScrim] = useState(true);

  useEffect(() => {
    if (!id) {
      setThought(null);
      setRelated([]);
      setThread([]);
      setLoops([]);
      return;
    }
    setShowScrim(openOverlays.value === 0);
    setZIndex(nextOverlayZ());
    openOverlays.value++;

    setLoading(true);
    setShowRaw(false);
    setConfirmDelete(false);
    setEditing(false);
    setEditContent("");
    setAddingNote(false);
    setNoteContent("");
    setLinkLoopOpen(false);
    setLoopFilter("");
    setCopied(false);

    Promise.all([
      api.thought(id!),
      api.related(id!).catch(() => ({ related: [] })),
      api.thread(id!).catch(() => ({ thread: [] })),
      api.loopsByThought(id!).catch(() => ({ loops: [] })),
    ]).then(([t, r, th, l]) => {
      setThought(t);
      setRelated(r.related);
      setThread(th.thread);
      setLoops(l.loops);
      setLoading(false);
      contentRef.current?.scrollTo(0, 0);
    }).catch(() => {
      showToast("Failed to load thought", "error");
      setLoading(false);
    });

    return () => { openOverlays.value--; };
  }, [id]);

  // Lock body scroll on mobile when panel is open
  useEffect(() => {
    if (id && isMobile) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [id, isMobile]);

  if (!id) return null;

  const close = () => {
    selectedThoughtId.value = null;
  };

  const handleDelete = async () => {
    if (!thought) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await api.deleteThought(thought.id);
      showToast("Thought deleted", "success");
      lastDeletedId.value = thought.id;
      selectedThoughtId.value = null;
    } catch {
      showToast("Failed to delete", "error");
    }
  };

  const startEdit = () => {
    if (!thought) return;
    setEditContent(thought.content);
    setReprocess(false);
    setEditing(true);
    setTimeout(() => editRef.current?.focus(), 50);
  };

  const handleCopy = async () => {
    if (!thought) return;
    try {
      await navigator.clipboard.writeText(thought.content);
      setCopied(true);
      showToast("Copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast("Failed to copy", "error");
    }
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

  // Fullscreen keyboard shortcuts (desktop only)
  useEffect(() => {
    if (isMobile || !id) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (editing) return;
      if (e.key === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setFullscreen((f) => !f);
      }
      if (e.key === "c" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        handleCopy();
      }
      if (e.key === "q" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Escape" && fullscreen) {
        e.stopPropagation();
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isMobile, id, editing, fullscreen]);

  // Discuss popover: close on click-outside or Escape
  useEffect(() => {
    if (!discussOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (discussRef.current && !discussRef.current.contains(e.target as Node)) {
        setDiscussOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setDiscussOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [discussOpen]);

  // Fetch open loops when link picker opens
  useEffect(() => {
    if (linkLoopOpen) {
      api.loops("open").then((res) => setAllLoops(res.loops)).catch(() => {});
      setTimeout(() => loopFilterRef.current?.focus(), 50);
    }
  }, [linkLoopOpen]);

  const handleLinkToLoop = async (loopId: string) => {
    if (!thought) return;
    try {
      await api.linkEvidence(loopId, thought.id);
      const updated = await api.loopsByThought(thought.id);
      setLoops(updated.loops);
      setLinkLoopOpen(false);
      setLoopFilter("");
      showToast("Linked to loop", "success");
    } catch {
      showToast("Failed to link to loop", "error");
    }
  };

  const filteredLoops = allLoops.filter((l) =>
    l.content.toLowerCase().includes(loopFilter.toLowerCase()) &&
    !loops.some((existing) => existing.id === l.id),
  );

  const typeAccent = typeColor(thought?.metadata?.type);

  const panelInner = (
    <>
      {loading ? (
        <div class="p-6 space-y-4">
          <div class="h-4 w-24 rounded bg-[var(--bg-tertiary)] animate-pulse" />
          <div class="space-y-2">
            <div class="h-3 w-full rounded bg-[var(--bg-tertiary)] animate-pulse" />
            <div class="h-3 w-5/6 rounded bg-[var(--bg-tertiary)] animate-pulse" />
            <div class="h-3 w-4/6 rounded bg-[var(--bg-tertiary)] animate-pulse" />
          </div>
          <div class="h-3 w-32 rounded bg-[var(--bg-tertiary)] animate-pulse" />
        </div>
      ) : thought ? (
        <div class="detail-stagger">
          {/* Type accent bar */}
          <div class="h-1 w-full" style={{ background: `linear-gradient(90deg, ${typeAccent}, transparent)` }} />

          <div class="p-5 sm:p-6">
            {/* Parent breadcrumb for sub-thoughts */}
            {thought.parent_id && (
              <button
                onClick={() => { selectedThoughtId.value = thought.parent_id!; }}
                class="flex items-center gap-1.5 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] mb-3 transition-colors"
              >
                <ArrowLeft class="w-3 h-3" />
                Parent thought
              </button>
            )}

            {/* Header — type + time on left, edit/view controls on right */}
            <div class="flex items-center justify-between mb-5">
              <div class="flex items-center gap-2.5 min-w-0">
                <span
                  class="text-sm font-semibold capitalize tracking-wide flex-shrink-0"
                  style={{ color: typeAccent }}
                >
                  {typeLabel(thought.metadata?.type)}
                </span>
                <span class="text-xs text-[var(--text-muted)] flex-shrink-0">
                  {relativeTime(thought.created_at)}
                </span>
                {thought.updated_at && new Date(thought.updated_at).getTime() - new Date(thought.created_at).getTime() > 1000 && (
                  <span class="text-xs text-[var(--text-muted)] opacity-60 truncate">
                    · edited {relativeTime(thought.updated_at)}
                  </span>
                )}
              </div>
              {editing ? (
                <div class="flex items-center gap-2 flex-shrink-0">
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
                <div class="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={handleCopy}
                    class="p-2.5 rounded-lg hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover)] text-[var(--text-muted)] transition-colors"
                    title="Copy content (c)"
                  >
                    {copied ? <Check class="w-[18px] h-[18px] text-green-500" /> : <Copy class="w-[18px] h-[18px]" />}
                  </button>
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
                  {!isMobile && (
                    <button
                      onClick={() => setFullscreen(!fullscreen)}
                      class="p-2.5 rounded-lg hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover)] text-[var(--text-muted)] transition-colors"
                      title={fullscreen ? "Exit fullscreen (f)" : "Fullscreen (f)"}
                    >
                      {fullscreen ? <Minimize2 class="w-[18px] h-[18px]" /> : <Maximize2 class="w-[18px] h-[18px]" />}
                    </button>
                  )}
                  <div class="relative" ref={discussRef}>
                    <button
                      onClick={() => setDiscussOpen(!discussOpen)}
                      class="p-2.5 rounded-lg hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover)] text-[var(--text-muted)] transition-colors"
                      title="Discuss with AI"
                    >
                      <MessageCircle class="w-[18px] h-[18px]" />
                    </button>
                    {discussOpen && thought && (
                      <div
                        class="absolute right-0 top-full mt-1.5 z-50 bg-[var(--surface)] border border-[var(--border-color)] rounded-xl shadow-lg overflow-hidden"
                        style={{ opacity: 1, transition: "opacity 150ms" }}
                      >
                        <button
                          class="w-full px-4 py-2.5 text-sm text-left text-[var(--text-primary)] hover:bg-[var(--surface-hover)] cursor-pointer transition-colors"
                          onClick={() => {
                            setDiscussOpen(false);
                            selectedThoughtId.value = null;
                            route("/chat?thoughtId=" + thought.id);
                          }}
                        >
                          Brain Chat
                        </button>
                        <button
                          class="w-full px-4 py-2.5 text-sm text-left text-[var(--text-primary)] hover:bg-[var(--surface-hover)] cursor-pointer transition-colors flex items-center gap-2"
                          onClick={() => {
                            setDiscussOpen(false);
                            window.open(
                              "https://claude.ai/new?q=" +
                                encodeURIComponent(
                                  `Use the get_thought tool from Open Brain to fetch thought "${thought.id}" and let's discuss it.`
                                ),
                              "_blank",
                            );
                          }}
                        >
                          Claude
                          <ExternalLink class="w-3 h-3 text-[var(--text-muted)]" />
                        </button>
                        <button
                          class="w-full px-4 py-2.5 text-sm text-left text-[var(--text-primary)] hover:bg-[var(--surface-hover)] cursor-pointer transition-colors flex items-center gap-2"
                          onClick={() => {
                            setDiscussOpen(false);
                            window.open(
                              "https://chatgpt.com/?q=" +
                                encodeURIComponent(
                                  `Use the get_thought tool from Open Brain to fetch thought "${thought.id}" and let's discuss it.`
                                ),
                              "_blank",
                            );
                          }}
                        >
                          ChatGPT
                          <ExternalLink class="w-3 h-3 text-[var(--text-muted)]" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

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
                    class="w-full px-4 py-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] resize-y text-base font-mono leading-relaxed"
                    style={{ minHeight: "14rem" }}
                  />
                  {/* Re-process toggle */}
                  <label class="flex items-center gap-3 mt-3 px-1 cursor-pointer select-none">
                    <div
                      role="switch"
                      tabIndex={0}
                      aria-checked={reprocess}
                      onClick={() => setReprocess(!reprocess)}
                      onKeyDown={(e) => {
                        if (e.key === " " || e.key === "Enter") {
                          e.preventDefault();
                          setReprocess(!reprocess);
                        }
                      }}
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

            {/* Metadata */}
            <div class="mt-6 pt-4 border-t border-[var(--border-color)]">
              {/* Topics */}
              <TopicEditor
                thoughtId={thought.id}
                topics={thought.metadata?.topics || []}
                onUpdate={(topics) =>
                  setThought({ ...thought, metadata: { ...thought.metadata, topics } })
                }
              />

              {/* People */}
              {thought.metadata?.people && thought.metadata.people.length > 0 && (
                <div class="flex flex-wrap gap-1.5 mb-3">
                  {thought.metadata.people.map((p) => (
                    <span
                      key={p}
                      class="text-xs px-2.5 py-1 rounded-md bg-[var(--type-person-note)]/15 text-[var(--type-person-note)] cursor-pointer hover:bg-[var(--type-person-note)]/25 active:scale-95 transition-all"
                      onClick={() => {
                        selectedEntityName.value = p;
                      }}
                    >
                      {p}
                    </span>
                  ))}
                </div>
              )}

              {/* Loops (action items) */}
              <div class="mt-4">
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Loops{loops.length > 0 ? ` (${loops.length})` : ""}
                  </h4>
                  {!linkLoopOpen && (
                    <button
                      onClick={() => setLinkLoopOpen(true)}
                      class="flex items-center gap-1 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                    >
                      <Plus class="w-3 h-3" />
                      Link to loop
                    </button>
                  )}
                </div>

                {/* Link to loop picker */}
                {linkLoopOpen && (
                  <div class="mb-3">
                    <input
                      ref={loopFilterRef}
                      type="text"
                      value={loopFilter}
                      onInput={(e) => setLoopFilter((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setLinkLoopOpen(false);
                          setLoopFilter("");
                        }
                      }}
                      placeholder="Filter open loops..."
                      class="w-full text-sm px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--accent)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none mb-2"
                    />
                    <div class="max-h-48 overflow-y-auto space-y-1">
                      {filteredLoops.length > 0 ? filteredLoops.slice(0, 10).map((l) => (
                        <button
                          key={l.id}
                          onClick={() => handleLinkToLoop(l.id)}
                          class="w-full text-left text-sm px-2.5 py-1.5 rounded-md hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] transition-colors flex items-start gap-2"
                        >
                          <span class="text-[var(--type-task)] mt-0.5 flex-shrink-0">{"\u2022"}</span>
                          <span class="line-clamp-2">{l.content}</span>
                          <span class="text-[10px] text-[var(--text-muted)] mt-0.5 flex-shrink-0 capitalize">{l.loop_type.replace("_", " ")}</span>
                        </button>
                      )) : (
                        <p class="text-xs text-[var(--text-muted)] px-2 py-1">No matching loops</p>
                      )}
                    </div>
                    <button
                      onClick={() => { setLinkLoopOpen(false); setLoopFilter(""); }}
                      class="mt-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {loops.length > 0 ? (
                  <ul class="space-y-1.5">
                    {loops.map((loop) => (
                      <li
                        key={loop.id}
                        class="text-sm flex items-start gap-2 leading-relaxed cursor-pointer hover:bg-[var(--surface-hover)] rounded-md px-1.5 py-1 -mx-1.5 transition-colors"
                        onClick={() => {
                          selectedThoughtId.value = null;
                          selectedLoopId.value = loop.id;
                          route("/loops?id=" + loop.id + "&status=" + loop.status);
                        }}
                      >
                        <span class={`mt-0.5 flex-shrink-0 text-xs ${loop.status === "closed" ? "text-green-500" : loop.status === "snoozed" ? "text-yellow-500" : "text-[var(--type-task)]"}`}>
                          {loop.status === "closed" ? "\u2713" : loop.status === "snoozed" ? "\u23F8\uFE0E" : "\u2022"}
                        </span>
                        <span class={loop.status === "closed" ? "text-[var(--text-muted)] line-through" : "text-[var(--text-secondary)]"}>
                          {loop.content}
                        </span>
                        <span class="text-[10px] text-[var(--text-muted)] mt-0.5 flex-shrink-0 capitalize">
                          {loop.loop_type.replace("_", " ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : !linkLoopOpen && thought.metadata?.action_items && thought.metadata.action_items.length > 0 ? (
                  <ul class="space-y-1.5">
                    {thought.metadata.action_items.map((item, i) => (
                      <li
                        key={i}
                        class="text-sm text-[var(--text-secondary)] flex items-start gap-2 leading-relaxed"
                      >
                        <span class="text-[var(--type-task)] mt-0.5">&#x2022;</span>
                        {typeof item === "string" ? item : item.content}
                      </li>
                    ))}
                  </ul>
                ) : !linkLoopOpen ? (
                  <p class="text-xs text-[var(--text-muted)]">No loops linked</p>
                ) : null}
              </div>

              {/* Source */}
              {thought.metadata?.source_context && (
                <p class="text-xs text-[var(--text-muted)] mt-3">
                  Source: {thought.metadata.source_context}
                </p>
              )}

              <p class="text-xs text-[var(--text-muted)] mt-2 tabular-nums">
                {new Date(thought.created_at).toLocaleString()}
              </p>
            </div>

            {/* Thread (sub-thoughts) */}
            {(thread.length > 0 || !thought.parent_id) && (
              <div class="mt-6 pt-4 border-t border-[var(--border-color)]" style={{ opacity: editing ? 0.4 : 1, pointerEvents: editing ? "none" : "auto", transition: "opacity 0.2s" }}>
                <div class="flex items-center justify-between mb-3">
                  <h4 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Thread{thread.length > 0 ? ` (${thread.length})` : ""}
                  </h4>
                  {!addingNote && (
                    <button
                      onClick={() => setAddingNote(true)}
                      class="flex items-center gap-1 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                    >
                      <Plus class="w-3 h-3" />
                      Add note
                    </button>
                  )}
                </div>

                {addingNote && (
                  <div class="mb-3">
                    <textarea
                      value={noteContent}
                      onInput={(e) => setNoteContent((e.target as HTMLTextAreaElement).value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          if (noteContent.trim()) {
                            setSavingNote(true);
                            api.capture(noteContent.trim(), "manual_note", thought.id)
                              .then(() => api.thread(thought.id))
                              .then((res) => {
                                setThread(res.thread);
                                setNoteContent("");
                                setAddingNote(false);
                                showToast("Note added");
                              })
                              .catch(() => showToast("Failed to save note", "error"))
                              .finally(() => setSavingNote(false));
                          }
                        }
                        if (e.key === "Escape") {
                          setAddingNote(false);
                          setNoteContent("");
                        }
                      }}
                      placeholder="Write a note..."
                      class="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] resize-y"
                      style={{ minHeight: "5rem" }}
                    />
                    <div class="flex justify-end gap-2 mt-2">
                      <button
                        onClick={() => { setAddingNote(false); setNoteContent(""); }}
                        class="px-3 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          if (!noteContent.trim() || savingNote) return;
                          setSavingNote(true);
                          api.capture(noteContent.trim(), "manual_note", thought.id)
                            .then(() => api.thread(thought.id))
                            .then((res) => {
                              setThread(res.thread);
                              setNoteContent("");
                              setAddingNote(false);
                              showToast("Note added");
                            })
                            .catch(() => showToast("Failed to save note", "error"))
                            .finally(() => setSavingNote(false));
                        }}
                        disabled={!noteContent.trim() || savingNote}
                        class="px-4 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
                      >
                        {savingNote ? "Saving..." : "Save"}
                      </button>
                    </div>
                  </div>
                )}

                {thread.length > 0 && (
                  <div class="space-y-2">
                    {thread.map((t) => (
                      <ThoughtCard
                        key={t.id}
                        thought={t}
                        onClick={() => { selectedThoughtId.value = t.id; }}
                      />
                    ))}
                  </div>
                )}

                {thread.length === 0 && !addingNote && (
                  <p class="text-xs text-[var(--text-muted)]">No notes yet</p>
                )}
              </div>
            )}

            {/* Related thoughts */}
            {related.length > 0 && (
              <div class="mt-6 pt-4 border-t border-[var(--border-color)]" style={{ opacity: editing ? 0.4 : 1, pointerEvents: editing ? "none" : "auto", transition: "opacity 0.2s" }}>
                <h4 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-3">
                  Related Thoughts
                </h4>
                <div class="space-y-2">
                  {related.map((r) => (
                    <ThoughtCard
                      key={r.id}
                      thought={r}
                      similarity={r.similarity}
                      onClick={() => {
                        selectedThoughtId.value = r.id;
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Delete zone — isolated at bottom, well separated from content */}
            <div class="mt-8 pt-4 border-t border-[var(--border-color)]" style={{ paddingBottom: "var(--viewport-offset-bottom)" }}>
              {confirmDelete ? (
                <div class="flex gap-3">
                  <button
                    onClick={handleDelete}
                    class="flex-1 py-3 rounded-xl bg-red-500/15 text-red-400 text-sm font-medium active:bg-red-500/25 transition-colors"
                  >
                    Confirm Delete
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    class="flex-1 py-3 rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)] text-sm font-medium active:bg-[var(--surface-hover)] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleDelete}
                  class="w-full py-3 rounded-xl text-[var(--text-muted)] text-sm flex items-center justify-center gap-2 hover:bg-red-500/10 hover:text-red-400 active:bg-red-500/15 transition-colors"
                >
                  <Trash2 class="w-4 h-4" />
                  Delete thought
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );

  // Mobile: bottom sheet with swipe-to-close
  if (isMobile) {
    return (
      <BottomSheet onClose={close} noScrim={!showScrim} zIndex={zIndex}>
        {panelInner}
      </BottomSheet>
    );
  }

  // Desktop: side panel
  return (
    <div
      class="fixed inset-0 flex justify-end animate-[fadeIn_0.15s_ease-out]"
      style={{ zIndex }}
      onClick={close}
    >
      {showScrim && <div class="absolute inset-0 bg-black/40" />}
      <div
        ref={contentRef}
        class={`detail-panel group relative w-full bg-[var(--bg-primary)] h-full overflow-y-auto transition-[max-width,border-color] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          fullscreen
            ? "max-w-none"
            : `border-l border-[var(--border-color)] ${expanded ? "max-w-4xl" : "max-w-xl"}`
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Expand/collapse toggle on left edge */}
        {!fullscreen && (
          <button
            onClick={() => setExpanded(!expanded)}
            class="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-5 h-20 flex items-center justify-center rounded-r-lg bg-[var(--bg-secondary)] border border-l-0 border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] transition-all opacity-0 group-hover:opacity-60 hover:!opacity-100"
            title={expanded ? "Collapse panel" : "Expand panel"}
          >
            {expanded ? <ChevronsRight class="w-3.5 h-3.5" /> : <ChevronsLeft class="w-3.5 h-3.5" />}
          </button>
        )}
        {/* Desktop close: X in top-right corner */}
        <button
          onClick={close}
          class="sticky top-0 float-right m-3 z-10 p-2 rounded-lg bg-[var(--bg-secondary)]/80 backdrop-blur-sm hover:bg-[var(--surface-hover)] text-[var(--text-muted)] transition-colors"
          title="Close"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class={fullscreen ? "max-w-6xl mx-auto" : ""}>
          {panelInner}
        </div>
      </div>
    </div>
  );
}
