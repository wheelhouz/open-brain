import { useState, useEffect, useCallback } from "preact/hooks";
import { api, type EntityFact, type FactEvidence } from "../api";
import { showToast } from "../state";
import { ChevronDown, ChevronUp, CheckCircle, XCircle, Pencil, Sparkles } from "lucide-preact";

interface SuggestionTrayProps {
  entityId: string;
  onConflict?: (newFact: EntityFact, conflictWith: { id: string; predicate: string; object_display_text: string; status: string }) => void;
  onChanged?: () => void;
}

export function SuggestionTray({ entityId, onConflict, onChanged }: SuggestionTrayProps) {
  const [suggestions, setSuggestions] = useState<EntityFact[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPredicate, setEditPredicate] = useState("");
  const [editValue, setEditValue] = useState("");
  const [dismissing, setDismissing] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    api
      .entityFacts(entityId, { review_state: "pending" })
      .then((r) => setSuggestions(r.facts))
      .catch(() => {});
  }, [entityId]);

  useEffect(load, [load]);

  const handleAccept = async (fact: EntityFact) => {
    try {
      await api.acceptFact(entityId, fact.id);
      setDismissing((prev) => new Set(prev).add(fact.id));
      setTimeout(() => {
        setSuggestions((prev) => prev.filter((f) => f.id !== fact.id));
        setDismissing((prev) => { const s = new Set(prev); s.delete(fact.id); return s; });
      }, 300);
      onChanged?.();
      showToast("Fact accepted", "success");
    } catch (err: unknown) {
      const conflict = (err as { conflict?: { conflict_with: { id: string; predicate: string; object_display_text: string; status: string } } }).conflict;
      if (conflict?.conflict_with) {
        onConflict?.(fact, conflict.conflict_with);
      } else {
        showToast("Failed to accept fact", "error");
      }
    }
  };

  const handleReject = async (factId: string) => {
    try {
      await api.rejectFact(entityId, factId);
      setDismissing((prev) => new Set(prev).add(factId));
      setTimeout(() => {
        setSuggestions((prev) => prev.filter((f) => f.id !== factId));
        setDismissing((prev) => { const s = new Set(prev); s.delete(factId); return s; });
      }, 300);
      onChanged?.();
      showToast("Fact rejected");
    } catch {
      showToast("Failed to reject fact", "error");
    }
  };

  const startEdit = (fact: EntityFact) => {
    setEditingId(fact.id);
    setEditPredicate(fact.predicate);
    setEditValue(fact.object_display_text);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditPredicate("");
    setEditValue("");
  };

  const saveEditAndAccept = async (fact: EntityFact) => {
    const predicate = editPredicate.trim();
    const value = editValue.trim();
    if (!predicate || !value) return;

    try {
      // Update first, then accept
      if (predicate !== fact.predicate || value !== fact.object_display_text) {
        await api.updateFact(entityId, fact.id, {
          predicate: predicate !== fact.predicate ? predicate : undefined,
          object_display_text: value !== fact.object_display_text ? value : undefined,
        });
      }
      await api.acceptFact(entityId, fact.id);
      cancelEdit();
      setDismissing((prev) => new Set(prev).add(fact.id));
      setTimeout(() => {
        setSuggestions((prev) => prev.filter((f) => f.id !== fact.id));
        setDismissing((prev) => { const s = new Set(prev); s.delete(fact.id); return s; });
      }, 300);
      onChanged?.();
      showToast("Fact updated and accepted", "success");
    } catch (err: unknown) {
      const conflict = (err as { conflict?: { conflict_with: { id: string; predicate: string; object_display_text: string; status: string } } }).conflict;
      if (conflict?.conflict_with) {
        cancelEdit();
        onConflict?.(fact, conflict.conflict_with);
      } else {
        showToast("Failed to save", "error");
      }
    }
  };

  if (suggestions.length === 0) return null;

  return (
    <div class="mb-5">
      <button
        onClick={() => setExpanded(!expanded)}
        class="flex items-center gap-2 w-full text-left mb-2 cursor-pointer"
      >
        <div class="flex items-center gap-1.5">
          <Sparkles class="w-3.5 h-3.5 text-amber-500" />
          <h4 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
            Suggestions
          </h4>
          <span class="bg-amber-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center">
            {suggestions.length}
          </span>
        </div>
        {expanded
          ? <ChevronUp class="w-3.5 h-3.5 text-[var(--text-muted)]" />
          : <ChevronDown class="w-3.5 h-3.5 text-[var(--text-muted)]" />}
      </button>

      {expanded && (
        <div class="space-y-2">
          {suggestions.map((fact) => (
            <div
              key={fact.id}
              class={`rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20 p-3 transition-all ${
                dismissing.has(fact.id) ? "opacity-0 scale-95" : "opacity-100"
              }`}
              style={{ transitionDuration: "300ms" }}
            >
              {editingId === fact.id ? (
                /* Edit mode */
                <div class="space-y-2">
                  <input
                    type="text"
                    value={editPredicate}
                    onInput={(e) => setEditPredicate((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    class="w-full text-sm px-2.5 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                    placeholder="Predicate"
                  />
                  <input
                    type="text"
                    value={editValue}
                    onInput={(e) => setEditValue((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") saveEditAndAccept(fact);
                      if (e.key === "Escape") cancelEdit();
                    }}
                    class="w-full text-sm px-2.5 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                    placeholder="Value"
                  />
                  <div class="flex gap-2 justify-end">
                    <button
                      onClick={cancelEdit}
                      class="px-2 py-1 text-xs rounded text-[var(--text-muted)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => saveEditAndAccept(fact)}
                      class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors cursor-pointer"
                    >
                      <CheckCircle class="w-3 h-3" /> Save & Accept
                    </button>
                  </div>
                </div>
              ) : (
                /* Display mode */
                <>
                  <div class="flex items-start justify-between gap-2">
                    <div class="flex-1 min-w-0">
                      <p class="text-sm text-[var(--text-secondary)]">{fact.predicate}</p>
                      <p class="text-sm font-medium text-[var(--text-primary)]">{fact.object_display_text}</p>
                      {fact.confidence != null && (
                        <p class="text-xs text-[var(--text-muted)] mt-0.5">
                          {(fact.confidence * 100).toFixed(0)}% confidence
                        </p>
                      )}
                    </div>
                  </div>
                  <div class="flex items-center gap-2 mt-2">
                    <button
                      onClick={() => handleAccept(fact)}
                      class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors cursor-pointer"
                    >
                      <CheckCircle class="w-3 h-3" /> Accept
                    </button>
                    <button
                      onClick={() => handleReject(fact.id)}
                      class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors cursor-pointer"
                    >
                      <XCircle class="w-3 h-3" /> Reject
                    </button>
                    <button
                      onClick={() => startEdit(fact)}
                      class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-[var(--text-muted)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
                    >
                      <Pencil class="w-3 h-3" /> Edit
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
