import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { selectedLoopId, selectedThoughtId, showToast } from "../state";
import { api, type Loop, type Thought } from "../api";
import { BottomSheet } from "./BottomSheet";
import { DetailPanel } from "./DetailPanel";
import { ThoughtCard } from "./ThoughtCard";
import { typeColors, typeLabels, typeIcons } from "./LoopCard";
import { relativeTime } from "../lib/format";
import {
  Check, AlarmClock, RotateCcw, Trash2, Plus, Search, X,
} from "lucide-preact";

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

interface LoopDetailPanelProps {
  onLoopChanged?: () => void;
}

export function LoopDetailPanel({ onLoopChanged }: LoopDetailPanelProps) {
  const id = selectedLoopId.value;
  const [loop, setLoop] = useState<(Loop & { evidence?: Thought[] }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showResolution, setShowResolution] = useState(false);
  const [resolution, setResolution] = useState("");
  const [showSnooze, setShowSnooze] = useState(false);
  const [snoozeDate, setSnoozeDate] = useState("");
  const [linkSearchOpen, setLinkSearchOpen] = useState(false);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState<Thought[]>([]);
  const [linkSearching, setLinkSearching] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [noteContent, setNoteContent] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useMobileDetect();
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) {
      setLoop(null);
      return;
    }

    setLoading(true);
    setConfirmDelete(false);
    setShowResolution(false);
    setResolution("");
    setShowSnooze(false);
    setLinkSearchOpen(false);
    setLinkQuery("");
    setLinkResults([]);
    setAddingNote(false);
    setNoteContent("");

    api.loop(id).then((data) => {
      setLoop(data);
      setLoading(false);
      contentRef.current?.scrollTo(0, 0);
    }).catch(() => {
      showToast("Failed to load loop", "error");
      setLoading(false);
    });
  }, [id]);

  // Lock body scroll on mobile when panel is open
  useEffect(() => {
    if (id && isMobile) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [id, isMobile]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "q" || e.key === "Escape") {
        if (!selectedThoughtId.value) {
          e.preventDefault();
          close();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [id]);

  if (!id) return null;

  const close = () => {
    selectedLoopId.value = null;
  };

  const handleClose = async () => {
    if (!loop) return;
    const needsResolution = loop.loop_type === "question" || loop.loop_type === "decision";
    if (needsResolution && !showResolution) {
      setShowResolution(true);
      return;
    }
    try {
      await api.closeLoop(loop.id, resolution || undefined);
      showToast("Loop closed", "success");
      setLoop({ ...loop, status: "closed", resolution: resolution || loop.resolution, closed_at: new Date().toISOString() });
      setShowResolution(false);
      setResolution("");
      onLoopChanged?.();
    } catch {
      showToast("Failed to close loop", "error");
    }
  };

  const handleSnooze = async () => {
    if (!loop) return;
    if (!showSnooze) {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      setSnoozeDate(d.toISOString().slice(0, 10));
      setShowSnooze(true);
      return;
    }
    if (!snoozeDate) return;
    try {
      await api.snoozeLoop(loop.id, snoozeDate);
      showToast("Reminder set", "success");
      setLoop({ ...loop, status: "snoozed", snoozed_until: snoozeDate });
      setShowSnooze(false);
      onLoopChanged?.();
    } catch {
      showToast("Failed to snooze loop", "error");
    }
  };

  const handleReopen = async () => {
    if (!loop) return;
    try {
      await api.reopenLoop(loop.id);
      showToast("Loop reopened", "success");
      setLoop({ ...loop, status: "open", closed_at: null, snoozed_until: null });
      onLoopChanged?.();
    } catch {
      showToast("Failed to reopen loop", "error");
    }
  };

  const handleDelete = async () => {
    if (!loop) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await api.deleteLoop(loop.id);
      showToast("Loop deleted", "success");
      selectedLoopId.value = null;
      onLoopChanged?.();
    } catch {
      showToast("Failed to delete loop", "error");
    }
  };

  // Debounced search for linking thoughts
  useEffect(() => {
    if (!linkQuery.trim()) {
      setLinkResults([]);
      return;
    }
    setLinkSearching(true);
    const timer = setTimeout(() => {
      api.search(linkQuery.trim(), undefined, 5)
        .then((res) => setLinkResults(res.results))
        .catch(() => setLinkResults([]))
        .finally(() => setLinkSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [linkQuery]);

  // Focus search input when opened
  useEffect(() => {
    if (linkSearchOpen) linkInputRef.current?.focus();
  }, [linkSearchOpen]);

  const handleLinkThought = async (thoughtId: string) => {
    if (!loop) return;
    try {
      await api.linkEvidence(loop.id, thoughtId);
      const updated = await api.loop(loop.id);
      setLoop(updated);
      setLinkSearchOpen(false);
      setLinkQuery("");
      setLinkResults([]);
      showToast("Thought linked", "success");
    } catch {
      showToast("Failed to link thought", "error");
    }
  };

  const handleUnlinkEvidence = async (thoughtId: string) => {
    if (!loop) return;
    try {
      await api.unlinkEvidence(loop.id, thoughtId);
      setLoop({
        ...loop,
        evidence: loop.evidence?.filter((t) => t.id !== thoughtId),
      });
      showToast("Evidence removed", "success");
    } catch {
      showToast("Failed to unlink", "error");
    }
  };

  const handleAddNote = async () => {
    if (!loop || !noteContent.trim() || savingNote) return;
    setSavingNote(true);
    try {
      const captured = await api.capture(noteContent.trim(), "loop_evidence");
      await api.linkEvidence(loop.id, captured.id);
      const updated = await api.loop(loop.id);
      setLoop(updated);
      setNoteContent("");
      setAddingNote(false);
      showToast("Note added & linked", "success");
    } catch {
      showToast("Failed to add note", "error");
    } finally {
      setSavingNote(false);
    }
  };

  const color = loop ? typeColors[loop.loop_type] : "var(--text-muted)";
  const Icon = loop ? typeIcons[loop.loop_type] : null;
  const isClosed = loop?.status === "closed";

  const panelInner = (
    <>
      {loading ? (
        <div class="p-6 space-y-4">
          <div class="h-4 w-24 rounded bg-[var(--bg-tertiary)] animate-pulse" />
          <div class="space-y-2">
            <div class="h-3 w-full rounded bg-[var(--bg-tertiary)] animate-pulse" />
            <div class="h-3 w-5/6 rounded bg-[var(--bg-tertiary)] animate-pulse" />
          </div>
          <div class="h-3 w-32 rounded bg-[var(--bg-tertiary)] animate-pulse" />
        </div>
      ) : loop ? (
        <div class="detail-stagger">
          {/* Type accent bar */}
          <div class="h-1 w-full" style={{ background: `linear-gradient(90deg, ${color}, transparent)` }} />

          <div class="p-5 sm:p-6">
            {/* Header — type + status + time */}
            <div class="flex items-center justify-between mb-5">
              <div class="flex items-center gap-2.5 min-w-0">
                {Icon && <Icon class="w-5 h-5 flex-shrink-0" style={{ color }} />}
                <span class="text-sm font-semibold tracking-wide flex-shrink-0" style={{ color }}>
                  {typeLabels[loop.loop_type]}
                </span>
                {loop.status !== "open" && (
                  <span class={`text-xs px-2 py-0.5 rounded-full ${
                    isClosed
                      ? "bg-green-500/15 text-green-400"
                      : "bg-amber-500/15 text-amber-400"
                  }`}>
                    {isClosed ? "Closed" : "Snoozed"}
                  </span>
                )}
                <span class="text-xs text-[var(--text-muted)] flex-shrink-0">
                  {relativeTime(loop.created_at)}
                </span>
              </div>
            </div>

            {/* Content */}
            <div class="mb-6">
              <p class={`text-base text-[var(--text-primary)] leading-relaxed ${isClosed ? "line-through opacity-60" : ""}`}>
                {loop.content}
              </p>
            </div>

            {/* Resolution (when closed) */}
            {loop.resolution && (
              <div class="mb-6 bg-[var(--bg-secondary)] rounded-lg p-3">
                <h4 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-1.5">
                  Resolution
                </h4>
                <p class="text-sm text-[var(--text-primary)] leading-relaxed">
                  {loop.resolution}
                </p>
              </div>
            )}

            {/* Reminder date */}
            {loop.status === "snoozed" && loop.snoozed_until && (
              <div class="mb-6 flex items-center gap-2 text-sm text-amber-400">
                <AlarmClock class="w-4 h-4" />
                Remind me {new Date(loop.snoozed_until).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              </div>
            )}

            {/* Action buttons */}
            <div class="flex items-center gap-2 mb-6">
              {isClosed ? (
                <button
                  onClick={handleReopen}
                  class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm text-[var(--text-secondary)] bg-[var(--bg-secondary)] hover:bg-[var(--surface-hover)] transition-colors"
                >
                  <RotateCcw class="w-4 h-4" />
                  Reopen
                </button>
              ) : (
                <>
                  <button
                    onClick={handleClose}
                    class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm text-green-400 bg-green-400/10 hover:bg-green-400/20 transition-colors"
                  >
                    <Check class="w-4 h-4" />
                    Close
                  </button>
                  <button
                    onClick={handleSnooze}
                    class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm text-amber-400 bg-amber-400/10 hover:bg-amber-400/20 transition-colors"
                  >
                    <AlarmClock class="w-4 h-4" />
                    Remind me
                  </button>
                </>
              )}
            </div>

            {/* Resolution input */}
            {showResolution && (
              <div class="mb-6">
                <div class="flex gap-2">
                  <input
                    type="text"
                    class="flex-1 text-sm bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                    placeholder={loop.loop_type === "question" ? "Answer..." : "Decision & rationale..."}
                    value={resolution}
                    onInput={(e) => setResolution((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleClose();
                      if (e.key === "Escape") setShowResolution(false);
                    }}
                    autoFocus
                  />
                  <button
                    onClick={handleClose}
                    class="px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-500 transition-colors"
                  >
                    Close
                  </button>
                  <button
                    onClick={() => setShowResolution(false)}
                    class="px-3 py-2 rounded-lg text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Reminder date picker */}
            {showSnooze && (
              <div class="mb-6">
                <label class="text-xs text-[var(--text-muted)] mb-1 block">Remind me on</label>
                <div class="flex gap-2">
                  <input
                    type="date"
                    class="flex-1 text-sm bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                    value={snoozeDate}
                    onInput={(e) => setSnoozeDate((e.target as HTMLInputElement).value)}
                  />
                  <button
                    onClick={handleSnooze}
                    class="px-4 py-2 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-500 transition-colors"
                  >
                    Set reminder
                  </button>
                  <button
                    onClick={() => setShowSnooze(false)}
                    class="px-3 py-2 rounded-lg text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Evidence thoughts */}
            <div class="mt-6 pt-4 border-t border-[var(--border-color)]">
              <div class="flex items-center justify-between mb-3">
                <h4 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                  Linked Thoughts{loop.evidence && loop.evidence.length > 0 ? ` (${loop.evidence.length})` : ""}
                </h4>
                {!linkSearchOpen && !addingNote && (
                  <div class="flex items-center gap-2">
                    <button
                      onClick={() => setLinkSearchOpen(true)}
                      class="flex items-center gap-1 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                    >
                      <Search class="w-3 h-3" />
                      Link thought
                    </button>
                    <button
                      onClick={() => setAddingNote(true)}
                      class="flex items-center gap-1 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                    >
                      <Plus class="w-3 h-3" />
                      Add note
                    </button>
                  </div>
                )}
              </div>

              {/* Link thought search */}
              {linkSearchOpen && (
                <div class="mb-3">
                  <div class="relative">
                    <input
                      ref={linkInputRef}
                      type="text"
                      value={linkQuery}
                      onInput={(e) => setLinkQuery((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setLinkSearchOpen(false);
                          setLinkQuery("");
                          setLinkResults([]);
                        }
                      }}
                      placeholder="Search thoughts to link..."
                      class="w-full text-sm px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--accent)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                    />
                    <button
                      onClick={() => { setLinkSearchOpen(false); setLinkQuery(""); setLinkResults([]); }}
                      class="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    >
                      <X class="w-4 h-4" />
                    </button>
                  </div>
                  {linkSearching && (
                    <p class="text-xs text-[var(--text-muted)] mt-2">Searching...</p>
                  )}
                  {linkResults.length > 0 && (
                    <div class="mt-2 space-y-1.5 max-h-60 overflow-y-auto">
                      {linkResults.map((t) => (
                        <ThoughtCard
                          key={t.id}
                          thought={t}
                          onClick={() => handleLinkThought(t.id)}
                        />
                      ))}
                    </div>
                  )}
                  {linkQuery.trim() && !linkSearching && linkResults.length === 0 && (
                    <p class="text-xs text-[var(--text-muted)] mt-2">No results</p>
                  )}
                </div>
              )}

              {/* Add note as evidence */}
              {addingNote && (
                <div class="mb-3">
                  <textarea
                    value={noteContent}
                    onInput={(e) => setNoteContent((e.target as HTMLTextAreaElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        handleAddNote();
                      }
                      if (e.key === "Escape") {
                        setAddingNote(false);
                        setNoteContent("");
                      }
                    }}
                    placeholder="Write a note to link as evidence..."
                    class="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] resize-y"
                    style={{ minHeight: "5rem" }}
                    autoFocus
                  />
                  <div class="flex justify-end gap-2 mt-2">
                    <button
                      onClick={() => { setAddingNote(false); setNoteContent(""); }}
                      class="px-3 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAddNote}
                      disabled={!noteContent.trim() || savingNote}
                      class="px-4 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
                    >
                      {savingNote ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              )}

              {loop.evidence && loop.evidence.length > 0 ? (
                <div class="space-y-2">
                  {loop.evidence.map((t) => (
                    <ThoughtCard
                      key={t.id}
                      thought={t}
                      badge={loop.evidence!.length > 1 && loop.source_thought_id === t.id ? "Source" : undefined}
                      onClick={() => {
                        selectedThoughtId.value = t.id;
                      }}
                      onRemove={loop.source_thought_id !== t.id ? () => handleUnlinkEvidence(t.id) : undefined}
                    />
                  ))}
                </div>
              ) : !linkSearchOpen && !addingNote ? (
                <p class="text-xs text-[var(--text-muted)]">No linked thoughts yet</p>
              ) : null}
            </div>

            {/* Metadata */}
            <div class="mt-6 pt-4 border-t border-[var(--border-color)]">
              <p class="text-xs text-[var(--text-muted)] tabular-nums">
                Created {new Date(loop.created_at).toLocaleString()}
              </p>
              {loop.closed_at && (
                <p class="text-xs text-[var(--text-muted)] tabular-nums mt-1">
                  Closed {new Date(loop.closed_at).toLocaleString()}
                </p>
              )}
            </div>

            {/* Delete zone */}
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
                  Delete loop
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );

  // Mobile: bottom sheet
  if (isMobile) {
    return (
      <>
        <BottomSheet onClose={close}>
          {panelInner}
        </BottomSheet>
        <DetailPanel />
      </>
    );
  }

  // Desktop: side panel
  return (
    <>
      <div
        class="fixed inset-0 z-50 flex justify-end animate-[fadeIn_0.15s_ease-out]"
        onClick={close}
      >
        <div class="absolute inset-0 bg-black/40" />
        <div
          ref={contentRef}
          class="detail-panel relative w-full max-w-xl bg-[var(--bg-primary)] h-full overflow-y-auto border-l border-[var(--border-color)]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close button */}
          <button
            onClick={close}
            class="sticky top-0 float-right m-3 z-10 p-2 rounded-lg bg-[var(--bg-secondary)]/80 backdrop-blur-sm hover:bg-[var(--surface-hover)] text-[var(--text-muted)] transition-colors"
            title="Close (q)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          {panelInner}
        </div>
      </div>
      <DetailPanel />
    </>
  );
}
