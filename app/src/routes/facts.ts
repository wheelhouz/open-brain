import { Hono } from "hono";
import { query } from "../db.js";
import { generateEmbedding } from "../openrouter.js";
import { normalizePredicate, renderFactEmbeddingText } from "../facts.js";
import pgvector from "pgvector";

export const factsRouter = new Hono();

// GET /api/entities/:entityId/facts
factsRouter.get("/", async (c) => {
  const entityId = c.req.param("entityId");
  const status = c.req.query("status");
  const reviewState = c.req.query("review_state");

  let sql = `SELECT id, entity_id, predicate, object_value_json, object_display_text, status, review_state, confidence, source_kind, valid_at_start, valid_at_end, created_at, updated_at FROM entity_facts WHERE entity_id = $1`;
  const params: unknown[] = [entityId];
  let paramIdx = 2;

  if (!reviewState) {
    sql += ` AND review_state != 'rejected'`;
  } else {
    sql += ` AND review_state = $${paramIdx}`;
    params.push(reviewState);
    paramIdx++;
  }

  if (status) {
    sql += ` AND status = $${paramIdx}`;
    params.push(status);
  }

  sql += ` ORDER BY
    CASE status
      WHEN 'active' THEN 0
      WHEN 'tentative' THEN 1
      WHEN 'disputed' THEN 2
      WHEN 'superseded' THEN 3
    END,
    updated_at DESC`;

  const result = await query(sql, params);
  return c.json({ facts: result.rows });
});

// GET /api/entities/:entityId/facts/:factId
factsRouter.get("/:factId", async (c) => {
  const factId = c.req.param("factId");
  const entityId = c.req.param("entityId");

  const factResult = await query(
    `SELECT id, entity_id, predicate, object_value_json, object_display_text, status, review_state, confidence, source_kind, valid_at_start, valid_at_end, created_at, updated_at FROM entity_facts WHERE id = $1 AND entity_id = $2`,
    [factId, entityId],
  );
  if (factResult.rows.length === 0) return c.json({ error: "Fact not found" }, 404);

  const evidenceResult = await query(
    `SELECT efe.*, t.content as thought_content
     FROM entity_fact_evidence efe
     LEFT JOIN thoughts t ON t.id = efe.thought_id
     WHERE efe.fact_id = $1
     ORDER BY efe.created_at DESC`,
    [factId],
  );

  return c.json({ fact: factResult.rows[0], evidence: evidenceResult.rows });
});

// POST /api/entities/:entityId/facts — manual creation
factsRouter.post("/", async (c) => {
  const entityId = c.req.param("entityId");
  const body = await c.req.json<{
    predicate: string;
    value: string;
    display_text?: string;
    valid_at_start?: string;
    valid_at_end?: string;
  }>();

  if (!body.predicate || !body.value) {
    return c.json({ error: "predicate and value are required" }, 400);
  }

  const predicate = normalizePredicate(body.predicate);
  const displayText = body.display_text || body.value;
  const objectValueJson = { value: body.value };

  // Get entity canonical name for embedding
  const entityResult = await query<{ canonical_name: string }>(
    `SELECT canonical_name FROM entities WHERE id = $1`,
    [entityId],
  );
  if (entityResult.rows.length === 0) return c.json({ error: "Entity not found" }, 404);

  // Check for conflicts
  const existing = await query<{ id: string; predicate: string; object_display_text: string; status: string }>(
    `SELECT id, predicate, object_display_text, status FROM entity_facts
     WHERE entity_id = $1 AND replace(lower(predicate), ' ', '_') = $2 AND review_state != 'rejected'`,
    [entityId, predicate],
  );

  const activeConflict = existing.rows.find(
    (f) => f.object_display_text.toLowerCase() !== displayText.toLowerCase()
      && (f.status === "active" || f.status === "disputed"),
  );

  if (activeConflict) {
    return c.json({
      error: "Conflicts with existing fact",
      conflict_with: activeConflict,
    }, 409);
  }

  // Check for same-meaning (deduplicate)
  const sameMeaning = existing.rows.find(
    (f) => f.object_display_text.toLowerCase() === displayText.toLowerCase(),
  );

  if (sameMeaning) {
    return c.json({ fact: sameMeaning, deduplicated: true });
  }

  // Embed and insert
  const embeddingText = renderFactEmbeddingText(entityResult.rows[0].canonical_name, predicate, displayText);
  const embedding = await generateEmbedding(embeddingText);

  const result = await query(
    `INSERT INTO entity_facts (entity_id, predicate, object_value_json, object_display_text, status, review_state, confidence, source_kind, valid_at_start, valid_at_end, embedding)
     VALUES ($1, $2, $3, $4, 'active', 'accepted', 1.0, 'manual', $5, $6, $7)
     RETURNING *`,
    [entityId, predicate, JSON.stringify(objectValueJson), displayText, body.valid_at_start || null, body.valid_at_end || null, pgvector.toSql(embedding)],
  );

  // Create manual evidence row (no thought_id)
  await query(
    `INSERT INTO entity_fact_evidence (fact_id, excerpt, evidence_type)
     VALUES ($1, $2, 'manual')`,
    [result.rows[0].id, `Manual entry: ${predicate} = ${displayText}`],
  );

  return c.json({ fact: result.rows[0] }, 201);
});

// PATCH /api/entities/:entityId/facts/:factId
factsRouter.patch("/:factId", async (c) => {
  const factId = c.req.param("factId");
  const entityId = c.req.param("entityId");
  const body = await c.req.json<{
    predicate?: string;
    object_display_text?: string;
    valid_at_start?: string | null;
    valid_at_end?: string | null;
  }>();

  // Check fact exists and is editable
  const factResult = await query<{ id: string; status: string; review_state: string; predicate: string; object_display_text: string }>(
    `SELECT id, status, review_state, predicate, object_display_text FROM entity_facts WHERE id = $1 AND entity_id = $2`,
    [factId, entityId],
  );
  if (factResult.rows.length === 0) return c.json({ error: "Fact not found" }, 404);

  const fact = factResult.rows[0];
  if (fact.status === "disputed" || fact.status === "superseded") {
    return c.json({ error: `Cannot edit ${fact.status} fact. Use resolve-conflict endpoint.` }, 409);
  }

  // Build update
  const updates: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  let paramIdx = 1;

  const newPredicate = body.predicate ? normalizePredicate(body.predicate) : fact.predicate;
  const newDisplayText = body.object_display_text || fact.object_display_text;
  let needsReembed = false;

  if (body.predicate) {
    updates.push(`predicate = $${paramIdx}`);
    params.push(newPredicate);
    paramIdx++;
    needsReembed = true;
  }
  if (body.object_display_text) {
    updates.push(`object_display_text = $${paramIdx}`);
    params.push(newDisplayText);
    paramIdx++;
    updates.push(`object_value_json = $${paramIdx}`);
    params.push(JSON.stringify({ value: newDisplayText }));
    paramIdx++;
    needsReembed = true;
  }
  if (body.valid_at_start !== undefined) {
    updates.push(`valid_at_start = $${paramIdx}`);
    params.push(body.valid_at_start);
    paramIdx++;
  }
  if (body.valid_at_end !== undefined) {
    updates.push(`valid_at_end = $${paramIdx}`);
    params.push(body.valid_at_end);
    paramIdx++;
  }

  // Re-embed if predicate or display text changed
  if (needsReembed) {
    const entityResult = await query<{ canonical_name: string }>(
      `SELECT canonical_name FROM entities WHERE id = $1`, [entityId],
    );
    const embeddingText = renderFactEmbeddingText(entityResult.rows[0].canonical_name, newPredicate, newDisplayText);
    const embedding = await generateEmbedding(embeddingText);
    updates.push(`embedding = $${paramIdx}`);
    params.push(pgvector.toSql(embedding));
    paramIdx++;
  }

  params.push(factId);
  const result = await query(
    `UPDATE entity_facts SET ${updates.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
    params,
  );

  return c.json({ fact: result.rows[0] });
});

// POST /api/entities/:entityId/facts/:factId/accept
factsRouter.post("/:factId/accept", async (c) => {
  const factId = c.req.param("factId");
  const entityId = c.req.param("entityId");

  const factResult = await query<{ id: string; predicate: string; review_state: string }>(
    `SELECT id, predicate, review_state FROM entity_facts WHERE id = $1 AND entity_id = $2`,
    [factId, entityId],
  );
  if (factResult.rows.length === 0) return c.json({ error: "Fact not found" }, 404);
  if (factResult.rows[0].review_state !== "pending") {
    return c.json({ error: "Only pending facts can be accepted" }, 400);
  }

  // Check for conflicts (active OR disputed with same predicate)
  const conflicts = await query<{ id: string; predicate: string; object_display_text: string; status: string }>(
    `SELECT id, predicate, object_display_text, status FROM entity_facts
     WHERE entity_id = $1 AND replace(lower(predicate), ' ', '_') = $2 AND id != $3
       AND (status = 'active' OR status = 'disputed')
       AND review_state != 'rejected'`,
    [entityId, factResult.rows[0].predicate, factId],
  );

  if (conflicts.rows.length > 0) {
    return c.json({
      error: "Conflicts with existing fact",
      conflict_with: conflicts.rows[0],
    }, 409);
  }

  await query(
    `UPDATE entity_facts SET status = 'active', review_state = 'accepted', updated_at = now() WHERE id = $1`,
    [factId],
  );

  return c.json({ accepted: true });
});

// POST /api/entities/:entityId/facts/:factId/reject
factsRouter.post("/:factId/reject", async (c) => {
  const factId = c.req.param("factId");
  const entityId = c.req.param("entityId");

  // Get the fact before rejecting so we can check for disputed counterparts
  const factResult = await query<{ id: string; predicate: string; status: string }>(
    `SELECT id, predicate, status FROM entity_facts WHERE id = $1 AND entity_id = $2`,
    [factId, entityId],
  );
  if (factResult.rows.length === 0) return c.json({ error: "Fact not found" }, 404);

  const fact = factResult.rows[0];

  await query(
    `UPDATE entity_facts SET review_state = 'rejected', updated_at = now() WHERE id = $1`,
    [factId],
  );

  // If rejected fact was disputed, restore the remaining disputed counterpart to active
  if (fact.status === "disputed") {
    await query(
      `UPDATE entity_facts SET status = 'active', updated_at = now()
       WHERE entity_id = $1 AND replace(lower(predicate), ' ', '_') = $2 AND id != $3
         AND status = 'disputed' AND review_state != 'rejected'`,
      [entityId, fact.predicate, factId],
    );
  }

  return c.json({ rejected: true });
});

// POST /api/entities/:entityId/facts/:factId/resolve-conflict
factsRouter.post("/:factId/resolve-conflict", async (c) => {
  const factId = c.req.param("factId");
  const entityId = c.req.param("entityId");
  const body = await c.req.json<{
    action: "replace_existing_with_new" | "mark_old_as_past" | "mark_old_as_wrong" | "keep_both_disputed" | "cancel";
    note?: string;
  }>();

  if (!body.action) return c.json({ error: "action is required" }, 400);
  if (body.action === "cancel") return c.json({ cancelled: true });

  // Get the new fact and find the conflicting old fact
  const newFact = await query<{ id: string; predicate: string; entity_id: string }>(
    `SELECT id, predicate, entity_id FROM entity_facts WHERE id = $1 AND entity_id = $2`,
    [factId, entityId],
  );
  if (newFact.rows.length === 0) return c.json({ error: "Fact not found" }, 404);

  if (body.action === "keep_both_disputed") {
    // Accept the new fact (move out of pending) but keep both as disputed
    await query(
      `UPDATE entity_facts SET review_state = 'accepted', updated_at = now() WHERE id = $1 AND review_state = 'pending'`,
      [factId],
    );
    return c.json({ resolved: true, action: body.action });
  }

  const oldFact = await query<{ id: string }>(
    `SELECT id FROM entity_facts
     WHERE entity_id = $1 AND replace(lower(predicate), ' ', '_') = $2 AND id != $3
       AND status = 'disputed' AND review_state != 'rejected'
     LIMIT 1`,
    [entityId, newFact.rows[0].predicate, factId],
  );

  if (oldFact.rows.length === 0) {
    return c.json({ error: "No conflicting fact found" }, 404);
  }

  const oldFactId = oldFact.rows[0].id;

  switch (body.action) {
    case "replace_existing_with_new":
    case "mark_old_as_past":
      // New → active/accepted, Old → superseded
      await query(
        `UPDATE entity_facts SET status = 'active', review_state = 'accepted', updated_at = now() WHERE id = $1`,
        [factId],
      );
      await query(
        `UPDATE entity_facts SET status = 'superseded', review_state = 'accepted', valid_at_end = now(), updated_at = now() WHERE id = $1`,
        [oldFactId],
      );
      break;

    case "mark_old_as_wrong":
      // New → active/accepted, Old → rejected
      await query(
        `UPDATE entity_facts SET status = 'active', review_state = 'accepted', updated_at = now() WHERE id = $1`,
        [factId],
      );
      await query(
        `UPDATE entity_facts SET review_state = 'rejected', updated_at = now() WHERE id = $1`,
        [oldFactId],
      );
      break;
  }

  return c.json({ resolved: true, action: body.action });
});

// DELETE /api/entities/:entityId/facts/:factId
factsRouter.delete("/:factId", async (c) => {
  const factId = c.req.param("factId");
  const entityId = c.req.param("entityId");

  const factResult = await query<{ id: string; predicate: string; status: string }>(
    `SELECT id, predicate, status FROM entity_facts WHERE id = $1 AND entity_id = $2`,
    [factId, entityId],
  );
  if (factResult.rows.length === 0) return c.json({ error: "Fact not found" }, 404);

  const fact = factResult.rows[0];

  // If deleting a disputed fact, restore the counterpart to active
  if (fact.status === "disputed") {
    await query(
      `UPDATE entity_facts SET status = 'active', updated_at = now()
       WHERE entity_id = $1 AND replace(lower(predicate), ' ', '_') = $2 AND id != $3
         AND status = 'disputed' AND review_state != 'rejected'`,
      [entityId, fact.predicate, factId],
    );
  }

  // Evidence rows cascade-delete via FK
  await query(`DELETE FROM entity_facts WHERE id = $1`, [factId]);

  return c.json({ deleted: true });
});

export const pendingFactsRouter = new Hono();

// GET /api/facts/pending
pendingFactsRouter.get("/", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);
  const cursor = c.req.query("cursor");

  let sql = `SELECT ef.id, ef.entity_id, ef.predicate, ef.object_value_json, ef.object_display_text, ef.status, ef.review_state, ef.confidence, ef.source_kind, ef.valid_at_start, ef.valid_at_end, ef.created_at, ef.updated_at, e.canonical_name as entity_name
     FROM entity_facts ef
     JOIN entities e ON e.id = ef.entity_id
     WHERE ef.review_state = 'pending'`;
  const params: unknown[] = [];

  if (cursor) {
    sql += ` AND ef.created_at < $${params.length + 1}`;
    params.push(cursor);
  }

  sql += ` ORDER BY ef.created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit + 1);

  const result = await query(sql, params);
  const hasMore = result.rows.length > limit;
  const facts = hasMore ? result.rows.slice(0, limit) : result.rows;
  const nextCursor = hasMore ? facts[facts.length - 1].created_at : null;

  return c.json({ facts, next_cursor: nextCursor });
});
