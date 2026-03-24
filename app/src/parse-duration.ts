/**
 * Parse a snooze date string — accepts ISO 8601 dates or relative durations.
 *
 * Supported formats:
 *   - ISO 8601: "2026-03-21", "2026-03-21T10:00:00Z"
 *   - Relative:  "3d" (days), "2w" (weeks), "1m" (months)
 *
 * Returns an ISO date string (YYYY-MM-DD).
 * Throws on invalid input.
 */
export function parseSnoozeDate(input: string): string {
  // ISO 8601 passthrough
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(input)) {
    if (isNaN(Date.parse(input))) {
      throw new Error(`Invalid date: "${input}"`);
    }
    return input.slice(0, 10);
  }

  // Relative duration: Nd, Nw, Nm
  const match = input.match(/^(\d+)(d|w|m)$/i);
  if (!match) {
    throw new Error(
      `Invalid snooze date: "${input}". Expected ISO date (2026-03-21) or relative duration (3d, 2w, 1m).`,
    );
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const date = new Date();

  switch (unit) {
    case "d":
      date.setDate(date.getDate() + amount);
      break;
    case "w":
      date.setDate(date.getDate() + amount * 7);
      break;
    case "m":
      date.setMonth(date.getMonth() + amount);
      break;
  }

  return date.toISOString().slice(0, 10);
}
