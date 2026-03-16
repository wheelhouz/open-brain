import { query } from "./db.js";
import { config } from "./config.js";

/**
 * Resolve person names to canonical entity records.
 * Pure SQL — no LLM calls.
 *
 * For each name:
 * 1. Exact match on lower(canonical_name) where entity_type = 'person'
 * 2. Alias match via ILIKE ANY(aliases)
 * 3. Fuzzy match via pg_trgm similarity (auto-adds alias on hit)
 * 4. No match → create new entity with name as sole alias
 * 5. Upsert entity_mentions row
 */
export async function resolveEntityMentions(
  names: string[],
  thoughtId: string,
): Promise<void> {
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;

    let entityId: string | null = null;

    // 1. Exact match on canonical_name
    const exact = await query<{ id: string }>(
      `SELECT id FROM entities WHERE lower(canonical_name) = lower($1) AND entity_type = 'person'`,
      [trimmed],
    );

    if (exact.rows.length > 0) {
      entityId = exact.rows[0].id;
    } else {
      // 2. Alias match
      const aliasMatch = await query<{ id: string }>(
        `SELECT id FROM entities WHERE $1 ILIKE ANY(aliases) AND entity_type = 'person' LIMIT 1`,
        [trimmed],
      );

      if (aliasMatch.rows.length > 0) {
        entityId = aliasMatch.rows[0].id;
      } else {
        // 3. Fuzzy match via pg_trgm
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
          // Auto-add as alias for future exact lookups
          await query(
            `UPDATE entities SET aliases = array_append(aliases, $1), updated_at = now()
             WHERE id = $2 AND NOT ($1 = ANY(aliases))`,
            [trimmed, entityId],
          );
        } else {
          // 4. Create new entity
          const created = await query<{ id: string }>(
            `INSERT INTO entities (canonical_name, entity_type, aliases)
             VALUES ($1, 'person', ARRAY[$1])
             ON CONFLICT (lower(canonical_name), entity_type) DO UPDATE SET updated_at = now()
             RETURNING id`,
            [trimmed],
          );
          entityId = created.rows[0].id;
        }
      }
    }

    // 5. Upsert entity_mentions
    await query(
      `INSERT INTO entity_mentions (entity_id, thought_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [entityId, thoughtId],
    );
  }
}
