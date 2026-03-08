import { useRef } from "preact/hooks";
import { route } from "preact-router";
import { Search, X, ArrowUp } from "lucide-preact";
import { searchQuery } from "../state";

export function SearchBar() {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleInput = (e: Event) => {
    const q = (e.target as HTMLInputElement).value;
    searchQuery.value = q;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const path = window.location.pathname;
      if (path === "/search") {
        const url = q.trim() ? `/search?q=${encodeURIComponent(q)}` : "/search";
        window.history.replaceState(null, "", url);
      } else if (q.trim()) {
        route(`/search?q=${encodeURIComponent(q)}`);
      }
    }, 300);
  };

  const handleSubmit = () => {
    if (searchQuery.value.trim()) {
      clearTimeout(timerRef.current);
      route(`/search?q=${encodeURIComponent(searchQuery.value)}`);
    }
  };

  const clearQuery = () => {
    searchQuery.value = "";
    if (window.location.pathname === "/search") {
      window.history.replaceState(null, "", "/search");
    }
    document.getElementById("search-input")?.focus();
  };

  const hasQuery = searchQuery.value.trim().length > 0;

  return (
    <div class="w-full max-w-56 sm:max-w-sm">
      <div class="search-composer-box" style="padding: 0.25rem 0.25rem 0.25rem 0.75rem;">
        <Search class="search-composer-icon" />
        <input
          type="text"
          value={searchQuery.value}
          onInput={handleInput}
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
          placeholder="Search thoughts..."
          class="search-composer-input"
          id="search-input"
          style="padding: 0.25rem 0;"
        />
        {hasQuery && (
          <button
            type="button"
            onClick={clearQuery}
            class="search-composer-clear"
            aria-label="Clear search"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          class={`search-composer-submit ${hasQuery ? "search-composer-submit-active" : ""}`}
          disabled={!hasQuery}
          aria-label="Search"
        >
          <ArrowUp class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
