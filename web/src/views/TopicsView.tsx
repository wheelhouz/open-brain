import { useState, useEffect, useCallback } from "preact/hooks";
import type { RoutableProps } from "../lib/route";
import { api, type TopicEntry, type Thought, type MergeCluster } from "../api";
import { selectedThoughtId, lastDeletedId, showToast } from "../state";
import { TopicCloud } from "../components/TopicCloud";
import { ThoughtCard } from "../components/ThoughtCard";
import { SwipeableCard } from "../components/SwipeableCard";
import { DetailPanel } from "../components/DetailPanel";
import { Sparkles, Pencil, X, Check, ArrowRight } from "lucide-preact";

type CleanupState = "idle" | "scanning" | "reviewing" | "applying";

function ClusterCard({
  cluster,
  index,
  accepted,
  onToggleAccept,
  onRemoveTag,
  onEditCanonical,
}: {
  cluster: MergeCluster;
  index: number;
  accepted: boolean;
  onToggleAccept: (i: number) => void;
  onRemoveTag: (i: number, tag: string) => void;
  onEditCanonical: (i: number, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(cluster.canonical);

  return (
    <div
      class={`p-4 rounded-lg border transition-all ${
        accepted
          ? "border-[var(--accent)] bg-[var(--bg-secondary)]"
          : "border-[var(--border)] bg-[var(--bg-secondary)] opacity-60"
      }`}
    >
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2 min-w-0">
          <ArrowRight size={14} class="text-[var(--accent)] shrink-0" />
          {editing ? (
            <form
              class="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = editValue.trim();
                if (trimmed && trimmed !== cluster.canonical) {
                  onEditCanonical(index, trimmed);
                }
                setEditing(false);
              }}
            >
              <input
                type="text"
                value={editValue}
                onInput={(e) => setEditValue((e.target as HTMLInputElement).value)}
                class="px-2 py-0.5 text-sm rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] w-40"
                autoFocus
                onBlur={() => setEditing(false)}
              />
            </form>
          ) : (
            <button
              class="flex items-center gap-1 text-sm font-semibold text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors"
              onClick={() => {
                setEditValue(cluster.canonical);
                setEditing(true);
              }}
            >
              {cluster.canonical}
              <Pencil size={12} class="opacity-40" />
            </button>
          )}
        </div>
        <button
          onClick={() => onToggleAccept(index)}
          class={`px-2 py-0.5 text-xs rounded transition-colors ${
            accepted
              ? "bg-[var(--accent)] text-white"
              : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
          }`}
        >
          {accepted ? "Accepted" : "Skipped"}
        </button>
      </div>

      <div class="flex flex-wrap gap-1.5 mb-2">
        {cluster.merge.map((tag) => (
          <span
            key={tag}
            class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
          >
            {tag}
            <button
              onClick={() => onRemoveTag(index, tag)}
              class="hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={10} />
            </button>
          </span>
        ))}
      </div>

      {cluster.reason && (
        <p class="text-xs text-[var(--text-muted)]">{cluster.reason}</p>
      )}
    </div>
  );
}

export function TopicsView(props: RoutableProps & { selected?: string }) {
  const [topics, setTopics] = useState<TopicEntry[]>([]);
  const [selected, setSelected] = useState(props.selected || "");
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingThoughts, setLoadingThoughts] = useState(false);

  const [cleanupState, setCleanupState] = useState<CleanupState>("idle");
  const [clusters, setClusters] = useState<MergeCluster[]>([]);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());

  // Sync route param into state when URL changes
  useEffect(() => {
    setSelected(props.selected || "");
  }, [props.selected]);

  const loadTopics = useCallback(() => {
    api
      .topics()
      .then((r) => setTopics(r.topics))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadTopics();
  }, [loadTopics]);

  useEffect(() => {
    if (!selected) {
      setThoughts([]);
      return;
    }
    setLoadingThoughts(true);
    api
      .thoughts({ topic: selected, limit: 20 })
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
      const result = await api.renameTopic(oldName, newName);
      showToast(`Renamed "${oldName}" → "${newName}" across ${result.affected} thought${result.affected !== 1 ? "s" : ""}`, "success");
      if (selected === oldName) setSelected(newName);
      const r = await api.topics();
      setTopics(r.topics);
    } catch {
      showToast("Failed to rename topic", "error");
    }
  }, [selected]);

  const handleAnalyze = useCallback(async () => {
    setCleanupState("scanning");
    try {
      const result = await api.analyzeTopics();
      setClusters(result.clusters);
      setAccepted(new Set(result.clusters.map((_, i) => i)));
      setCleanupState("reviewing");
    } catch {
      showToast("Failed to analyze topics", "error");
      setCleanupState("idle");
    }
  }, []);

  const toggleAccept = useCallback((index: number) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const removeTagFromCluster = useCallback((index: number, tag: string) => {
    setClusters((prev) => {
      const next = [...prev];
      const cluster = { ...next[index], merge: next[index].merge.filter((t) => t !== tag) };
      if (cluster.merge.length === 0) {
        next.splice(index, 1);
        setAccepted((prevAcc) => {
          const newAcc = new Set<number>();
          for (const i of prevAcc) {
            if (i < index) newAcc.add(i);
            else if (i > index) newAcc.add(i - 1);
          }
          return newAcc;
        });
        return next;
      }
      next[index] = cluster;
      return next;
    });
  }, []);

  const editCanonical = useCallback((index: number, name: string) => {
    setClusters((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], canonical: name };
      return next;
    });
  }, []);

  const handleApply = useCallback(async () => {
    const merges = clusters
      .filter((_, i) => accepted.has(i))
      .map((cl) => ({ canonical: cl.canonical, merge: cl.merge }));

    if (merges.length === 0) {
      setCleanupState("idle");
      return;
    }

    setCleanupState("applying");
    try {
      const result = await api.mergeTopics(merges);
      showToast(
        `Merged ${result.applied} tag${result.applied !== 1 ? "s" : ""} across ${result.thoughts_updated} thought${result.thoughts_updated !== 1 ? "s" : ""}`,
        "success",
      );
      loadTopics();
      setCleanupState("idle");
      setClusters([]);
      setAccepted(new Set());
    } catch {
      showToast("Failed to apply merges", "error");
      setCleanupState("reviewing");
    }
  }, [clusters, accepted, loadTopics]);

  const handleCancel = useCallback(() => {
    setCleanupState("idle");
    setClusters([]);
    setAccepted(new Set());
  }, []);

  const acceptedCount = clusters.filter((_, i) => accepted.has(i)).length;

  return (
    <div class="p-4">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-[var(--text-primary)]">Topics</h2>
        {cleanupState === "idle" && topics.length >= 2 && (
          <button
            onClick={handleAnalyze}
            class="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors"
          >
            <Sparkles size={14} />
            Clean Up
          </button>
        )}
      </div>

      {cleanupState === "scanning" && (
        <div class="flex items-center gap-3 py-12 justify-center">
          <div class="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          <p class="text-[var(--text-muted)] text-sm">
            Analyzing {topics.length} topics for duplicates...
          </p>
        </div>
      )}

      {cleanupState === "reviewing" && (
        <div>
          {clusters.length === 0 ? (
            <div class="text-center py-12">
              <Check size={32} class="mx-auto text-[var(--accent)] mb-2" />
              <p class="text-[var(--text-secondary)]">No duplicates found</p>
              <p class="text-sm text-[var(--text-muted)] mt-1">Your tags are clean!</p>
              <button
                onClick={handleCancel}
                class="mt-4 px-4 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)] transition-colors"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <p class="text-sm text-[var(--text-muted)] mb-3">
                Found {clusters.length} merge group{clusters.length !== 1 ? "s" : ""}. Review and adjust before applying.
              </p>
              <div class="space-y-3 mb-4">
                {clusters.map((cluster, i) => (
                  <ClusterCard
                    key={`${cluster.canonical}-${i}`}
                    cluster={cluster}
                    index={i}
                    accepted={accepted.has(i)}
                    onToggleAccept={toggleAccept}
                    onRemoveTag={removeTagFromCluster}
                    onEditCanonical={editCanonical}
                  />
                ))}
              </div>
              <div class="flex gap-2">
                <button
                  onClick={handleCancel}
                  class="px-4 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleApply}
                  disabled={acceptedCount === 0}
                  class="px-4 py-2 text-sm rounded-lg bg-[var(--accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  Apply {acceptedCount} merge{acceptedCount !== 1 ? "s" : ""}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {cleanupState === "applying" && (
        <div class="flex items-center gap-3 py-12 justify-center">
          <div class="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          <p class="text-[var(--text-muted)] text-sm">Merging tags...</p>
        </div>
      )}

      {cleanupState === "idle" && (
        <>
          {loading ? (
            <p class="text-[var(--text-muted)] text-sm">Loading topics...</p>
          ) : topics.length === 0 ? (
            <div class="text-center py-12">
              <p class="text-[var(--text-muted)]">No topics yet</p>
              <p class="text-sm text-[var(--text-muted)] mt-1">
                Topics are extracted automatically from your thoughts
              </p>
            </div>
          ) : (
            <>
              <TopicCloud
                topics={topics}
                selected={selected}
                onSelect={setSelected}
                onRename={handleRename}
              />

              {selected && (
                <div class="mt-6">
                  <h3 class="text-sm font-medium text-[var(--text-secondary)] mb-3">
                    Thoughts about "{selected}"
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
        </>
      )}

      <DetailPanel />
    </div>
  );
}
