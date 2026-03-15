import { useState, useEffect, useCallback } from "preact/hooks";
import type { RoutableProps } from "../lib/route";
import { api, type Thought } from "../api";
import { selectedThoughtId, lastDeletedId, showToast, searchQuery } from "../state";
import { useUrlSignal } from "../hooks/useUrlSignal";
import { ThoughtCard } from "../components/ThoughtCard";
import { SwipeableCard } from "../components/SwipeableCard";
import { DetailPanel } from "../components/DetailPanel";
import { Search } from "lucide-preact";

const PRECISION_LEVELS = [
  { label: "Broad", value: 0.3 },
  { label: "Balanced", value: 0.45 },
  { label: "Precise", value: 0.65 },
] as const;

function SkeletonCard() {
  return (
    <div class="search-skeleton p-3 rounded-lg bg-[var(--surface)] border border-[var(--border-color)]">
      <div class="flex items-start gap-2">
        <div class="w-4 h-4 mt-0.5 rounded bg-[var(--bg-tertiary)]" />
        <div class="flex-1 space-y-2">
          <div class="flex justify-between">
            <div class="h-3 w-16 rounded bg-[var(--bg-tertiary)]" />
            <div class="h-3 w-10 rounded bg-[var(--bg-tertiary)]" />
          </div>
          <div class="h-3 w-full rounded bg-[var(--bg-tertiary)]" />
          <div class="h-3 w-4/5 rounded bg-[var(--bg-tertiary)]" />
          <div class="flex gap-1.5 mt-1">
            <div class="h-4 w-12 rounded bg-[var(--bg-tertiary)]" />
            <div class="h-4 w-16 rounded bg-[var(--bg-tertiary)]" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function SearchView(_props: RoutableProps) {
  useUrlSignal(selectedThoughtId, "thought");

  const [precision, setPrecision] = useState(1);
  const [results, setResults] = useState<(Thought & { similarity: number })[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const threshold = PRECISION_LEVELS[precision].value;

  // Sync URL ?q= param to searchQuery on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlQuery = params.get("q") || "";
    if (urlQuery && !searchQuery.value) {
      searchQuery.value = urlQuery;
    }
  }, []);

  const doSearch = useCallback(async (q: string, t: number) => {
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const res = await api.search(q, t, 20);
      setResults(res.results);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Trigger search when query or threshold changes
  useEffect(() => {
    const q = searchQuery.value;
    if (q.trim()) {
      doSearch(q, threshold);
    } else {
      setResults([]);
      setSearched(false);
    }
  }, [searchQuery.value, threshold, doSearch]);

  const handlePrecisionChange = (idx: number) => {
    setPrecision(idx);
  };

  useEffect(() => {
    const id = lastDeletedId.value;
    if (id) {
      setResults((prev) => prev.filter((t) => t.id !== id));
      lastDeletedId.value = null;
    }
  }, [lastDeletedId.value]);

  const handleSwipeDelete = useCallback(async (id: string) => {
    await api.deleteThought(id);
    showToast("Thought deleted", "success");
    setResults((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const query = searchQuery.value;
  const hasQuery = query.trim().length > 0;
  const hasResults = results.length > 0;

  return (
    <div class="search-view">
      {/* Precision pills */}
      <div class="search-composer">
        <div class="search-precision">
          <div class="search-pills">
            {PRECISION_LEVELS.map((level, i) => (
              <button
                key={level.label}
                type="button"
                onClick={() => handlePrecisionChange(i)}
                class={`search-pill ${precision === i ? "search-pill-active" : ""}`}
              >
                {level.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content area */}
      <div class="search-content">
        {loading ? (
          <div class="search-results">
            <div class="space-y-2">
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </div>
          </div>
        ) : searched && results.length === 0 ? (
          <div class="search-empty">
            <p class="search-empty-title">No matches found</p>
            <p class="search-empty-hint">
              Try different words or switch to{" "}
              <button class="search-empty-link" onClick={() => handlePrecisionChange(0)}>
                Broad
              </button>{" "}
              matching
            </p>
          </div>
        ) : hasResults ? (
          <div class="search-results">
            <div class="search-results-meta">
              <span class="search-results-count">
                {results.length} result{results.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div class="search-results-list">
              {results.map((r, i) => (
                <div
                  key={r.id}
                  class="search-result-item"
                  style={{ animationDelay: `${Math.min(i * 40, 300)}ms` }}
                >
                  <SwipeableCard onDelete={() => handleSwipeDelete(r.id)}>
                    <ThoughtCard
                      thought={r}
                      similarity={r.similarity}
                      selected={selectedThoughtId.value === r.id}
                      onClick={() => { selectedThoughtId.value = r.id; }}
                    />
                  </SwipeableCard>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div class="search-idle">
            <div class="search-idle-icon">
              <Search class="w-6 h-6" />
            </div>
            <p class="search-idle-title">Semantic search</p>
            <p class="search-idle-hint">Type in the search bar above to find thoughts</p>
          </div>
        )}
      </div>

      <DetailPanel />
    </div>
  );
}
