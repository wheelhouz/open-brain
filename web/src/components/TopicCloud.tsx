import { useState, useRef } from "preact/hooks";
import { Pencil, ChevronDown, ChevronUp } from "lucide-preact";
import type { TopicEntry } from "../api";

const COLLAPSED_LIMIT = 20;

interface TopicCloudProps {
  topics: TopicEntry[];
  selected: Set<string>;
  onSelect: (topic: string) => void;
  onRename?: (oldName: string, newName: string) => void;
  categoryColorMap?: Map<string, { bg: string; text: string; selected: string }>;
}

export function TopicCloud({ topics, selected, onSelect, onRename, categoryColorMap }: TopicCloudProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (topics.length === 0) return null;

  const maxCount = Math.max(...topics.map((t) => t.count));
  const minSize = 0.75;
  const maxSize = 1.5;

  const confirmEdit = (oldName: string) => {
    const newName = inputRef.current?.value.trim();
    setEditing(null);
    if (newName && newName !== oldName && onRename) {
      onRename(oldName, newName);
    }
  };

  const canCollapse = topics.length > COLLAPSED_LIMIT;
  const visibleTopics = canCollapse && !expanded ? topics.slice(0, COLLAPSED_LIMIT) : topics;
  const hiddenCount = topics.length - COLLAPSED_LIMIT;

  return (
    <div>
      <div class="flex flex-wrap gap-2.5">
      {visibleTopics.map((t) => {
        const scale = minSize + ((t.count / maxCount) * (maxSize - minSize));
        const isSelected = selected.has(t.topic);
        const catColor = categoryColorMap?.get(t.category);
        const isEditing = editing === t.topic;

        if (isEditing) {
          return (
            <input
              key={t.topic + "-edit"}
              ref={inputRef}
              class="px-2 py-1 rounded-lg bg-[var(--surface)] border border-[var(--accent)] text-[var(--text-primary)] outline-none animate-[fadeIn_0.15s]"
              style={{ fontSize: `${scale}rem` }}
              value={t.topic}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmEdit(t.topic);
                if (e.key === "Escape") setEditing(null);
              }}
              onBlur={() => confirmEdit(t.topic)}
              onFocus={(e) => (e.target as HTMLInputElement).select()}
              autoFocus
            />
          );
        }

        return (
          <div key={t.topic} class="group relative">
            <button
              onClick={() => onSelect(t.topic)}
              class={`px-2 py-1 rounded-lg transition-colors cursor-pointer ${
                isSelected ? "text-white" : "hover:opacity-80"
              }`}
              style={{
                fontSize: `${scale}rem`,
                ...(isSelected
                  ? { background: catColor?.selected || "var(--accent)" }
                  : catColor
                    ? { background: catColor.bg, color: catColor.text }
                    : { background: "var(--bg-tertiary)", color: "var(--text-secondary)" }),
              }}
            >
              {t.topic}
              <span class="text-[0.6em] ml-1 opacity-60">{t.count}</span>
            </button>
            {onRename && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(t.topic);
                }}
                class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-color)] flex items-center justify-center opacity-40 sm:opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              >
                <Pencil class="w-2.5 h-2.5 text-[var(--text-secondary)]" />
              </button>
            )}
          </div>
        );
      })}
      </div>
      {canCollapse && (
        <button
          onClick={() => setExpanded(!expanded)}
          class="flex items-center gap-1 mt-3 mb-4 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        >
          {expanded ? (
            <>
              <ChevronUp size={14} />
              Show less
            </>
          ) : (
            <>
              <ChevronDown size={14} />
              Show {hiddenCount} more
            </>
          )}
        </button>
      )}
    </div>
  );
}
