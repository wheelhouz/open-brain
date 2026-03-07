import { useState, useRef } from "preact/hooks";
import type { PersonEntry } from "../api";
import { relativeTime } from "../lib/format";
import { User, Pencil } from "lucide-preact";

interface PersonCardProps {
  person: PersonEntry;
  selected?: boolean;
  onClick: () => void;
  onRename?: (oldName: string, newName: string) => void;
}

export function PersonCard({ person, selected, onClick, onRename }: PersonCardProps) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const confirmEdit = () => {
    const newName = inputRef.current?.value.trim();
    setEditing(false);
    if (newName && newName !== person.person && onRename) {
      onRename(person.person, newName);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => { if (!editing) onClick(); }}
      onKeyDown={(e) => { if (e.key === "Enter" && !editing) onClick(); }}
      class={`group relative w-full text-left p-3 rounded-lg border transition-colors cursor-pointer flex items-center gap-3 ${
        selected
          ? "bg-[var(--accent)]/10 border-[var(--accent)]"
          : "bg-[var(--surface)] border-[var(--border-color)] hover:bg-[var(--surface-hover)]"
      }`}
    >
      <div class="w-10 h-10 rounded-full bg-[var(--type-person-note)]/20 flex items-center justify-center flex-shrink-0">
        <User class="w-5 h-5 text-[var(--type-person-note)]" />
      </div>
      <div class="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            class="text-sm font-medium text-[var(--text-primary)] bg-transparent border-b border-[var(--accent)] outline-none w-full animate-[fadeIn_0.15s]"
            value={person.person}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") confirmEdit();
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={confirmEdit}
            onFocus={(e) => (e.target as HTMLInputElement).select()}
            autoFocus
          />
        ) : (
          <p class="text-sm font-medium text-[var(--text-primary)] truncate">
            {person.person}
          </p>
        )}
        <p class="text-xs text-[var(--text-muted)]">
          {person.count} thought{person.count !== 1 ? "s" : ""} &middot;{" "}
          {relativeTime(person.last_seen)}
        </p>
      </div>
      {onRename && !editing && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          class="absolute top-2 right-2 w-5 h-5 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-color)] flex items-center justify-center opacity-40 sm:opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        >
          <Pencil class="w-3 h-3 text-[var(--text-secondary)]" />
        </button>
      )}
    </div>
  );
}
