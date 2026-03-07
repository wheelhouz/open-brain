import { Hono } from "hono";
import { query } from "../db.js";

export const peopleRouter = new Hono();

peopleRouter.patch("/:name", async (c) => {
  const oldName = c.req.param("name").trim();
  const body = await c.req.json<{ name?: string }>();
  const newName = (body.name || "").trim();

  if (!oldName || !newName) return c.json({ error: "Both old and new name are required" }, 400);
  if (oldName === newName) return c.json({ error: "Names are the same" }, 400);

  const result = await query(
    `UPDATE thoughts
     SET metadata = jsonb_set(
       metadata, '{people}',
       (SELECT jsonb_agg(DISTINCT val ORDER BY val)
        FROM jsonb_array_elements_text(
          (metadata->'people') - $1 || jsonb_build_array($2::text)
        ) AS val)
     ), updated_at = now()
     WHERE metadata->'people' ? $1 AND deleted_at IS NULL`,
    [oldName, newName],
  );

  return c.json({ renamed: true, from: oldName, to: newName, affected: result.rowCount || 0 });
});

peopleRouter.get("/", async (c) => {
  const result = await query<{ person: string; count: string; last_seen: string }>(
    `SELECT person, count(*) as count, max(t.created_at) as last_seen
     FROM thoughts t, jsonb_array_elements_text(t.metadata->'people') as person
     WHERE t.deleted_at IS NULL
     GROUP BY person
     ORDER BY count DESC`,
  );

  return c.json({
    people: result.rows.map((r) => ({
      person: r.person,
      count: parseInt(r.count, 10),
      last_seen: r.last_seen,
    })),
  });
});
