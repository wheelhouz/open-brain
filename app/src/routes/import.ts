import { Hono } from "hono";
import { config } from "../config.js";
import { capturePipeline } from "../pipeline.js";
import { normalizeContent } from "../openrouter.js";
import crypto from "node:crypto";
import { query } from "../db.js";

export const importRouter = new Hono();

interface ImportThought {
  content: string;
  source_context?: string;
  created_at?: string;
}

interface ImportRequest {
  thoughts: ImportThought[];
  options?: {
    normalize?: boolean;
    source_label?: string;
  };
}

importRouter.post("/", async (c) => {
  const body = await c.req.json<ImportRequest>();

  if (!Array.isArray(body.thoughts) || body.thoughts.length === 0) {
    return c.json({ error: "thoughts array is required and must not be empty" }, 400);
  }

  if (body.thoughts.length > 500) {
    return c.json({ error: "Too many thoughts (max 500)" }, 400);
  }

  const normalize = body.options?.normalize ?? false;
  const sourceLabel = body.options?.source_label;

  let imported = 0;
  let skipped = 0;
  const errors: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < body.thoughts.length; i++) {
    const t = body.thoughts[i];

    if (!t.content || typeof t.content !== "string") {
      errors.push({ index: i, error: "content is required" });
      continue;
    }

    let content = t.content.trim();
    if (content.length === 0) {
      errors.push({ index: i, error: "content is empty" });
      continue;
    }

    if (content.length > config.maxContentLength) {
      errors.push({ index: i, error: "content exceeds max length" });
      continue;
    }

    // Deduplication via content hash
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const existing = await query(
      `SELECT id FROM thoughts WHERE metadata->>'content_hash' = $1 AND deleted_at IS NULL`,
      [hash],
    );
    if (existing.rows.length > 0) {
      skipped++;
      continue;
    }

    try {
      // Normalize if requested
      if (normalize) {
        content = await normalizeContent(content);
      }

      const source = t.source_context || sourceLabel || "import";
      await capturePipeline(content, source);
      imported++;
    } catch (err) {
      errors.push({ index: i, error: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  return c.json({ imported, skipped, errors });
});
