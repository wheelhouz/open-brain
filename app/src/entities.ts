import { query } from "./db.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

export type ResolutionState =
  | "auto_linked_exact"
  | "auto_linked_alias"
  | "auto_linked_fuzzy"
  | "new_entity_created"
  | "pending_review"
  | "merged_after_review"
  | "rejected";

export interface MentionResolution {
  raw_mention_text: string;
  normalized_mention_text: string;
  entity_id: string;
  resolution_state: ResolutionState;
  resolution_confidence: number;
  resolution_metadata: Record<string, unknown> | null;
}

/**
 * Resolve person names to canonical entity records.
 * Pure SQL — no LLM calls.
 *
 * For each name:
 * 1. Exact match on lower(canonical_name) where entity_type = 'person'
 * 2. Alias match via ILIKE ANY(aliases)
 * 3. Fuzzy match via pg_trgm similarity (auto-adds alias on hit)
 * 4. No match → create new entity with name as sole alias
 * 5. Upsert entity_mentions row with enrichment columns
 */
export async function resolveEntityMentions(
  names: string[],
  thoughtId: string,
): Promise<MentionResolution[]> {
  const results: MentionResolution[] = [];

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLowerCase();

    let entityId: string | null = null;
    let resolutionState: ResolutionState = "new_entity_created";
    let confidence = 1.0;
    let metadata: Record<string, unknown> | null = null;

    // 1. Exact match on canonical_name
    const exact = await query<{ id: string }>(
      `SELECT id FROM entities WHERE lower(canonical_name) = lower($1) AND entity_type = 'person' LIMIT 1`,
      [trimmed],
    );

    if (exact.rows.length > 0) {
      entityId = exact.rows[0].id;
      resolutionState = "auto_linked_exact";
      confidence = 1.0;
      metadata = { match_type: "canonical" };
    }

    // 2. Alias match
    if (!entityId) {
      const alias = await query<{ id: string }>(
        `SELECT id FROM entities WHERE $1 ILIKE ANY(aliases) AND entity_type = 'person' LIMIT 1`,
        [trimmed],
      );
      if (alias.rows.length > 0) {
        entityId = alias.rows[0].id;
        resolutionState = "auto_linked_alias";
        confidence = 1.0;
        metadata = { match_type: "alias", matched_alias: trimmed };
      }
    }

    // 3. Fuzzy match via pg_trgm
    if (!entityId) {
      const fuzzy = await query<{ id: string; sim: number }>(
        `SELECT id,
                greatest(
                  similarity(lower(canonical_name), lower($1)),
                  coalesce((SELECT max(similarity(lower(a), lower($1))) FROM unnest(aliases) a), 0)
                ) AS sim
         FROM entities
         WHERE entity_type = 'person'
           AND (
             lower(canonical_name) % lower($1)
             OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) % lower($1))
           )
         ORDER BY sim DESC
         LIMIT 1`,
        [trimmed],
      );

      if (fuzzy.rows.length > 0 && fuzzy.rows[0].sim >= config.entityFuzzyThreshold) {
        entityId = fuzzy.rows[0].id;
        resolutionState = "auto_linked_fuzzy";
        confidence = fuzzy.rows[0].sim;
        metadata = { match_type: "fuzzy", similarity: fuzzy.rows[0].sim };

        // Auto-add as alias for future exact lookups
        await query(
          `UPDATE entities SET aliases = array_append(aliases, $1), updated_at = now()
           WHERE id = $2 AND NOT ($1 = ANY(aliases))`,
          [trimmed, entityId],
        );
      }
    }

    // 4. Create new entity
    if (!entityId) {
      const created = await query<{ id: string }>(
        `INSERT INTO entities (canonical_name, entity_type, aliases)
         VALUES ($1, 'person', ARRAY[$1])
         ON CONFLICT (lower(canonical_name), entity_type) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [trimmed],
      );
      entityId = created.rows[0].id;
      resolutionState = "new_entity_created";
      confidence = 1.0;
      metadata = null;
    }

    // 5. Upsert entity_mentions with enrichment columns
    await query(
      `INSERT INTO entity_mentions (entity_id, thought_id, raw_mention_text, normalized_mention_text, resolution_state, resolution_confidence, resolution_metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (entity_id, thought_id) DO NOTHING`,
      [entityId, thoughtId, trimmed, normalized, resolutionState, confidence, metadata ? JSON.stringify(metadata) : null],
    );

    logger.info({ event: "entity_resolved", name: trimmed, state: resolutionState, confidence, entityId });

    results.push({
      raw_mention_text: trimmed,
      normalized_mention_text: normalized,
      entity_id: entityId,
      resolution_state: resolutionState,
      resolution_confidence: confidence,
      resolution_metadata: metadata,
    });
  }

  return results;
}

export interface MentionRecord {
  entity_id: string;
  thought_id: string;
  raw_mention_text: string;
  normalized_mention_text: string;
  resolution_state: ResolutionState;
  resolution_confidence: number;
  resolution_metadata_json: Record<string, unknown> | null;
}

/**
 * Pure mention resolver for reprocess path — read-only, no writes.
 * Skips unresolvable names (does NOT auto-create entities).
 */
export async function computeEntityMentions(
  names: string[],
  thoughtId: string,
): Promise<MentionRecord[]> {
  const results: MentionRecord[] = [];

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLowerCase();

    // 1. Exact match
    const exact = await query<{ id: string }>(
      `SELECT id FROM entities WHERE lower(canonical_name) = lower($1) AND entity_type = 'person' LIMIT 1`,
      [trimmed],
    );
    if (exact.rows.length > 0) {
      results.push({
        entity_id: exact.rows[0].id, thought_id: thoughtId,
        raw_mention_text: trimmed, normalized_mention_text: normalized,
        resolution_state: "auto_linked_exact", resolution_confidence: 1.0,
        resolution_metadata_json: { match_type: "canonical" },
      });
      continue;
    }

    // 2. Alias match
    const alias = await query<{ id: string }>(
      `SELECT id FROM entities WHERE $1 ILIKE ANY(aliases) AND entity_type = 'person' LIMIT 1`,
      [trimmed],
    );
    if (alias.rows.length > 0) {
      results.push({
        entity_id: alias.rows[0].id, thought_id: thoughtId,
        raw_mention_text: trimmed, normalized_mention_text: normalized,
        resolution_state: "auto_linked_alias", resolution_confidence: 1.0,
        resolution_metadata_json: { match_type: "alias" },
      });
      continue;
    }

    // 3. Fuzzy match
    const fuzzy = await query<{ id: string; sim: number }>(
      `SELECT id,
              greatest(
                similarity(lower(canonical_name), lower($1)),
                coalesce((SELECT max(similarity(lower(a), lower($1))) FROM unnest(aliases) a), 0)
              ) AS sim
       FROM entities WHERE entity_type = 'person'
         AND (lower(canonical_name) % lower($1) OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) % lower($1)))
       ORDER BY sim DESC LIMIT 1`,
      [trimmed],
    );
    if (fuzzy.rows.length > 0 && fuzzy.rows[0].sim >= config.entityFuzzyThreshold) {
      results.push({
        entity_id: fuzzy.rows[0].id, thought_id: thoughtId,
        raw_mention_text: trimmed, normalized_mention_text: normalized,
        resolution_state: "auto_linked_fuzzy", resolution_confidence: fuzzy.rows[0].sim,
        resolution_metadata_json: { match_type: "fuzzy", similarity: fuzzy.rows[0].sim },
      });
      continue;
    }

    // Unresolvable — skip (no auto-create)
  }

  return results;
}

/**
 * Query-time entity resolver — read-only, no side effects.
 * Person-only for v1. Returns null for unresolvable names.
 */
export async function resolveEntityCandidates(
  names: string[],
): Promise<Array<{ name: string; entity_id: string | null }>> {
  const results: Array<{ name: string; entity_id: string | null }> = [];

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;

    // 1. Exact match
    const exact = await query<{ id: string }>(
      `SELECT id FROM entities WHERE lower(canonical_name) = lower($1) AND entity_type = 'person' LIMIT 1`,
      [trimmed],
    );
    if (exact.rows.length > 0) {
      results.push({ name: trimmed, entity_id: exact.rows[0].id });
      continue;
    }

    // 2. Alias match
    const alias = await query<{ id: string }>(
      `SELECT id FROM entities WHERE $1 ILIKE ANY(aliases) AND entity_type = 'person' LIMIT 1`,
      [trimmed],
    );
    if (alias.rows.length > 0) {
      results.push({ name: trimmed, entity_id: alias.rows[0].id });
      continue;
    }

    // 3. Fuzzy match
    const fuzzy = await query<{ id: string; sim: number }>(
      `SELECT id,
              greatest(
                similarity(lower(canonical_name), lower($1)),
                coalesce((SELECT max(similarity(lower(a), lower($1))) FROM unnest(aliases) a), 0)
              ) AS sim
       FROM entities
       WHERE entity_type = 'person'
         AND (lower(canonical_name) % lower($1) OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) % lower($1)))
       ORDER BY sim DESC LIMIT 1`,
      [trimmed],
    );
    if (fuzzy.rows.length > 0 && fuzzy.rows[0].sim >= config.entityFuzzyThreshold) {
      results.push({ name: trimmed, entity_id: fuzzy.rows[0].id });
      continue;
    }

    // Unresolvable
    results.push({ name: trimmed, entity_id: null });
  }

  return results;
}
