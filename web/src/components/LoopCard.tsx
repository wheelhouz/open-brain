import { useState, useRef, useEffect } from "preact/hooks";
import type { Loop } from "../api";
import { api } from "../api";
import { relativeTime } from "../lib/format";
import { extractHeadline } from "../lib/markdown";
import { showToast } from "../state";
import { CheckSquare, HelpCircle, Scale, Clock, MoreVertical, Check, AlarmClock, RotateCcw } from "lucide-preact";

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
  onChanged?: () => void;
  selected?: boolean;
}

function isDueNow(loop: Loop): boolean {
  return loop.status === "snoozed" && !!loop.snoozed_until && new Date(loop.snoozed_until) <= new Date();
}

function QuickActions({ loop, onChanged }: { loop: Loop; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [showResolution, setShowResolution] = useState(false);
  const [resolution, setResolution] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleClose = async (e: Event) => {
    e.stopPropagation();
    const needsResolution = loop.loop_type === "question" || loop.loop_type === "decision";
    if (needsResolution && !showResolution) {
      setShowResolution(true);
      setOpen(false);
      return;
    }
    try {
      await api.closeLoop(loop.id, resolution || undefined);
      showToast("Loop closed", "success");
      setOpen(false);
      setShowResolution(false);
      setResolution("");
      onChanged?.();
    } catch {
      showToast("Failed to close loop", "error");
    }
  };

  const handleSnooze = async (e: Event, days: number) => {
    e.stopPropagation();
    const d = new Date();
    d.setDate(d.getDate() + days);
    try {
      await api.snoozeLoop(loop.id, d.toISOString().slice(0, 10));
      showToast(`Snoozed ${days === 1 ? "until tomorrow" : `for ${days} days`}`, "success");
      setOpen(false);
      onChanged?.();
    } catch {
      showToast("Failed to snooze loop", "error");
    }
  };

  const handleReopen = async (e: Event) => {
    e.stopPropagation();
    try {
      await api.reopenLoop(loop.id);
      showToast("Loop reopened", "success");
      setOpen(false);
      onChanged?.();
    } catch {
      showToast("Failed to reopen loop", "error");
    }
  };

  const isClosed = loop.status === "closed";

  if (showResolution) {
    return (
      <div class="flex gap-1 mt-1" onClick={(e) => e.stopPropagation()}>
        <input
          type="text"
          class="flex-1 text-xs bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-2 py-1 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
          placeholder={loop.loop_type === "question" ? "Answer..." : "Decision..."}
          value={resolution}
          onInput={(e) => setResolution((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleClose(e);
            if (e.key === "Escape") { setShowResolution(false); setResolution(""); }
          }}
          autoFocus
        />
        <button onClick={handleClose} class="text-xs px-2 py-1 rounded bg-green-600 text-white">Close</button>
        <button onClick={(e) => { e.stopPropagation(); setShowResolution(false); setResolution(""); }} class="text-xs px-2 py-1 text-[var(--text-muted)]">Cancel</button>
      </div>
    );
  }

  return (
    <div ref={menuRef} class="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        class="p-1 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
      >
        <MoreVertical class="w-3.5 h-3.5" />
      </button>
      {open && (
        <div class="absolute right-0 top-full mt-1 z-20 bg-[var(--surface)] border border-[var(--border-color)] rounded-lg shadow-lg py-1 min-w-[140px]">
          {isClosed ? (
            <button onClick={handleReopen} class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
              <RotateCcw class="w-3.5 h-3.5" /> Reopen
            </button>
          ) : (
            <>
              <button onClick={handleClose} class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-green-400 hover:bg-[var(--bg-secondary)]">
                <Check class="w-3.5 h-3.5" /> Close
              </button>
              <button onClick={(e) => handleSnooze(e, 1)} class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-amber-400 hover:bg-[var(--bg-secondary)]">
                <AlarmClock class="w-3.5 h-3.5" /> Tomorrow
              </button>
              <button onClick={(e) => handleSnooze(e, 7)} class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-amber-400 hover:bg-[var(--bg-secondary)]">
                <AlarmClock class="w-3.5 h-3.5" /> Next week
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function LoopCard({ loop, onClick, onChanged, selected }: LoopCardProps) {
  const Icon = typeIcons[loop.loop_type];
  const color = typeColors[loop.loop_type];
  const isClosed = loop.status === "closed";
  const headline = extractHeadline(loop.content);
  const dueNow = isDueNow(loop);

  // Build meta parts
  const metaParts: string[] = [typeLabels[loop.loop_type]];
  metaParts.push(loop.evidence_count === 1 ? "1 thought" : `${loop.evidence_count} thoughts`);
  if (loop.source_preview) {
    const preview = loop.source_preview.length >= 78 ? loop.source_preview + "..." : loop.source_preview;
    metaParts.push(`Source: "${preview}"`);
  }

  // Needs-action badge for open questions/decisions
  const needsAction = loop.status !== "closed" && (loop.loop_type === "question" || loop.loop_type === "decision");
  const actionLabel = loop.loop_type === "question" ? "Needs answer" : "Needs decision";

  return (
    <div
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
          {/* Headline + time + actions */}
          <div class="flex items-center justify-between gap-2 mb-0.5">
            <span class={`text-sm font-medium text-[var(--text-primary)] truncate ${isClosed ? "line-through" : ""}`}>
              {headline ? headline.headline : loop.content.split("\n")[0]}
            </span>
            <div class="flex items-center gap-1 flex-shrink-0">
              <span class="text-xs text-[var(--text-muted)]">
                {relativeTime(loop.created_at)}
              </span>
              {/* 3-dot menu hidden on mobile — swipe actions used instead */}
              <span class="hidden sm:block">
                <QuickActions loop={loop} onChanged={onChanged} />
              </span>
            </div>
          </div>

          {/* Body preview */}
          {headline?.body && (
            <p class="text-xs text-[var(--text-secondary)] line-clamp-1 mb-0.5">
              {headline.body}
            </p>
          )}

          {/* Meta row */}
          <div class="flex items-center gap-1 flex-wrap mt-0.5">
            <span class="text-[10px] text-[var(--text-muted)]">
              {metaParts.join(" · ")}
            </span>
            {dueNow && (
              <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400">
                Due now
              </span>
            )}
            {needsAction && (
              <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
                {actionLabel}
              </span>
            )}
            {loop.status === "snoozed" && loop.snoozed_until && !dueNow && (
              <span class="text-[10px] text-amber-400">
                snoozed until {new Date(loop.snoozed_until).toLocaleDateString()}
              </span>
            )}
          </div>

          {/* Resolution preview (when closed) */}
          {loop.resolution && (
            <p class="text-xs text-[var(--text-secondary)] mt-1 italic line-clamp-1">
              {loop.resolution}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
