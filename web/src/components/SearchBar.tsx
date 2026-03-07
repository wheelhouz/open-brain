import { useRef, useEffect } from "preact/hooks";
import { route } from "preact-router";
import { Search } from "lucide-preact";

interface SearchBarProps {
  value?: string;
  onSearch?: (query: string) => void;
  inline?: boolean;
}

export function SearchBar({ value = "", onSearch, inline }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !e.ctrlKey &&
        !e.metaKey &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA"
      ) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleInput = (e: Event) => {
    const q = (e.target as HTMLInputElement).value;
    clearTimeout(timerRef.current);

    if (onSearch) {
      timerRef.current = setTimeout(() => onSearch(q), 300);
    } else {
      timerRef.current = setTimeout(() => {
        if (q.trim()) {
          route(`/search?q=${encodeURIComponent(q)}`);
        }
      }, 300);
    }
  };

  return (
    <div class={`relative ${inline ? "" : "w-full max-w-md"}`}>
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
      <input
        ref={inputRef}
        type="text"
        defaultValue={value}
        onInput={handleInput}
        placeholder='Search thoughts... (press "/")'
        class="w-full pl-9 pr-3 py-1.5 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
        id="search-input"
      />
    </div>
  );
}
