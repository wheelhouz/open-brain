import { useState, useRef, useEffect, useCallback } from "preact/hooks";
import type { RoutableProps } from "../lib/route";
import { api, type ChatMessage, type SourceThought, type SourceLoop, type Thought } from "../api";
import { selectedThoughtId, selectedLoopId, showToast } from "../state";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { DetailPanel } from "../components/DetailPanel";
import { ThoughtCard } from "../components/ThoughtCard";
import { Send, Brain, Sparkles, Bookmark, BookmarkCheck, CircleDot } from "lucide-preact";

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  sources?: SourceThought[];
  loops?: SourceLoop[];
  thoughtContext?: Thought;
}

const SUGGESTIONS = [
  "What have I been thinking about lately?",
  "Summarize my recent decisions",
  "What action items do I have?",
  "Find connections between my ideas",
];

function TypingDots() {
  return (
    <span class="chat-typing-dots">
      <span />
      <span />
      <span />
    </span>
  );
}

function SourceChips({ sources }: { sources: SourceThought[] }) {
  return (
    <div class="chat-sources">
      <span class="chat-sources-label">
        <Sparkles class="w-3 h-3" />
        {sources.length} source{sources.length !== 1 ? "s" : ""}
      </span>
      <div class="chat-sources-scroll">
        {sources.map((src) => (
          <button
            key={src.id}
            onClick={() => { selectedThoughtId.value = src.id; }}
            class="chat-source-chip"
          >
            <span class="chat-source-text">{src.content}</span>
            <span class="chat-source-pct">{(src.similarity * 100).toFixed(0)}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const loopTypeLabels: Record<string, string> = {
  task: "Task",
  question: "Question",
  decision: "Decision",
  waiting_on: "Waiting on",
};

function LoopChips({ loops }: { loops: SourceLoop[] }) {
  return (
    <div class="chat-sources">
      <span class="chat-sources-label">
        <CircleDot class="w-3 h-3" />
        {loops.length} loop{loops.length !== 1 ? "s" : ""}
      </span>
      <div class="chat-sources-scroll">
        {loops.map((loop) => (
          <button
            key={loop.id}
            onClick={() => { selectedLoopId.value = loop.id; }}
            class="chat-loop-chip"
          >
            <span class="chat-source-text">{loop.content}</span>
            <span class="chat-loop-type">{loopTypeLabels[loop.loop_type] || loop.loop_type}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChatView(_props: RoutableProps) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [savedIndices, setSavedIndices] = useState<Set<number>>(new Set());
  const [entityId] = useState<string | undefined>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("entity_id") || undefined;
  });
  const [entityName, setEntityName] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const shouldAutoScroll = useRef(true);
  const autoSentRef = useRef(false);

  // Load entity name for display
  useEffect(() => {
    if (!entityId) return;
    api.entity(entityId).then((e) => setEntityName(e.canonical_name)).catch(() => {});
  }, [entityId]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Track whether user is near bottom to decide auto-scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 80;
    shouldAutoScroll.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Auto-scroll only when near bottom
  useEffect(() => {
    if (shouldAutoScroll.current) scrollToBottom();
  }, [entries]);

  // Auto-resize textarea
  const handleInput = (e: Event) => {
    const ta = e.target as HTMLTextAreaElement;
    setInput(ta.value);
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  };

  const send = async (text?: string, thoughtContext?: Thought) => {
    const msg = (text || input).trim();
    if (!msg || streaming) return;

    const userEntry: ChatEntry = { role: "user", content: msg, thoughtContext };
    const assistantEntry: ChatEntry = { role: "assistant", content: "" };

    shouldAutoScroll.current = true;
    setEntries((prev) => [...prev, userEntry, assistantEntry]);
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setStreaming(true);

    const messages: ChatMessage[] = [
      ...entries.map((e) => ({ role: e.role, content: e.content })),
      { role: "user" as const, content: msg },
    ];

    try {
      await api.chat(
        messages,
        (chunk) => {
          setEntries((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            updated[updated.length - 1] = { ...last, content: last.content + chunk };
            return updated;
          });
        },
        (sources, loops) => {
          setEntries((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            updated[updated.length - 1] = { ...last, sources, loops };
            return updated;
          });
        },
        entityId,
      );
    } catch {
      setEntries((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        updated[updated.length - 1] = {
          ...last,
          content: last.content || "Failed to get a response. Please try again.",
        };
        return updated;
      });
    } finally {
      setStreaming(false);
      inputRef.current?.focus();
    }
  };

  // Auto-send when navigated from Discuss with thoughtId
  useEffect(() => {
    if (autoSentRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const thoughtId = params.get("thoughtId");
    if (!thoughtId) return;
    autoSentRef.current = true;

    api.thought(thoughtId).then((t) => {
      const prompt = `Let's discuss this thought:\n\n${t.content}`;
      send(prompt, t);
      // Clean up URL without reloading
      window.history.replaceState({}, "", "/chat");
    });
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Find the parent thought from the first thoughtContext entry (if Discuss flow)
  const parentThought = entries.find((e) => e.thoughtContext)?.thoughtContext;

  const saveToThread = async (index: number, content: string) => {
    if (!parentThought || savedIndices.has(index)) return;
    try {
      await api.capture(content, "ai_save", parentThought.id);
      setSavedIndices((prev) => new Set(prev).add(index));
      showToast("Saved to thread");
    } catch {
      showToast("Failed to save", "error");
    }
  };

  const hasMessages = entries.length > 0;
  const canSend = input.trim().length > 0 && !streaming;

  return (
    <div class="chat-view">
      {/* Messages area */}
      <div ref={scrollRef} onScroll={handleScroll} class="chat-messages">
        {!hasMessages && (
          <div class="chat-welcome">
            <div class="chat-welcome-icon">
              <Brain class="w-7 h-7" />
            </div>
            <h2 class="chat-welcome-title">
              {entityName ? `Chat about ${entityName}` : "Chat with your brain"}
            </h2>
            <p class="chat-welcome-hint">
              {entityName
                ? `Ask questions about ${entityName} — answers are grounded in facts and evidence`
                : "Ask questions about your stored thoughts"}
            </p>
            <div class="chat-suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  class="chat-suggestion"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((entry, i) => (
          <div
            key={i}
            class={`chat-msg chat-msg-${entry.role}`}
          >
            {entry.role === "user" ? (
              entry.thoughtContext ? (
                <div class="ml-auto max-w-md w-full">
                  <p class="text-xs text-[var(--text-muted)] mb-1.5">Discussing</p>
                  <ThoughtCard
                    thought={entry.thoughtContext}
                    onClick={() => { selectedThoughtId.value = entry.thoughtContext!.id; }}
                  />
                </div>
              ) : (
                <div class="chat-bubble-user">
                  <p>{entry.content}</p>
                </div>
              )
            ) : (
              <div class="chat-bubble-assistant">
                {entry.content ? (
                  <MarkdownRenderer content={entry.content} />
                ) : (
                  <TypingDots />
                )}
                {entry.sources && entry.sources.length > 0 && (
                  <SourceChips sources={entry.sources} />
                )}
                {entry.loops && entry.loops.length > 0 && (
                  <LoopChips loops={entry.loops} />
                )}
                {parentThought && entry.content && !streaming && (
                  <div class="flex justify-end mt-1.5">
                    <button
                      onClick={() => saveToThread(i, entry.content)}
                      disabled={savedIndices.has(i)}
                      class={`flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors ${
                        savedIndices.has(i)
                          ? "text-[var(--accent)] opacity-60 cursor-default"
                          : "text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/10"
                      }`}
                      title={savedIndices.has(i) ? "Saved to thread" : "Save to thread"}
                    >
                      {savedIndices.has(i) ? (
                        <BookmarkCheck class="w-3.5 h-3.5" />
                      ) : (
                        <Bookmark class="w-3.5 h-3.5" />
                      )}
                      {savedIndices.has(i) ? "Saved" : "Save"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

      </div>

      {/* Composer */}
      <div class="chat-composer">
        <div class="chat-composer-inner">
          <textarea
            ref={inputRef}
            value={input}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your thoughts..."
            rows={1}
            class="chat-input"
            disabled={streaming}
          />
          <div class="chat-composer-actions">
            <button
              onClick={() => send()}
              disabled={!canSend}
              class={`chat-send ${canSend ? "chat-send-active" : ""}`}
              aria-label="Send message"
            >
              <Send class="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <DetailPanel />
    </div>
  );
}
