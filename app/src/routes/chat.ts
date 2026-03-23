import { Hono } from "hono";
import { chatCompletionStream, rewriteQuery } from "../openrouter.js";
import type { ChatMessage } from "../openrouter.js";
import { searchMemory, formatContext } from "../rag.js";
import type { MemoryCandidate } from "../rag.js";
import { query } from "../db.js";
import { buildEntityGroundingContext, formatEntityGroundingPrompt } from "../entity-chat.js";
import { resolveEntityCandidates } from "../entities.js";

export const chatRouter = new Hono();

const SYSTEM_PROMPT = `You are a helpful assistant with access to the user's personal knowledge base called "Open Brain".

Guidelines:
- Reference specific thoughts when they support your answer
- Distinguish between what the context directly states and what you're inferring
- Mention dates when they're relevant to the answer
- If the context is suggestive but not conclusive, say so
- If no relevant context was found, be honest about it
- Be concise but thorough
- Use markdown formatting for readability`;

const ENTITY_SYSTEM_PROMPT = `You are answering a question about a specific entity from the user's personal knowledge base "Open Brain". Use only the provided facts, evidence, and thoughts. Apply these rules:

- Active facts: state directly ("Maya is from Porto")
- Tentative facts: hedge ("Maya may have been born on May 12, 1991")
- Disputed facts: present as unresolved conflict ("Maya's current city is unclear — one note supports Seattle, a newer note suggests Portland")
- Superseded facts: frame as past ("Maya previously lived in Seattle")
- Thoughts without a corresponding fact: frame as unconfirmed ("A recent note suggests she may be considering a move, but this has not been confirmed")
- If no fact or thought exists for what the user asked about: say so directly. Do not speculate.

Use markdown formatting for readability.`;

chatRouter.post("/", async (c) => {
  const body = await c.req.json<{
    messages?: Array<{ role: "user" | "assistant"; content: string }>;
    entity_id?: string;
  }>();

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }

  if (body.messages.length > 50) {
    return c.json({ error: "Too many messages (max 50)" }, 400);
  }

  const lastUserMsg = [...body.messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) {
    return c.json({ error: "at least one user message is required" }, 400);
  }

  let systemPrompt: string;
  let sources: Array<{ id: string; content: string; similarity: number }>;
  let loopSources: Array<{ id: string; content: string; score: number; loop_type: string }> = [];

  if (body.entity_id) {
    // Entity-grounded path
    const entityCheck = await query(`SELECT id FROM entities WHERE id = $1`, [body.entity_id]);
    if (entityCheck.rows.length === 0) {
      return c.json({ error: "Entity not found" }, 404);
    }

    const groundingContext = await buildEntityGroundingContext(body.entity_id, lastUserMsg.content);
    const contextBlock = formatEntityGroundingPrompt(groundingContext);
    systemPrompt = `${ENTITY_SYSTEM_PROMPT}\n\n${contextBlock}`;

    sources = groundingContext.thoughts.map((t) => ({
      id: t.id,
      content: t.content.slice(0, 200),
      similarity: t.similarity,
    }));
  } else {
    // Unified broker RAG path with intent routing
    const rewrite = await rewriteQuery(body.messages);

    // Resolve entity candidates from rewrite
    let resolvedEntities: Array<{ name: string; entity_id: string | null }> = [];
    if (rewrite.entity_candidate_names && rewrite.entity_candidate_names.length > 0) {
      try {
        resolvedEntities = await resolveEntityCandidates(rewrite.entity_candidate_names);
      } catch { /* fallback to generic */ }
    }

    // Guardrail: decision-history queries should not trigger loop injection
    const queryText = lastUserMsg.content.toLowerCase();
    const isDecisionHistory = /\b(what did (we|i|you) decide|decision (about|on|regarding)|why did (we|i) choose|what was the (decision|plan|strategy))\b/.test(queryText);
    if (isDecisionHistory) {
      rewrite.prefer_open_loops = false;
      if (!rewrite.memory_types || rewrite.memory_types.includes("all")) {
        rewrite.memory_types = ["thoughts"];
      }
    }

    const resolvedEntityId = resolvedEntities.find(e => e.entity_id !== null)?.entity_id;
    const isPersonSummary = rewrite.intent_type === "person-summary" || rewrite.intent_type === "person-recency";
    const hasLoopSignal = rewrite.intent_type === "task" || rewrite.intent_type === "status" || rewrite.intent_type === "follow-up" || rewrite.intent_type === "person-recency" || rewrite.prefer_open_loops;

    if (resolvedEntityId && isPersonSummary && !hasLoopSignal) {
      // Person-summary only → entity-grounded path
      const groundingContext = await buildEntityGroundingContext(resolvedEntityId, lastUserMsg.content);
      const contextBlock = formatEntityGroundingPrompt(groundingContext);
      systemPrompt = `${ENTITY_SYSTEM_PROMPT}\n\n${contextBlock}`;

      sources = groundingContext.thoughts.map((t) => ({
        id: t.id,
        content: t.content.slice(0, 200),
        similarity: t.similarity,
      }));
    } else if (resolvedEntityId && isPersonSummary && hasLoopSignal) {
      // Person-summary + loop signal → entity-grounded facts/thoughts + broker-sourced loops
      const groundingContext = await buildEntityGroundingContext(resolvedEntityId, lastUserMsg.content);
      const contextBlock = formatEntityGroundingPrompt(groundingContext);

      // Loops via broker — provenance-based retrieval with source-thought scoring
      const loopResult = await searchMemory({
        query: rewrite.search_query,
        filter: rewrite.filter,
        timeHint: rewrite.time_hint,
        memoryTypes: ["loops"],
        preferOpenLoops: true,
        entityIds: [resolvedEntityId],
      });

      const loopCandidates = loopResult.candidates.filter((c) => c.memory_type === "loop");

      let loopsBlock = "";
      if (loopCandidates.length > 0) {
        loopsBlock = loopCandidates
          .map((c, i) => {
            const date = new Date(c.timestamp).toISOString().split("T")[0];
            const loopType = (c.metadata?.loop_type as string) || "task";
            const relevance = (c.score * 100).toFixed(0);
            return `[Loop ${i + 1}] (relevance: ${relevance}%, ${date}, ${loopType})\n${c.content}`;
          })
          .join("\n\n");
      }

      let augmentedContext = contextBlock;
      if (loopsBlock) {
        augmentedContext += `\n\n--- Open Loops ---\n${loopsBlock}\n--- End of Open Loops ---`;
      }
      systemPrompt = `${ENTITY_SYSTEM_PROMPT}\n\n${augmentedContext}`;

      sources = groundingContext.thoughts.map((t) => ({
        id: t.id,
        content: t.content.slice(0, 200),
        similarity: t.similarity,
      }));

      loopSources = loopCandidates.map((c) => ({
        id: c.id,
        content: c.content.slice(0, 200),
        score: c.score,
        loop_type: (c.metadata?.loop_type as string) || "task",
      }));
    } else {
      // Default / action-status broker path
      const resolvedIds = resolvedEntities
        .filter((e) => e.entity_id !== null)
        .map((e) => e.entity_id as string);

      const memoryResult = await searchMemory({
        query: rewrite.search_query,
        filter: rewrite.filter,
        timeHint: rewrite.time_hint,
        memoryTypes: rewrite.memory_types,
        preferOpenLoops: rewrite.prefer_open_loops,
        entityIds: resolvedIds.length > 0 ? resolvedIds : undefined,
      });

      // Split candidates by type
      const thoughtCandidates = memoryResult.candidates.filter((c) => c.memory_type === "thought");
      const loopCandidates = memoryResult.candidates.filter((c) => c.memory_type === "loop");

      // Format thoughts section using existing formatter
      const thoughtsForFormat = thoughtCandidates.map((c) => ({
        id: c.id,
        content: c.content,
        metadata: c.metadata as Record<string, unknown>,
        similarity: c.score,
        created_at: c.timestamp,
      }));
      const thoughtsBlock = formatContext(thoughtsForFormat);

      // Format loops section
      let loopsBlock = "";
      if (loopCandidates.length > 0) {
        loopsBlock = loopCandidates
          .map((c, i) => {
            const date = new Date(c.timestamp).toISOString().split("T")[0];
            const loopType = (c.metadata?.loop_type as string) || "task";
            const relevance = (c.score * 100).toFixed(0);
            return `[Loop ${i + 1}] (relevance: ${relevance}%, ${date}, ${loopType})\n${c.content}`;
          })
          .join("\n\n");
      }

      // Build system prompt with labeled sections
      let contextSections = `--- Retrieved Thoughts ---\n${thoughtsBlock}\n--- End of Retrieved Thoughts ---`;
      if (loopsBlock) {
        contextSections += `\n\n--- Open Loops ---\n${loopsBlock}\n--- End of Open Loops ---`;
      }
      systemPrompt = `${SYSTEM_PROMPT}\n\n${contextSections}`;

      // Build backward-compatible sources
      sources = thoughtCandidates.map((c) => ({
        id: c.id,
        content: c.content.slice(0, 200),
        similarity: c.score,
      }));

      loopSources = loopCandidates.map((c) => ({
        id: c.id,
        content: c.content.slice(0, 200),
        score: c.score,
        loop_type: (c.metadata?.loop_type as string) || "task",
      }));
    }
  }

  const llmMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...body.messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  const stream = chatCompletionStream(llmMessages);
  const reader = stream.getReader();

  // Stream SSE response
  const sseStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      // Send sources first so the UI can show them while streaming
      send(JSON.stringify({ type: "sources", thoughts: sources, loops: loopSources }));

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        send(JSON.stringify({ type: "chunk", content: value }));
      }

      send(JSON.stringify({ type: "done" }));
      controller.close();
    },
  });

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
