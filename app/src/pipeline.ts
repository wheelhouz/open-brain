import crypto from "node:crypto";
import { query } from "./db.js";
import { generateEmbedding, extractMetadata, assignCategory, type ThoughtMetadata } from "./openrouter.js";
import pgvector from "pgvector";

export interface CaptureResult {
  id: string;
  metadata: ThoughtMetadata;
  created_at: string;
}

export async function capturePipeline(
  content: string,
  source?: string,
  parentId?: string,
): Promise<CaptureResult> {
  // Run embedding + metadata extraction in parallel
  const [embedding, metadata] = await Promise.all([
    generateEmbedding(content),
    extractMetadata(content).catch(() => ({
      type: "observation" as const,
      topics: [] as string[],
      people: [] as string[],
      action_items: [] as string[],
      dates_mentioned: [] as string[],
      source_context: source || null,
    })),
  ]);

  // Override source_context if explicitly provided
  if (source) {
    metadata.source_context = source;
  }

  // Add content hash for deduplication
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  const metadataWithHash = { ...metadata, content_hash: contentHash };

  const result = await query<{ id: string; created_at: string }>(
    `INSERT INTO thoughts (content, embedding, metadata, parent_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [content, pgvector.toSql(embedding), JSON.stringify(metadataWithHash), parentId || null],
  );

  // Auto-categorize new topics (best-effort, don't block capture)
  if (metadata.topics.length > 0) {
    try {
      const catResult = await query<{ category: string }>(
        `SELECT DISTINCT category FROM topic_categories LIMIT 1`,
      );
      if (catResult.rows.length > 0) {
        // Categories exist — assign new topics
        const uncategorized = await query<{ topic: string }>(
          `SELECT unnest($1::text[]) AS topic EXCEPT SELECT topic FROM topic_categories`,
          [metadata.topics],
        );
        if (uncategorized.rows.length > 0) {
          const existingCats = await query<{ category: string }>(
            `SELECT DISTINCT category FROM topic_categories ORDER BY category`,
          );
          const categories = existingCats.rows.map((r) => r.category);
          for (const row of uncategorized.rows) {
            const category = await assignCategory(row.topic, categories);
            await query(
              `INSERT INTO topic_categories (topic, category) VALUES ($1, $2)
               ON CONFLICT (topic) DO UPDATE SET category = $2, updated_at = now()`,
              [row.topic, category],
            );
          }
        }
      }
    } catch {
      // Don't fail capture if categorization fails
    }
  }

  return {
    id: result.rows[0].id,
    metadata,
    created_at: result.rows[0].created_at,
  };
}

export interface UpdateResult {
  embedding: number[];
  metadata: ThoughtMetadata | null;
  content_hash: string;
}

export async function updatePipeline(
  content: string,
  reprocess: boolean,
): Promise<UpdateResult> {
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");

  if (reprocess) {
    const [embedding, metadata] = await Promise.all([
      generateEmbedding(content),
      extractMetadata(content).catch(() => null),
    ]);
    return { embedding, metadata, content_hash: contentHash };
  }

  const embedding = await generateEmbedding(content);
  return { embedding, metadata: null, content_hash: contentHash };
}
