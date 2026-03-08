import { query } from "./db.js";
import { generateEmbedding, rewriteQuery } from "./openrouter.js";
import pgvector from "pgvector";

export interface RetrievedThought {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
  thread?: Array<{ content: string; created_at: string }>;
}

export interface RAGDiagnostics {
  originalQuery?: string;
  rewrittenQuery: string;
  filter: Record<string, unknown>;
  timeHint: string | null;
  candidateCount: number;
  finalCount: number;
  latencyMs: number;
}

export interface RAGResult {
  thoughts: RetrievedThought[];
  diagnostics: RAGDiagnostics;
}

export interface RAGContext extends RAGResult {
  rewrittenQuery: string;
}

const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_HALF_LIFE_DAYS_TIME = 14;

function recencyScore(createdAt: string | Date, halfLifeDays: number): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function metadataOverlap(
  thoughtMeta: Record<string, unknown>,
  filter: Record<string, unknown>,
): number {
  const filterTerms: string[] = [];
  for (const val of Object.values(filter)) {
    if (Array.isArray(val)) {
      filterTerms.push(...val.map((v) => String(v).toLowerCase()));
    }
  }
  if (filterTerms.length === 0) return 0;

  const metaTerms: string[] = [];
  for (const val of Object.values(thoughtMeta)) {
    if (Array.isArray(val)) {
      metaTerms.push(...val.map((v) => String(v).toLowerCase()));
    } else if (typeof val === "string") {
      metaTerms.push(val.toLowerCase());
    }
  }

  const matched = filterTerms.filter((t) => metaTerms.includes(t)).length;
  return matched / filterTerms.length;
}

function threadBonus(thought: { metadata: Record<string, unknown> }): number {
  return thought.metadata.parent_id ? 1.0 : 0.0;
}

interface RankCandidate {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
}

function rerank(
  candidates: RankCandidate[],
  filter: Record<string, unknown>,
  timeHint: string | null,
  limit: number,
): RetrievedThought[] {
  const hasTimeHint = timeHint !== null;
  const weights = hasTimeHint
    ? { similarity: 0.50, recency: 0.30, metadata: 0.15, thread: 0.05 }
    : { similarity: 0.60, recency: 0.20, metadata: 0.15, thread: 0.05 };
  const halfLife = hasTimeHint ? RECENCY_HALF_LIFE_DAYS_TIME : RECENCY_HALF_LIFE_DAYS;

  const scored = candidates.map((c) => {
    const score =
      weights.similarity * c.similarity +
      weights.recency * recencyScore(c.created_at, halfLife) +
      weights.metadata * metadataOverlap(c.metadata || {}, filter) +
      weights.thread * threadBonus({ metadata: c.metadata || {} });
    return { ...c, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);

  return scored.slice(0, limit).map(({ _score: _, ...thought }) => thought);
}

export async function searchWithReranking(options: {
  query: string;
  filter?: Record<string, unknown>;
  timeHint?: "recent" | "last_month" | "older" | null;
  limit?: number;
  threshold?: number;
  poolSize?: number;
}): Promise<RAGResult> {
  const {
    query: searchQuery,
    filter = {},
    timeHint = null,
    limit = 10,
    threshold = 0.25,
    poolSize = 15,
  } = options;

  const start = Date.now();

  const embedding = await generateEmbedding(searchQuery);

  // Build metadata filter for match_thoughts — only pass structured JSONB containment
  const dbFilter: Record<string, unknown> = {};
  if (filter.people && Array.isArray(filter.people) && filter.people.length > 0) {
    dbFilter.people = filter.people;
  }
  if (filter.topics && Array.isArray(filter.topics) && filter.topics.length > 0) {
    dbFilter.topics = filter.topics;
  }

  const result = await query(
    `SELECT * FROM match_thoughts($1, $2, $3, $4)`,
    [pgvector.toSql(embedding), threshold, poolSize, JSON.stringify(dbFilter)],
  );

  let candidates: RankCandidate[] = result.rows.map((r: any) => ({
    id: r.id,
    content: r.content,
    metadata: r.metadata,
    similarity: r.similarity,
    created_at: r.created_at,
  }));

  // Recency slice: when time_hint is "recent", pull in latest thoughts
  if (timeHint === "recent") {
    const recentResult = await query(
      `SELECT id, content, metadata, created_at FROM thoughts
       WHERE deleted_at IS NULL AND created_at > now() - interval '7 days'
       ORDER BY created_at DESC LIMIT 5`,
    );
    const existingIds = new Set(candidates.map((c) => c.id));
    for (const r of recentResult.rows as any[]) {
      if (!existingIds.has(r.id)) {
        candidates.push({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          similarity: 0.3,
          created_at: r.created_at,
        });
      }
    }
  }

  const reranked = rerank(candidates, filter, timeHint, limit);

  // Thread expansion for top 3 results
  const top3 = reranked.slice(0, 3);
  if (top3.length > 0) {
    const top3Ids = top3.map((t) => t.id);

    // Fetch parents for thoughts that have parent_id in metadata
    const parentIds = top3
      .map((t) => t.metadata?.parent_id as string | undefined)
      .filter(Boolean) as string[];

    const [childrenResult, parentsResult] = await Promise.all([
      query(
        `SELECT parent_id, content, created_at FROM thoughts
         WHERE parent_id = ANY($1) AND deleted_at IS NULL
         ORDER BY created_at LIMIT 6`,
        [top3Ids],
      ),
      parentIds.length > 0
        ? query(
            `SELECT id, content, created_at FROM thoughts WHERE id = ANY($1)`,
            [parentIds],
          )
        : Promise.resolve({ rows: [] }),
    ]);

    // Build thread map
    const threadMap = new Map<string, Array<{ content: string; created_at: string }>>();
    for (const row of childrenResult.rows as any[]) {
      const arr = threadMap.get(row.parent_id) || [];
      arr.push({ content: row.content, created_at: row.created_at });
      threadMap.set(row.parent_id, arr);
    }

    const parentMap = new Map<string, { content: string; created_at: string }>();
    for (const row of parentsResult.rows as any[]) {
      parentMap.set(row.id, { content: row.content, created_at: row.created_at });
    }

    for (const thought of reranked) {
      const thread: Array<{ content: string; created_at: string }> = [];
      const parentId = thought.metadata?.parent_id as string | undefined;
      if (parentId && parentMap.has(parentId)) {
        thread.push(parentMap.get(parentId)!);
      }
      const children = threadMap.get(thought.id);
      if (children) {
        thread.push(...children.slice(0, 2));
      }
      if (thread.length > 0) {
        thought.thread = thread;
      }
    }
  }

  const diagnostics: RAGDiagnostics = {
    rewrittenQuery: searchQuery,
    filter,
    timeHint,
    candidateCount: candidates.length,
    finalCount: reranked.length,
    latencyMs: Date.now() - start,
  };

  console.log(JSON.stringify({ event: "rag_retrieval", ...diagnostics }));

  return { thoughts: reranked, diagnostics };
}

export async function retrieveContext(
  messages: Array<{ role: string; content: string }>,
): Promise<RAGContext> {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const originalQuery = lastUserMsg?.content || "";

  const rewrite = await rewriteQuery(messages);

  const result = await searchWithReranking({
    query: rewrite.search_query,
    filter: rewrite.filter,
    timeHint: rewrite.time_hint,
  });

  result.diagnostics.originalQuery = originalQuery;

  return {
    ...result,
    rewrittenQuery: rewrite.search_query,
  };
}

export function formatContext(thoughts: RetrievedThought[]): string {
  if (thoughts.length === 0) {
    return "No relevant thoughts were found in the knowledge base for this query.";
  }

  return thoughts
    .map((t, i) => {
      const date = new Date(t.created_at).toISOString().split("T")[0];
      const type = (t.metadata?.type as string) || "note";
      const similarity = (t.similarity * 100).toFixed(0);
      const topics = Array.isArray(t.metadata?.topics) ? (t.metadata.topics as string[]).join(", ") : "";
      const people = Array.isArray(t.metadata?.people) ? (t.metadata.people as string[]).join(", ") : "";

      let header = `[Thought ${i + 1}] (relevance: ${similarity}%, ${date}, ${type})`;
      const metaParts: string[] = [];
      if (topics) metaParts.push(`Topics: ${topics}`);
      if (people) metaParts.push(`People: ${people}`);
      if (metaParts.length > 0) header += `\n${metaParts.join(" | ")}`;

      let body = `${header}\n${t.content}`;

      if (t.thread && t.thread.length > 0) {
        const threadLines = t.thread
          .map((n) => {
            const d = new Date(n.created_at).toISOString().split("T")[0];
            return `  - (${d}) ${n.content.slice(0, 200)}`;
          })
          .join("\n");
        body += `\n\n  [Thread] ${t.thread.length} related note${t.thread.length > 1 ? "s" : ""}:\n${threadLines}`;
      }

      return body;
    })
    .join("\n\n");
}
