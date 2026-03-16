import { Hono } from "hono";
import { query } from "../db.js";

export const loopsRouter = new Hono();

// List loops with status/type filter and cursor pagination
loopsRouter.get("/", async (c) => {
  const status = c.req.query("status") || "open";
  const loopType = c.req.query("loop_type");
  const sourceThoughtId = c.req.query("source_thought_id");
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
  const cursor = c.req.query("cursor");

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (sourceThoughtId) {
    // When filtering by source thought, return all statuses
    conditions.push(`source_thought_id = $${idx++}`);
    params.push(sourceThoughtId);
  } else if (status === "open") {
    // Open query includes snoozed loops past their snoozed_until date
    conditions.push(`(status = 'open' OR (status = 'snoozed' AND snoozed_until <= now()))`);
  } else {
    conditions.push(`status = $${idx++}`);
    params.push(status);
  }

  if (loopType) {
    conditions.push(`loop_type = $${idx++}`);
    params.push(loopType);
  }

  if (cursor) {
    conditions.push(`created_at < $${idx++}`);
    params.push(cursor);
  }

  params.push(limit + 1);

  const result = await query<{
    id: string;
    content: string;
    loop_type: string;
    status: string;
    resolution: string | null;
    source_thought_id: string | null;
    snoozed_until: string | null;
    created_at: string;
    closed_at: string | null;
    evidence_count: string;
    last_evidence_at: string | null;
    source_preview: string | null;
  }>(
    `SELECT l.*,
       (SELECT count(*) FROM open_loop_evidence ole JOIN thoughts t ON t.id = ole.thought_id AND t.deleted_at IS NULL WHERE ole.loop_id = l.id) as evidence_count,
       (SELECT max(ole.noted_at) FROM open_loop_evidence ole JOIN thoughts t ON t.id = ole.thought_id AND t.deleted_at IS NULL WHERE ole.loop_id = l.id) as last_evidence_at,
       sp.source_preview
     FROM open_loops l
     LEFT JOIN LATERAL (
       SELECT left(t.content, 80) as source_preview
       FROM thoughts t WHERE t.id = l.source_thought_id AND t.deleted_at IS NULL
     ) sp ON true
     WHERE ${conditions.join(" AND ")}
     ORDER BY l.created_at DESC
     LIMIT $${idx}`,
    params,
  );

  const hasMore = result.rows.length > limit;
  const loops = result.rows.slice(0, limit).map((r) => ({
    ...r,
    evidence_count: parseInt(r.evidence_count, 10),
  }));

  return c.json({
    loops,
    next_cursor: hasMore ? loops[loops.length - 1].created_at : null,
  });
});

// Get single loop with evidence thoughts
loopsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");

  const loopResult = await query<{
    id: string;
    content: string;
    loop_type: string;
    status: string;
    resolution: string | null;
    source_thought_id: string | null;
    snoozed_until: string | null;
    created_at: string;
    closed_at: string | null;
  }>(
    `SELECT * FROM open_loops WHERE id = $1`,
    [id],
  );

  if (loopResult.rows.length === 0) {
    return c.json({ error: "Loop not found" }, 404);
  }

  const evidenceResult = await query<{
    id: string;
    content: string;
    metadata: unknown;
    created_at: string;
    noted_at: string;
  }>(
    `SELECT t.id, t.content, t.metadata, t.created_at, e.noted_at
     FROM open_loop_evidence e
     JOIN thoughts t ON t.id = e.thought_id
     WHERE e.loop_id = $1 AND t.deleted_at IS NULL
     ORDER BY e.noted_at DESC`,
    [id],
  );

  return c.json({
    ...loopResult.rows[0],
    evidence: evidenceResult.rows,
  });
});

// Create loop manually
loopsRouter.post("/", async (c) => {
  const body = await c.req.json<{
    content: string;
    loop_type?: string;
    source_thought_id?: string;
  }>();

  if (!body.content?.trim()) {
    return c.json({ error: "content is required" }, 400);
  }

  const result = await query<{ id: string; created_at: string }>(
    `INSERT INTO open_loops (content, loop_type, source_thought_id)
     VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [body.content.trim(), body.loop_type || "task", body.source_thought_id || null],
  );

  const loop = result.rows[0];

  // If source thought provided, auto-link as evidence
  if (body.source_thought_id) {
    await query(
      `INSERT INTO open_loop_evidence (loop_id, thought_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [loop.id, body.source_thought_id],
    );
  }

  return c.json(loop, 201);
});

// Update loop status/resolution
loopsRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    status?: string;
    resolution?: string;
    snoozed_until?: string;
  }>();

  // Verify loop exists
  const existing = await query<{ id: string; status: string }>(
    `SELECT id, status FROM open_loops WHERE id = $1`,
    [id],
  );

  if (existing.rows.length === 0) {
    return c.json({ error: "Loop not found" }, 404);
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (body.status) {
    sets.push(`status = $${idx++}`);
    params.push(body.status);

    if (body.status === "closed") {
      sets.push(`closed_at = now()`);
    } else if (body.status === "open") {
      // Reopen: clear closed_at and snoozed_until
      sets.push(`closed_at = NULL`, `snoozed_until = NULL`);
    }
  }

  if (body.resolution !== undefined) {
    sets.push(`resolution = $${idx++}`);
    params.push(body.resolution);
  }

  if (body.snoozed_until !== undefined) {
    sets.push(`snoozed_until = $${idx++}`);
    params.push(body.snoozed_until);
  }

  if (sets.length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  params.push(id);
  await query(
    `UPDATE open_loops SET ${sets.join(", ")} WHERE id = $${idx}`,
    params,
  );

  return c.json({ updated: true });
});

// Delete loop
loopsRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");

  const result = await query(
    `DELETE FROM open_loops WHERE id = $1`,
    [id],
  );

  if (result.rowCount === 0) {
    return c.json({ error: "Loop not found" }, 404);
  }

  return c.json({ deleted: true });
});

// Link thought as evidence
loopsRouter.post("/:id/evidence", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ thought_id: string }>();

  if (!body.thought_id) {
    return c.json({ error: "thought_id is required" }, 400);
  }

  // Verify loop exists
  const loopExists = await query(`SELECT id FROM open_loops WHERE id = $1`, [id]);
  if (loopExists.rows.length === 0) {
    return c.json({ error: "Loop not found" }, 404);
  }

  await query(
    `INSERT INTO open_loop_evidence (loop_id, thought_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, body.thought_id],
  );

  return c.json({ linked: true });
});
