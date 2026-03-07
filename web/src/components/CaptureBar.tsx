import { useState, useRef, useEffect } from "preact/hooks";
import { api } from "../api";
import { showToast, lastCapturedThought } from "../state";
import { Send, Plus } from "lucide-preact";
import { BottomSheet } from "./BottomSheet";

interface CaptureBarProps {
  mobile?: boolean;
}

function useScrollDirection() {
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  const lastY = useRef(0);

  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        if (Math.abs(y - lastY.current) > 8) {
          setDir(y > lastY.current ? "down" : "up");
          lastY.current = y;
        }
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return dir;
}

export function CaptureBar({ mobile }: CaptureBarProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollDir = useScrollDirection();

  const submit = async () => {
    const text = content.trim();
    if (!text || loading) return;

    setLoading(true);
    try {
      const result = await api.capture(text);
      // Emit the new thought so StreamView can prepend it
      lastCapturedThought.value = {
        id: result.id,
        content: text,
        metadata: result.metadata,
        created_at: result.created_at,
      };
      setContent("");
      setExpanded(false);
      setSheetOpen(false);
      showToast(
        `Captured as ${result.metadata.type || "thought"}`,
        "success",
      );
    } catch (err) {
      showToast("Failed to capture thought", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

  // Auto-focus textarea when sheet opens
  useEffect(() => {
    if (sheetOpen && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 150);
    }
  }, [sheetOpen]);

  // Mobile: FAB + bottom sheet
  if (mobile) {
    const fabDimmed = scrollDir === "down";

    return (
      <>
        {/* FAB */}
        {!sheetOpen && (
          <button
            onClick={() => setSheetOpen(true)}
            class="capture-fab"
            style={{
              opacity: fabDimmed ? 0.45 : 1,
              transform: fabDimmed ? "scale(0.92)" : "scale(1)",
            }}
            aria-label="Capture thought"
          >
            <Plus class="w-6 h-6" />
          </button>
        )}

        {/* Bottom sheet */}
        {sheetOpen && (
          <BottomSheet onClose={() => setSheetOpen(false)} size="half" blur={false}>
            <div class="px-4 pt-1 pb-4">
              {/* Header */}
              <div class="mb-4">
                <span class="text-sm font-medium text-[var(--text-primary)]">
                  Capture a thought
                </span>
              </div>

              {/* Input */}
              <textarea
                ref={textareaRef}
                value={content}
                onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
                onKeyDown={handleKeyDown}
                placeholder="What's on your mind?"
                rows={6}
                class="w-full px-3 py-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-none text-base"
              />

              {/* Submit */}
              <button
                onClick={submit}
                disabled={loading || !content.trim()}
                class="w-full mt-3 py-3 rounded-xl bg-[var(--accent)] text-white font-medium text-sm hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors flex items-center justify-center gap-2"
              >
                <Send class="w-4 h-4" />
                {loading ? "Saving..." : "Capture"}
              </button>
            </div>
          </BottomSheet>
        )}
      </>
    );
  }

  // Desktop: inline sticky bar
  return (
    <div class="sticky bottom-0 z-30 bg-[var(--bg-secondary)] border-t border-[var(--border-color)]">
      <div class="max-w-6xl mx-auto px-4 py-2 flex gap-2 items-end">
        <textarea
          value={content}
          onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
          onFocus={() => setExpanded(true)}
          onKeyDown={handleKeyDown}
          placeholder="Capture a thought... (Ctrl+Enter to save)"
          rows={expanded ? Math.min(content.split("\n").length + 1, 6) : 1}
          class="flex-1 px-3 py-2 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-none transition-all text-sm"
          id="capture-input"
        />
        <button
          onClick={submit}
          disabled={loading || !content.trim()}
          class="p-2 rounded-lg bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors flex-shrink-0"
          title="Capture (Ctrl+Enter)"
        >
          <Send class="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
