import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import type { RoutableProps } from "../lib/route";
import { api, type Loop, type LoopsResponse } from "../api";
import { showToast, selectedLoopId } from "../state";
import { LoopCard } from "../components/LoopCard";
import { SwipeableLoopCard } from "../components/SwipeableLoopCard";
import { LoopDetailPanel } from "../components/LoopDetailPanel";
import { useUrlSignal } from "../hooks/useUrlSignal";

const statusTabs = [
  { value: "open", label: "Open" },
  { value: "snoozed", label: "Snoozed" },
  { value: "closed", label: "Closed" },
] as const;

const typeFilters = [
  { value: "", label: "All" },
  { value: "task", label: "Tasks" },
  { value: "question", label: "Questions" },
  { value: "decision", label: "Decisions" },
  { value: "waiting_on", label: "Waiting" },
] as const;

type SortOption = "newest" | "oldest" | "most_evidence" | "recently_active";

const sortOptions: { value: SortOption; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "most_evidence", label: "Most evidence" },
  { value: "recently_active", label: "Recently active" },
];

interface LoopGroup {
  label: string;
  loops: Loop[];
}

function sortLoops(loops: Loop[], sort: SortOption): Loop[] {
  const sorted = [...loops];
  switch (sort) {
    case "newest":
      return sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    case "oldest":
      return sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    case "most_evidence":
      return sorted.sort((a, b) => b.evidence_count - a.evidence_count);
    case "recently_active":
      return sorted.sort((a, b) => {
        const aTime = a.last_evidence_at ? new Date(a.last_evidence_at).getTime() : new Date(a.created_at).getTime();
        const bTime = b.last_evidence_at ? new Date(b.last_evidence_at).getTime() : new Date(b.created_at).getTime();
        return bTime - aTime;
      });
  }
}

function groupLoops(loops: Loop[], status: string): LoopGroup[] {
  if (status === "open") {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const resurfaced: Loop[] = [];
    const active: Loop[] = [];
    const recent: Loop[] = [];
    const dormant: Loop[] = [];

    for (const loop of loops) {
      if (loop.status === "snoozed" && loop.snoozed_until && new Date(loop.snoozed_until) <= now) {
        resurfaced.push(loop);
      } else if (loop.last_evidence_at && new Date(loop.last_evidence_at) >= sevenDaysAgo) {
        active.push(loop);
      } else if (!loop.last_evidence_at && new Date(loop.created_at) >= twoDaysAgo) {
        recent.push(loop);
      } else {
        dormant.push(loop);
      }
    }

    return [
      { label: "Resurfaced", loops: resurfaced },
      { label: "Active", loops: active },
      { label: "Recent", loops: recent },
      { label: "Dormant", loops: dormant },
    ].filter((g) => g.loops.length > 0);
  }

  if (status === "snoozed") {
    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const today: Loop[] = [];
    const thisWeek: Loop[] = [];
    const later: Loop[] = [];

    for (const loop of loops) {
      const until = loop.snoozed_until ? new Date(loop.snoozed_until) : null;
      if (!until) {
        later.push(loop);
      } else if (until < endOfToday) {
        today.push(loop);
      } else if (until < weekFromNow) {
        thisWeek.push(loop);
      } else {
        later.push(loop);
      }
    }

    return [
      { label: "Today", loops: today },
      { label: "This week", loops: thisWeek },
      { label: "Later", loops: later },
    ].filter((g) => g.loops.length > 0);
  }

  if (status === "closed") {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent: Loop[] = [];
    const older: Loop[] = [];

    for (const loop of loops) {
      if (loop.closed_at && new Date(loop.closed_at) >= sevenDaysAgo) {
        recent.push(loop);
      } else {
        older.push(loop);
      }
    }

    return [
      { label: "Recently closed", loops: recent },
      { label: "Older", loops: older },
    ].filter((g) => g.loops.length > 0);
  }

  return [{ label: "All", loops }];
}

// Count loops per status (fetches all statuses in parallel)
function useLoopCounts(refreshKey: number) {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    Promise.all([
      api.loops("open").then((r) => ["open", r.loops.length] as const),
      api.loops("snoozed").then((r) => ["snoozed", r.loops.length] as const),
      api.loops("closed").then((r) => ["closed", r.loops.length] as const),
    ]).then((results) => {
      setCounts(Object.fromEntries(results));
    }).catch(() => {});
  }, [refreshKey]);

  return counts;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isMobile;
}

export function LoopsView(_props: RoutableProps) {
  useUrlSignal(selectedLoopId, "id");

  const [loops, setLoops] = useState<Loop[]>([]);
  const [loading, setLoading] = useState(true);
  const isMobile = useIsMobile();
  const [status, setStatus] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("status") || "open";
  });
  const [typeFilter, setTypeFilter] = useState("");
  const [sort, setSort] = useState<SortOption>("newest");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const counts = useLoopCounts(refreshKey);

  const loadLoops = useCallback(() => {
    setLoading(true);
    setNextCursor(null);
    api
      .loops(status, typeFilter || undefined)
      .then((r: LoopsResponse) => {
        setLoops(r.loops);
        setNextCursor(r.next_cursor);
      })
      .catch(() => showToast("Failed to load loops", "error"))
      .finally(() => setLoading(false));
  }, [status, typeFilter]);

  useEffect(loadLoops, [loadLoops]);

  const onLoopChanged = useCallback(() => {
    loadLoops();
    setRefreshKey((k) => k + 1);
  }, [loadLoops]);

  const handleSwipeDelete = useCallback(async (loopId: string) => {
    await api.deleteLoop(loopId);
    showToast("Loop deleted", "success");
    onLoopChanged();
  }, [onLoopChanged]);

  // Infinite scroll
  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const search = new URLSearchParams();
    if (status) search.set("status", status);
    if (typeFilter) search.set("loop_type", typeFilter);
    search.set("cursor", nextCursor);
    const qs = search.toString();
    fetch(`/api/loops?${qs}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("brain_access_key") || ""}` },
    })
      .then((r) => r.json())
      .then((r: LoopsResponse) => {
        setLoops((prev) => [...prev, ...r.loops]);
        setNextCursor(r.next_cursor);
      })
      .catch(() => showToast("Failed to load more loops", "error"))
      .finally(() => setLoadingMore(false));
  }, [nextCursor, loadingMore, status, typeFilter]);

  // Intersection observer for infinite scroll
  useEffect(() => {
    if (!sentinelRef.current || !nextCursor) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMore(); },
      { rootMargin: "200px" },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [nextCursor, loadMore]);

  const emptyMessages: Record<string, string> = {
    open: "No open loops. You're all caught up!",
    snoozed: "No snoozed loops",
    closed: "No closed loops yet",
  };

  const sorted = sortLoops(loops, sort);
  const groups = groupLoops(sorted, status);

  return (
    <div class="p-4">
      <h2 class="text-lg font-semibold text-[var(--text-primary)] mb-4">Loops</h2>

      {/* Status tabs with counts */}
      <div class="flex gap-1 mb-3">
        {statusTabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatus(tab.value)}
            class={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              status === tab.value
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {tab.label}
            {counts[tab.value] !== undefined && (
              <span class="ml-1 opacity-70">({counts[tab.value]})</span>
            )}
          </button>
        ))}
      </div>

      {/* Type filter pills + sort dropdown */}
      <div class="flex items-center gap-2 mb-4 flex-wrap">
        <div class="flex gap-1 flex-wrap flex-1">
          {typeFilters.map((f) => (
            <button
              key={f.value}
              onClick={() => setTypeFilter(f.value)}
              class={`px-2 py-1 text-xs rounded-full transition-colors ${
                typeFilter === f.value
                  ? "bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/30"
                  : "bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort((e.target as HTMLSelectElement).value as SortOption)}
          class="text-xs bg-[var(--bg-secondary)] text-[var(--text-secondary)] border border-[var(--border-color)] rounded-lg px-2 py-1 focus:outline-none focus:border-[var(--accent)]"
        >
          {sortOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p class="text-[var(--text-muted)] text-sm">Loading loops...</p>
      ) : loops.length === 0 ? (
        <div class="text-center py-12">
          <p class="text-[var(--text-muted)]">{emptyMessages[status]}</p>
        </div>
      ) : (
        <div class="space-y-4">
          {groups.map((group) => (
            <div key={group.label}>
              <h3 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
                {group.label} ({group.loops.length})
              </h3>
              <div class="space-y-2">
                {group.loops.map((loop) => {
                  const card = (
                    <LoopCard
                      key={loop.id}
                      loop={loop}
                      selected={selectedLoopId.value === loop.id}
                      onClick={() => { selectedLoopId.value = loop.id; }}
                      onChanged={onLoopChanged}
                    />
                  );
                  return isMobile ? (
                    <SwipeableLoopCard
                      key={loop.id}
                      loop={loop}
                      onChanged={onLoopChanged}
                      onDelete={() => handleSwipeDelete(loop.id)}
                    >
                      {card}
                    </SwipeableLoopCard>
                  ) : card;
                })}
              </div>
            </div>
          ))}
          {/* Infinite scroll sentinel */}
          {nextCursor && (
            <div ref={sentinelRef} class="py-4 text-center">
              {loadingMore && <span class="text-xs text-[var(--text-muted)]">Loading more...</span>}
            </div>
          )}
        </div>
      )}

      <LoopDetailPanel onLoopChanged={onLoopChanged} />
    </div>
  );
}
