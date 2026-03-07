const TYPE_COLORS: Record<string, string> = {
  observation: "var(--type-observation)",
  task: "var(--type-task)",
  idea: "var(--type-idea)",
  reference: "var(--type-reference)",
  person_note: "var(--type-person-note)",
  decision: "var(--type-decision)",
  meeting_note: "var(--type-meeting-note)",
};

export function typeColor(type?: string): string {
  return TYPE_COLORS[type || ""] || "var(--text-muted)";
}

export function typeLabel(type?: string): string {
  if (!type) return "thought";
  return type.replace(/_/g, " ");
}

export function relativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diff = now - date;

  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  if (days < 30) return `${Math.floor(days / 7)}w ago`;

  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function groupByDate<T extends { created_at: string }>(
  items: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = new Date(item.created_at).toDateString();
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}
