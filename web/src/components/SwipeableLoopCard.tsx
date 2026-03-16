import { useMemo } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Loop } from "../api";
import { api } from "../api";
import { showToast } from "../state";
import { SwipeableCard, type SwipeAction } from "./SwipeableCard";
import { Trash2, Check, AlarmClock, RotateCcw } from "lucide-preact";

interface SwipeableLoopCardProps {
  loop: Loop;
  onChanged?: () => void;
  onDelete: () => Promise<void> | void;
  children: ComponentChildren;
}

export function SwipeableLoopCard({ loop, onChanged, onDelete, children }: SwipeableLoopCardProps) {
  const isClosed = loop.status === "closed";

  const leftActions: SwipeAction[] = useMemo(() => [{
    icon: <Trash2 class="w-5 h-5" />,
    label: "Delete",
    color: "#ef4444",
    onAction: onDelete,
  }], [onDelete]);

  const rightActions: SwipeAction[] = useMemo(() => {
    if (isClosed) {
      return [{
        icon: <RotateCcw class="w-5 h-5" />,
        label: "Reopen",
        color: "#3b82f6",
        onAction: async () => {
          try {
            await api.reopenLoop(loop.id);
            showToast("Loop reopened", "success");
            onChanged?.();
          } catch {
            showToast("Failed to reopen loop", "error");
          }
        },
      }];
    }
    return [
      {
        icon: <Check class="w-5 h-5" />,
        label: "Close",
        color: "#22c55e",
        onAction: async () => {
          try {
            await api.closeLoop(loop.id);
            showToast("Loop closed", "success");
            onChanged?.();
          } catch {
            showToast("Failed to close loop", "error");
          }
        },
      },
      {
        icon: <AlarmClock class="w-4 h-4" />,
        label: "Tomorrow",
        color: "#f59e0b",
        onAction: async () => {
          const d = new Date();
          d.setDate(d.getDate() + 1);
          try {
            await api.snoozeLoop(loop.id, d.toISOString().slice(0, 10));
            showToast("Reminder set for tomorrow", "success");
            onChanged?.();
          } catch {
            showToast("Failed to set reminder", "error");
          }
        },
      },
      {
        icon: <AlarmClock class="w-4 h-4" />,
        label: "Next week",
        color: "#f59e0b",
        onAction: async () => {
          const d = new Date();
          d.setDate(d.getDate() + 7);
          try {
            await api.snoozeLoop(loop.id, d.toISOString().slice(0, 10));
            showToast("Reminder set for next week", "success");
            onChanged?.();
          } catch {
            showToast("Failed to set reminder", "error");
          }
        },
      },
    ];
  }, [loop.id, isClosed, onChanged]);

  return (
    <SwipeableCard leftActions={leftActions} rightActions={rightActions}>
      {children}
    </SwipeableCard>
  );
}
