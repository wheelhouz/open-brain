import { Hono } from "hono";
import { query } from "../db.js";
import { generateEmbedding, chatCompletionStream } from "../openrouter.js";
import type { ChatMessage } from "../openrouter.js";
import pgvector from "pgvector";

export const chatRouter = new Hono();

const SYSTEM_PROMPT = `You are a helpful assistant with access to the user's personal knowledge base called "Open Brain". You answer questions by drawing on the relevant thoughts provided below as context.

Guidelines:
- Reference specific thoughts when they're relevant to your answer
- If the context doesn't contain enough information, say so honestly
- Be concise but thorough
- Use markdown formatting for readability`;

function buildSystemPrompt(
  thoughts: Array<{ id: string; content: string; similarity: number }>,
): string {
  if (thoughts.length === 0) {
    return `${SYSTEM_PROMPT}\n\nNo relevant thoughts were found in the knowledge base for this query.`;
  }

  const context = thoughts
    .map(
      (t, i) =>
        `[Thought ${i + 1}] (similarity: ${(t.similarity * 100).toFixed(0)}%)\n${t.content}`,
    )
    .join("\n\n");

  return `${SYSTEM_PROMPT}\n\n--- Retrieved Thoughts ---\n${context}\n--- End of Retrieved Thoughts ---`;
}

chatRouter.post("/", async (c) => {
  const body = await c.req.json<{
    messages?: Array<{ role: "user" | "assistant"; content: string }>;
  }>();

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }

  const lastUserMsg = [...body.messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) {
    return c.json({ error: "at least one user message is required" }, 400);
  }

  // RAG: embed the last user message and retrieve relevant thoughts
  const embedding = await generateEmbedding(lastUserMsg.content);
  const result = await query(`SELECT * FROM match_thoughts($1, $2, $3, $4)`, [
    pgvector.toSql(embedding),
    0.3,
    6,
    JSON.stringify({}),
  ]);

  const sources = result.rows.map((r: any) => ({
    id: r.id,
    content: r.content.slice(0, 200),
    similarity: r.similarity,
  }));

  // Build messages for the LLM
  const systemPrompt = buildSystemPrompt(result.rows as any);
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
      send(JSON.stringify({ type: "sources", thoughts: sources }));

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
