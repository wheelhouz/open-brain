import { useState, useEffect } from "preact/hooks";
import { route } from "preact-router";
import type { RoutableProps } from "../lib/route";
import { api, type StatsResponse } from "../api";
import { StatCard } from "../components/StatCard";
import { ActivityChart } from "../components/ActivityChart";
import { typeColor } from "../lib/format";
import { Brain, Calendar, Hash, Users } from "lucide-preact";

export function StatsView(_props: RoutableProps) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .stats()
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div class="p-4">
        <p class="text-[var(--text-muted)] text-sm">Loading stats...</p>
      </div>
    );
  }

  if (!stats) {
    return (
      <div class="p-4 text-center py-12">
        <p class="text-[var(--text-muted)]">Failed to load stats</p>
      </div>
    );
  }

  const totalTopics = stats.topics.length;
  const totalPeople = stats.people.length;
  const totalDays = stats.daily.length;

  return (
    <div class="p-4">
      <h2 class="text-lg font-semibold text-[var(--text-primary)] mb-4">Stats</h2>

      {/* Metric cards */}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard
          label="Total Thoughts"
          value={stats.total}
          icon={<Brain class="w-4 h-4" />}
        />
        <StatCard
          label="Active Days"
          value={totalDays}
          icon={<Calendar class="w-4 h-4" />}
        />
        <StatCard
          label="Topics"
          value={totalTopics}
          icon={<Hash class="w-4 h-4" />}
        />
        <StatCard
          label="People"
          value={totalPeople}
          icon={<Users class="w-4 h-4" />}
        />
      </div>

      {/* Activity chart */}
      <div class="mb-6">
        <ActivityChart data={stats.daily} />
      </div>

      {/* Type breakdown */}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="p-4 rounded-lg bg-[var(--surface)] border border-[var(--border-color)]">
          <h3 class="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-3">
            By Type
          </h3>
          <div class="space-y-2">
            {stats.types.map((t) => (
              <div key={t.type} class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <div
                    class="w-2 h-2 rounded-full"
                    style={{ backgroundColor: typeColor(t.type) }}
                  />
                  <span class="text-sm text-[var(--text-primary)] capitalize">
                    {(t.type || "unknown").replace(/_/g, " ")}
                  </span>
                </div>
                <span class="text-sm text-[var(--text-muted)] tabular-nums">
                  {t.count}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Top topics */}
        <div class="p-4 rounded-lg bg-[var(--surface)] border border-[var(--border-color)]">
          <h3 class="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Top Topics
          </h3>
          <div class="space-y-2">
            {stats.topics.slice(0, 10).map((t) => (
              <div
                key={t.topic}
                class="flex items-center justify-between cursor-pointer hover:bg-[var(--surface-hover)] -mx-1 px-1 rounded"
                onClick={() => route("/topics?selected=" + encodeURIComponent(t.topic))}
              >
                <span class="text-sm text-[var(--text-primary)]">{t.topic}</span>
                <span class="text-sm text-[var(--text-muted)] tabular-nums">
                  {t.count}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Sources */}
        <div class="p-4 rounded-lg bg-[var(--surface)] border border-[var(--border-color)]">
          <h3 class="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Sources
          </h3>
          <div class="space-y-2">
            {stats.sources.map((s) => (
              <div key={s.source} class="flex items-center justify-between">
                <span class="text-sm text-[var(--text-primary)]">
                  {s.source || "unknown"}
                </span>
                <span class="text-sm text-[var(--text-muted)] tabular-nums">
                  {s.count}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Top people */}
        <div class="p-4 rounded-lg bg-[var(--surface)] border border-[var(--border-color)]">
          <h3 class="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Top People
          </h3>
          <div class="space-y-2">
            {stats.people.slice(0, 10).map((p) => (
              <div
                key={p.person}
                class="flex items-center justify-between cursor-pointer hover:bg-[var(--surface-hover)] -mx-1 px-1 rounded"
                onClick={() => route("/people?selected=" + encodeURIComponent(p.person))}
              >
                <span class="text-sm text-[var(--text-primary)]">
                  {p.person}
                </span>
                <span class="text-sm text-[var(--text-muted)] tabular-nums">
                  {p.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
