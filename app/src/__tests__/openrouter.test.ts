import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateEmbedding, extractMetadata } from "../openrouter.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateEmbedding", () => {
  it("returns embedding vector from OpenRouter", async () => {
    const fakeEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: fakeEmbedding }] }),
    });

    const result = await generateEmbedding("test thought");
    expect(result).toEqual(fakeEmbedding);
    expect(result).toHaveLength(1536);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/embeddings");
    const body = JSON.parse(opts.body);
    expect(body.input).toBe("test thought");
  });

  it("throws on API error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    });

    await expect(generateEmbedding("test")).rejects.toThrow("OpenRouter");
  });
});

describe("extractMetadata", () => {
  it("returns structured metadata from OpenRouter", async () => {
    const metadata = {
      type: "person_note",
      topics: ["roadmap", "api"],
      people: ["Sarah"],
      action_items: ["Prioritize API rewrite"],
      dates_mentioned: [],
      source_context: "meeting",
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(metadata) } }],
      }),
    });

    const result = await extractMetadata("Met with Sarah about the Q2 roadmap");
    expect(result.type).toBe("person_note");
    expect(result.people).toContain("Sarah");
    expect(result.topics).toContain("roadmap");
  });

  it("handles malformed metadata gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ type: "idea" }) } }],
      }),
    });

    const result = await extractMetadata("Some idea");
    expect(result.type).toBe("idea");
    expect(result.topics).toEqual([]);
    expect(result.people).toEqual([]);
  });
});
