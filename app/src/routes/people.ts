import { Hono } from "hono";
import { query } from "../db.js";

export const peopleRouter = new Hono();

// Task 26: Entity rename (replaces old PATCH that rewrote metadata.people)
peopleRouter.patch("/:name", async (c) => {
  const oldName = c.req.param("name").trim();
  const body = await c.req.json<{ name?: string }>();
  const newName = (body.name || "").trim();

  if (!oldName || !newName) return c.json({ error: "Both old and new name are required" }, 400);
  if (oldName === newName) return c.json({ error: "Names are the same" }, 400);

  // Find entity by canonical name
  const entity = await query<{ id: string }>(
    `SELECT id FROM entities WHERE lower(canonical_name) = lower($1) AND entity_type = 'person'`,
    [oldName],
  );
  if (entity.rows.length === 0) {
    return c.json({ error: "Person not found" }, 404);
  }

  // Rename: update canonical_name, add old name as alias
  await query(
    `UPDATE entities
     SET canonical_name = $1,
         aliases = array_append(array_remove(aliases, $1), $2),
         updated_at = now()
     WHERE id = $3`,
    [newName, oldName, entity.rows[0].id],
  );

  return c.json({ renamed: true, from: oldName, to: newName, entity_id: entity.rows[0].id });
});

// Task 25: Entity-backed people listing
peopleRouter.get("/", async (c) => {
  const result = await query<{ id: string; name: string; mention_count: number; last_seen: string }>(
    `SELECT e.id, e.canonical_name as name,
            count(DISTINCT em.thought_id)::int as mention_count,
            max(t.created_at) as last_seen
     FROM entities e
     JOIN entity_mentions em ON em.entity_id = e.id
     JOIN thoughts t ON t.id = em.thought_id AND t.deleted_at IS NULL
     WHERE e.entity_type = 'person'
     GROUP BY e.id, e.canonical_name
     ORDER BY mention_count DESC`,
  );

  return c.json({
    people: result.rows.map((r) => ({
      person: r.name,
      count: r.mention_count,
      last_seen: r.last_seen,
    })),
  });
});

// Task 25: Entity-backed person thoughts filtering
peopleRouter.get("/:name/thoughts", async (c) => {
  const name = decodeURIComponent(c.req.param("name")).trim();

  // Try entity-backed resolution first
  const entityResult = await query<{ id: string }>(
    `SELECT id FROM entities WHERE lower(canonical_name) = lower($1) AND entity_type = 'person'`,
    [name],
  );

  if (entityResult.rows.length > 0) {
    const entityId = entityResult.rows[0].id;
    const result = await query(
      `SELECT t.id, t.content, t.metadata, t.created_at, t.updated_at
       FROM thoughts t
       JOIN entity_mentions em ON em.thought_id = t.id
       WHERE em.entity_id = $1 AND t.deleted_at IS NULL
       ORDER BY t.created_at DESC`,
      [entityId],
    );
    return c.json({ thoughts: result.rows });
  }

  // Fallback to metadata for unresolved names (temporary bridge)
  const result = await query(
    `SELECT id, content, metadata, created_at, updated_at
     FROM thoughts
     WHERE metadata->'people' ? $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [name],
  );
  return c.json({ thoughts: result.rows });
});
