import { signal } from "@preact/signals";

export const isAuthenticated = signal(!!localStorage.getItem("brain_access_key"));
export const selectedThoughtId = signal<string | null>(null);
export const lastDeletedId = signal<string | null>(null);
export const selectedLoopId = signal<string | null>(null);
export const lastCapturedThought = signal<{ id: string; content: string; metadata: any; created_at: string } | null>(null);
export const theme = signal<"dark" | "light">(
  (localStorage.getItem("theme") as "dark" | "light") || "dark",
);

// Apply theme to document
export function applyTheme(t: "dark" | "light") {
  theme.value = t;
  localStorage.setItem("theme", t);
  if (t === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

// Initialize theme on load
applyTheme(theme.value);

// Search state
export const searchQuery = signal("");

// Toast state
export interface Toast {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}

let toastId = 0;
export const toasts = signal<Toast[]>([]);

export function showToast(message: string, type: Toast["type"] = "info") {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, message, type }];
}
