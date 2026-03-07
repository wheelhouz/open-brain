import { route } from "preact-router";
import type { Thought } from "../api";
import { plainTextPreview } from "../lib/markdown";
import { typeColor, typeLabel, relativeTime } from "../lib/format";
import { SimilarityBar } from "./SimilarityBar";
import {
  Eye, CheckSquare, Lightbulb, BookOpen, User, Scale, Users, MessageCircle,
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
  selected?: boolean;
  similarity?: number;
}

export function ThoughtCard({
  thought,
  onClick,
  selected,
  similarity,
}: ThoughtCardProps) {
  const type = thought.metadata?.type;
  const Icon = TYPE_ICONS[type || ""] || Eye;
  const topics = thought.metadata?.topics || [];
  const people = thought.metadata?.people || [];
  const actionItems = thought.metadata?.action_items || [];
  const preview = plainTextPreview(thought.content);

  return (
    <button
      onClick={onClick}
      class={`w-full text-left p-3 rounded-lg border transition-colors cursor-pointer ${
        selected
          ? "bg-[var(--accent)]/10 border-[var(--accent)]"
          : "bg-[var(--surface)] border-[var(--border-color)] hover:bg-[var(--surface-hover)]"
      }`}
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
          {/* Header */}
          <div class="flex items-center justify-between gap-2 mb-1">
            <span
              class="text-xs font-medium capitalize"
              style={{ color: typeColor(type) }}
            >
              {typeLabel(type)}
            </span>
            <span class="text-xs text-[var(--text-muted)] flex-shrink-0">
              {relativeTime(thought.created_at)}
            </span>
          </div>

          {/* Preview */}
          <p class="text-sm text-[var(--text-primary)] line-clamp-3 whitespace-pre-line">
            {preview}
          </p>

          {/* Chips + badges */}
          <div class="flex items-center flex-wrap gap-1 mt-2">
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
                  route("/people?selected=" + encodeURIComponent(p));
                }}
              >
                {p}
              </span>
            ))}
            {actionItems.length > 0 && (
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--type-task)]/20 text-[var(--type-task)]">
                {actionItems.length} action{actionItems.length > 1 ? "s" : ""}
              </span>
            )}
            {!!thought.thread_count && thought.thread_count > 0 && (
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)]">
                <MessageCircle class="w-2.5 h-2.5 inline mr-0.5" />
                {thought.thread_count}
              </span>
            )}
          </div>

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
