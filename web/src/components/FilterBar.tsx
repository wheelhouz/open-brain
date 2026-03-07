interface FilterBarProps {
  type: string;
  topic: string;
  person: string;
  days: string;
  onTypeChange: (v: string) => void;
  onTopicChange: (v: string) => void;
  onPersonChange: (v: string) => void;
  onDaysChange: (v: string) => void;
  types?: string[];
  topics?: string[];
  people?: string[];
}

const THOUGHT_TYPES = [
  "observation", "task", "idea", "reference",
  "person_note", "decision", "meeting_note",
];

const DAY_OPTIONS = [
  { label: "All time", value: "" },
  { label: "Today", value: "1" },
  { label: "7 days", value: "7" },
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
];

export function FilterBar(props: FilterBarProps) {
  const selectClass =
    "text-xs px-2 py-1 rounded bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]";

  return (
    <div class="flex flex-wrap gap-2 mb-3">
      <select
        value={props.type}
        onChange={(e) => props.onTypeChange((e.target as HTMLSelectElement).value)}
        class={selectClass}
      >
        <option value="">All types</option>
        {THOUGHT_TYPES.map((t) => (
          <option key={t} value={t}>
            {t.replace(/_/g, " ")}
          </option>
        ))}
      </select>

      {props.topics && props.topics.length > 0 && (
        <select
          value={props.topic}
          onChange={(e) => props.onTopicChange((e.target as HTMLSelectElement).value)}
          class={selectClass}
        >
          <option value="">All topics</option>
          {props.topics.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      )}

      {props.people && props.people.length > 0 && (
        <select
          value={props.person}
          onChange={(e) => props.onPersonChange((e.target as HTMLSelectElement).value)}
          class={selectClass}
        >
          <option value="">All people</option>
          {props.people.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      )}

      <select
        value={props.days}
        onChange={(e) => props.onDaysChange((e.target as HTMLSelectElement).value)}
        class={selectClass}
      >
        {DAY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
