import { theme, applyTheme } from "../state";
import { Sun, Moon } from "lucide-preact";

export function ThemeToggle() {
  const toggle = () => {
    applyTheme(theme.value === "dark" ? "light" : "dark");
  };

  return (
    <button
      onClick={toggle}
      class="p-2 rounded-lg hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] transition-colors"
      title={`Switch to ${theme.value === "dark" ? "light" : "dark"} mode`}
    >
      {theme.value === "dark" ? <Sun class="w-4 h-4" /> : <Moon class="w-4 h-4" />}
    </button>
  );
}
