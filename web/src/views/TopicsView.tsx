import { useState, useEffect, useCallback, useMemo } from "preact/hooks";
import type { RoutableProps } from "../lib/route";
import { api, type TopicEntry, type Thought, type MergeCluster } from "../api";
import { selectedThoughtId, lastDeletedId, showToast, theme } from "../state";
import { TopicCloud } from "../components/TopicCloud";
import { ThoughtCard } from "../components/ThoughtCard";
import { SwipeableCard } from "../components/SwipeableCard";
import { DetailPanel } from "../components/DetailPanel";
import { Sparkles, Pencil, X, Check, ArrowRight, Tags, Search } from "lucide-preact";

// 12 perceptually distinct hues in OKLCH (~25°+ gap, hue-tuned L/C).
// - bg: 10% alpha tint — adapts naturally to dark/light backgrounds
// - text: mid-tone label color, lighter in dark mode for readability
// - selected: darkened + chroma-boosted for 4.5:1+ contrast vs white (WCAG AA)
// Dark/light text variants are resolved at render time via isDark.
const CATEGORY_HUES = [
  { h: 25,  ld: 0.72, ll: 0.55 }, // red
  { h: 55,  ld: 0.75, ll: 0.52 }, // orange
  { h: 80,  ld: 0.80, ll: 0.50 }, // amber
  { h: 135, ld: 0.73, ll: 0.45 }, // lime
  { h: 155, ld: 0.72, ll: 0.45 }, // green
  { h: 185, ld: 0.72, ll: 0.45 }, // teal
  { h: 215, ld: 0.72, ll: 0.48 }, // cyan
  { h: 250, ld: 0.70, ll: 0.50 }, // blue
  { h: 280, ld: 0.70, ll: 0.50 }, // indigo
  { h: 310, ld: 0.73, ll: 0.50 }, // purple
  { h: 340, ld: 0.73, ll: 0.52 }, // magenta
  { h: 0,   ld: 0.72, ll: 0.52 }, // pink
];

function buildPalette(isDark: boolean) {
  return CATEGORY_HUES.map(({ h, ld, ll }) => {
    const textL = isDark ? ld : ll;
    const textC = 0.14;
    return {
      bg: `oklch(${textL} ${textC} ${h} / 0.10)`,
      text: `oklch(${textL} ${textC} ${h})`,
      selected: `oklch(${isDark ? 0.52 : 0.48} 0.16 ${h})`,
    };
  });
}

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
  const [categories, setCategories] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState("All");
  const [selected, setSelected] = useState<Set<string>>(new Set(props.selected ? [props.selected] : []));
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<"popular" | "grouped">("popular");
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingThoughts, setLoadingThoughts] = useState(false);
  const [categorizing, setCategorizing] = useState(false);

  const [cleanupState, setCleanupState] = useState<CleanupState>("idle");
  const [clusters, setClusters] = useState<MergeCluster[]>([]);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());

  // Sync route param into state when URL changes
  useEffect(() => {
    setSelected(new Set(props.selected ? [props.selected] : []));
  }, [props.selected]);

  const loadTopics = useCallback(() => {
    api
      .topics()
      .then((r) => {
        setTopics(r.topics);
        setCategories(r.categories || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadTopics();
  }, [loadTopics]);

  // Serialize selected set to a stable string for use as effect dependency
  const selectedKey = useMemo(() => [...selected].sort().join("\0"), [selected]);

  useEffect(() => {
    if (selected.size === 0) {
      setThoughts([]);
      setLoadingThoughts(false);
      return;
    }
    const currentKey = selectedKey;
    setLoadingThoughts(true);
    const topics = [...selected];
    Promise.all(topics.map(topic => api.thoughts({ topic, limit: 20 })))
      .then((results) => {
        // Discard if selection changed while fetching
        if (currentKey !== [...selected].sort().join("\0")) return;
        const seen = new Set<string>();
        const merged: Thought[] = [];
        for (const r of results) {
          for (const t of r.thoughts) {
            if (!seen.has(t.id)) {
              seen.add(t.id);
              merged.push(t);
            }
          }
        }
        merged.sort((a, b) => b.created_at.localeCompare(a.created_at));
        setThoughts(merged);
      })
      .catch(() => {})
      .finally(() => setLoadingThoughts(false));
  }, [selectedKey]);

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
      if (selected.has(oldName)) {
        setSelected(prev => {
          const next = new Set(prev);
          next.delete(oldName);
          next.add(newName);
          return next;
        });
      }
      const r = await api.topics();
      setTopics(r.topics);
    } catch {
      showToast("Failed to rename topic", "error");
    }
  }, [selected]);

  const handleCategorize = useCallback(async () => {
    setCategorizing(true);
    try {
      const result = await api.categorizeTopics();
      const sweptMsg = result.swept > 0 ? ` (${result.swept} re-assigned in sweep)` : "";
      showToast(`Categorized into ${result.categories.length} categories (${result.assigned} topics)${sweptMsg}`, "success");
      loadTopics();
    } catch {
      showToast("Failed to categorize topics", "error");
    } finally {
      setCategorizing(false);
    }
  }, [loadTopics]);

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

  const isDark = theme.value === "dark";
  const palette = useMemo(() => buildPalette(isDark), [isDark]);

  const categoryColorMap = useMemo(() => {
    const map = new Map<string, typeof palette[0]>();
    categories.forEach((cat, i) => map.set(cat, palette[i % palette.length]));
    return map;
  }, [categories, palette]);

  const toggleSelect = useCallback((topic: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  }, []);

  const filteredTopics = useMemo(() => {
    let filtered = activeCategory === "All" ? topics : topics.filter(t => t.category === activeCategory);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(t => t.topic.toLowerCase().includes(q));
    }
    filtered = [...filtered];
    if (sortMode === "popular") {
      filtered.sort((a, b) => b.count - a.count);
    } else {
      filtered.sort((a, b) => a.category.localeCompare(b.category) || a.topic.localeCompare(b.topic));
    }
    return filtered;
  }, [topics, activeCategory, searchQuery, sortMode]);

  const selectedCount = useMemo(() => {
    return filteredTopics.filter(t => selected.has(t.topic)).reduce((sum, t) => sum + t.count, 0);
  }, [filteredTopics, selected]);

  const acceptedCount = clusters.filter((_, i) => accepted.has(i)).length;

  return (
    <div class="p-4">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-[var(--text-primary)]">Topics</h2>
        {cleanupState === "idle" && topics.length >= 2 && (
          <div class="flex items-center gap-2">
            <button
              onClick={handleCategorize}
              disabled={categorizing}
              class="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors disabled:opacity-40"
            >
              {categorizing ? (
                <div class="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                <Tags size={14} />
              )}
              {categories.length > 0 ? "Re-categorize" : "Categorize"}
            </button>
            <button
              onClick={handleAnalyze}
              class="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors"
            >
              <Sparkles size={14} />
              Clean Up
            </button>
          </div>
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
              <div class="mb-4">
                <div class="search-composer-box" style="padding: 0.25rem 0.25rem 0.25rem 0.75rem;">
                  <Search class="search-composer-icon" />
                  <input
                    type="text"
                    value={searchQuery}
                    onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
                    placeholder="Filter topics..."
                    class="search-composer-input"
                    style="padding: 0.25rem 0;"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery("")}
                      class="search-composer-clear"
                      aria-label="Clear filter"
                    >
                      <X class="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {categories.length > 0 && (
                <div class="mb-6">
                  <h3 class="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] mb-3.5">Categories</h3>
                  <div class="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none sm:flex-wrap sm:overflow-x-visible">
                    {["All", ...categories].map((cat) => {
                      const count = cat === "All"
                        ? topics.length
                        : topics.filter((t) => t.category === cat).length;
                      const catColor = cat !== "All" ? categoryColorMap.get(cat) : undefined;
                      const isActive = activeCategory === cat;
                      return (
                        <button
                          key={cat}
                          onClick={() => setActiveCategory(cat)}
                          class={`shrink-0 px-3 py-1.5 text-sm rounded-full transition-colors ${
                            isActive ? "text-white" : "hover:opacity-80"
                          }`}
                          style={isActive
                            ? { background: catColor?.selected || "var(--accent)" }
                            : catColor
                              ? { background: catColor.bg, color: catColor.text }
                              : { background: "var(--bg-tertiary)", color: "var(--text-secondary)" }
                          }
                        >
                          {cat}
                          <span class="text-[0.75em] ml-1 opacity-70">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {selected.size > 0 && (
                <div class="mb-7 p-3.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)]">
                  <div class="flex items-center justify-between mb-2.5">
                    <span class="text-sm text-[var(--text-secondary)]">
                      {selected.size} selected{selectedCount > 0 && ` · ${selectedCount} items`}
                    </span>
                    <button
                      onClick={() => setSelected(new Set())}
                      class="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      Clear all
                    </button>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    {[...selected].map(topic => {
                      const cat = topics.find(t => t.topic === topic)?.category;
                      const pillColor = cat ? categoryColorMap.get(cat)?.selected : undefined;
                      return (
                      <button
                        key={topic}
                        onClick={() => toggleSelect(topic)}
                        class="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full text-white hover:opacity-80 transition-opacity cursor-pointer"
                        style={{ background: pillColor || "var(--accent)" }}
                      >
                        {topic}
                        <X size={10} />
                      </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div class="flex items-center gap-2.5 mb-4">
                <h3 class="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">Topics</h3>
                <div class="flex items-center gap-0.5 rounded-full bg-[var(--bg-tertiary)] p-0.5">
                  {(["popular", "grouped"] as const).map(mode => (
                    <button
                      key={mode}
                      onClick={() => setSortMode(mode)}
                      class={`px-2.5 py-0.5 text-xs rounded-full transition-colors ${
                        sortMode === mode
                          ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm"
                          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                      }`}
                    >
                      {mode === "popular" ? "Popular" : "Grouped"}
                    </button>
                  ))}
                </div>
              </div>
              <TopicCloud
                topics={filteredTopics}
                selected={selected}
                onSelect={toggleSelect}
                onRename={handleRename}
                categoryColorMap={categoryColorMap}
              />

              {selected.size > 0 && (
                <div class="mt-8">
                  <h3 class="text-sm font-medium text-[var(--text-secondary)] mb-3">
                    Thoughts about {selected.size === 1 ? `"${[...selected][0]}"` : `${selected.size} topics`}
                  </h3>
                  <div class={`space-y-2 transition-opacity ${loadingThoughts ? "opacity-50" : ""}`}>
                    {thoughts.length === 0 && loadingThoughts ? (
                      <p class="text-[var(--text-muted)] text-sm">Loading...</p>
                    ) : (
                      thoughts.map((t) => (
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
                      ))
                    )}
                  </div>
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
