import { Hono } from "hono";
import { query } from "../db.js";
import { generateEmbedding } from "../openrouter.js";
import pgvector from "pgvector";

export const searchRouter = new Hono();

searchRouter.post("/", async (c) => {
  const body = await c.req.json<{
    query?: string;
    threshold?: number;
    filter?: Record<string, unknown>;
    limit?: number;
  }>();

  if (!body.query || typeof body.query !== "string") {
    return c.json({ error: "query is required and must be a string" }, 400);
  }

  const threshold = body.threshold ?? 0.5;
  const limit = Math.min(body.limit ?? 10, 100);
  const filter = body.filter ?? {};

  const embedding = await generateEmbedding(body.query);

  const result = await query(
    `SELECT * FROM match_thoughts($1, $2, $3, $4)`,
    [pgvector.toSql(embedding), threshold, limit, JSON.stringify(filter)],
  );

  return c.json({ results: result.rows });
});
