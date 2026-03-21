import { route } from "preact-router";
import type { Thought } from "../api";
import { selectedEntityName } from "../state";
import { extractHeadline, plainTextPreview } from "../lib/markdown";
import { typeColor, typeLabel, relativeTime } from "../lib/format";
import { SimilarityBar } from "./SimilarityBar";
import {
  Eye, CheckSquare, Lightbulb, BookOpen, User, Scale, Users, MessageCircle, Unlink,
  type LucideIcon,
} from "lucide-preact";

const TYPE_ICONS: Record<string, LucideIcon> = {
  observation: Eye,
  task: CheckSquare,
  idea: Lightbulb,
  reference: BookOpen,
  person_note: User,
  decision: Scale,
  meeting_note: Users,
};

interface ThoughtCardProps {
  thought: Thought;
  onClick?: () => void;
  onRemove?: () => void;
  selected?: boolean;
  similarity?: number;
  badge?: string;
}

export function ThoughtCard({
  thought,
  onClick,
  onRemove,
  selected,
  similarity,
  badge,
}: ThoughtCardProps) {
  const type = thought.metadata?.type;
  const Icon = TYPE_ICONS[type || ""] || Eye;
  const topics = thought.metadata?.topics || [];
  const people = thought.metadata?.people || [];
  const loopCount = thought.loop_count || 0;

  const extracted = extractHeadline(thought.content);
  const hasHeadline = !!extracted;
  const headline = extracted?.headline;
  const bodyPreview = extracted ? extracted.body : plainTextPreview(thought.content, 2);

  return (
    <button
      onClick={onClick}
      class={`thought-card w-full text-left p-3 rounded-lg border-r border-y transition-colors cursor-pointer ${
        selected
          ? "bg-[var(--accent)]/10 border-[var(--accent)] border-l-[var(--accent)]"
          : "bg-[var(--surface)] border-[var(--border-color)] hover:bg-[var(--surface-hover)]"
      }`}
      style={!selected ? { borderLeftWidth: "2px", borderLeftStyle: "solid", borderLeftColor: typeColor(type) } : { borderLeftWidth: "2px", borderLeftStyle: "solid" }}
      data-thought-id={thought.id}
    >
      <div class="flex items-start gap-2">
        {/* Type icon */}
        <div
          class="mt-0.5 flex-shrink-0"
          style={{ color: typeColor(type) }}
        >
          <Icon class="w-4 h-4" />
        </div>

        <div class="flex-1 min-w-0">
          {/* Header: type label + actions badge + time */}
          <div class="flex items-center justify-between gap-2 mb-1">
            <div class="flex items-center gap-1.5">
              <span
                class="text-xs font-medium capitalize"
                style={{ color: typeColor(type) }}
              >
                {typeLabel(type)}
              </span>
              {badge && (
                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] font-medium">
                  {badge}
                </span>
              )}
              {loopCount > 0 && (
                <span class="text-[10px] text-[var(--text-muted)]">
                  {loopCount} loop{loopCount > 1 ? "s" : ""}
                </span>
              )}
              {!!thought.thread_count && thought.thread_count > 0 && (
                <span class="text-[10px] text-[var(--text-muted)] flex items-center gap-0.5">
                  <MessageCircle class="w-3 h-3" />
                  {thought.thread_count}
                </span>
              )}
            </div>
            <div class="flex items-center gap-1 flex-shrink-0">
              <span class="text-xs text-[var(--text-muted)]">
                {relativeTime(thought.created_at)}
              </span>
              {onRemove && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(); }}
                  class="p-0.5 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  title="Unlink"
                >
                  <Unlink class="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Headline — primary selection anchor */}
          {hasHeadline && (
            <p class="text-[15px] font-semibold text-[var(--text-primary)] line-clamp-1">
              {headline}
            </p>
          )}

          {/* Body preview — orient the click, not a reading surface */}
          {bodyPreview && (
            <p class="text-[13px] text-[var(--text-secondary)] line-clamp-3 whitespace-pre-line mt-0.5">
              {bodyPreview}
            </p>
          )}

          {/* Topic + people chips */}
          {(topics.length > 0 || people.length > 0) && (
            <div class="flex items-center flex-wrap gap-1 mt-1.5">
              {topics.slice(0, 3).map((t) => (
                <span
                  key={t}
                  class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] cursor-pointer hover:opacity-80"
                  onClick={(e) => {
                    e.stopPropagation();
                    route("/topics?selected=" + encodeURIComponent(t));
                  }}
                >
                  {t}
                </span>
              ))}
              {people.slice(0, 2).map((p) => (
                <span
                  key={p}
                  class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--type-person-note)]/20 text-[var(--type-person-note)] cursor-pointer hover:opacity-80"
                  onClick={(e) => {
                    e.stopPropagation();
                    selectedEntityName.value = p;
                  }}
                >
                  {p}
                </span>
              ))}
            </div>
          )}

          {/* Similarity */}
          {similarity !== undefined && (
            <div class="mt-2">
              <SimilarityBar similarity={similarity} />
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
