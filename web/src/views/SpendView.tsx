import { useState, useEffect } from "preact/hooks";
import {
  api,
  type SpendSummary,
  type SpendBreakdown,
  type SpendBudget,
} from "../api";
import { StatCard } from "../components/StatCard";
import { DollarSign, AlertTriangle, Zap, Database } from "lucide-preact";

function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(2)}`;
}

function SpendChart({ data }: { data: SpendBreakdown["daily"] }) {
  if (data.length === 0) return null;

  const today = new Date();
  const days: { date: string; usd: number }[] = [];
  const dataMap = new Map(data.map((d) => [d.date.slice(0, 10), parseFloat(d.usd)]));

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ date: key, usd: dataMap.get(key) || 0 });
  }

  const maxUsd = Math.max(...days.map((d) => d.usd), 0.001);

  return (
    <div class="p-4 rounded-lg bg-[var(--surface)] border border-[var(--border-color)]">
      <h3 class="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-3">
        Daily Spend (30 days)
      </h3>
      <div class="flex items-end gap-[2px] h-20">
        {days.map((d) => {
          const pct = (d.usd / maxUsd) * 100;
          return (
            <div
              key={d.date}
              class="flex-1 rounded-t transition-all group relative"
              style={{
                height: `${Math.max(pct, 2)}%`,
                backgroundColor:
                  d.usd > 0 ? "var(--accent)" : "var(--bg-tertiary)",
              }}
              title={`${d.date}: ${formatUsd(d.usd)}`}
            >
              <div class="absolute -top-6 left-1/2 -translate-x-1/2 hidden group-hover:block text-[10px] text-[var(--text-muted)] whitespace-nowrap bg-[var(--bg-secondary)] px-1 rounded">
                {formatUsd(d.usd)}
              </div>
            </div>
          );
        })}
      </div>
      <div class="flex justify-between mt-1">
        <span class="text-[10px] text-[var(--text-muted)]">{days[0].date}</span>
        <span class="text-[10px] text-[var(--text-muted)]">
          {days[days.length - 1].date}
        </span>
      </div>
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  labelKey,
}: {
  title: string;
  rows: Array<Record<string, string>>;
  labelKey: string;
}) {
  if (rows.length === 0) {
    return (
      <div class="p-4 rounded-lg bg-[var(--surface)] border border-[var(--border-color)]">
        <h3 class="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-3">
          {title}
        </h3>
        <p class="text-sm text-[var(--text-muted)]">No data</p>
      </div>
    );
  }

  return (
    <div class="p-4 rounded-lg bg-[var(--surface)] border border-[var(--border-color)]">
      <h3 class="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-3">
        {title}
      </h3>
      <table class="w-full text-sm">
        <thead>
          <tr class="text-[var(--text-muted)] text-xs uppercase">
            <th class="text-left pb-2 font-medium">{labelKey}</th>
            <th class="text-right pb-2 font-medium">Calls</th>
            <th class="text-right pb-2 font-medium">Tokens</th>
            <th class="text-right pb-2 font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r[labelKey]}
              class="border-t border-[var(--border-color)]"
            >
              <td class="py-1.5 text-[var(--text-primary)]">
                {r[labelKey] || "unknown"}
              </td>
              <td class="py-1.5 text-right text-[var(--text-muted)] tabular-nums">
                {parseInt(r.calls).toLocaleString()}
              </td>
              <td class="py-1.5 text-right text-[var(--text-muted)] tabular-nums">
                {parseInt(r.tokens).toLocaleString()}
              </td>
              <td class="py-1.5 text-right text-[var(--text-primary)] tabular-nums">
                {formatUsd(parseFloat(r.usd))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SpendPanel() {
  const [summary, setSummary] = useState<SpendSummary | null>(null);
  const [breakdown, setBreakdown] = useState<SpendBreakdown | null>(null);
  const [budget, setBudget] = useState<SpendBudget | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.spendSummary(),
      api.spendBreakdown(30),
      api.spendBudget(),
    ])
      .then(([s, b, bg]) => {
        setSummary(s);
        setBreakdown(b);
        setBudget(bg);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <p class="text-[var(--text-muted)] text-sm">Loading spend data...</p>
    );
  }

  if (!summary || !breakdown || !budget) {
    return (
      <div class="text-center py-12">
        <p class="text-[var(--text-muted)]">Failed to load spend data</p>
      </div>
    );
  }

  return (
    <>
      {/* Budget alert */}
      {budget.alert_triggered && (
        <div class="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center gap-2">
          <AlertTriangle class="w-5 h-5 text-amber-500 shrink-0" />
          <span class="text-sm text-amber-500">
            Monthly spend has reached {budget.percent_used.toFixed(1)}% of the{" "}
            {formatUsd(budget.monthly_budget_usd)} budget.
          </span>
        </div>
      )}

      {/* Summary cards */}
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
        <StatCard
          label="Today"
          value={formatUsd(summary.today.estimated_usd)}
          icon={<DollarSign class="w-4 h-4" />}
        />
        <StatCard
          label="This Month"
          value={formatUsd(summary.this_month.estimated_usd)}
          icon={<Zap class="w-4 h-4" />}
        />
        <StatCard
          label="All Time"
          value={formatUsd(summary.all_time.estimated_usd)}
          icon={<Database class="w-4 h-4" />}
        />
      </div>

      {/* Budget progress bar */}
      {budget.monthly_budget_usd > 0 && (
        <div class="mb-6 p-4 rounded-lg bg-[var(--surface)] border border-[var(--border-color)]">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-xs text-[var(--text-muted)] uppercase tracking-wider">
              Monthly Budget
            </h3>
            <span class="text-sm text-[var(--text-primary)] tabular-nums">
              {formatUsd(budget.month_to_date_usd)} /{" "}
              {formatUsd(budget.monthly_budget_usd)}
            </span>
          </div>
          <div class="w-full h-3 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
            <div
              class="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(budget.percent_used, 100)}%`,
                backgroundColor:
                  budget.percent_used >= budget.alert_threshold_pct
                    ? "var(--color-amber-500, #f59e0b)"
                    : "var(--accent)",
              }}
            />
          </div>
          <div class="flex justify-between mt-1">
            <span class="text-[10px] text-[var(--text-muted)]">
              {budget.percent_used.toFixed(1)}% used
            </span>
            {budget.hard_cutoff_usd > 0 && (
              <span class="text-[10px] text-[var(--text-muted)]">
                Hard cutoff: {formatUsd(budget.hard_cutoff_usd)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Daily spend chart */}
      <div class="mb-6">
        <SpendChart data={breakdown.daily} />
      </div>

      {/* Breakdown tables */}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <BreakdownTable
          title="By Operation"
          rows={breakdown.by_operation}
          labelKey="operation"
        />
        <BreakdownTable
          title="By Model"
          rows={breakdown.by_model}
          labelKey="model"
        />
        <BreakdownTable
          title="By Source"
          rows={breakdown.by_source}
          labelKey="source"
        />
      </div>
    </>
  );
}
