import { useState, useEffect, useRef } from "preact/hooks";
import { api, type TopicEntry } from "../api";
import { showToast } from "../state";
import { X, Plus } from "lucide-preact";
import { route } from "preact-router";
import { selectedThoughtId } from "../state";

interface Props {
  thoughtId: string;
  topics: string[];
  onUpdate: (topics: string[]) => void;
}

let cachedTopics: string[] | null = null;

export function TopicEditor({ thoughtId, topics, onUpdate }: Props) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [allTopics, setAllTopics] = useState<string[]>(cachedTopics || []);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch all topics lazily on first edit
  useEffect(() => {
    if (editing && !cachedTopics) {
      api.topics().then((res) => {
        cachedTopics = res.topics.map((t: TopicEntry) => t.topic);
        setAllTopics(cachedTopics!);
      });
    }
  }, [editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Reset highlight when input changes
  useEffect(() => {
    setHighlightIdx(0);
  }, [input]);

  const suggestions = input.trim()
    ? allTopics
        .filter(
          (t) =>
            t.toLowerCase().includes(input.trim().toLowerCase()) &&
            !topics.includes(t),
        )
        .slice(0, 8)
    : [];

  const exactMatch = allTopics.some(
    (t) => t.toLowerCase() === input.trim().toLowerCase(),
  );
  const showCreate = input.trim() && !exactMatch && !topics.includes(input.trim());

  const totalItems = suggestions.length + (showCreate ? 1 : 0);

  const addTopic = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || topics.includes(trimmed)) return;

    // Optimistic update
    const prev = [...topics];
    onUpdate([...topics, trimmed].sort());
    setInput("");
    setEditing(false);

    try {
      const res = await api.updateTopics(thoughtId, [trimmed]);
      onUpdate(res.topics);
      // Update cache
      if (cachedTopics && !cachedTopics.includes(trimmed)) {
        cachedTopics = [...cachedTopics, trimmed].sort();
        setAllTopics(cachedTopics);
      }
    } catch {
      onUpdate(prev);
      showToast("Failed to add topic", "error");
    }
  };

  const removeTopic = async (name: string) => {
    const prev = [...topics];
    onUpdate(topics.filter((t) => t !== name));

    try {
      const res = await api.updateTopics(thoughtId, undefined, [name]);
      onUpdate(res.topics);
    } catch {
      onUpdate(prev);
      showToast("Failed to remove topic", "error");
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setEditing(false);
      setInput("");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, totalItems - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (totalItems === 0 && input.trim()) {
        addTopic(input.trim());
      } else if (highlightIdx < suggestions.length) {
        addTopic(suggestions[highlightIdx]);
      } else if (showCreate) {
        addTopic(input.trim());
      }
    }
  };

  // Close on outside click
  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setEditing(false);
        setInput("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editing]);

  return (
    <div class="flex flex-wrap gap-1.5 mb-3">
      {topics.map((t) => (
        <span
          key={t}
          class="group text-xs px-2.5 py-1 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] flex items-center gap-1"
        >
          <span
            class="cursor-pointer hover:bg-[var(--surface-hover)] active:scale-95 transition-all"
            onClick={() => {
              selectedThoughtId.value = null;
              route("/topics?selected=" + encodeURIComponent(t));
            }}
          >
            {t}
          </span>
          <button
            onClick={() => removeTopic(t)}
            class="relative inline-flex items-center justify-center w-[18px] h-[18px] rounded text-[var(--text-muted)] hover:text-red-400 transition-colors -mr-1 before:absolute before:inset-[-12px] before:content-[''] sm:before:inset-[-4px]"
            title={`Remove ${t}`}
          >
            <X class="w-3 h-3" />
          </button>
        </span>
      ))}

      {editing ? (
        <div class="relative">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onInput={(e) => setInput((e.target as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
            class="text-xs px-2.5 py-1 rounded-md bg-[var(--bg-secondary)] border border-[var(--accent)] text-[var(--text-primary)] outline-none w-32"
            placeholder="Type topic..."
          />
          {totalItems > 0 && (
            <div
              ref={dropdownRef}
              class="absolute left-0 mt-1 w-48 max-h-40 overflow-y-auto rounded-md bg-[var(--bg-secondary)] border border-[var(--border-color)] shadow-lg z-50"
            >
              {suggestions.map((s, i) => (
                <button
                  key={s}
                  class={`w-full text-left text-xs px-3 py-1.5 transition-colors ${
                    i === highlightIdx
                      ? "bg-[var(--surface-hover)]"
                      : "hover:bg-[var(--surface-hover)]"
                  } text-[var(--text-secondary)]`}
                  onMouseEnter={() => setHighlightIdx(i)}
                  onClick={() => addTopic(s)}
                >
                  {s}
                </button>
              ))}
              {showCreate && (
                <button
                  class={`w-full text-left text-xs px-3 py-1.5 transition-colors ${
                    highlightIdx === suggestions.length
                      ? "bg-[var(--surface-hover)]"
                      : "hover:bg-[var(--surface-hover)]"
                  } text-[var(--accent)]`}
                  onMouseEnter={() => setHighlightIdx(suggestions.length)}
                  onClick={() => addTopic(input.trim())}
                >
                  Create &ldquo;{input.trim()}&rdquo;
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={() => setEditing(true)}
          class="text-xs px-2.5 py-1 rounded-md border border-dashed border-[var(--text-muted)]/40 text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors flex items-center gap-1"
        >
          <Plus class="w-3 h-3" />
          Add
        </button>
      )}
    </div>
  );
}
