interface ActivityChartProps {
  data: { date: string; count: number }[];
}

export function ActivityChart({ data }: ActivityChartProps) {
  if (data.length === 0) return null;

  // Fill in missing days to get 30 contiguous days
  const today = new Date();
  const days: { date: string; count: number }[] = [];
  const dataMap = new Map(data.map((d) => [d.date, d.count]));

  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ date: key, count: dataMap.get(key) || 0 });
  }

  const maxCount = Math.max(...days.map((d) => d.count), 1);

  return (
    <div class="p-4 rounded-lg bg-[var(--surface)] border border-[var(--border-color)]">
      <h3 class="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-3">
        Activity (30 days)
      </h3>
      <div class="flex items-end gap-[2px] h-20">
        {days.map((d) => {
          const pct = (d.count / maxCount) * 100;
          return (
            <div
              key={d.date}
              class="flex-1 rounded-t transition-all group relative"
              style={{
                height: `${Math.max(pct, 2)}%`,
                backgroundColor:
                  d.count > 0 ? "var(--accent)" : "var(--bg-tertiary)",
              }}
              title={`${d.date}: ${d.count}`}
            >
              <div class="absolute -top-6 left-1/2 -translate-x-1/2 hidden group-hover:block text-[10px] text-[var(--text-muted)] whitespace-nowrap bg-[var(--bg-secondary)] px-1 rounded">
                {d.count}
              </div>
            </div>
          );
        })}
      </div>
      <div class="flex justify-between mt-1">
        <span class="text-[10px] text-[var(--text-muted)]">{days[0].date}</span>
        <span class="text-[10px] text-[var(--text-muted)]">{days[days.length - 1].date}</span>
      </div>
    </div>
  );
}
