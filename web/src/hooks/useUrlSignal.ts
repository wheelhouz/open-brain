import { useEffect } from "preact/hooks";
import type { Signal } from "@preact/signals";

/**
 * Two-way sync between a signal and a URL query parameter.
 * On mount: reads the param and sets the signal (clears if absent).
 * On signal change: updates the URL param via replaceState.
 */
export function useUrlSignal(signal: Signal<string | null>, paramName: string) {
  // Mount: URL → signal
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    signal.value = params.get(paramName);
  }, []);

  // Signal → URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (signal.value) {
      params.set(paramName, signal.value);
    } else {
      params.delete(paramName);
    }
    const qs = params.toString();
    const path = window.location.pathname;
    history.replaceState(null, "", `${path}${qs ? `?${qs}` : ""}`);
  }, [signal.value]);
}
