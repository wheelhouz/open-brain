import { query } from "./db.js";
import { generateEmbedding } from "./openrouter.js";
import pgvector from "pgvector";

interface EntityIdentity {
  id: string;
  canonical_name: string;
  entity_type: string;
  aliases: string[];
}

interface GroundingFact {
  id: string;
  predicate: string;
  object_display_text: string;
  status: string;
  confidence: number | null;
  valid_at_start: string | null;
  valid_at_end: string | null;
  evidence: Array<{ excerpt: string | null; evidence_type: string }>;
}

interface GroundingThought {
  id: string;
  content: string;
  created_at: string;
  similarity: number;
}

export interface EntityGroundingContext {
  entity: EntityIdentity;
  facts: GroundingFact[];
  thoughts: GroundingThought[];
}

const FACT_LIMIT = 12;
const THOUGHT_LIMIT = 5;

export async function buildEntityGroundingContext(
  entityId: string,
  userQuery: string,
): Promise<EntityGroundingContext> {
  // 1. Entity identity
  const entityResult = await query<EntityIdentity>(
    `SELECT id, canonical_name, entity_type, aliases FROM entities WHERE id = $1`,
    [entityId],
  );
  if (entityResult.rows.length === 0) {
    throw new Error("Entity not found");
  }
  const entity = entityResult.rows[0];

  // 2. Embed user query for fact matching
  const queryEmbedding = await generateEmbedding(userQuery);
  const embeddingSql = pgvector.toSql(queryEmbedding);

  // 2a. Always include disputed facts
  const disputedFacts = await query(
    `SELECT id, predicate, object_display_text, status, confidence, valid_at_start, valid_at_end
     FROM entity_facts
     WHERE entity_id = $1 AND status = 'disputed' AND review_state != 'rejected'`,
    [entityId],
  );

  // 2b. Retrieve remaining facts by embedding similarity
  const disputedIds = disputedFacts.rows.map((f: any) => f.id);
  const remainingSlots = FACT_LIMIT - disputedFacts.rows.length;

  let semanticFacts: any[] = [];
  if (remainingSlots > 0) {
    const result = await query(
      `SELECT id, predicate, object_display_text, status, confidence, valid_at_start, valid_at_end,
              1 - (embedding <=> $1) as similarity
       FROM entity_facts
       WHERE entity_id = $2 AND review_state != 'rejected'
         AND embedding IS NOT NULL
         ${disputedIds.length > 0 ? `AND id != ALL($4)` : ""}
       ORDER BY embedding <=> $1
       LIMIT $3`,
      disputedIds.length > 0
        ? [embeddingSql, entityId, remainingSlots, disputedIds]
        : [embeddingSql, entityId, remainingSlots],
    );
    semanticFacts = result.rows;
  }

  const allFacts = [...disputedFacts.rows, ...semanticFacts];

  // 3. Load evidence for selected facts
  const factIds = allFacts.map((f: any) => f.id);
  const evidenceMap = new Map<string, any[]>();

  if (factIds.length > 0) {
    const evidenceResult = await query(
      `SELECT fact_id, excerpt, evidence_type FROM entity_fact_evidence
       WHERE fact_id = ANY($1) ORDER BY created_at DESC`,
      [factIds],
    );
    for (const e of evidenceResult.rows) {
      const arr = evidenceMap.get(e.fact_id) || [];
      // Limit evidence per fact: 2 normally, 1 per side for disputed
      if (arr.length < 2) arr.push(e);
      evidenceMap.set(e.fact_id, arr);
    }
  }

  const groundingFacts: GroundingFact[] = allFacts.map((f: any) => ({
    ...f,
    evidence: evidenceMap.get(f.id) || [],
  }));

  // 4. Recent entity-filtered thoughts
  const thoughtResult = await query<GroundingThought>(
    `SELECT t.id, t.content, t.created_at,
            1 - (t.embedding <=> $1) as similarity
     FROM thoughts t
     JOIN entity_mentions em ON em.thought_id = t.id
     WHERE em.entity_id = $2 AND t.deleted_at IS NULL AND t.embedding IS NOT NULL
     ORDER BY t.embedding <=> $1
     LIMIT $3`,
    [embeddingSql, entityId, THOUGHT_LIMIT],
  );

  return {
    entity,
    facts: groundingFacts,
    thoughts: thoughtResult.rows,
  };
}

export function formatEntityGroundingPrompt(ctx: EntityGroundingContext): string {
  const parts: string[] = [];

  // Entity identity
  parts.push(`Entity: ${ctx.entity.canonical_name} (${ctx.entity.entity_type})`);
  if (ctx.entity.aliases.length > 0) {
    parts.push(`Also known as: ${ctx.entity.aliases.join(", ")}`);
  }

  // Facts
  if (ctx.facts.length > 0) {
    parts.push("\n--- Facts ---");
    for (const fact of ctx.facts) {
      let line = `[${fact.status}] ${fact.predicate}: ${fact.object_display_text}`;
      if (fact.valid_at_end) line += ` (until ${fact.valid_at_end})`;
      if (fact.confidence && fact.confidence < 0.9) line += ` (confidence: ${(fact.confidence * 100).toFixed(0)}%)`;
      parts.push(line);

      for (const e of fact.evidence) {
        if (e.excerpt) parts.push(`  Evidence: ${e.excerpt}`);
      }
    }
  }

  // Thoughts
  if (ctx.thoughts.length > 0) {
    parts.push("\n--- Recent Mentions ---");
    for (const t of ctx.thoughts) {
      const date = new Date(t.created_at).toISOString().split("T")[0];
      parts.push(`[${date}] ${t.content.slice(0, 500)}`);
    }
  }

  return parts.join("\n");
}
