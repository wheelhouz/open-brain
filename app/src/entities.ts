import { query } from "./db.js";

/**
 * Resolve person names to canonical entity records.
 * Pure SQL — no LLM calls.
 *
 * For each name:
 * 1. Exact match on lower(canonical_name) where entity_type = 'person'
 * 2. Alias match via ILIKE ANY(aliases)
 * 3. No match → create new entity with name as sole alias
 * 4. Upsert entity_mentions row
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
        // 3. Create new entity
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

    // 4. Upsert entity_mentions
    await query(
      `INSERT INTO entity_mentions (entity_id, thought_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [entityId, thoughtId],
    );
  }
}
