import { useState, useEffect, useCallback } from "preact/hooks";
import type { RoutableProps } from "../lib/route";
import { api, type PersonEntry, type Thought } from "../api";
import { selectedThoughtId, lastDeletedId, showToast } from "../state";
import { PersonCard } from "../components/PersonCard";
import { ThoughtCard } from "../components/ThoughtCard";
import { SwipeableCard } from "../components/SwipeableCard";
import { DetailPanel } from "../components/DetailPanel";

export function PeopleView(props: RoutableProps & { selected?: string }) {
  const [people, setPeople] = useState<PersonEntry[]>([]);
  const [selected, setSelected] = useState(props.selected || "");
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingThoughts, setLoadingThoughts] = useState(false);

  // Sync route param into state when URL changes
  useEffect(() => {
    setSelected(props.selected || "");
  }, [props.selected]);

  useEffect(() => {
    api
      .people()
      .then((r) => setPeople(r.people))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) {
      setThoughts([]);
      return;
    }
    setLoadingThoughts(true);
    api
      .thoughts({ person: selected, limit: 20 })
      .then((r) => setThoughts(r.thoughts))
      .catch(() => {})
      .finally(() => setLoadingThoughts(false));
  }, [selected]);

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

  const handleRename = useCallback(async (oldName: string, newName: string) => {
    try {
      const result = await api.renamePerson(oldName, newName);
      showToast(`Renamed "${oldName}" → "${newName}" across ${result.affected} thought${result.affected !== 1 ? "s" : ""}`, "success");
      if (selected === oldName) setSelected(newName);
      const r = await api.people();
      setPeople(r.people);
    } catch {
      showToast("Failed to rename person", "error");
    }
  }, [selected]);

  return (
    <div class="p-4">
      <h2 class="text-lg font-semibold text-[var(--text-primary)] mb-4">People</h2>

      {loading ? (
        <p class="text-[var(--text-muted)] text-sm">Loading people...</p>
      ) : people.length === 0 ? (
        <div class="text-center py-12">
          <p class="text-[var(--text-muted)]">No people mentioned yet</p>
          <p class="text-sm text-[var(--text-muted)] mt-1">
            People are extracted automatically from your thoughts
          </p>
        </div>
      ) : (
        <>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-6">
            {people.map((p) => (
              <PersonCard
                key={p.person}
                person={p}
                selected={selected === p.person}
                onClick={() =>
                  setSelected(selected === p.person ? "" : p.person)
                }
                onRename={handleRename}
              />
            ))}
          </div>

          {selected && (
            <div>
              <h3 class="text-sm font-medium text-[var(--text-secondary)] mb-3">
                Thoughts mentioning {selected}
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
