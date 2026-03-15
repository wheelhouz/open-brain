import { useState, useEffect, useCallback } from "preact/hooks";
import type { RoutableProps } from "../lib/route";
import { api, type Loop } from "../api";
import { showToast, selectedLoopId } from "../state";
import { LoopCard } from "../components/LoopCard";
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

export function LoopsView(_props: RoutableProps) {
  useUrlSignal(selectedLoopId, "id");

  const [loops, setLoops] = useState<Loop[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("status") || "open";
  });
  const [typeFilter, setTypeFilter] = useState("");

  const loadLoops = useCallback(() => {
    setLoading(true);
    api
      .loops(status, typeFilter || undefined)
      .then((r) => setLoops(r.loops))
      .catch(() => showToast("Failed to load loops", "error"))
      .finally(() => setLoading(false));
  }, [status, typeFilter]);

  useEffect(loadLoops, [loadLoops]);

  const emptyMessages: Record<string, string> = {
    open: "No open loops. You're all caught up!",
    snoozed: "No snoozed loops",
    closed: "No closed loops yet",
  };

  return (
    <div class="p-4">
      <h2 class="text-lg font-semibold text-[var(--text-primary)] mb-4">Loops</h2>

      {/* Status tabs */}
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
          </button>
        ))}
      </div>

      {/* Type filter pills */}
      <div class="flex gap-1 mb-4 flex-wrap">
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

      {loading ? (
        <p class="text-[var(--text-muted)] text-sm">Loading loops...</p>
      ) : loops.length === 0 ? (
        <div class="text-center py-12">
          <p class="text-[var(--text-muted)]">{emptyMessages[status]}</p>
        </div>
      ) : (
        <div class="space-y-2">
          {loops.map((loop) => (
            <LoopCard
              key={loop.id}
              loop={loop}
              selected={selectedLoopId.value === loop.id}
              onClick={() => { selectedLoopId.value = loop.id; }}
            />
          ))}
        </div>
      )}

      <LoopDetailPanel onLoopChanged={loadLoops} />
    </div>
  );
}
