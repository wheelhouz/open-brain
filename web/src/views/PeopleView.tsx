import { useState, useEffect, useCallback } from "preact/hooks";
import type { RoutableProps } from "../lib/route";
import { api, type Entity, type Thought } from "../api";
import { selectedThoughtId, lastDeletedId, showToast } from "../state";
import { ThoughtCard } from "../components/ThoughtCard";
import { SwipeableCard } from "../components/SwipeableCard";
import { DetailPanel } from "../components/DetailPanel";
import { User, Pencil, Merge } from "lucide-preact";
import { relativeTime } from "../lib/format";

function EntityCard({
  entity,
  selected,
  onClick,
  onRename,
  mergeMode,
}: {
  entity: Entity;
  selected?: boolean;
  onClick: () => void;
  onRename?: (id: string, newName: string) => void;
  mergeMode?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(entity.canonical_name);

  const confirmEdit = () => {
    setEditing(false);
    const newName = editValue.trim();
    if (newName && newName !== entity.canonical_name && onRename) {
      onRename(entity.id, newName);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => { if (!editing) onClick(); }}
      onKeyDown={(e) => { if (e.key === "Enter" && !editing) onClick(); }}
      class={`group relative w-full text-left p-3 rounded-lg border transition-colors cursor-pointer flex items-center gap-3 ${
        selected
          ? mergeMode
            ? "bg-purple-500/10 border-purple-500"
            : "bg-[var(--accent)]/10 border-[var(--accent)]"
          : "bg-[var(--surface)] border-[var(--border-color)] hover:bg-[var(--surface-hover)]"
      }`}
    >
      <div class="w-10 h-10 rounded-full bg-[var(--type-person-note)]/20 flex items-center justify-center flex-shrink-0">
        <User class="w-5 h-5 text-[var(--type-person-note)]" />
      </div>
      <div class="flex-1 min-w-0">
        {editing ? (
          <input
            class="text-sm font-medium text-[var(--text-primary)] bg-transparent border-b border-[var(--accent)] outline-none w-full"
            value={editValue}
            onInput={(e) => setEditValue((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") confirmEdit();
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={confirmEdit}
            autoFocus
          />
        ) : (
          <p class="text-sm font-medium text-[var(--text-primary)] truncate">
            {entity.canonical_name}
          </p>
        )}
        {entity.aliases.length > 1 && (
          <p class="text-xs text-[var(--text-muted)] truncate">
            aka {entity.aliases.filter((a) => a !== entity.canonical_name).join(", ")}
          </p>
        )}
        <p class="text-xs text-[var(--text-muted)]">
          {entity.mention_count} thought{entity.mention_count !== 1 ? "s" : ""}
          {entity.last_seen && <> &middot; {relativeTime(entity.last_seen)}</>}
        </p>
      </div>
      {onRename && !editing && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          class="absolute top-2 right-2 w-5 h-5 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-color)] flex items-center justify-center opacity-40 sm:opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        >
          <Pencil class="w-3 h-3 text-[var(--text-secondary)]" />
        </button>
      )}
    </div>
  );
}

export function PeopleView(_props: RoutableProps) {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingThoughts, setLoadingThoughts] = useState(false);
  const [mergeSelection, setMergeSelection] = useState<string[]>([]);
  const mergeMode = mergeSelection.length > 0;

  const loadEntities = useCallback(() => {
    api
      .entities("person")
      .then((r) => setEntities(r.entities))
      .catch(() => {
        // Fallback to old /api/people if entities table isn't ready
        api.people().then((r) =>
          setEntities(
            r.people.map((p) => ({
              id: p.person, // use name as ID for fallback
              canonical_name: p.person,
              entity_type: "person",
              aliases: [p.person],
              attributes: {},
              mention_count: p.count,
              last_seen: p.last_seen,
              created_at: p.last_seen,
            })),
          ),
        );
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(loadEntities, [loadEntities]);

  useEffect(() => {
    if (!selectedId) {
      setThoughts([]);
      return;
    }
    setLoadingThoughts(true);
    // Try entities endpoint first, fall back to metadata filter
    const entity = entities.find((e) => e.id === selectedId);
    if (entity && entity.id !== entity.canonical_name) {
      // Real entity ID — use entities endpoint
      api
        .entityThoughts(selectedId)
        .then((r) => setThoughts(r.thoughts))
        .catch(() => {
          // Fallback
          if (entity) {
            api
              .thoughts({ person: entity.canonical_name, limit: 20 })
              .then((r) => setThoughts(r.thoughts));
          }
        })
        .finally(() => setLoadingThoughts(false));
    } else if (entity) {
      // Fallback mode — use person filter
      api
        .thoughts({ person: entity.canonical_name, limit: 20 })
        .then((r) => setThoughts(r.thoughts))
        .catch(() => {})
        .finally(() => setLoadingThoughts(false));
    }
  }, [selectedId, entities]);

  useEffect(() => {
    const id = lastDeletedId.value;
    if (id) {
      setThoughts((prev) => prev.filter((t) => t.id !== id));
      lastDeletedId.value = null;
    }
  }, [lastDeletedId.value]);

  const handleSwipeDelete = useCallback(async (id: string) => {
    await api.deleteThought(id);
    showToast("Thought deleted", "success");
    setThoughts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const handleRename = useCallback(async (entityId: string, newName: string) => {
    try {
      await api.updateEntity(entityId, { canonical_name: newName });
      showToast(`Renamed to "${newName}"`, "success");
      loadEntities();
    } catch {
      showToast("Failed to rename", "error");
    }
  }, [loadEntities]);

  const handleMergeToggle = useCallback((id: string) => {
    setMergeSelection((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id]; // keep last two
      return [...prev, id];
    });
  }, []);

  const handleMerge = useCallback(async () => {
    if (mergeSelection.length !== 2) return;
    try {
      const result = await api.mergeEntities(mergeSelection[0], mergeSelection[1]);
      showToast(`Merged into ${entities.find((e) => e.id === result.target_id)?.canonical_name || "entity"}`, "success");
      setMergeSelection([]);
      setSelectedId("");
      loadEntities();
    } catch {
      showToast("Failed to merge", "error");
    }
  }, [mergeSelection, entities, loadEntities]);

  const selectedEntity = entities.find((e) => e.id === selectedId);

  return (
    <div class="p-4">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-[var(--text-primary)]">People</h2>
        <div class="flex items-center gap-2">
          {mergeMode && mergeSelection.length === 2 && (
            <button
              onClick={handleMerge}
              class="text-xs px-3 py-1.5 rounded-lg bg-purple-600 text-white hover:bg-purple-500 flex items-center gap-1"
            >
              <Merge class="w-3 h-3" />
              Merge
            </button>
          )}
          <button
            onClick={() => setMergeSelection(mergeMode ? [] : [])}
            class={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
              mergeMode
                ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
            title={mergeMode ? "Cancel merge" : "Select entities to merge"}
          >
            {mergeMode ? "Cancel" : "Merge..."}
          </button>
        </div>
      </div>

      {loading ? (
        <p class="text-[var(--text-muted)] text-sm">Loading people...</p>
      ) : entities.length === 0 ? (
        <div class="text-center py-12">
          <p class="text-[var(--text-muted)]">No people mentioned yet</p>
          <p class="text-sm text-[var(--text-muted)] mt-1">
            People are extracted automatically from your thoughts
          </p>
        </div>
      ) : (
        <>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-6">
            {entities.map((entity) => (
              <EntityCard
                key={entity.id}
                entity={entity}
                selected={mergeMode ? mergeSelection.includes(entity.id) : selectedId === entity.id}
                onClick={() => mergeMode ? handleMergeToggle(entity.id) : setSelectedId(selectedId === entity.id ? "" : entity.id)}
                onRename={!mergeMode ? handleRename : undefined}
                mergeMode={mergeMode && mergeSelection.includes(entity.id)}
              />
            ))}
          </div>

          {selectedEntity && !mergeMode && (
            <div>
              <h3 class="text-sm font-medium text-[var(--text-secondary)] mb-3">
                Thoughts mentioning {selectedEntity.canonical_name}
              </h3>
              {loadingThoughts ? (
                <p class="text-[var(--text-muted)] text-sm">Loading...</p>
              ) : (
                <div class="space-y-2">
                  {thoughts.map((t) => (
                    <SwipeableCard
                      key={t.id}
                      onDelete={() => handleSwipeDelete(t.id)}
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
                </div>
              )}
            </div>
          )}
        </>
      )}

      <DetailPanel />
    </div>
  );
}
