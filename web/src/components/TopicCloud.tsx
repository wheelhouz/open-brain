import { useState, useRef } from "preact/hooks";
import { Pencil } from "lucide-preact";
import type { TopicEntry } from "../api";

interface TopicCloudProps {
  topics: TopicEntry[];
  selected?: string;
  onSelect: (topic: string) => void;
  onRename?: (oldName: string, newName: string) => void;
}

export function TopicCloud({ topics, selected, onSelect, onRename }: TopicCloudProps) {
  const [editing, setEditing] = useState<string | null>(null);
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

  return (
    <div class="flex flex-wrap gap-2">
      {topics.map((t) => {
        const scale = minSize + ((t.count / maxCount) * (maxSize - minSize));
        const isSelected = selected === t.topic;
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
              onClick={() => onSelect(isSelected ? "" : t.topic)}
              class={`px-2 py-1 rounded-lg transition-colors cursor-pointer ${
                isSelected
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
              }`}
              style={{ fontSize: `${scale}rem` }}
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
  );
}
