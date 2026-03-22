import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { api, type Entity, type EntityFact, type Thought } from "../api";
import { selectedThoughtId, showToast, nextOverlayZ, openOverlays } from "../state";
import { BottomSheet } from "./BottomSheet";
import { ThoughtCard } from "./ThoughtCard";
import { SwipeableCard } from "./SwipeableCard";
import { DetailPanel } from "./DetailPanel";
import { FactSection } from "./FactSection";
import { SuggestionTray } from "./SuggestionTray";
import { ConflictCard } from "./ConflictCard";
import { relativeTime } from "../lib/format";
import { User, Pencil, X, MessageCircle } from "lucide-preact";

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

interface EntityDetailPanelProps {
  entityId: string | null;
  onClose: () => void;
  onEntityChanged?: () => void;
  noScrim?: boolean;
}

export function EntityDetailPanel({ entityId, onClose, onEntityChanged, noScrim }: EntityDetailPanelProps) {
  const [entity, setEntity] = useState<Entity | null>(null);
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [factKey, setFactKey] = useState(0);
  const [conflict, setConflict] = useState<{ newFact: EntityFact; existing: { id: string; predicate: string; object_display_text: string; status: string } } | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const isMobile = useMobileDetect();
  const contentRef = useRef<HTMLDivElement>(null);
  const [zIndex, setZIndex] = useState(50);
  const [showScrim, setShowScrim] = useState(true);

  useEffect(() => {
    if (!entityId) {
      setEntity(null);
      setThoughts([]);
      setNextCursor(null);
      return;
    }
    setShowScrim(openOverlays.value === 0);
    setZIndex(nextOverlayZ());
    openOverlays.value++;

    setLoading(true);
    setEditing(false);
    setConflict(null);
    setFactKey(0);

    Promise.all([
      api.entity(entityId!),
      api.entityThoughts(entityId!),
    ]).then(([e, t]) => {
      setEntity(e);
      setThoughts(t.thoughts);
      setNextCursor(t.next_cursor);
      setLoading(false);
      contentRef.current?.scrollTo(0, 0);
    }).catch(() => {
      showToast("Failed to load entity", "error");
      setLoading(false);
    });

    return () => { openOverlays.value--; };
  }, [entityId]);

  const loadMore = useCallback(() => {
    if (!entityId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    api.entityThoughts(entityId, nextCursor).then((r) => {
      setThoughts((prev) => [...prev, ...r.thoughts]);
      setNextCursor(r.next_cursor);
    }).catch(() => {
      showToast("Failed to load more", "error");
    }).finally(() => setLoadingMore(false));
  }, [entityId, nextCursor, loadingMore]);

  const startEdit = () => {
    if (!entity) return;
    setEditValue(entity.canonical_name);
    setEditing(true);
    setTimeout(() => editRef.current?.focus(), 50);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditValue("");
  };

  const saveEdit = async () => {
    if (!entity) return;
    const newName = editValue.trim();
    if (!newName || newName === entity.canonical_name) {
      cancelEdit();
      return;
    }

    try {
      await api.updateEntity(entity.id, { canonical_name: newName });
      setEntity({ ...entity, canonical_name: newName });
      setEditing(false);
      showToast(`Renamed to "${newName}"`, "success");
      onEntityChanged?.();
    } catch (err: unknown) {
      const conflict = (err as { conflict?: { conflict: string; existing_entity: { id: string; canonical_name: string } } }).conflict;
      if (conflict?.conflict === "name_exists") {
        const target = conflict.existing_entity;
        if (confirm(`"${target.canonical_name}" already exists. Merge into "${target.canonical_name}"?`)) {
          try {
            await api.mergeEntities(entity.id, target.id);
            showToast(`Merged into "${target.canonical_name}"`, "success");
            setEditing(false);
            onClose();
            onEntityChanged?.();
          } catch {
            showToast("Failed to merge", "error");
          }
        } else {
          cancelEdit();
        }
      } else {
        showToast("Failed to rename", "error");
      }
    }
  };

  const handleDeleteThought = useCallback(async (id: string) => {
    await api.deleteThought(id);
    showToast("Thought deleted", "success");
    setThoughts((prev) => prev.filter((t) => t.id !== id));
    if (entity) {
      setEntity({ ...entity, mention_count: entity.mention_count - 1 });
    }
  }, [entity]);

  // Keyboard: Escape to close (or cancel edit)
  useEffect(() => {
    if (!entityId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editing) {
          e.stopPropagation();
          cancelEdit();
        } else if (!selectedThoughtId.value) {
          e.stopPropagation();
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [entityId, editing, onClose]);

  if (!entityId) return null;

  const personColor = "var(--type-person-note)";

  const panelInner = (
    <>
      {loading ? (
        <div class="p-6 space-y-4">
          <div class="flex items-center gap-4">
            <div class="w-14 h-14 rounded-full bg-[var(--bg-tertiary)] animate-pulse" />
            <div class="space-y-2 flex-1">
              <div class="h-5 w-32 rounded bg-[var(--bg-tertiary)] animate-pulse" />
              <div class="h-3 w-20 rounded bg-[var(--bg-tertiary)] animate-pulse" />
            </div>
          </div>
          <div class="space-y-2 mt-6">
            <div class="h-3 w-full rounded bg-[var(--bg-tertiary)] animate-pulse" />
            <div class="h-3 w-5/6 rounded bg-[var(--bg-tertiary)] animate-pulse" />
          </div>
        </div>
      ) : entity ? (
        <div class="detail-stagger">
          {/* Accent bar */}
          <div class="h-1 w-full" style={{ background: `linear-gradient(90deg, ${personColor}, transparent)` }} />

          <div class="p-5 sm:p-6">
            {/* Entity header */}
            <div class="flex items-start gap-4 mb-5">
              <div
                class="w-14 h-14 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: `color-mix(in srgb, ${personColor} 15%, transparent)` }}
              >
                <User class="w-7 h-7" style={{ color: personColor }} />
              </div>

              <div class="flex-1 min-w-0">
                {editing ? (
                  <div class="flex items-center gap-2">
                    <input
                      ref={editRef}
                      class="text-lg font-semibold text-[var(--text-primary)] bg-transparent border-b-2 border-[var(--accent)] outline-none w-full py-0.5"
                      value={editValue}
                      onInput={(e) => setEditValue((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") saveEdit();
                        if (e.key === "Escape") cancelEdit();
                      }}
                    />
                    <button
                      onClick={cancelEdit}
                      class="p-1.5 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-muted)] transition-colors flex-shrink-0"
                    >
                      <X class="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div class="flex items-center gap-2 group/name">
                    <h2 class="text-lg font-semibold text-[var(--text-primary)] truncate">
                      {entity.canonical_name}
                    </h2>
                    <button
                      onClick={startEdit}
                      class="p-1.5 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-muted)] transition-colors opacity-0 group-hover/name:opacity-100 flex-shrink-0"
                      title="Rename"
                    >
                      <Pencil class="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <p class="text-xs text-[var(--text-muted)] mt-0.5 capitalize">
                  {entity.entity_type}
                </p>
              </div>
            </div>

            {/* Stats row */}
            <div class="flex gap-4 mb-5">
              <div class="flex-1 p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)]">
                <p class="text-2xl font-semibold text-[var(--text-primary)] tabular-nums">
                  {entity.mention_count}
                </p>
                <p class="text-xs text-[var(--text-muted)]">
                  mention{entity.mention_count !== 1 ? "s" : ""}
                </p>
              </div>
              {entity.last_seen && (
                <div class="flex-1 p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)]">
                  <p class="text-sm font-medium text-[var(--text-primary)]">
                    {relativeTime(entity.last_seen)}
                  </p>
                  <p class="text-xs text-[var(--text-muted)]">last seen</p>
                </div>
              )}
              <div class="flex-1 p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)]">
                <p class="text-sm font-medium text-[var(--text-primary)]">
                  {relativeTime(entity.created_at)}
                </p>
                <p class="text-xs text-[var(--text-muted)]">first seen</p>
              </div>
            </div>

            {/* Aliases */}
            {entity.aliases.filter((a) => a.toLowerCase() !== entity.canonical_name.toLowerCase()).length > 0 && (
              <div class="mb-5">
                <h4 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
                  Also known as
                </h4>
                <div class="flex flex-wrap gap-1.5">
                  {entity.aliases
                    .filter((a) => a.toLowerCase() !== entity.canonical_name.toLowerCase())
                    .map((alias) => (
                      <span
                        key={alias}
                        class="text-xs px-2.5 py-1 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] bg-[var(--bg-secondary)]"
                      >
                        {alias}
                      </span>
                    ))}
                </div>
              </div>
            )}

            {/* Facts section */}
            <FactSection
              key={`facts-${entityId}-${factKey}`}
              entityId={entity.id}
              onFactChanged={() => setFactKey((k) => k + 1)}
              onThoughtClick={(id) => { selectedThoughtId.value = id; }}
              onConflict={(newFact, existing) => setConflict({ newFact, existing })}
            />

            {/* Suggestions */}
            <SuggestionTray
              key={`suggestions-${entityId}-${factKey}`}
              entityId={entity.id}
              onConflict={(newFact, existing) => setConflict({ newFact, existing })}
              onChanged={() => { setFactKey((k) => k + 1); setConflict(null); }}
              onThoughtClick={(id) => { selectedThoughtId.value = id; }}
            />

            {/* Conflict resolution */}
            {conflict && (
              <ConflictCard
                entityId={entity.id}
                newFact={conflict.newFact}
                existingFact={conflict.existing}
                onResolved={() => { setConflict(null); setFactKey((k) => k + 1); }}
                onCancel={() => setConflict(null)}
              />
            )}

            {/* Chat about entity */}
            <div class="mb-5">
              <a
                href={`/chat?entity_id=${entity.id}`}
                class="inline-flex items-center gap-1.5 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
              >
                <MessageCircle class="w-3.5 h-3.5" /> Chat about {entity.canonical_name}
              </a>
            </div>

            {/* Thoughts section */}
            <div class="border-t border-[var(--border-color)] pt-4">
              <h4 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-3">
                Thoughts ({entity.mention_count})
              </h4>

              {thoughts.length === 0 ? (
                <p class="text-sm text-[var(--text-muted)]">No thoughts found</p>
              ) : (
                <div class="space-y-2">
                  {thoughts.map((t) => (
                    <SwipeableCard
                      key={t.id}
                      onDelete={() => handleDeleteThought(t.id)}
                    >
                      <ThoughtCard
                        thought={t}
                        selected={selectedThoughtId.value === t.id}
                        onClick={() => {
                          selectedThoughtId.value = t.id;
                        }}
                      />
                    </SwipeableCard>
                  ))}

                  {nextCursor && (
                    <button
                      onClick={loadMore}
                      disabled={loadingMore}
                      class="w-full py-2.5 rounded-lg text-sm text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors disabled:opacity-50"
                    >
                      {loadingMore ? "Loading..." : "Load more"}
                    </button>
                  )}
                </div>
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
        <DetailPanel />
        <BottomSheet onClose={onClose} noScrim={!showScrim} zIndex={zIndex}>
          {panelInner}
        </BottomSheet>
      </>
    );
  }

  // Desktop: side panel (same pattern as DetailPanel)
  return (
    <>
      <DetailPanel />
      <div
        class="fixed inset-0 flex justify-end animate-[fadeIn_0.15s_ease-out]"
        style={{ zIndex }}
        onClick={onClose}
      >
        {showScrim && !noScrim && <div class="absolute inset-0 bg-black/40" />}
        <div
          ref={contentRef}
          class="detail-panel relative w-full max-w-xl bg-[var(--bg-primary)] h-full overflow-y-auto border-l border-[var(--border-color)]"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={onClose}
            class="sticky top-0 float-right m-3 z-10 p-2 rounded-lg bg-[var(--bg-secondary)]/80 backdrop-blur-sm hover:bg-[var(--surface-hover)] text-[var(--text-muted)] transition-colors"
            title="Close (Esc)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          {panelInner}
        </div>
      </div>
    </>
  );
}
