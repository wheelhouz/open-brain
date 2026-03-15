import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import type { RoutableProps } from "../lib/route";
import { api, type Thought } from "../api";
import { selectedThoughtId, lastDeletedId, lastCapturedThought, showToast } from "../state";
import { useUrlSignal } from "../hooks/useUrlSignal";
import { ThoughtCard } from "../components/ThoughtCard";
import { SwipeableCard } from "../components/SwipeableCard";
import { FilterBar } from "../components/FilterBar";
import { DetailPanel } from "../components/DetailPanel";
import { formatDate, groupByDate } from "../lib/format";

export function StreamView(_props: RoutableProps) {
  useUrlSignal(selectedThoughtId, "thought");

  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Filters
  const [type, setType] = useState("");
  const [topic, setTopic] = useState("");
  const [person, setPerson] = useState("");
  const [days, setDays] = useState("");

  // Available filter options
  const [topicOptions, setTopicOptions] = useState<string[]>([]);
  const [peopleOptions, setPeopleOptions] = useState<string[]>([]);

  const loadThoughts = useCallback(
    async (reset = false) => {
      if (!reset && loadingMoreRef.current) return;
      const isMore = !reset && cursor;
      if (isMore) {
        loadingMoreRef.current = true;
        setLoadingMore(true);
      } else setLoading(true);

      try {
        const res = await api.thoughts({
          type: type || undefined,
          topic: topic || undefined,
          person: person || undefined,
          days: days || undefined,
          cursor: isMore ? cursor! : undefined,
          limit: 20,
        });

        if (reset || !isMore) {
          setThoughts(res.thoughts);
        } else {
          setThoughts((prev) => [...prev, ...res.thoughts]);
        }
        setCursor(res.next_cursor);
        setHasMore(!!res.next_cursor);
      } catch {
        // Error handled silently
      } finally {
        setLoading(false);
        setLoadingMore(false);
        loadingMoreRef.current = false;
      }
    },
    [type, topic, person, days, cursor],
  );

  // Load filter options
  useEffect(() => {
    api.topics().then((r) => setTopicOptions(r.topics.map((t) => t.topic))).catch(() => {});
    api.people().then((r) => setPeopleOptions(r.people.map((p) => p.person))).catch(() => {});
  }, []);

  // Load thoughts on filter change
  useEffect(() => {
    setCursor(null);
    setHasMore(false);
    setThoughts([]);
    setLoading(true);

    // Need fresh load with no cursor
    api
      .thoughts({
        type: type || undefined,
        topic: topic || undefined,
        person: person || undefined,
        days: days || undefined,
        limit: 20,
      })
      .then((res) => {
        setThoughts(res.thoughts);
        setCursor(res.next_cursor);
        setHasMore(!!res.next_cursor);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [type, topic, person, days]);

  // Track newly inserted IDs for entrance animation
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  // Prepend newly captured thought
  useEffect(() => {
    const captured = lastCapturedThought.value;
    if (!captured) return;

    const newThought: Thought = {
      id: captured.id,
      content: captured.content,
      metadata: captured.metadata,
      created_at: captured.created_at,
      updated_at: captured.created_at,
    };

    setThoughts((prev) => {
      // Avoid duplicates
      if (prev.some((t) => t.id === newThought.id)) return prev;
      return [newThought, ...prev];
    });

    setNewIds((prev) => new Set(prev).add(captured.id));
    // Clear animation class after it plays
    setTimeout(() => {
      setNewIds((prev) => {
        const next = new Set(prev);
        next.delete(captured.id);
        return next;
      });
    }, 600);

    lastCapturedThought.value = null;
  }, [lastCapturedThought.value]);

  // Remove thought when deleted from DetailPanel
  useEffect(() => {
    const id = lastDeletedId.value;
    if (id) {
      setThoughts((prev) => prev.filter((t) => t.id !== id));
      lastDeletedId.value = null;
    }
  }, [lastDeletedId.value]);

  const handleSwipeDelete = useCallback(
    async (id: string) => {
      await api.deleteThought(id);
      showToast("Thought deleted", "success");
      setThoughts((prev) => prev.filter((t) => t.id !== id));
    },
    [],
  );

  // Mobile infinite scroll via IntersectionObserver
  const loadingMoreRef = useRef(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadThoughtsRef = useRef(loadThoughts);
  loadThoughtsRef.current = loadThoughts;

  // Callback ref: fires when sentinel mounts/unmounts, avoiding timing issues
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (node) {
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            loadThoughtsRef.current(false);
          }
        },
        { rootMargin: "0px 0px 200px 0px" },
      );
      observer.observe(node);
      observerRef.current = observer;
    }
  }, []);

  const groups = groupByDate(thoughts);

  return (
    <div class="p-4">
      <FilterBar
        type={type}
        topic={topic}
        person={person}
        days={days}
        onTypeChange={(v) => setType(v)}
        onTopicChange={(v) => setTopic(v)}
        onPersonChange={(v) => setPerson(v)}
        onDaysChange={(v) => setDays(v)}
        topics={topicOptions}
        people={peopleOptions}
      />

      {loading ? (
        <p class="text-[var(--text-muted)] text-sm">Loading thoughts...</p>
      ) : thoughts.length === 0 ? (
        <div class="text-center py-12">
          <p class="text-[var(--text-muted)]">No thoughts yet</p>
          <p class="text-sm text-[var(--text-muted)] mt-1">
            Capture your first thought using the bar below
          </p>
        </div>
      ) : (
        <>
          {Array.from(groups.entries()).map(([dateKey, items]) => (
            <div key={dateKey} class="mb-6">
              <h3 class="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
                {formatDate(items[0].created_at)}
              </h3>
              <div class="space-y-3">
                {items.map((thought) => (
                  <div
                    key={thought.id}
                    class={newIds.has(thought.id) ? "thought-enter" : ""}
                  >
                    <SwipeableCard
                      onDelete={() => handleSwipeDelete(thought.id)}
                    >
                      <ThoughtCard
                        thought={thought}
                        selected={selectedThoughtId.value === thought.id}
                        onClick={() => {
                          selectedThoughtId.value = thought.id;
                        }}
                      />
                    </SwipeableCard>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {hasMore && (
            <div ref={sentinelRef} class="flex justify-center py-4">
              {loadingMore && (
                <div class="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
              )}
            </div>
          )}
        </>
      )}

      {/* Detail panel */}
      <DetailPanel />
    </div>
  );
}
