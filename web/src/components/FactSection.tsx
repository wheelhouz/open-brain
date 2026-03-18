import { useState, useEffect, useCallback } from "preact/hooks";
import { api, type EntityFact, type FactEvidence } from "../api";
import { showToast } from "../state";
import { FactCard } from "./FactCard";
import { Plus, X } from "lucide-preact";

interface FactSectionProps {
  entityId: string;
  onFactChanged?: () => void;
  onThoughtClick?: (thoughtId: string) => void;
}

interface GroupedFacts {
  predicate: string;
  facts: EntityFact[];
}

const STATUS_WEIGHT: Record<string, number> = {
  active: 0,
  tentative: 1,
  disputed: 2,
  superseded: 3,
};

function groupByPredicate(facts: EntityFact[]): GroupedFacts[] {
  const map = new Map<string, EntityFact[]>();
  for (const f of facts) {
    const arr = map.get(f.predicate) || [];
    arr.push(f);
    map.set(f.predicate, arr);
  }
  return Array.from(map.entries())
    .map(([predicate, facts]) => ({
      predicate,
      facts: facts.sort((a, b) => (STATUS_WEIGHT[a.status] ?? 3) - (STATUS_WEIGHT[b.status] ?? 3)),
    }))
    .sort((a, b) => {
      const aMin = Math.min(...a.facts.map((f) => STATUS_WEIGHT[f.status] ?? 3));
      const bMin = Math.min(...b.facts.map((f) => STATUS_WEIGHT[f.status] ?? 3));
      return aMin - bMin;
    });
}

export function FactSection({ entityId, onFactChanged, onThoughtClick }: FactSectionProps) {
  const [facts, setFacts] = useState<EntityFact[]>([]);
  const [evidenceMap, setEvidenceMap] = useState<Map<string, FactEvidence[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formPredicate, setFormPredicate] = useState("");
  const [formValue, setFormValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadFacts = useCallback(() => {
    setLoading(true);
    api
      .entityFacts(entityId)
      .then((r) => {
        // Filter to only accepted facts (pending shown in SuggestionTray)
        setFacts(r.facts.filter((f) => f.review_state !== "pending"));
      })
      .catch(() => showToast("Failed to load facts", "error"))
      .finally(() => setLoading(false));
  }, [entityId]);

  useEffect(loadFacts, [loadFacts]);

  const loadEvidence = useCallback(
    async (factId: string) => {
      if (evidenceMap.has(factId)) return;
      try {
        const r = await api.entityFactDetail(entityId, factId);
        setEvidenceMap((prev) => new Map(prev).set(factId, r.evidence));
      } catch {
        // silent
      }
    },
    [entityId, evidenceMap],
  );

  const handleCreate = async () => {
    const predicate = formPredicate.trim();
    const value = formValue.trim();
    if (!predicate || !value) return;

    setSubmitting(true);
    try {
      await api.createFact(entityId, { predicate, value });
      setShowForm(false);
      setFormPredicate("");
      setFormValue("");
      loadFacts();
      onFactChanged?.();
      showToast("Fact added", "success");
    } catch (err: unknown) {
      const conflict = (err as { conflict?: { error: string } }).conflict;
      if (conflict) {
        showToast(conflict.error || "Conflicts with existing fact", "error");
      } else {
        showToast("Failed to add fact", "error");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (factId: string, data: { predicate?: string; object_display_text?: string }) => {
    try {
      await api.updateFact(entityId, factId, data);
      loadFacts();
      onFactChanged?.();
      showToast("Fact updated", "success");
    } catch {
      showToast("Failed to update fact", "error");
    }
  };

  const handleResolve = async (factId: string, action: string) => {
    try {
      await api.resolveConflict(entityId, factId, action);
      loadFacts();
      onFactChanged?.();
      showToast("Conflict resolved", "success");
    } catch {
      showToast("Failed to resolve conflict", "error");
    }
  };

  const grouped = groupByPredicate(facts);
  const hasAcceptedFacts = facts.some((f) => f.review_state === "accepted");

  if (loading) {
    return (
      <div class="mb-5">
        <h4 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
          Facts
        </h4>
        <div class="space-y-2">
          <div class="h-12 rounded-lg bg-[var(--bg-tertiary)] animate-pulse" />
          <div class="h-12 rounded-lg bg-[var(--bg-tertiary)] animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div class="mb-5">
      <div class="flex items-center justify-between mb-2">
        <h4 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
          Facts {hasAcceptedFacts && `(${facts.length})`}
        </h4>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            class="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors cursor-pointer"
          >
            <Plus class="w-3 h-3" /> Add
          </button>
        )}
      </div>

      {/* Inline add form */}
      {showForm && (
        <div class="mb-3 p-3 rounded-lg border border-[var(--border-color)] bg-[var(--surface)] space-y-2">
          <div class="flex items-center justify-between">
            <p class="text-xs font-medium text-[var(--text-secondary)]">Add a fact</p>
            <button
              onClick={() => { setShowForm(false); setFormPredicate(""); setFormValue(""); }}
              class="p-1 rounded hover:bg-[var(--surface-hover)] text-[var(--text-muted)] cursor-pointer"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>
          <input
            type="text"
            placeholder="Predicate (e.g. works_at, from, born_on)"
            value={formPredicate}
            onInput={(e) => setFormPredicate((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.stopPropagation()}
            class="w-full text-sm px-2.5 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <input
            type="text"
            placeholder="Value (e.g. Anthropic, Porto, 1991-05-12)"
            value={formValue}
            onInput={(e) => setFormValue((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") handleCreate();
            }}
            class="w-full text-sm px-2.5 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <div class="flex justify-end gap-2">
            <button
              onClick={() => { setShowForm(false); setFormPredicate(""); setFormValue(""); }}
              class="px-3 py-1 text-xs rounded text-[var(--text-muted)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={submitting || !formPredicate.trim() || !formValue.trim()}
              class="px-3 py-1 text-xs rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {submitting ? "Adding..." : "Add Fact"}
            </button>
          </div>
        </div>
      )}

      {/* Grouped facts */}
      {grouped.length === 0 ? (
        <p class="text-sm text-[var(--text-muted)]">No confirmed facts yet</p>
      ) : (
        <div class="space-y-2">
          {grouped.map((group) =>
            group.facts.map((fact) => (
              <FactCard
                key={fact.id}
                fact={fact}
                evidence={evidenceMap.get(fact.id)}
                onEdit={(data) => handleEdit(fact.id, data)}
                onResolve={(action) => handleResolve(fact.id, action)}
                onThoughtClick={(id) => {
                  loadEvidence(fact.id);
                  onThoughtClick?.(id);
                }}
                showActions={true}
              />
            )),
          )}
        </div>
      )}
    </div>
  );
}
