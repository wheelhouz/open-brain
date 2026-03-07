export function SimilarityBar({ similarity }: { similarity: number }) {
  const pct = Math.round(similarity * 100);
  const color =
    pct >= 90
      ? "var(--sim-high)"
      : pct >= 70
        ? "var(--sim-medium)"
        : "var(--sim-low)";

  return (
    <div class="flex items-center gap-2 text-xs">
      <div class="w-16 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <div
          class="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span class="text-[var(--text-muted)] tabular-nums">{pct}%</span>
    </div>
  );
}
