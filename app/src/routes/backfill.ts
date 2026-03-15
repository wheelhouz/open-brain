import { Hono } from "hono";
import { query } from "../db.js";
import { resolveEntityMentions } from "../entities.js";

export const backfillRouter = new Hono();

backfillRouter.post("/", async (c) => {
  let loopsCreated = 0;
  let entitiesCreated = 0;
  let mentionsCreated = 0;

  // Phase 1: Loops from action_items
  const loopThoughts = await query<{
    id: string;
    metadata: { action_items?: Array<string | { content: string; loop_type: string }> };
  }>(
    `SELECT id, metadata FROM thoughts
     WHERE metadata->'action_items' IS NOT NULL
       AND jsonb_array_length(metadata->'action_items') > 0
       AND deleted_at IS NULL
     ORDER BY created_at`,
  );

  for (const thought of loopThoughts.rows) {
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
        loopsCreated++;
      }
    }
  }

  // Phase 2: Entities from people
  const entityThoughts = await query<{
    id: string;
    metadata: { people?: string[] };
  }>(
    `SELECT id, metadata FROM thoughts
     WHERE metadata->'people' IS NOT NULL
       AND jsonb_array_length(metadata->'people') > 0
       AND deleted_at IS NULL
     ORDER BY created_at`,
  );

  const entitiesBefore = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM entities WHERE entity_type = 'person'`,
  );
  const mentionsBefore = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM entity_mentions`,
  );

  for (const thought of entityThoughts.rows) {
    const people = thought.metadata.people || [];
    if (people.length === 0) continue;
    await resolveEntityMentions(people, thought.id);
  }

  const entitiesAfter = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM entities WHERE entity_type = 'person'`,
  );
  const mentionsAfter = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM entity_mentions`,
  );

  entitiesCreated = parseInt(entitiesAfter.rows[0].count) - parseInt(entitiesBefore.rows[0].count);
  mentionsCreated = parseInt(mentionsAfter.rows[0].count) - parseInt(mentionsBefore.rows[0].count);

  return c.json({
    loops_created: loopsCreated,
    entities_created: entitiesCreated,
    mentions_created: mentionsCreated,
  });
});
