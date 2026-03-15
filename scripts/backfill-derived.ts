/**
 * Backfill script for derived memory objects.
 *
 * Phase 1: Creates open_loops from historical action_items in thought metadata.
 * Phase 2: Creates entities and entity_mentions from historical people in thought metadata.
 *
 * Idempotent — safe to re-run. Uses ON CONFLICT DO NOTHING for all inserts.
 *
 * Usage: npx tsx scripts/backfill-derived.ts
 * Requires: DATABASE_URL environment variable
 */

import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });

async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

async function backfillLoops() {
  console.log("Phase 1: Backfilling open_loops from action_items...");

  const thoughts = await query<{
    id: string;
    metadata: { action_items?: Array<string | { content: string; loop_type: string }> };
  }>(
    `SELECT id, metadata FROM thoughts
     WHERE metadata->'action_items' IS NOT NULL
       AND jsonb_array_length(metadata->'action_items') > 0
       AND deleted_at IS NULL
     ORDER BY created_at`,
  );

  let created = 0;

  for (const thought of thoughts.rows) {
    const items = thought.metadata.action_items || [];

    for (const item of items) {
      const content = typeof item === "string" ? item : item.content;
      const loopType = typeof item === "string" ? "task" : item.loop_type || "task";

      if (!content?.trim()) continue;

      const result = await query<{ id: string }>(
        `INSERT INTO open_loops (content, loop_type, source_thought_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [content.trim(), loopType, thought.id],
      );

      if (result.rows.length > 0) {
        await query(
          `INSERT INTO open_loop_evidence (loop_id, thought_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [result.rows[0].id, thought.id],
        );
        created++;
      }
    }
  }

  console.log(`  Created ${created} open loops.`);
}

async function backfillEntities() {
  console.log("Phase 2: Backfilling entities from people...");

  const thoughts = await query<{
    id: string;
    metadata: { people?: string[] };
  }>(
    `SELECT id, metadata FROM thoughts
     WHERE metadata->'people' IS NOT NULL
       AND jsonb_array_length(metadata->'people') > 0
       AND deleted_at IS NULL
     ORDER BY created_at`,
  );

  let entitiesCreated = 0;
  let mentionsCreated = 0;

  for (const thought of thoughts.rows) {
    const people = thought.metadata.people || [];

    for (const name of people) {
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
          entitiesCreated++;
        }
      }

      // 4. Upsert entity_mentions
      const mention = await query(
        `INSERT INTO entity_mentions (entity_id, thought_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [entityId, thought.id],
      );

      if ((mention as pg.QueryResult).rowCount && (mention as pg.QueryResult).rowCount! > 0) {
        mentionsCreated++;
      }
    }
  }

  console.log(`  Created ${entitiesCreated} entities and ${mentionsCreated} mentions.`);
}

async function main() {
  console.log("Backfill derived memory objects\n");

  try {
    await backfillLoops();
    await backfillEntities();
    console.log("\nDone.");
  } catch (err) {
    console.error("Backfill failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
