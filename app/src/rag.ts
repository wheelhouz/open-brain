import { query } from "./db.js";
import { generateEmbedding, rewriteQuery } from "./openrouter.js";
import { config } from "./config.js";
import pgvector from "pgvector";

export interface RetrievedThought {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
  parent_id?: string | null;
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

export interface MemoryCandidate {
  memory_type: "thought" | "loop" | "fact";
  id: string;
  content: string;
  source: string;
  score: number;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface SearchMemoryOptions {
  query: string;
  filter?: Record<string, unknown>;
  timeHint?: "recent" | "last_month" | "older" | null;
  limit?: number;
  threshold?: number;
  memoryTypes?: ("thoughts" | "loops" | "facts" | "all")[];
  preferOpenLoops?: boolean;
  entityIds?: string[];
}

export interface SearchMemoryResult {
  candidates: MemoryCandidate[];
  diagnostics: RAGDiagnostics & { loopCandidateCount: number; modelMismatchExclusions: number };
}

const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_HALF_LIFE_DAYS_TIME = 14;
const ENTITY_LINK_BOOST = 0.15;
const STRUCTURAL_DEFAULT_SCORE = 0.25;

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

interface RankCandidate {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
  parent_id?: string | null;
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
      weights.thread * (c.parent_id ? 1.0 : 0.0);
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
  } = options;
  const poolSize = options.poolSize ?? Math.max(limit * 2, 15);

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
    parent_id: r.parent_id,
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

    const parentIds = top3
      .map((t) => t.parent_id)
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
      const parentId = thought.parent_id;
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

export async function searchMemory(options: SearchMemoryOptions): Promise<SearchMemoryResult> {
  const {
    query: searchQuery,
    filter = {},
    timeHint = null,
    limit = 10,
    threshold = 0.25,
    memoryTypes = ["all"],
  } = options;

  const start = Date.now();

  const shouldQuery = (type: "thoughts" | "loops" | "facts") =>
    memoryTypes.includes("all") || memoryTypes.includes(type);

  const embedding = await generateEmbedding(searchQuery);
  const embeddingSql = pgvector.toSql(embedding);

  const candidates: MemoryCandidate[] = [];
  let loopCandidateCount = 0;
  let modelMismatchExclusions = 0;

  // Thought retrieval — reuse existing patterns
  if (shouldQuery("thoughts")) {
    const dbFilter: Record<string, unknown> = {};
    if (filter.people && Array.isArray(filter.people) && filter.people.length > 0) {
      dbFilter.people = filter.people;
    }
    if (filter.topics && Array.isArray(filter.topics) && filter.topics.length > 0) {
      dbFilter.topics = filter.topics;
    }

    const poolSize = Math.max(limit * 2, 15);
    const result = await query(
      `SELECT * FROM match_thoughts($1, $2, $3, $4)`,
      [embeddingSql, threshold, poolSize, JSON.stringify(dbFilter)],
    );

    let thoughtCandidates: RankCandidate[] = result.rows.map((r: any) => ({
      id: r.id,
      content: r.content,
      metadata: r.metadata,
      similarity: r.similarity,
      created_at: r.created_at,
      parent_id: r.parent_id,
    }));

    // Recency slice
    if (timeHint === "recent") {
      const recentResult = await query(
        `SELECT id, content, metadata, created_at FROM thoughts
         WHERE deleted_at IS NULL AND created_at > now() - interval '7 days'
         ORDER BY created_at DESC LIMIT 5`,
      );
      const existingIds = new Set(thoughtCandidates.map((c) => c.id));
      for (const r of recentResult.rows as any[]) {
        if (!existingIds.has(r.id)) {
          thoughtCandidates.push({
            id: r.id,
            content: r.content,
            metadata: r.metadata,
            similarity: 0.3,
            created_at: r.created_at,
          });
        }
      }
    }

    const reranked = rerank(thoughtCandidates, filter, timeHint, limit);

    // Thread expansion for top 3
    const top3 = reranked.slice(0, 3);
    if (top3.length > 0) {
      const top3Ids = top3.map((t) => t.id);
      const parentIds = top3.map((t) => t.parent_id).filter(Boolean) as string[];

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
        const parentId = thought.parent_id;
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

    // Map to MemoryCandidate
    for (const t of reranked) {
      candidates.push({
        memory_type: "thought",
        id: t.id,
        content: t.content,
        source: "thoughts",
        score: t.similarity,
        timestamp: t.created_at,
        metadata: {
          ...t.metadata,
          parent_id: t.parent_id,
          thread: t.thread,
        },
      });
    }

    // Lexical fallback: when semantic results are sparse, supplement with text match
    const LEXICAL_FALLBACK_THRESHOLD = 3;
    const topScore = reranked.length > 0 ? reranked[0].similarity : 0;
    if (reranked.length < LEXICAL_FALLBACK_THRESHOLD || topScore < 0.3) {
      // Extract key terms from query (words 3+ chars, skip stopwords)
      const stopwords = new Set(["the", "what", "about", "that", "this", "with", "from", "have", "been", "does", "did", "was", "were", "are", "for", "and", "how", "why", "who", "when", "where", "which"]);
      const terms = searchQuery.toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length >= 3 && !stopwords.has(w));

      if (terms.length > 0) {
        const existingIds = new Set(candidates.map((c) => c.id));
        // Use ILIKE with each term individually for broader matching
        const termConditions = terms.map((_, i) => `content ILIKE $${i + 1}`);
        const lexicalResult = await query(
          `SELECT id, content, metadata, created_at, parent_id
           FROM thoughts
           WHERE deleted_at IS NULL
             AND (${termConditions.join(" OR ")})
           ORDER BY created_at DESC
           LIMIT $${terms.length + 1}`,
          [...terms.map((t) => `%${t}%`), limit],
        );

        for (const r of lexicalResult.rows as any[]) {
          if (!existingIds.has(r.id)) {
            existingIds.add(r.id);
            // Count how many terms matched for scoring
            const contentLower = r.content.toLowerCase();
            const matchCount = terms.filter((t) => contentLower.includes(t)).length;
            candidates.push({
              memory_type: "thought",
              id: r.id,
              content: r.content,
              source: "thoughts",
              score: 0.15 + 0.05 * matchCount, // lower than vector results
              timestamp: r.created_at,
              metadata: {
                ...r.metadata,
                parent_id: r.parent_id,
                _lexical_fallback: true,
              },
            });
          }
        }
      }
    }
  }

  // Loop retrieval
  if (shouldQuery("loops")) {
    const currentModel = config.embeddingModel;
    const loopIds = new Set<string>();
    const loopScores = new Map<string, number>(); // track best score per loop

    // Count model mismatches for diagnostics
    const mismatchResult = await query(
      `SELECT COUNT(*)::int as count FROM open_loops
       WHERE embedding IS NOT NULL
         AND embedding_model != $1
         AND (status = 'open' OR (status = 'snoozed' AND snoozed_until <= now()))`,
      [currentModel],
    );
    modelMismatchExclusions = mismatchResult.rows[0]?.count ?? 0;

    const hasEntityScope = options.entityIds && options.entityIds.length > 0;
    const isActionQuery = options.preferOpenLoops === true;

    // --- Structural provenance recall (entity-linked loops) ---
    // Fires when BOTH: entity is resolved AND query is action/status-oriented
    // Fetches loops by entity → mentions → source_thought → loops (no embedding required)
    const structuralLoops: Array<{ id: string; content: string; loop_type: string; status: string; source_thought_id: string; created_at: string }> = [];

    if (hasEntityScope && isActionQuery) {
      const structuralResult = await query(
        `SELECT * FROM (
           SELECT DISTINCT ON (ol.id)
                  ol.id, ol.content, ol.loop_type, ol.status, ol.source_thought_id, ol.created_at
           FROM open_loops ol
           JOIN entity_mentions em ON em.thought_id = ol.source_thought_id
           WHERE em.entity_id = ANY($1)
             AND (ol.status = 'open' OR (ol.status = 'snoozed' AND ol.snoozed_until <= now()))
           ORDER BY ol.id
         ) deduped
         ORDER BY created_at DESC`,
        [options.entityIds],
      );

      structuralLoops.push(...(structuralResult.rows as any[]));

      // Fetch source thought embeddings for scoring
      const sourceThoughtIds = [...new Set(structuralLoops.map((l) => l.source_thought_id).filter(Boolean))];
      const sourceThoughtSimilarities = new Map<string, number>();

      if (sourceThoughtIds.length > 0) {
        const sourceThoughts = await query(
          `SELECT id, 1 - (embedding <=> $1) as similarity
           FROM thoughts
           WHERE id = ANY($2) AND deleted_at IS NULL AND embedding IS NOT NULL`,
          [embeddingSql, sourceThoughtIds],
        );
        for (const r of sourceThoughts.rows as any[]) {
          sourceThoughtSimilarities.set(r.id, r.similarity);
        }
      }

      for (const r of structuralLoops) {
        loopIds.add(r.id);
        const sourceThoughtSim = sourceThoughtSimilarities.get(r.source_thought_id) ?? null;
        const baseScore = sourceThoughtSim !== null ? sourceThoughtSim : STRUCTURAL_DEFAULT_SCORE;
        const score = baseScore + ENTITY_LINK_BOOST;
        loopScores.set(r.id, score);

        candidates.push({
          memory_type: "loop",
          id: r.id,
          content: r.content,
          source: "open_loops",
          score,
          timestamp: r.created_at,
          metadata: {
            loop_type: r.loop_type,
            status: r.status,
            source_thought_id: r.source_thought_id,
            _provenance: true,
          },
        });
      }
    }

    // --- Semantic loop retrieval (vector similarity on loop content) ---
    // Secondary/supplementary: catches semantically relevant loops, explicit name matches,
    // and loops whose source thought was not properly linked
    let entityFilter = "";
    const loopParams: unknown[] = [embeddingSql, currentModel, limit];
    if (hasEntityScope) {
      entityFilter = `AND source_thought_id IN (SELECT thought_id FROM entity_mentions WHERE entity_id = ANY($4))`;
      loopParams.push(options.entityIds);
    }

    const loopResult = await query(
      `SELECT id, content, loop_type, status, source_thought_id, created_at,
              1 - (embedding <=> $1) as similarity,
              embedding_model
       FROM open_loops
       WHERE embedding IS NOT NULL
         AND embedding_model = $2
         AND (status = 'open' OR (status = 'snoozed' AND snoozed_until <= now()))
         ${entityFilter}
       ORDER BY embedding <=> $1
       LIMIT $3`,
      loopParams,
    );

    for (const r of loopResult.rows as any[]) {
      if (r.similarity >= threshold) {
        if (loopIds.has(r.id)) {
          // Loop already from structural recall — take best score
          const existingScore = loopScores.get(r.id) ?? 0;
          const semanticScore = r.similarity;
          if (semanticScore > existingScore) {
            // Update the candidate's score to the better one (keep entity boost)
            const newScore = hasEntityScope && isActionQuery ? semanticScore + ENTITY_LINK_BOOST : semanticScore;
            const existing = candidates.find((c) => c.id === r.id && c.memory_type === "loop");
            if (existing) existing.score = Math.max(existing.score, newScore);
            loopScores.set(r.id, Math.max(existingScore, newScore));
          }
        } else {
          loopIds.add(r.id);
          loopScores.set(r.id, r.similarity);
          candidates.push({
            memory_type: "loop",
            id: r.id,
            content: r.content,
            source: "open_loops",
            score: r.similarity,
            timestamp: r.created_at,
            metadata: {
              loop_type: r.loop_type,
              status: r.status,
              source_thought_id: r.source_thought_id,
              embedding_model: r.embedding_model,
            },
          });
        }
      }
    }

    // --- Direct injection for non-entity action queries ---
    // When preferOpenLoops is true but no entity scope, supplement with recent actionable loops
    if (isActionQuery && !hasEntityScope) {
      const directResult = await query(
        `SELECT id, content, loop_type, status, source_thought_id, created_at
         FROM open_loops
         WHERE (status = 'open' OR (status = 'snoozed' AND snoozed_until <= now()))
         ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );

      for (const r of directResult.rows as any[]) {
        if (!loopIds.has(r.id)) {
          loopIds.add(r.id);
          candidates.push({
            memory_type: "loop",
            id: r.id,
            content: r.content,
            source: "open_loops",
            score: 0.3,
            timestamp: r.created_at,
            metadata: {
              loop_type: r.loop_type,
              status: r.status,
              source_thought_id: r.source_thought_id,
            },
          });
        }
      }
    }

    loopCandidateCount = loopIds.size;

    if (modelMismatchExclusions > 0) {
      console.log(JSON.stringify({
        event: "search_memory_model_mismatch",
        exclusions: modelMismatchExclusions,
        currentModel,
      }));
    }
  }

  // Merge: sort by score descending, take top limit
  candidates.sort((a, b) => b.score - a.score);
  const finalCandidates = candidates.slice(0, limit);

  const diagnostics = {
    rewrittenQuery: searchQuery,
    filter,
    timeHint,
    candidateCount: candidates.length,
    finalCount: finalCandidates.length,
    latencyMs: Date.now() - start,
    loopCandidateCount,
    modelMismatchExclusions,
  };

  console.log(JSON.stringify({ event: "search_memory", ...diagnostics }));

  return { candidates: finalCandidates, diagnostics };
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
      // people from cached metadata — display convenience, not source of truth (entity_mentions is authoritative)
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
