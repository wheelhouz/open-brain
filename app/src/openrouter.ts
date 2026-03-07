import { config } from "./config.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export async function openrouterRequest(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${OPENROUTER_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openrouterApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${path} failed (${res.status}): ${text}`);
  }

  return res.json();
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const data = (await openrouterRequest("/embeddings", {
    model: config.embeddingModel,
    input: text,
  })) as { data: Array<{ embedding: number[] }> };

  return data.data[0].embedding;
}

export interface ThoughtMetadata {
  type: string;
  topics: string[];
  people: string[];
  action_items: string[];
  dates_mentioned: string[];
  source_context: string | null;
}

const EXTRACTION_PROMPT = `You are a thought classifier. Given the following thought, extract structured metadata. Respond ONLY with valid JSON matching this schema:

{
    "type": one of "observation", "task", "idea", "reference", "person_note", "decision", "meeting_note",
    "topics": 1-3 subject tags as strings,
    "people": names of individuals mentioned (empty array if none),
    "action_items": implied to-dos (empty array if none),
    "dates_mentioned": dates in YYYY-MM-DD format (empty array if none),
    "source_context": one of "ai_save", "meeting", "migration", "manual" or null
}

Classification hints:
- "Decision: ..." → type: decision
- "Meeting with ..." → type: meeting_note, source_context: meeting
- "Saving from [tool]: ..." → source_context: ai_save
- "Insight: ..." → type: idea
- "[Name] — ..." → type: person_note

Thought: `;

const NORMALIZATION_PROMPT = `Rewrite the following note as a standalone statement. Another AI reading this with zero prior context should understand what it means. Preserve all factual content, names, dates, and specifics. Do not add information that is not present. If the note is already self-contained, return it unchanged.

Note: `;

export async function normalizeContent(content: string): Promise<string> {
  const data = (await openrouterRequest("/chat/completions", {
    model: config.extractionModel,
    messages: [
      { role: "user", content: NORMALIZATION_PROMPT + content },
    ],
    temperature: 0,
  })) as { choices: Array<{ message: { content: string } }> };

  return data.choices[0].message.content.trim();
}

export async function chatCompletion(systemPrompt: string, userContent: string): Promise<string> {
  const data = (await openrouterRequest("/chat/completions", {
    model: config.extractionModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.3,
  })) as { choices: Array<{ message: { content: string } }> };

  return data.choices[0].message.content.trim();
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function chatCompletionStream(
  messages: ChatMessage[],
  model?: string,
): ReadableStream<string> {
  return new ReadableStream({
    async start(controller) {
      const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.openrouterApiKey}`,
        },
        body: JSON.stringify({
          model: model || config.chatModel,
          messages,
          stream: true,
          temperature: 0.5,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        controller.enqueue(`Error: OpenRouter returned ${res.status}: ${text}`);
        controller.close();
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) controller.enqueue(delta);
          } catch {
            // skip malformed chunks
          }
        }
      }

      controller.close();
    },
  });
}

export async function extractMetadata(content: string): Promise<ThoughtMetadata> {
  const data = (await openrouterRequest("/chat/completions", {
    model: config.extractionModel,
    messages: [
      {
        role: "user",
        content: EXTRACTION_PROMPT + content,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  })) as { choices: Array<{ message: { content: string } }> };

  const raw = JSON.parse(data.choices[0].message.content);

  return {
    type: raw.type || "observation",
    topics: Array.isArray(raw.topics) ? raw.topics : [],
    people: Array.isArray(raw.people) ? raw.people : [],
    action_items: Array.isArray(raw.action_items) ? raw.action_items : [],
    dates_mentioned: Array.isArray(raw.dates_mentioned) ? raw.dates_mentioned : [],
    source_context: raw.source_context || null,
  };
}
