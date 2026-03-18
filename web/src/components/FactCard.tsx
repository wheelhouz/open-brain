import { useState } from "preact/hooks";
import type { EntityFact, FactEvidence } from "../api";
import { relativeTime } from "../lib/format";
import { ChevronDown, ChevronUp, Clock, AlertTriangle, CheckCircle, XCircle, Pencil } from "lucide-preact";

const STATUS_CONFIG: Record<string, { color: string; bg: string; label: string }> = {
  active: { color: "text-green-600", bg: "bg-green-100 dark:bg-green-900/30", label: "Active" },
  tentative: { color: "text-amber-600", bg: "bg-amber-100 dark:bg-amber-900/30", label: "Tentative" },
  disputed: { color: "text-red-600", bg: "bg-red-100 dark:bg-red-900/30", label: "Disputed" },
  superseded: { color: "text-[var(--text-muted)]", bg: "bg-[var(--bg-secondary)]", label: "Superseded" },
};

interface FactCardProps {
  fact: EntityFact;
  evidence?: FactEvidence[];
  onAccept?: () => void;
  onReject?: () => void;
  onResolve?: (action: string) => void;
  onEdit?: (data: { predicate?: string; object_display_text?: string }) => void;
  onExpand?: () => void;
  onThoughtClick?: (thoughtId: string) => void;
  showActions?: boolean;
}

export function FactCard({
  fact,
  evidence,
  onAccept,
  onReject,
  onResolve,
  onEdit,
  onExpand,
  onThoughtClick,
  showActions = true,
}: FactCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editPredicate, setEditPredicate] = useState(fact.predicate);
  const [editValue, setEditValue] = useState(fact.object_display_text);
  const config = STATUS_CONFIG[fact.status] || STATUS_CONFIG.active;
  const isPending = fact.review_state === "pending";
  const isEditable = fact.status === "active" || fact.status === "tentative";

  const startEdit = () => {
    setEditPredicate(fact.predicate);
    setEditValue(fact.object_display_text);
    setEditing(true);
  };

  const cancelEdit = () => setEditing(false);

  const saveEdit = () => {
    if (!onEdit) return;
    const data: { predicate?: string; object_display_text?: string } = {};
    const newPred = editPredicate.trim();
    const newVal = editValue.trim();
    if (!newPred || !newVal) return;
    if (newPred !== fact.predicate) data.predicate = newPred;
    if (newVal !== fact.object_display_text) data.object_display_text = newVal;
    if (Object.keys(data).length === 0) {
      cancelEdit();
      return;
    }
    onEdit(data);
    setEditing(false);
  };

  return (
    <div
      class={`rounded-lg border transition-colors ${
        fact.status === "disputed"
          ? "border-red-300 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20"
          : "border-[var(--border-color)] bg-[var(--surface)]"
      }`}
    >
      <div class="p-3">
        {editing ? (
          /* Inline edit mode */
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
                if (e.key === "Enter") saveEdit();
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
                onClick={saveEdit}
                class="px-2 py-1 text-xs rounded bg-[var(--accent)] text-white hover:opacity-90 transition-colors cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          /* Display mode */
          <>
            <div class="flex items-start justify-between gap-2">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${config.bg} ${config.color}`}>
                    {config.label}
                  </span>
                  {isPending && (
                    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-600">
                      Pending Review
                    </span>
                  )}
                  {fact.confidence != null && fact.confidence < 0.9 && (
                    <span class="text-xs text-[var(--text-muted)]">
                      {(fact.confidence * 100).toFixed(0)}% confidence
                    </span>
                  )}
                </div>
                <p class="mt-1 text-sm text-[var(--text-secondary)]">{fact.predicate}</p>
                <p class={`text-sm font-medium ${fact.status === "superseded" ? "text-[var(--text-muted)] line-through" : "text-[var(--text-primary)]"}`}>
                  {fact.object_display_text}
                </p>
                {(fact.valid_at_start || fact.valid_at_end) && (
                  <p class="mt-0.5 text-xs text-[var(--text-muted)] flex items-center gap-1">
                    <Clock class="w-3 h-3" />
                    {fact.valid_at_start && `From ${fact.valid_at_start.split("T")[0]}`}
                    {fact.valid_at_start && fact.valid_at_end && " "}
                    {fact.valid_at_end && `Until ${fact.valid_at_end.split("T")[0]}`}
                  </p>
                )}
              </div>
                  <button
                onClick={() => {
                  const willExpand = !expanded;
                  setExpanded(willExpand);
                  if (willExpand) onExpand?.();
                }}
                class="p-1 rounded hover:bg-[var(--surface-hover)] text-[var(--text-muted)] cursor-pointer"
                title={expanded ? "Collapse" : "Show evidence"}
              >
                {expanded
                  ? <ChevronUp class="w-4 h-4" />
                  : <ChevronDown class="w-4 h-4" />}
              </button>
            </div>

            {/* Action buttons */}
            {showActions && (
              <div class="flex items-center gap-2 mt-2 flex-wrap">
                {isPending && onAccept && (
                  <button
                    onClick={onAccept}
                    class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors cursor-pointer"
                  >
                    <CheckCircle class="w-3 h-3" /> Accept
                  </button>
                )}
                {isPending && onReject && (
                  <button
                    onClick={onReject}
                    class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors cursor-pointer"
                  >
                    <XCircle class="w-3 h-3" /> Reject
                  </button>
                )}
                {fact.status === "disputed" && onResolve && (
                  <button
                    onClick={() => onResolve("replace_existing_with_new")}
                    class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors cursor-pointer"
                  >
                    <AlertTriangle class="w-3 h-3" /> Resolve
                  </button>
                )}
                {isEditable && fact.review_state === "accepted" && onEdit && (
                  <button
                    onClick={startEdit}
                    class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-[var(--text-muted)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
                  >
                    <Pencil class="w-3 h-3" /> Edit
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Evidence section */}
      {expanded && (
        <div class="border-t border-[var(--border-color)] px-3 py-2 space-y-2">
          {!evidence ? (
            <div class="h-4 w-32 rounded bg-[var(--bg-tertiary)] animate-pulse" />
          ) : evidence.length === 0 ? (
            <p class="text-xs text-[var(--text-muted)]">No evidence recorded</p>
          ) : (
            <>
              <p class="text-xs font-medium text-[var(--text-muted)]">Evidence ({evidence.length})</p>
              {evidence.map((e) => (
                <div key={e.id} class="text-xs text-[var(--text-secondary)] pl-2 border-l-2 border-[var(--border-color)]">
                  {e.excerpt && <p class="italic">"{e.excerpt}"</p>}
                  <p class="text-[var(--text-muted)] mt-0.5">
                    {e.evidence_type}
                    {e.thought_id && onThoughtClick && (
                      <>
                        {" "}
                        <button
                          onClick={() => onThoughtClick(e.thought_id!)}
                          class="text-[var(--accent)] hover:underline cursor-pointer"
                        >
                          View source
                        </button>
                      </>
                    )}
                    {" "}&middot; {relativeTime(e.created_at)}
                  </p>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
