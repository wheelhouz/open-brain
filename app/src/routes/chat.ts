import { Hono } from "hono";
import { chatCompletionStream } from "../openrouter.js";
import type { ChatMessage } from "../openrouter.js";
import { retrieveContext, formatContext } from "../rag.js";

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

  // RAG: rewrite query from conversation context, retrieve and rerank
  const ragContext = await retrieveContext(body.messages);

  const sources = ragContext.thoughts.map((t) => ({
    id: t.id,
    content: t.content.slice(0, 200),
    similarity: t.similarity,
  }));

  // Build messages for the LLM
  const contextBlock = formatContext(ragContext.thoughts);
  const systemPrompt = `${SYSTEM_PROMPT}\n\n--- Retrieved Thoughts ---\n${contextBlock}\n--- End of Retrieved Thoughts ---`;

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
