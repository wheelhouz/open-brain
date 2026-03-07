interface StatCardProps {
  label: string;
  value: number | string;
  icon?: preact.ComponentChildren;
}

export function StatCard({ label, value, icon }: StatCardProps) {
  return (
    <div class="p-4 rounded-lg bg-[var(--surface)] border border-[var(--border-color)]">
      <div class="flex items-center justify-between mb-1">
        <span class="text-xs text-[var(--text-muted)] uppercase tracking-wider">
          {label}
        </span>
        {icon && <span class="text-[var(--text-muted)]">{icon}</span>}
      </div>
      <p class="text-2xl font-bold text-[var(--text-primary)] tabular-nums">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
    </div>
  );
}
