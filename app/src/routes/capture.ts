import { Hono } from "hono";
import { config } from "../config.js";
import { capturePipeline } from "../pipeline.js";

export const captureRouter = new Hono();

captureRouter.post("/", async (c) => {
  const body = await c.req.json<{ content?: string; source?: string; parent_id?: string }>();

  if (!body.content || typeof body.content !== "string") {
    return c.json({ error: "content is required and must be a string" }, 400);
  }

  const content = body.content.trim();
  if (content.length === 0) {
    return c.json({ error: "content must not be empty" }, 400);
  }

  if (content.length > config.maxContentLength) {
    return c.json(
      { error: `content exceeds maximum length of ${config.maxContentLength} bytes` },
      400,
    );
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (body.parent_id && !UUID_RE.test(body.parent_id)) {
    return c.json({ error: "parent_id must be a valid UUID" }, 400);
  }

  const result = await capturePipeline(content, body.source, body.parent_id);
  return c.json(result, 201);
});
