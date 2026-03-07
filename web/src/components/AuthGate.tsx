import { useState } from "preact/hooks";
import { isAuthenticated } from "../state";
import { api, setKey } from "../api";
import { Brain } from "lucide-preact";

export function AuthGate({ children }: { children: preact.ComponentChildren }) {
  if (isAuthenticated.value) return <>{children}</>;

  return <LoginScreen />;
}

function LoginScreen() {
  const [key, setKeyInput] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!key.trim()) return;

    setLoading(true);
    setError("");
    setKey(key.trim());

    try {
      await api.validate();
      isAuthenticated.value = true;
    } catch {
      setError("Invalid access key");
      setKey("");
      localStorage.removeItem("brain_access_key");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
      <form
        onSubmit={submit}
        class="w-full max-w-sm p-8 rounded-xl bg-[var(--surface)] border border-[var(--border-color)]"
      >
        <div class="flex items-center justify-center gap-3 mb-6">
          <Brain class="w-8 h-8 text-[var(--accent)]" />
          <h1 class="text-xl font-semibold text-[var(--text-primary)]">
            Open Brain
          </h1>
        </div>

        <label class="block text-sm text-[var(--text-secondary)] mb-2">
          Access Key
        </label>
        <input
          type="password"
          value={key}
          onInput={(e) => setKeyInput((e.target as HTMLInputElement).value)}
          placeholder="Enter your access key"
          class="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
          autofocus
        />

        {error && (
          <p class="text-red-400 text-sm mt-2">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading || !key.trim()}
          class="w-full mt-4 px-4 py-2 rounded-lg bg-[var(--accent)] text-white font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          {loading ? "Validating..." : "Continue"}
        </button>
      </form>
    </div>
  );
}
