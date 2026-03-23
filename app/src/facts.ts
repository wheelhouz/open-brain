import { query } from "./db.js";
import { config } from "./config.js";
import { generateEmbedding } from "./openrouter.js";
import pgvector from "pgvector";
import type { MentionResolution } from "./entities.js";
import { validateFactCandidate } from "./validateFact.js";

export interface FactCandidate {
  entity: string;
  predicate: string;
  value: string;
  display: string;
  confidence: number;
  excerpt: string;
}

export function normalizePredicate(predicate: string): string {
  return predicate
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[.:;,!?]+$/, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

const PREDICATE_DENYLIST = new Set([
  "related_to", "involved_with", "something_about", "talked_about",
  "mentioned", "said", "thinks", "feels", "has",
]);

export function isValidPredicateShape(predicate: string): { valid: boolean; reason?: string } {
  if (!predicate) return { valid: false, reason: "empty_predicate" };
  if (predicate.length > 40) return { valid: false, reason: "predicate_too_long" };
  const tokens = predicate.split("_").filter(Boolean);
  if (tokens.length > 3) return { valid: false, reason: "predicate_too_many_tokens" };
  if (PREDICATE_DENYLIST.has(predicate)) return { valid: false, reason: "predicate_denylist" };
  return { valid: true };
}

export function renderFactEmbeddingText(
  entityCanonicalName: string,
  predicate: string,
  objectDisplayText: string,
): string {
  return `${entityCanonicalName} — ${predicate} — ${objectDisplayText}`;
}

interface ExistingFact {
  id: string;
  predicate: string;
  object_display_text: string;
  object_value_json: unknown;
  status: string;
}

function isSameMeaning(candidate: { predicate: string; display: string }, existing: ExistingFact): boolean {
  if (normalizePredicate(candidate.predicate) !== normalizePredicate(existing.predicate)) return false;
  const normalizedNew = candidate.display.trim().toLowerCase();
  const normalizedExisting = existing.object_display_text.trim().toLowerCase();
  if (normalizedNew === normalizedExisting) return true;
  if (existing.object_value_json && typeof existing.object_value_json === "object") {
    const val = (existing.object_value_json as Record<string, unknown>).value;
    if (typeof val === "string" && val.trim().toLowerCase() === normalizedNew) return true;
  }
  return false;
}

function isConflicting(candidate: { predicate: string; display: string }, existing: ExistingFact): boolean {
  if (normalizePredicate(candidate.predicate) !== normalizePredicate(existing.predicate)) return false;
  if (isSameMeaning(candidate, existing)) return false;
  // Only active, tentative, or disputed facts create live conflicts
  return existing.status !== "superseded";
}

async function embedFact(
  entityName: string,
  predicate: string,
  displayText: string,
): Promise<string> {
  const text = renderFactEmbeddingText(entityName, predicate, displayText);
  const embedding = await generateEmbedding(text, "embed_fact");
  return pgvector.toSql(embedding);
}

export async function processFactCandidates(
  candidates: FactCandidate[],
  thoughtId: string,
  mentionMap: MentionResolution[],
  sourceContent: string,
): Promise<void> {
  const autoLinkedStates = new Set(["auto_linked_exact", "auto_linked_alias", "auto_linked_fuzzy", "new_entity_created"]);
  const mentionLookup = new Map(mentionMap.map((m) => [m.normalized_mention_text, m]));

  for (const candidate of candidates) {
    const display = candidate.display || candidate.value;

    // Clamp out-of-range confidence to 0
    if (candidate.confidence < 0 || candidate.confidence > 1) {
      console.log(JSON.stringify({ event: "fact_candidate_clamped", thoughtId, entity: candidate.entity, predicate: candidate.predicate, display, original: candidate.confidence }));
      candidate.confidence = 0;
    }

    // Filter below threshold
    if (candidate.confidence < config.factConfidenceThreshold) {
      console.log(JSON.stringify({ event: "fact_skipped", reason: "confidence_below_threshold", thoughtId, entity: candidate.entity, predicate: candidate.predicate, display, confidence: candidate.confidence }));
      continue;
    }

    // Validate candidate against source content
    const validation = validateFactCandidate(candidate, sourceContent);
    if (!validation.valid) {
      console.log(JSON.stringify({ event: "fact_skipped", thoughtId, entity: candidate.entity, predicate: normalizePredicate(candidate.predicate), display, reasons: validation.reasons, containingLine: validation.containingLine }));
      continue;
    }
    if (validation.flagged) {
      console.log(JSON.stringify({ event: "fact_flagged", thoughtId, entity: candidate.entity, predicate: normalizePredicate(candidate.predicate), display, reasons: validation.reasons }));
    }

    // Resolve entity from mention map
    const normalized = candidate.entity.trim().toLowerCase();
    const mention = mentionLookup.get(normalized);
    if (!mention || !autoLinkedStates.has(mention.resolution_state)) {
      console.log(JSON.stringify({ event: "fact_skipped", reason: "entity_unresolved", thoughtId, entity: candidate.entity, predicate: candidate.predicate, display, resolution_state: mention?.resolution_state ?? null }));
      continue;
    }

    const entityId = mention.entity_id;
    const predicate = normalizePredicate(candidate.predicate);
    const displayText = candidate.display || candidate.value;
    let objectValueJson: unknown = null;

    // Attempt structured parsing for known patterns
    const dateMatch = candidate.value.match(/^\d{4}-\d{2}-\d{2}$/);
    if (dateMatch) {
      objectValueJson = { value: candidate.value, type: "date" };
    } else {
      const numMatch = candidate.value.match(/^-?\d+(\.\d+)?$/);
      if (numMatch) {
        objectValueJson = { value: parseFloat(candidate.value), type: "number" };
      } else {
        objectValueJson = { value: candidate.value };
      }
    }

    // Check existing facts for this entity
    const existing = await query<ExistingFact>(
      `SELECT id, predicate, object_display_text, object_value_json, status
       FROM entity_facts
       WHERE entity_id = $1 AND review_state != 'rejected'`,
      [entityId],
    );

    // Classify against existing facts
    const sameMeaning = existing.rows.find((f) => isSameMeaning({ predicate, display: displayText }, f));
    const conflicting = existing.rows.find((f) => isConflicting({ predicate, display: displayText }, f));

    let factId: string;

    if (sameMeaning) {
      // Attach evidence to existing fact, refresh timestamp
      factId = sameMeaning.id;
      await query(
        `UPDATE entity_facts SET updated_at = now() WHERE id = $1`,
        [factId],
      );
      console.log(JSON.stringify({ event: "fact_dedup", thoughtId, entity: candidate.entity, predicate, display: displayText, existingFactId: factId }));
    } else if (conflicting) {
      // Insert new fact as disputed
      const embeddingVal = await embedFact(mention.raw_mention_text, predicate, displayText);
      const result = await query<{ id: string }>(
        `INSERT INTO entity_facts (entity_id, predicate, object_value_json, object_display_text, status, review_state, confidence, source_kind, embedding)
         VALUES ($1, $2, $3, $4, 'disputed', 'pending', $5, 'extracted', $6)
         RETURNING id`,
        [entityId, predicate, JSON.stringify(objectValueJson), displayText, candidate.confidence, embeddingVal],
      );
      factId = result.rows[0].id;

      // Mark existing fact as disputed too
      await query(
        `UPDATE entity_facts SET status = 'disputed', updated_at = now() WHERE id = $1 AND status != 'disputed'`,
        [conflicting.id],
      );
      console.log(JSON.stringify({ event: "fact_inserted", thoughtId, entity: candidate.entity, predicate, display: displayText, factId, status: "disputed", conflictsWith: conflicting.id }));
    } else {
      // No conflict — insert as tentative/pending
      const embeddingVal = await embedFact(mention.raw_mention_text, predicate, displayText);
      const result = await query<{ id: string }>(
        `INSERT INTO entity_facts (entity_id, predicate, object_value_json, object_display_text, status, review_state, confidence, source_kind, embedding)
         VALUES ($1, $2, $3, $4, 'tentative', 'pending', $5, 'extracted', $6)
         RETURNING id`,
        [entityId, predicate, JSON.stringify(objectValueJson), displayText, candidate.confidence, embeddingVal],
      );
      factId = result.rows[0].id;
      console.log(JSON.stringify({ event: "fact_inserted", thoughtId, entity: candidate.entity, predicate, display: displayText, factId, status: "tentative" }));
    }

    // Attach evidence
    await query(
      `INSERT INTO entity_fact_evidence (fact_id, thought_id, excerpt, evidence_type)
       VALUES ($1, $2, $3, 'extraction')
       ON CONFLICT (fact_id, thought_id) DO NOTHING`,
      [factId, thoughtId, candidate.excerpt],
    );
  }
}
