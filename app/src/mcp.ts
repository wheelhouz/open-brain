import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query } from "./db.js";
import { chatCompletion, generateEmbedding } from "./openrouter.js";
import { capturePipeline } from "./pipeline.js";
import { searchWithReranking } from "./rag.js";
import { normalizePredicate, renderFactEmbeddingText } from "./facts.js";
import pgvector from "pgvector";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "open-brain",
    version: "0.1.0",
  });

  // get_thought
  server.tool(
    "get_thought",
    "Retrieve a single thought by its ID.",
    {
      id: z.string().describe("The thought UUID"),
    },
    async ({ id }) => {
      const result = await query(
        `SELECT id, content, metadata, created_at FROM thoughts WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Thought "${id}" not found.` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.rows[0], null, 2) }],
      };
    },
  );

  // search_thoughts
  server.tool(
    "search_thoughts",
    "Search thoughts by semantic similarity to a natural language query. Retrieves a wider candidate pool and reranks by relevance, recency, and metadata overlap.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().default(10).describe("Max results to return"),
      threshold: z.number().default(0.25).describe("Minimum similarity score (0-1)"),
      filter: z.record(z.string(), z.unknown()).default({}).describe("Metadata filter, e.g. {people: ['Liz']}"),
      time_hint: z.enum(["recent", "last_month", "older"]).optional().describe("Temporal bias for reranking"),
    },
    async ({ query: searchQuery, limit, threshold, filter, time_hint }) => {
      const result = await searchWithReranking({
        query: searchQuery,
        limit: Math.min(limit, 100),
        threshold,
        filter,
        timeHint: time_hint,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.thoughts, null, 2),
          },
        ],
      };
    },
  );

  // list_thoughts
  server.tool(
    "list_thoughts",
    "List recent thoughts with optional filters.",
    {
      limit: z.number().default(20).describe("Max results"),
      type: z.string().optional().describe("Filter by thought type"),
      topic: z.string().optional().describe("Filter by topic"),
      person: z.string().optional().describe("Filter by mentioned person"),
      days: z.number().optional().describe("Only thoughts from last N days"),
    },
    async ({ limit, type, topic, person, days }) => {
      const conditions: string[] = ["deleted_at IS NULL"];
      const params: unknown[] = [];
      let idx = 1;

      if (type) {
        conditions.push(`metadata->>'type' = $${idx++}`);
        params.push(type);
      }
      if (topic) {
        conditions.push(`metadata->'topics' ? $${idx++}`);
        params.push(topic);
      }
      if (person) {
        conditions.push(`metadata->'people' ? $${idx++}`);
        params.push(person);
      }
      if (days) {
        conditions.push(`created_at > now() - interval '1 day' * $${idx++}`);
        params.push(days);
      }

      params.push(Math.min(limit, 100));

      const result = await query(
        `SELECT id, content, metadata, created_at
         FROM thoughts
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT $${idx}`,
        params,
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.rows, null, 2) }],
      };
    },
  );

  // thought_stats
  server.tool(
    "thought_stats",
    "Get aggregate statistics about captured thoughts.",
    {},
    async () => {
      const [totalResult, typeResult, topicsResult, peopleResult] = await Promise.all([
        query<{ count: string }>(`SELECT count(*) FROM thoughts WHERE deleted_at IS NULL`),
        query<{ type: string; count: string }>(
          `SELECT metadata->>'type' as type, count(*) as count
           FROM thoughts WHERE deleted_at IS NULL
           GROUP BY metadata->>'type' ORDER BY count DESC`,
        ),
        query<{ topic: string; count: string }>(
          `SELECT topic, count(*) as count
           FROM thoughts, jsonb_array_elements_text(metadata->'topics') as topic
           WHERE deleted_at IS NULL GROUP BY topic ORDER BY count DESC LIMIT 20`,
        ),
        query<{ person: string; count: string }>(
          `SELECT person, count(*) as count
           FROM thoughts, jsonb_array_elements_text(metadata->'people') as person
           WHERE deleted_at IS NULL GROUP BY person ORDER BY count DESC LIMIT 20`,
        ),
      ]);

      const stats = {
        total: parseInt(totalResult.rows[0].count, 10),
        types: typeResult.rows.map((r) => ({ type: r.type, count: parseInt(r.count, 10) })),
        topics: topicsResult.rows.map((r) => ({ topic: r.topic, count: parseInt(r.count, 10) })),
        people: peopleResult.rows.map((r) => ({ person: r.person, count: parseInt(r.count, 10) })),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
      };
    },
  );

  // capture_thought
  server.tool(
    "capture_thought",
    "Capture a new thought. Generates embedding and extracts metadata automatically.",
    {
      content: z.string().describe("The thought to capture"),
      parent_id: z.string().optional().describe("Parent thought ID to link as sub-thought"),
    },
    async ({ content, parent_id }) => {
      const result = await capturePipeline(content, "mcp", parent_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // add_note
  server.tool(
    "add_note",
    "Add a note or commentary to an existing thought. Use when the user wants to save a follow-up, annotation, or AI-generated insight as a sub-thought linked to a parent thought.",
    {
      thought_id: z.string().describe("The parent thought ID to attach the note to"),
      content: z.string().describe("The note content to save"),
    },
    async ({ thought_id, content }) => {
      const parent = await query(
        `SELECT id FROM thoughts WHERE id = $1 AND deleted_at IS NULL`,
        [thought_id],
      );
      if (parent.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Thought "${thought_id}" not found.` }],
        };
      }
      const result = await capturePipeline(content, "mcp_note", thought_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // bulk_import
  server.tool(
    "bulk_import",
    "Import multiple thoughts at once. Used for migrating from other knowledge systems.",
    {
      thoughts: z.array(z.string()).describe("Array of thought content strings to import"),
      normalize: z.boolean().default(true).describe("Rewrite each thought to be self-contained"),
      source_label: z.string().optional().describe("Origin system label"),
    },
    async ({ thoughts, normalize, source_label }) => {
      let imported = 0;
      let failed = 0;

      for (const content of thoughts) {
        try {
          await capturePipeline(content, source_label || "import");
          imported++;
        } catch {
          failed++;
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ imported, failed, total: thoughts.length }, null, 2),
          },
        ],
      };
    },
  );

  // weekly_review
  server.tool(
    "weekly_review",
    "Synthesize the past week's captured thoughts into themes, open action items, and focus areas.",
    {
      days: z.number().default(7).describe("Number of days to review"),
    },
    async ({ days }) => {
      const result = await query<{
        id: string;
        content: string;
        metadata: {
          type?: string;
          topics?: string[];
          people?: string[];
          action_items?: string[];
        };
        created_at: string;
      }>(
        `SELECT id, content, metadata, created_at
         FROM thoughts
         WHERE deleted_at IS NULL AND created_at > now() - interval '1 day' * $1
         ORDER BY created_at DESC`,
        [days],
      );

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No thoughts captured in this period." }],
        };
      }

      const thoughtsSummary = result.rows
        .map((t) => `- [${t.metadata.type || "unknown"}] ${t.content.slice(0, 200)}`)
        .join("\n");

      const review = await chatCompletion(
        `You are a personal knowledge assistant. Analyze the following thoughts captured over the last ${days} days and provide a structured weekly review with: 1) Key themes, 2) Open action items, 3) Most mentioned people, 4) Suggested focus areas for next week.`,
        thoughtsSummary,
      );

      return {
        content: [{ type: "text" as const, text: review }],
      };
    },
  );

  // list_open_loops
  server.tool(
    "list_open_loops",
    "List open loops (action items, questions, decisions, waiting-on items). Filterable by status and type.",
    {
      status: z.enum(["open", "closed", "snoozed"]).default("open").describe("Filter by status"),
      loop_type: z.enum(["task", "question", "decision", "waiting_on"]).optional().describe("Filter by loop type"),
      limit: z.number().default(20).describe("Max results"),
    },
    async ({ status, loop_type, limit }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (status === "open") {
        conditions.push(`(status = 'open' OR (status = 'snoozed' AND snoozed_until <= now()))`);
      } else {
        conditions.push(`status = $${idx++}`);
        params.push(status);
      }

      if (loop_type) {
        conditions.push(`loop_type = $${idx++}`);
        params.push(loop_type);
      }

      params.push(Math.min(limit, 100));

      const result = await query(
        `SELECT id, content, loop_type, status, resolution, source_thought_id, created_at, closed_at
         FROM open_loops
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT $${idx}`,
        params,
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.rows, null, 2) }],
      };
    },
  );

  // close_loop
  server.tool(
    "close_loop",
    "Close an open loop, optionally with a resolution note (answer for questions, rationale for decisions).",
    {
      id: z.string().describe("The loop UUID"),
      resolution: z.string().optional().describe("Resolution text — answer, rationale, or closing note"),
    },
    async ({ id, resolution }) => {
      const result = await query(
        `UPDATE open_loops SET status = 'closed', closed_at = now(), resolution = $2
         WHERE id = $1 AND status != 'closed'
         RETURNING id, content, status`,
        [id, resolution || null],
      );

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Loop "${id}" not found or already closed.` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.rows[0], null, 2) }],
      };
    },
  );

  // snooze_loop
  server.tool(
    "snooze_loop",
    "Snooze a loop until a future date. It will auto-surface in the open list after that date.",
    {
      id: z.string().describe("The loop UUID"),
      until: z.string().describe("ISO 8601 date to snooze until (e.g. 2026-03-21)"),
    },
    async ({ id, until }) => {
      const result = await query(
        `UPDATE open_loops SET status = 'snoozed', snoozed_until = $2
         WHERE id = $1 AND status != 'closed'
         RETURNING id, content, status, snoozed_until`,
        [id, until],
      );

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Loop "${id}" not found or already closed.` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.rows[0], null, 2) }],
      };
    },
  );

  // get_entity
  server.tool(
    "get_entity",
    "Look up a person (entity) by name or alias. Returns the canonical entity record with mention count.",
    {
      name: z.string().describe("Person name to search for (checks canonical name and aliases)"),
    },
    async ({ name }) => {
      const result = await query(
        `SELECT e.id, e.canonical_name, e.entity_type, e.aliases, e.attributes,
                count(em.thought_id) as mention_count
         FROM entities e
         LEFT JOIN entity_mentions em ON em.entity_id = e.id
         WHERE (lower(e.canonical_name) = lower($1) OR $1 ILIKE ANY(e.aliases))
           AND e.entity_type = 'person'
         GROUP BY e.id
         LIMIT 1`,
        [name],
      );

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No entity found matching "${name}".` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.rows[0], null, 2) }],
      };
    },
  );

  // list_entity_mentions
  server.tool(
    "list_entity_mentions",
    "List thoughts that mention a specific entity. Returns the evidence timeline.",
    {
      entity_id: z.string().describe("The entity UUID"),
      limit: z.number().default(10).describe("Max results"),
    },
    async ({ entity_id, limit }) => {
      const result = await query(
        `SELECT t.id, t.content, t.metadata, t.created_at
         FROM entity_mentions em
         JOIN thoughts t ON t.id = em.thought_id
         WHERE em.entity_id = $1 AND t.deleted_at IS NULL
         ORDER BY t.created_at DESC
         LIMIT $2`,
        [entity_id, Math.min(limit, 100)],
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.rows, null, 2) }],
      };
    },
  );

  // list_entity_facts
  server.tool(
    "list_entity_facts",
    "List memory facts about an entity. Facts are structured claims like 'from Porto' or 'works at Anthropic'.",
    {
      entity_name: z.string().optional().describe("Entity name to look up (checks canonical name and aliases)"),
      entity_id: z.string().optional().describe("Entity UUID (alternative to entity_name)"),
      status: z.enum(["active", "tentative", "disputed", "superseded"]).optional().describe("Filter by fact status"),
      review_state: z.enum(["pending", "accepted", "rejected"]).optional().describe("Filter by review state"),
      include_evidence: z.boolean().optional().default(false).describe("Include supporting evidence for each fact"),
      limit: z.number().optional().default(20).describe("Maximum facts to return"),
    },
    async ({ entity_name, entity_id, status, review_state, include_evidence, limit }) => {
      let resolvedId = entity_id;
      if (!resolvedId && entity_name) {
        const entityResult = await query(
          `SELECT id FROM entities WHERE (lower(canonical_name) = lower($1) OR $1 ILIKE ANY(aliases)) LIMIT 1`,
          [entity_name],
        );
        if (entityResult.rows.length === 0) {
          return { content: [{ type: "text" as const, text: `No entity found matching "${entity_name}"` }] };
        }
        resolvedId = entityResult.rows[0].id;
      }
      if (!resolvedId) {
        return { content: [{ type: "text" as const, text: "Provide entity_name or entity_id" }] };
      }

      let sql = `SELECT * FROM entity_facts WHERE entity_id = $1`;
      const params: unknown[] = [resolvedId];
      let idx = 2;

      if (review_state) {
        sql += ` AND review_state = $${idx}`;
        params.push(review_state);
        idx++;
      } else {
        sql += ` AND review_state != 'rejected'`;
      }

      if (status) {
        sql += ` AND status = $${idx}`;
        params.push(status);
        idx++;
      }

      sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
      params.push(limit);

      const facts = await query(sql, params);
      let result = facts.rows;

      if (include_evidence && result.length > 0) {
        const factIds = result.map((f: any) => f.id);
        const evidence = await query(
          `SELECT * FROM entity_fact_evidence WHERE fact_id = ANY($1) ORDER BY created_at DESC`,
          [factIds],
        );
        const evidenceMap = new Map<string, any[]>();
        for (const e of evidence.rows) {
          const arr = evidenceMap.get(e.fact_id) || [];
          arr.push(e);
          evidenceMap.set(e.fact_id, arr);
        }
        result = result.map((f: any) => ({ ...f, evidence: evidenceMap.get(f.id) || [] }));
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // add_entity_fact
  server.tool(
    "add_entity_fact",
    "Add a fact about an entity. Example: 'Maya Patel works at Anthropic'. Use source_kind='manual' for user-confirmed facts, 'agent' for AI-derived.",
    {
      entity_name: z.string().describe("Entity name"),
      predicate: z.string().describe("The relationship/attribute (e.g. 'from', 'works_at', 'born_on')"),
      value: z.string().describe("The fact value"),
      display_text: z.string().optional().describe("Human-readable display text (defaults to value)"),
      source_kind: z.enum(["manual", "agent"]).optional().default("agent").describe("'manual' for user-confirmed, 'agent' for AI-derived"),
      confidence: z.number().optional().describe("Confidence 0.0-1.0"),
      note: z.string().optional().describe("Optional context note"),
    },
    async ({ entity_name, predicate, value, display_text, source_kind, confidence, note }) => {
      const entityResult = await query(
        `SELECT id, canonical_name FROM entities WHERE (lower(canonical_name) = lower($1) OR $1 ILIKE ANY(aliases)) AND entity_type = 'person'`,
        [entity_name],
      );

      if (entityResult.rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No entity found matching "${entity_name}"` }] };
      }

      if (entityResult.rows.length > 1) {
        const names = entityResult.rows.map((r: any) => `- ${r.canonical_name} (${r.id})`).join("\n");
        return {
          content: [{
            type: "text" as const,
            text: `Multiple entities match "${entity_name}". Please specify:\n${names}\n\nUse the exact canonical name or provide entity_id via list_entity_facts.`,
          }],
        };
      }

      const entity = entityResult.rows[0];
      const normalizedPredicate = normalizePredicate(predicate);
      const displayText = display_text || value;
      const isManual = source_kind === "manual";

      const existing = await query(
        `SELECT id, predicate, object_display_text, status FROM entity_facts
         WHERE entity_id = $1 AND lower(predicate) = lower($2) AND review_state != 'rejected'`,
        [entity.id, normalizedPredicate],
      );

      const sameMeaning = existing.rows.find(
        (f: any) => f.object_display_text.trim().toLowerCase() === displayText.trim().toLowerCase(),
      );

      if (sameMeaning) {
        return {
          content: [{
            type: "text" as const,
            text: `This fact already exists: ${entity.canonical_name} — ${normalizedPredicate} — ${sameMeaning.object_display_text} (status: ${sameMeaning.status})`,
          }],
        };
      }

      const conflict = existing.rows.find(
        (f: any) => f.status === "active" || f.status === "disputed",
      );

      if (conflict) {
        return {
          content: [{
            type: "text" as const,
            text: `Conflict: existing fact "${entity.canonical_name} — ${conflict.predicate} — ${conflict.object_display_text}" (${conflict.status}). Use review_entity_fact or resolve_fact_conflict to handle this.`,
          }],
        };
      }

      const embeddingText = renderFactEmbeddingText(entity.canonical_name, normalizedPredicate, displayText);
      const embedding = await generateEmbedding(embeddingText);

      const status = isManual ? "active" : "tentative";
      const reviewState = isManual ? "accepted" : "pending";

      const result = await query(
        `INSERT INTO entity_facts (entity_id, predicate, object_value_json, object_display_text, status, review_state, confidence, source_kind, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [entity.id, normalizedPredicate, JSON.stringify({ value }), displayText, status, reviewState, confidence || (isManual ? 1.0 : 0.8), source_kind, pgvector.toSql(embedding)],
      );

      if (note) {
        await query(
          `INSERT INTO entity_fact_evidence (fact_id, excerpt, evidence_type)
           VALUES ($1, $2, $3)`,
          [result.rows[0].id, note, isManual ? "manual" : "extraction"],
        );
      }

      return {
        content: [{
          type: "text" as const,
          text: `Added fact: ${entity.canonical_name} — ${normalizedPredicate} — ${displayText} (${status}/${reviewState})`,
        }],
      };
    },
  );

  // review_entity_fact
  server.tool(
    "review_entity_fact",
    "Accept or reject a pending fact suggestion.",
    {
      fact_id: z.string().describe("The fact UUID to review"),
      action: z.enum(["accept", "reject"]).describe("Accept or reject the fact"),
      note: z.string().optional().describe("Optional note for audit trail"),
    },
    async ({ fact_id, action }) => {
      const fact = await query(
        `SELECT ef.*, e.canonical_name FROM entity_facts ef JOIN entities e ON e.id = ef.entity_id WHERE ef.id = $1`,
        [fact_id],
      );
      if (fact.rows.length === 0) {
        return { content: [{ type: "text" as const, text: "Fact not found" }] };
      }

      const f = fact.rows[0];
      if (f.review_state !== "pending") {
        return { content: [{ type: "text" as const, text: `Fact is already ${f.review_state}, not pending` }] };
      }

      if (action === "reject") {
        await query(`UPDATE entity_facts SET review_state = 'rejected', updated_at = now() WHERE id = $1`, [fact_id]);
        return { content: [{ type: "text" as const, text: `Rejected: ${f.canonical_name} — ${f.predicate} — ${f.object_display_text}` }] };
      }

      const conflicts = await query(
        `SELECT id, predicate, object_display_text, status FROM entity_facts
         WHERE entity_id = $1 AND lower(predicate) = lower($2) AND id != $3
           AND (status = 'active' OR status = 'disputed') AND review_state != 'rejected'`,
        [f.entity_id, f.predicate, fact_id],
      );

      if (conflicts.rows.length > 0) {
        const c = conflicts.rows[0];
        return {
          content: [{
            type: "text" as const,
            text: `Cannot accept — conflicts with existing fact: "${f.canonical_name} — ${c.predicate} — ${c.object_display_text}" (${c.status}). Use resolve_fact_conflict with fact_id="${fact_id}" to resolve.`,
          }],
        };
      }

      await query(`UPDATE entity_facts SET status = 'active', review_state = 'accepted', updated_at = now() WHERE id = $1`, [fact_id]);
      return { content: [{ type: "text" as const, text: `Accepted: ${f.canonical_name} — ${f.predicate} — ${f.object_display_text}` }] };
    },
  );

  // resolve_fact_conflict
  server.tool(
    "resolve_fact_conflict",
    "Resolve a disputed fact conflict. Actions: 'replace_existing_with_new' (existing was true, now outdated), 'mark_old_as_past' (same), 'mark_old_as_wrong' (existing was incorrect), 'keep_both_disputed' (no change).",
    {
      fact_id: z.string().describe("The new/incoming fact UUID"),
      action: z.enum(["replace_existing_with_new", "mark_old_as_past", "mark_old_as_wrong", "keep_both_disputed"]).describe("How to resolve"),
      note: z.string().optional().describe("Optional note for audit trail"),
    },
    async ({ fact_id, action }) => {
      const newFact = await query(
        `SELECT ef.*, e.canonical_name FROM entity_facts ef JOIN entities e ON e.id = ef.entity_id WHERE ef.id = $1`,
        [fact_id],
      );
      if (newFact.rows.length === 0) {
        return { content: [{ type: "text" as const, text: "Fact not found" }] };
      }

      const f = newFact.rows[0];

      if (action === "keep_both_disputed") {
        await query(
          `UPDATE entity_facts SET review_state = 'accepted', updated_at = now() WHERE id = $1 AND review_state = 'pending'`,
          [fact_id],
        );
        return { content: [{ type: "text" as const, text: `Kept both facts as disputed for "${f.canonical_name} — ${f.predicate}"` }] };
      }

      const oldFact = await query(
        `SELECT id, object_display_text FROM entity_facts
         WHERE entity_id = $1 AND lower(predicate) = lower($2) AND id != $3
           AND status = 'disputed' AND review_state != 'rejected'
         LIMIT 1`,
        [f.entity_id, f.predicate, fact_id],
      );

      if (oldFact.rows.length === 0) {
        return { content: [{ type: "text" as const, text: "No conflicting fact found to resolve against" }] };
      }

      const old = oldFact.rows[0];

      switch (action) {
        case "replace_existing_with_new":
        case "mark_old_as_past":
          await query(`UPDATE entity_facts SET status = 'active', review_state = 'accepted', updated_at = now() WHERE id = $1`, [fact_id]);
          await query(`UPDATE entity_facts SET status = 'superseded', valid_at_end = now(), updated_at = now() WHERE id = $1`, [old.id]);
          return { content: [{ type: "text" as const, text: `Resolved: "${f.object_display_text}" is now active, "${old.object_display_text}" superseded` }] };

        case "mark_old_as_wrong":
          await query(`UPDATE entity_facts SET status = 'active', review_state = 'accepted', updated_at = now() WHERE id = $1`, [fact_id]);
          await query(`UPDATE entity_facts SET review_state = 'rejected', updated_at = now() WHERE id = $1`, [old.id]);
          return { content: [{ type: "text" as const, text: `Resolved: "${f.object_display_text}" is now active, "${old.object_display_text}" rejected` }] };
      }
    },
  );

  return server;
}
