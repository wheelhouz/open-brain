import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query } from "./db.js";
import { chatCompletion } from "./openrouter.js";
import { capturePipeline } from "./pipeline.js";
import { searchWithReranking } from "./rag.js";

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

  return server;
}
