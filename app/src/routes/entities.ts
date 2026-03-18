import { Hono } from "hono";
import { query } from "../db.js";
import { factsRouter } from "./facts.js";

export const entitiesRouter = new Hono();

// List entities with mention count and last_seen
entitiesRouter.get("/", async (c) => {
  const entityType = c.req.query("type");
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (entityType) {
    conditions.push(`e.entity_type = $${idx++}`);
    params.push(entityType);
  }

  params.push(limit);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await query<{
    id: string;
    canonical_name: string;
    entity_type: string;
    aliases: string[];
    attributes: unknown;
    mention_count: string;
    last_seen: string | null;
    created_at: string;
  }>(
    `SELECT e.*,
            count(em.thought_id) as mention_count,
            max(t.created_at) as last_seen
     FROM entities e
     LEFT JOIN entity_mentions em ON em.entity_id = e.id
     LEFT JOIN thoughts t ON t.id = em.thought_id AND t.deleted_at IS NULL
     ${where}
     GROUP BY e.id
     ORDER BY count(em.thought_id) DESC
     LIMIT $${idx}`,
    params,
  );

  return c.json({
    entities: result.rows.map((r) => ({
      ...r,
      mention_count: parseInt(r.mention_count, 10),
    })),
  });
});

// Get single entity detail
entitiesRouter.get("/:id", async (c) => {
  const id = c.req.param("id");

  const result = await query<{
    id: string;
    canonical_name: string;
    entity_type: string;
    aliases: string[];
    attributes: unknown;
    mention_count: string;
    last_seen: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT e.*,
            count(em.thought_id) as mention_count,
            max(t.created_at) as last_seen
     FROM entities e
     LEFT JOIN entity_mentions em ON em.entity_id = e.id
     LEFT JOIN thoughts t ON t.id = em.thought_id AND t.deleted_at IS NULL
     WHERE e.id = $1
     GROUP BY e.id`,
    [id],
  );

  if (result.rows.length === 0) {
    return c.json({ error: "Entity not found" }, 404);
  }

  return c.json({
    ...result.rows[0],
    mention_count: parseInt(result.rows[0].mention_count, 10),
  });
});

// Update entity — rename, manage aliases, attributes
entitiesRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    canonical_name?: string;
    aliases?: string[];
    attributes?: unknown;
  }>();

  // Verify entity exists and get old name
  const existing = await query<{ id: string; canonical_name: string }>(
    `SELECT id, canonical_name FROM entities WHERE id = $1`,
    [id],
  );

  if (existing.rows.length === 0) {
    return c.json({ error: "Entity not found" }, 404);
  }

  // Check for name conflict before updating
  if (body.canonical_name !== undefined) {
    const trimmed = body.canonical_name.trim();
    if (trimmed !== existing.rows[0].canonical_name) {
      const conflict = await query<{ id: string; canonical_name: string }>(
        `SELECT id, canonical_name FROM entities
         WHERE lower(canonical_name) = lower($1) AND entity_type = (SELECT entity_type FROM entities WHERE id = $2) AND id != $2`,
        [trimmed, id],
      );
      if (conflict.rows.length > 0) {
        return c.json({
          conflict: "name_exists",
          existing_entity: { id: conflict.rows[0].id, canonical_name: conflict.rows[0].canonical_name },
        }, 409);
      }
    }
  }

  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  let idx = 1;

  if (body.canonical_name !== undefined) {
    sets.push(`canonical_name = $${idx++}`);
    params.push(body.canonical_name.trim());
  }

  if (body.aliases !== undefined) {
    sets.push(`aliases = $${idx++}`);
    params.push(body.aliases);
  }

  if (body.attributes !== undefined) {
    sets.push(`attributes = $${idx++}`);
    params.push(JSON.stringify(body.attributes));
  }

  params.push(id);
  await query(
    `UPDATE entities SET ${sets.join(", ")} WHERE id = $${idx}`,
    params,
  );

  // If renamed, also update metadata.people across linked thoughts
  if (body.canonical_name && body.canonical_name.trim() !== existing.rows[0].canonical_name) {
    const oldName = existing.rows[0].canonical_name;
    const newName = body.canonical_name.trim();
    await query(
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
  }

  return c.json({ updated: true });
});

// Merge two entities — reassign mentions from source to target
entitiesRouter.post("/merge", async (c) => {
  const body = await c.req.json<{ source_id: string; target_id: string }>();

  if (!body.source_id || !body.target_id) {
    return c.json({ error: "source_id and target_id are required" }, 400);
  }

  if (body.source_id === body.target_id) {
    return c.json({ error: "Cannot merge entity with itself" }, 400);
  }

  // Get both entities
  const [source, target] = await Promise.all([
    query<{ id: string; canonical_name: string; aliases: string[] }>(
      `SELECT id, canonical_name, aliases FROM entities WHERE id = $1`,
      [body.source_id],
    ),
    query<{ id: string; canonical_name: string; aliases: string[] }>(
      `SELECT id, canonical_name, aliases FROM entities WHERE id = $1`,
      [body.target_id],
    ),
  ]);

  if (source.rows.length === 0 || target.rows.length === 0) {
    return c.json({ error: "One or both entities not found" }, 404);
  }

  const sourceEntity = source.rows[0];
  const targetEntity = target.rows[0];

  // Merge aliases (union of both, deduplicated)
  const mergedAliases = [...new Set([
    ...targetEntity.aliases,
    ...sourceEntity.aliases,
    sourceEntity.canonical_name,
  ])];

  // Reassign mentions from source to target (ignore conflicts)
  await query(
    `UPDATE entity_mentions SET entity_id = $1 WHERE entity_id = $2
     AND thought_id NOT IN (SELECT thought_id FROM entity_mentions WHERE entity_id = $1)`,
    [body.target_id, body.source_id],
  );

  // Update target aliases
  await query(
    `UPDATE entities SET aliases = $1, updated_at = now() WHERE id = $2`,
    [mergedAliases, body.target_id],
  );

  // Update metadata.people: rename source name to target name across thoughts
  await query(
    `UPDATE thoughts
     SET metadata = jsonb_set(
       metadata, '{people}',
       (SELECT jsonb_agg(DISTINCT val ORDER BY val)
        FROM jsonb_array_elements_text(
          (metadata->'people') - $1 || jsonb_build_array($2::text)
        ) AS val)
     ), updated_at = now()
     WHERE metadata->'people' ? $1 AND deleted_at IS NULL`,
    [sourceEntity.canonical_name, targetEntity.canonical_name],
  );

  // Delete source entity (CASCADE removes remaining mentions)
  await query(`DELETE FROM entities WHERE id = $1`, [body.source_id]);

  return c.json({
    merged: true,
    target_id: body.target_id,
    aliases: mergedAliases,
  });
});

// Get thoughts mentioning an entity (cursor paginated)
entitiesRouter.get("/:id/thoughts", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const cursor = c.req.query("cursor");

  const conditions = [
    "em.entity_id = $1",
    "t.deleted_at IS NULL",
  ];
  const params: unknown[] = [id];
  let idx = 2;

  if (cursor) {
    conditions.push(`t.created_at < $${idx++}`);
    params.push(cursor);
  }

  params.push(limit + 1);

  const result = await query<{
    id: string;
    content: string;
    metadata: unknown;
    created_at: string;
  }>(
    `SELECT t.id, t.content, t.metadata, t.created_at
     FROM entity_mentions em
     JOIN thoughts t ON t.id = em.thought_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY t.created_at DESC
     LIMIT $${idx}`,
    params,
  );

  const hasMore = result.rows.length > limit;
  const thoughts = result.rows.slice(0, limit);

  return c.json({
    thoughts,
    next_cursor: hasMore ? thoughts[thoughts.length - 1].created_at : null,
  });
});

entitiesRouter.route("/:entityId/facts", factsRouter);
