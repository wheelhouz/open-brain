import { Hono } from "hono";
import { searchWithReranking } from "../rag.js";

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

  const result = await searchWithReranking({
    query: body.query,
    threshold: body.threshold ?? 0.25,
    limit: Math.min(body.limit ?? 10, 100),
    filter: body.filter ?? {},
  });

  return c.json({ results: result.thoughts });
});
