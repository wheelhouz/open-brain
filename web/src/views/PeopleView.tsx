import { useState, useEffect, useCallback } from "preact/hooks";
import type { RoutableProps } from "../lib/route";
import { api, type Entity } from "../api";
import { selectedThoughtId } from "../state";
import { useUrlSignal } from "../hooks/useUrlSignal";
import { EntityDetailPanel } from "../components/EntityDetailPanel";
import { User } from "lucide-preact";
import { relativeTime } from "../lib/format";

function EntityCard({
  entity,
  selected,
  onClick,
}: {
  entity: Entity;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
      class={`group relative w-full text-left p-3 rounded-lg border transition-colors cursor-pointer flex items-center gap-3 ${
        selected
          ? "bg-[var(--accent)]/10 border-[var(--accent)]"
          : "bg-[var(--surface)] border-[var(--border-color)] hover:bg-[var(--surface-hover)]"
      }`}
    >
      <div class="w-10 h-10 rounded-full bg-[var(--type-person-note)]/20 flex items-center justify-center flex-shrink-0">
        <User class="w-5 h-5 text-[var(--type-person-note)]" />
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-[var(--text-primary)] truncate">
          {entity.canonical_name}
        </p>
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
    </div>
  );
}

export function PeopleView(_props: RoutableProps) {
  useUrlSignal(selectedThoughtId, "thought");

  const [entities, setEntities] = useState<Entity[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);

  const loadEntities = useCallback(() => {
    api
      .entities("person")
      .then((r) => setEntities(r.entities))
      .catch(() => {
        // Fallback to old /api/people if entities table isn't ready
        api.people().then((r) =>
          setEntities(
            r.people.map((p) => ({
              id: p.person,
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

  // Auto-select entity from ?selected= query param (matches by name/alias)
  const applySelectedParam = useCallback(() => {
    if (entities.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const selected = params.get("selected");
    if (!selected) return;
    const match = entities.find(
      (e) =>
        e.canonical_name.toLowerCase() === selected.toLowerCase() ||
        e.aliases.some((a) => a.toLowerCase() === selected.toLowerCase()),
    );
    if (match) setSelectedId(match.id);
  }, [entities]);

  useEffect(applySelectedParam, [applySelectedParam]);

  // Re-apply when navigating to /people?selected=... while already on People tab
  useEffect(() => {
    const onRouteChange = () => applySelectedParam();
    addEventListener("popstate", onRouteChange);
    const origPushState = history.pushState.bind(history);
    history.pushState = (...args) => { origPushState(...args); onRouteChange(); };
    return () => {
      removeEventListener("popstate", onRouteChange);
      history.pushState = origPushState;
    };
  }, [applySelectedParam]);

  return (
    <div class="p-4">
      <h2 class="text-lg font-semibold text-[var(--text-primary)] mb-4">People</h2>

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
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {entities.map((entity) => (
            <EntityCard
              key={entity.id}
              entity={entity}
              selected={selectedId === entity.id}
              onClick={() => setSelectedId(selectedId === entity.id ? "" : entity.id)}
            />
          ))}
        </div>
      )}

      <EntityDetailPanel
        entityId={selectedId || null}
        onClose={() => setSelectedId("")}
        onEntityChanged={loadEntities}
      />
    </div>
  );
}
