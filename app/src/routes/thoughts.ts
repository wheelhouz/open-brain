import { Hono } from "hono";
import { query } from "../db.js";
import pgvector from "pgvector";
import { updatePipeline, createLoopsFromActionItems } from "../pipeline.js";
import { resolveEntityMentions } from "../entities.js";

export const thoughtsRouter = new Hono();

// List thoughts with filters and cursor pagination
thoughtsRouter.get("/", async (c) => {
  const type = c.req.query("type");
  const topic = c.req.query("topic");
  const person = c.req.query("person");
  const days = c.req.query("days");
  const source = c.req.query("source");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const cursor = c.req.query("cursor"); // ISO timestamp cursor

  const hasFilter = !!(type || topic || person || source);
  const conditions: string[] = ["deleted_at IS NULL"];
  if (!hasFilter) conditions.push("parent_id IS NULL");
  const params: unknown[] = [];
  let paramIdx = 1;

  if (type) {
    conditions.push(`metadata->>'type' = $${paramIdx++}`);
    params.push(type);
  }
  if (topic) {
    conditions.push(`metadata->'topics' ? $${paramIdx++}`);
    params.push(topic);
  }
  if (person) {
    conditions.push(`metadata->'people' ? $${paramIdx++}`);
    params.push(person);
  }
  if (days) {
    conditions.push(`created_at > now() - interval '1 day' * $${paramIdx++}`);
    params.push(parseInt(days, 10));
  }
  if (source) {
    conditions.push(`metadata->>'source_context' = $${paramIdx++}`);
    params.push(source);
  }
  if (cursor) {
    conditions.push(`created_at < $${paramIdx++}`);
    params.push(cursor);
  }

  // Fetch limit + 1 to determine if there's a next page
  params.push(limit + 1);
  const limitParam = `$${paramIdx}`;

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await query<{
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
    thread_count: number;
    loop_count: number;
  }>(
    `SELECT id, content, metadata, created_at, updated_at,
       (SELECT count(*)::int FROM thoughts c WHERE c.parent_id = thoughts.id AND c.deleted_at IS NULL) as thread_count,
       (SELECT count(*)::int FROM open_loops WHERE source_thought_id = thoughts.id) as loop_count
     FROM thoughts
     ${where}
     ORDER BY created_at DESC
     LIMIT ${limitParam}`,
    params,
  );

  const hasMore = result.rows.length > limit;
  const thoughts = hasMore ? result.rows.slice(0, limit) : result.rows;
  const nextCursor = hasMore ? thoughts[thoughts.length - 1].created_at : null;

  return c.json({ thoughts, next_cursor: nextCursor });
});

// Get single thought
thoughtsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const result = await query<{
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
    parent_id: string | null;
    loop_count: number;
  }>(
    `SELECT id, content, metadata, created_at, updated_at, parent_id,
       (SELECT count(*)::int FROM open_loops WHERE source_thought_id = thoughts.id) as loop_count
     FROM thoughts
     WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );

  if (result.rows.length === 0) {
    return c.json({ error: "Thought not found" }, 404);
  }

  return c.json(result.rows[0]);
});

// Related thoughts — reuses stored embedding
thoughtsRouter.get("/:id/related", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(parseInt(c.req.query("limit") || "5", 10), 20);

  // Fetch the thought's embedding
  const embResult = await query<{ embedding: string }>(
    `SELECT embedding::text FROM thoughts WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );

  if (embResult.rows.length === 0) {
    return c.json({ error: "Thought not found" }, 404);
  }

  if (!embResult.rows[0].embedding) {
    return c.json({ related: [] });
  }

  // Parse the stored vector and find similar thoughts (excluding self and thread members)
  const embedding = embResult.rows[0].embedding;
  const result = await query(
    `SELECT m.id, m.content, m.metadata, m.similarity, m.created_at
     FROM match_thoughts($1, $2, $3) m
     JOIN thoughts t ON t.id = m.id
     WHERE m.id != $4
       AND (t.parent_id IS NULL OR t.parent_id != $4)
       AND t.id NOT IN (SELECT parent_id FROM thoughts WHERE id = $4 AND parent_id IS NOT NULL)`,
    [embedding, 0.5, limit + 1, id],
  );

  return c.json({ related: result.rows.slice(0, limit) });
});

// Get thread (sub-thoughts) for a thought
thoughtsRouter.get("/:id/thread", async (c) => {
  const id = c.req.param("id");
  const result = await query<{
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
    parent_id: string;
  }>(
    `SELECT id, content, metadata, created_at, updated_at, parent_id
     FROM thoughts
     WHERE parent_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [id],
  );

  return c.json({ thread: result.rows });
});

// Update topics on a thought
thoughtsRouter.patch("/:id/topics", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ add?: string[]; remove?: string[] }>();

  const add = (body.add || []).map((t) => t.trim()).filter(Boolean);
  const remove = (body.remove || []).map((t) => t.trim()).filter(Boolean);

  if (add.length === 0 && remove.length === 0) {
    return c.json({ error: "At least one of add or remove must be non-empty" }, 400);
  }

  // Atomic: remove specified topics, union in new ones, deduplicate, sort
  const result = await query<{ id: string; metadata: Record<string, unknown> }>(
    `UPDATE thoughts
     SET metadata = jsonb_set(
       metadata, '{topics}',
       (SELECT COALESCE(jsonb_agg(val ORDER BY val), '[]'::jsonb)
        FROM (
          SELECT DISTINCT val
          FROM jsonb_array_elements_text(
            COALESCE(metadata->'topics', '[]'::jsonb) || $2::jsonb
          ) AS val
          WHERE val != ALL($3::text[])
        ) sub)
     ), updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING id, metadata`,
    [id, JSON.stringify(add), remove],
  );

  if (result.rows.length === 0) {
    return c.json({ error: "Thought not found" }, 404);
  }

  const row = result.rows[0];
  return c.json({
    id: row.id,
    topics: (row.metadata as Record<string, unknown>).topics || [],
  });
});

// Update thought content
thoughtsRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ content?: string; reprocess?: boolean }>();
  const content = body.content?.trim();

  if (!content) {
    return c.json({ error: "Content is required" }, 400);
  }

  const { embedding, metadata, content_hash } = await updatePipeline(
    content,
    body.reprocess === true,
  );

  let sql: string;
  let params: unknown[];

  if (metadata) {
    // Full re-process: strip action_items from stored metadata
    const { action_items, ...metadataForStorage } = metadata;
    sql = `UPDATE thoughts
      SET content = $1,
          embedding = $2,
          metadata = metadata || $3::jsonb,
          updated_at = now()
      WHERE id = $4 AND deleted_at IS NULL
      RETURNING id, content, metadata, created_at, updated_at`;
    params = [
      content,
      pgvector.toSql(embedding),
      JSON.stringify({ ...metadataForStorage, content_hash }),
      id,
    ];
  } else {
    // Embed-only: update content, embedding, content_hash
    sql = `UPDATE thoughts
      SET content = $1,
          embedding = $2,
          metadata = jsonb_set(metadata, '{content_hash}', $3::jsonb),
          updated_at = now()
      WHERE id = $4 AND deleted_at IS NULL
      RETURNING id, content, metadata, created_at, updated_at`;
    params = [
      content,
      pgvector.toSql(embedding),
      JSON.stringify(content_hash),
      id,
    ];
  }

  const result = await query<{
    id: string; content: string; metadata: Record<string, unknown>;
    created_at: string; updated_at: string;
  }>(sql, params);

  if (result.rows.length === 0) {
    return c.json({ error: "Thought not found" }, 404);
  }

  // Re-resolve entity mentions and recreate loops when metadata was re-extracted
  if (metadata) {
    const people = Array.isArray(metadata.people) ? metadata.people : [];
    if (people.length > 0) {
      try {
        await resolveEntityMentions(people, id);
      } catch {
        // Don't fail update if entity resolution fails
      }
    }

    // Recreate loops: delete existing open loops, preserve closed/snoozed
    const actionItems = Array.isArray(metadata.action_items) ? metadata.action_items : [];
    if (actionItems.length > 0) {
      try {
        await query(
          `DELETE FROM open_loops WHERE source_thought_id = $1 AND status = 'open'`,
          [id],
        );
        await createLoopsFromActionItems(actionItems, id);
      } catch {
        // Don't fail update if loop recreation fails
      }
    }
  }

  return c.json(result.rows[0]);
});

// Soft-delete thought
thoughtsRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const result = await query(
    `UPDATE thoughts SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING id`,
    [id],
  );

  if (result.rowCount === 0) {
    return c.json({ error: "Thought not found" }, 404);
  }

  return c.json({ deleted: true, id });
});
