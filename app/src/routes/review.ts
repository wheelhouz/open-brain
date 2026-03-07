import { Hono } from "hono";
import { query } from "../db.js";
import { chatCompletion } from "../openrouter.js";

export const reviewRouter = new Hono();

reviewRouter.get("/", async (c) => {
  const days = parseInt(c.req.query("days") || "7", 10);

  // Get all thoughts from the period
  const result = await query<{
    id: string;
    content: string;
    metadata: {
      type?: string;
      topics?: string[];
      people?: string[];
      action_items?: string[];
    };
    created_at: string;
  }>(
    `SELECT id, content, metadata, created_at
     FROM thoughts
     WHERE deleted_at IS NULL AND created_at > now() - interval '1 day' * $1
     ORDER BY created_at DESC`,
    [days],
  );

  if (result.rows.length === 0) {
    return c.json({
      period: { days },
      total_thoughts: 0,
      themes: [],
      open_action_items: [],
      top_people: [],
      connections: [],
      suggested_focus: [],
    });
  }

  // Collect action items
  const actionItems: Array<{ item: string; from_thought: string; created_at: string }> = [];
  const peopleCounts: Record<string, number> = {};
  const topicCounts: Record<string, number> = {};

  for (const t of result.rows) {
    const meta = t.metadata;
    if (meta.action_items) {
      for (const item of meta.action_items) {
        actionItems.push({ item, from_thought: t.id, created_at: t.created_at });
      }
    }
    if (meta.people) {
      for (const p of meta.people) {
        peopleCounts[p] = (peopleCounts[p] || 0) + 1;
      }
    }
    if (meta.topics) {
      for (const tp of meta.topics) {
        topicCounts[tp] = (topicCounts[tp] || 0) + 1;
      }
    }
  }

  // Group thoughts by topic for theme summaries
  const topicGroups: Record<string, string[]> = {};
  for (const t of result.rows) {
    const topics = t.metadata.topics || [];
    for (const tp of topics) {
      if (!topicGroups[tp]) topicGroups[tp] = [];
      topicGroups[tp].push(t.content);
    }
  }

  // Generate theme summaries via LLM
  const themes = await Promise.all(
    Object.entries(topicCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(async ([topic, count]) => {
        const thoughts = topicGroups[topic]?.slice(0, 5) || [];
        const summary = await chatCompletion(
          "Summarize the following thoughts about this topic in 1-2 sentences. Be concise.",
          `Topic: ${topic}\n\nThoughts:\n${thoughts.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
        ).catch(() => "");
        return { topic, count, summary };
      }),
  );

  const topPeople = Object.entries(peopleCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([name, mentions]) => ({ name, mentions }));

  // Generate suggested focus areas
  const focusPrompt = `Based on these action items and themes, suggest 2-3 focus areas for the coming week. Be concise, one line each.

Action items: ${actionItems.map((a) => a.item).join("; ")}
Top themes: ${themes.map((t) => `${t.topic} (${t.count})`).join(", ")}
Top people: ${topPeople.map((p) => `${p.name} (${p.mentions})`).join(", ")}`;

  const focusText = await chatCompletion(
    "You suggest concise weekly focus areas based on captured thoughts.",
    focusPrompt,
  ).catch(() => "");

  const suggestedFocus = focusText
    .split("\n")
    .map((l) => l.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);

  return c.json({
    period: { days },
    total_thoughts: result.rows.length,
    themes,
    open_action_items: actionItems.map((a) => ({
      item: a.item,
      from_thought: a.from_thought,
      age_days: Math.floor(
        (Date.now() - new Date(a.created_at).getTime()) / (1000 * 60 * 60 * 24),
      ),
    })),
    top_people: topPeople,
    suggested_focus: suggestedFocus,
  });
});
