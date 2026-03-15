import type { Loop } from "../api";
import { relativeTime } from "../lib/format";
import { CheckSquare, HelpCircle, Scale, Clock } from "lucide-preact";

const typeIcons = {
  task: CheckSquare,
  question: HelpCircle,
  decision: Scale,
  waiting_on: Clock,
} as const;

const typeColors = {
  task: "var(--type-task)",
  question: "var(--type-idea)",
  decision: "var(--type-decision)",
  waiting_on: "var(--type-meeting-note)",
} as const;

const typeLabels = {
  task: "Task",
  question: "Question",
  decision: "Decision",
  waiting_on: "Waiting on",
} as const;

export { typeColors, typeLabels, typeIcons };

interface LoopCardProps {
  loop: Loop;
  onClick?: () => void;
  selected?: boolean;
}

export function LoopCard({ loop, onClick, selected }: LoopCardProps) {
  const Icon = typeIcons[loop.loop_type];
  const color = typeColors[loop.loop_type];
  const isClosed = loop.status === "closed";

  return (
    <button
      onClick={onClick}
      class={`w-full text-left p-3 rounded-lg border-r border-y transition-colors cursor-pointer ${
        selected
          ? "bg-[var(--accent)]/10 border-[var(--accent)] border-l-[var(--accent)]"
          : "bg-[var(--surface)] border-[var(--border-color)] hover:bg-[var(--surface-hover)]"
      } ${isClosed ? "opacity-60" : ""}`}
      style={!selected ? { borderLeftWidth: "2px", borderLeftStyle: "solid", borderLeftColor: color } : { borderLeftWidth: "2px", borderLeftStyle: "solid" }}
    >
      <div class="flex items-start gap-2">
        <Icon class="w-4 h-4 mt-0.5 shrink-0" style={{ color }} />
        <div class="flex-1 min-w-0">
          {/* Header: type label + meta + time */}
          <div class="flex items-center justify-between gap-2 mb-1">
            <div class="flex items-center gap-1.5">
              <span class="text-xs font-medium" style={{ color }}>
                {typeLabels[loop.loop_type]}
              </span>
              {loop.evidence_count > 1 && (
                <span class="text-[10px] text-[var(--text-muted)]">
                  {loop.evidence_count} thoughts
                </span>
              )}
              {loop.status === "snoozed" && loop.snoozed_until && (
                <span class="text-[10px] text-amber-400">
                  snoozed until {new Date(loop.snoozed_until).toLocaleDateString()}
                </span>
              )}
            </div>
            <span class="text-xs text-[var(--text-muted)] flex-shrink-0">
              {relativeTime(loop.created_at)}
            </span>
          </div>

          {/* Content */}
          <p class={`text-sm text-[var(--text-primary)] leading-relaxed line-clamp-2 ${isClosed ? "line-through" : ""}`}>
            {loop.content}
          </p>

          {/* Resolution preview (when closed) */}
          {loop.resolution && (
            <p class="text-xs text-[var(--text-secondary)] mt-1 italic line-clamp-1">
              {loop.resolution}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}
