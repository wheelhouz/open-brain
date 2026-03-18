import { useState } from "preact/hooks";
import { api, type EntityFact } from "../api";
import { showToast } from "../state";
import { AlertTriangle, ArrowRight, X } from "lucide-preact";

interface ConflictCardProps {
  entityId: string;
  newFact: EntityFact;
  existingFact: { id: string; predicate: string; object_display_text: string; status: string };
  onResolved?: () => void;
  onCancel?: () => void;
}

export function ConflictCard({ entityId, newFact, existingFact, onResolved, onCancel }: ConflictCardProps) {
  const [resolving, setResolving] = useState(false);

  const resolve = async (action: string) => {
    setResolving(true);
    try {
      if (action === "reject_new") {
        await api.rejectFact(entityId, newFact.id);
      } else {
        await api.resolveConflict(entityId, newFact.id, action);
      }
      onResolved?.();
      showToast("Conflict resolved", "success");
    } catch {
      showToast("Failed to resolve conflict", "error");
    } finally {
      setResolving(false);
    }
  };

  return (
    <div class="rounded-lg border-2 border-red-300 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 p-4 mb-4">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2 text-red-600 dark:text-red-400">
          <AlertTriangle class="w-4 h-4" />
          <h4 class="text-sm font-semibold">Fact Conflict</h4>
        </div>
        {onCancel && (
          <button
            onClick={onCancel}
            class="p-1 rounded hover:bg-[var(--surface-hover)] text-[var(--text-muted)] cursor-pointer"
          >
            <X class="w-4 h-4" />
          </button>
        )}
      </div>

      <p class="text-xs text-[var(--text-muted)] mb-3">
        Two facts about <span class="font-medium">{newFact.predicate}</span> conflict. Choose how to resolve:
      </p>

      {/* Side by side comparison */}
      <div class="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-2 sm:gap-3 mb-4">
        {/* Existing fact */}
        <div class="p-3 rounded-lg border border-[var(--border-color)] bg-[var(--surface)]">
          <p class="text-xs text-[var(--text-muted)] mb-1">Existing ({existingFact.status})</p>
          <p class="text-sm font-medium text-[var(--text-primary)]">{existingFact.object_display_text}</p>
        </div>

        <div class="hidden sm:flex items-center justify-center">
          <ArrowRight class="w-4 h-4 text-[var(--text-muted)]" />
        </div>

        {/* New fact */}
        <div class="p-3 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-950/20">
          <p class="text-xs text-amber-600 dark:text-amber-400 mb-1">New (pending)</p>
          <p class="text-sm font-medium text-[var(--text-primary)]">{newFact.object_display_text}</p>
          {newFact.confidence != null && (
            <p class="text-xs text-[var(--text-muted)] mt-0.5">
              {(newFact.confidence * 100).toFixed(0)}% confidence
            </p>
          )}
        </div>
      </div>

      {/* Resolution actions */}
      <div class="flex flex-wrap gap-2">
        <button
          onClick={() => resolve("mark_old_as_past")}
          disabled={resolving}
          class="px-3 py-1.5 text-xs rounded-md bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/50 disabled:opacity-50 transition-colors cursor-pointer"
        >
          Accept new, mark old as past
        </button>
        <button
          onClick={() => resolve("mark_old_as_wrong")}
          disabled={resolving}
          class="px-3 py-1.5 text-xs rounded-md bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 disabled:opacity-50 transition-colors cursor-pointer"
        >
          Accept new, mark old as wrong
        </button>
        <button
          onClick={() => resolve("keep_both_disputed")}
          disabled={resolving}
          class="px-3 py-1.5 text-xs rounded-md bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50 disabled:opacity-50 transition-colors cursor-pointer"
        >
          Keep both as uncertain
        </button>
        <button
          onClick={() => resolve("reject_new")}
          disabled={resolving}
          class="px-3 py-1.5 text-xs rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-hover)] disabled:opacity-50 transition-colors cursor-pointer"
        >
          Keep existing, reject new
        </button>
      </div>
    </div>
  );
}
