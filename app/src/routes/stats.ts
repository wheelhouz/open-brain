import { Hono } from "hono";
import { query } from "../db.js";

export const statsRouter = new Hono();

statsRouter.get("/", async (c) => {
  const [totalResult, typeResult, topicsResult, peopleResult, sourceResult, dailyResult] =
    await Promise.all([
      // Total count
      query<{ count: string }>(
        `SELECT count(*) FROM thoughts WHERE deleted_at IS NULL`,
      ),
      // Type breakdown
      query<{ type: string; count: string }>(
        `SELECT metadata->>'type' as type, count(*) as count
         FROM thoughts WHERE deleted_at IS NULL
         GROUP BY metadata->>'type'
         ORDER BY count DESC`,
      ),
      // Top 20 topics
      query<{ topic: string; count: string }>(
        `SELECT topic, count(*) as count
         FROM thoughts, jsonb_array_elements_text(metadata->'topics') as topic
         WHERE deleted_at IS NULL
         GROUP BY topic
         ORDER BY count DESC
         LIMIT 20`,
      ),
      // Top 20 people
      query<{ person: string; count: string }>(
        `SELECT person, count(*) as count
         FROM thoughts, jsonb_array_elements_text(metadata->'people') as person
         WHERE deleted_at IS NULL
         GROUP BY person
         ORDER BY count DESC
         LIMIT 20`,
      ),
      // Source breakdown
      query<{ source: string; count: string }>(
        `SELECT metadata->>'source_context' as source, count(*) as count
         FROM thoughts WHERE deleted_at IS NULL
         GROUP BY metadata->>'source_context'
         ORDER BY count DESC`,
      ),
      // Thoughts per day (last 30 days)
      query<{ date: string; count: string }>(
        `SELECT date_trunc('day', created_at)::date::text as date, count(*) as count
         FROM thoughts
         WHERE deleted_at IS NULL AND created_at > now() - interval '30 days'
         GROUP BY date_trunc('day', created_at)
         ORDER BY date DESC`,
      ),
    ]);

  return c.json({
    total: parseInt(totalResult.rows[0].count, 10),
    types: typeResult.rows.map((r) => ({ type: r.type, count: parseInt(r.count, 10) })),
    topics: topicsResult.rows.map((r) => ({ topic: r.topic, count: parseInt(r.count, 10) })),
    people: peopleResult.rows.map((r) => ({ person: r.person, count: parseInt(r.count, 10) })),
    sources: sourceResult.rows.map((r) => ({ source: r.source, count: parseInt(r.count, 10) })),
    daily: dailyResult.rows.map((r) => ({ date: r.date, count: parseInt(r.count, 10) })),
  });
});
