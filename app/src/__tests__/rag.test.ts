import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockGenerateEmbedding = vi.fn();
const mockRewriteQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  rewriteQuery: (...args: unknown[]) => mockRewriteQuery(...args),
}));

vi.mock("pgvector", () => ({
  default: { toSql: (v: number[]) => `[${v.join(",")}]` },
}));

vi.mock("../config.js", () => ({
  config: {
    embeddingModel: "openai/text-embedding-3-small",
  },
}));

import { searchWithReranking, retrieveContext, formatContext, searchMemory } from "../rag.js";
import type { RetrievedThought } from "../rag.js";

function makeThought(overrides: Partial<RetrievedThought> = {}): any {
  return {
    id: overrides.id || "t1",
    content: overrides.content || "Test thought",
    metadata: overrides.metadata || { type: "observation", topics: ["test"], people: [] },
    similarity: overrides.similarity ?? 0.8,
    created_at: overrides.created_at || new Date().toISOString(),
    parent_id: overrides.parent_id || null,
  };
}

describe("searchWithReranking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
    // Default: match_thoughts returns results, thread queries return empty
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it("embeds query and calls match_thoughts with wider pool", async () => {
    mockQuery.mockResolvedValue({ rows: [makeThought()] });

    const result = await searchWithReranking({ query: "test query" });

    expect(mockGenerateEmbedding).toHaveBeenCalledWith("test query");
    // First call is match_thoughts
    expect(mockQuery.mock.calls[0][0]).toContain("match_thoughts");
    // threshold=0.25, poolSize=max(limit*2, 15)=20 by default
    expect(mockQuery.mock.calls[0][1]![1]).toBe(0.25);
    expect(mockQuery.mock.calls[0][1]![2]).toBe(20);
    expect(result.thoughts).toHaveLength(1);
    expect(result.diagnostics.candidateCount).toBe(1);
  });

  it("reranks candidates and respects limit", async () => {
    const thoughts = [
      makeThought({ id: "t1", similarity: 0.9, created_at: "2020-01-01" }),
      makeThought({ id: "t2", similarity: 0.5, created_at: new Date().toISOString() }),
      makeThought({ id: "t3", similarity: 0.7, created_at: new Date().toISOString() }),
    ];
    mockQuery
      .mockResolvedValueOnce({ rows: thoughts })     // match_thoughts
      .mockResolvedValue({ rows: [] });               // thread queries

    const result = await searchWithReranking({ query: "test", limit: 2 });

    expect(result.thoughts).toHaveLength(2);
    // t3 (0.7 sim + recent) should beat t1 (0.9 sim + old)
    expect(result.thoughts[0].id).toBe("t3");
  });

  it("passes metadata filter to match_thoughts", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await searchWithReranking({
      query: "test",
      filter: { people: ["Liz"] },
    });

    const filterArg = mockQuery.mock.calls[0][1]![3];
    expect(JSON.parse(filterArg)).toEqual({ people: ["Liz"] });
  });

  it("adds recency slice when time_hint is recent", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeThought({ id: "t1" })] })   // match_thoughts
      .mockResolvedValueOnce({ rows: [makeThought({ id: "t2" })] })   // recency query
      .mockResolvedValue({ rows: [] });                                 // thread queries

    const result = await searchWithReranking({
      query: "test",
      timeHint: "recent",
    });

    // Should have 2 candidates (1 from match + 1 from recency)
    expect(result.diagnostics.candidateCount).toBe(2);
    // Second query should be the recency slice
    expect(mockQuery.mock.calls[1][0]).toContain("7 days");
  });

  it("deduplicates recency slice results", async () => {
    const thought = makeThought({ id: "t1" });
    mockQuery
      .mockResolvedValueOnce({ rows: [thought] })   // match_thoughts
      .mockResolvedValueOnce({ rows: [thought] })   // recency (same thought)
      .mockResolvedValue({ rows: [] });              // thread queries

    const result = await searchWithReranking({
      query: "test",
      timeHint: "recent",
    });

    expect(result.diagnostics.candidateCount).toBe(1);
  });

  it("performs thread expansion for top results", async () => {
    const thought = makeThought({ id: "t1" });
    mockQuery
      .mockResolvedValueOnce({ rows: [thought] })                        // match_thoughts
      .mockResolvedValueOnce({ rows: [                                    // children query
        { parent_id: "t1", content: "Child note", created_at: new Date().toISOString() },
      ] })
      .mockResolvedValueOnce({ rows: [] });                               // parents query

    const result = await searchWithReranking({ query: "test" });

    expect(result.thoughts[0].thread).toHaveLength(1);
    expect(result.thoughts[0].thread![0].content).toBe("Child note");
  });

  it("logs diagnostics", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockQuery.mockResolvedValue({ rows: [] });

    await searchWithReranking({ query: "test" });

    expect(consoleSpy).toHaveBeenCalled();
    const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logged.event).toBe("rag_retrieval");
    expect(logged.rewrittenQuery).toBe("test");
    expect(typeof logged.latencyMs).toBe("number");
    consoleSpy.mockRestore();
  });
});

describe("retrieveContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it("rewrites query from conversation and searches", async () => {
    mockRewriteQuery.mockResolvedValue({
      search_query: "rewritten query",
      filter: { topics: ["memory"] },
      time_hint: null,
    });

    const result = await retrieveContext([
      { role: "user", content: "Tell me about memory" },
    ]);

    expect(mockRewriteQuery).toHaveBeenCalledWith([
      { role: "user", content: "Tell me about memory" },
    ]);
    expect(result.rewrittenQuery).toBe("rewritten query");
    expect(mockGenerateEmbedding).toHaveBeenCalledWith("rewritten query");
  });

  it("includes originalQuery in diagnostics", async () => {
    mockRewriteQuery.mockResolvedValue({
      search_query: "standalone search",
      filter: {},
      time_hint: null,
    });

    const result = await retrieveContext([
      { role: "user", content: "what about that?" },
      { role: "assistant", content: "Sure!" },
      { role: "user", content: "tell me more" },
    ]);

    expect(result.diagnostics.originalQuery).toBe("tell me more");
  });
});

describe("searchMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it("returns candidates array", async () => {
    const thought = makeThought({ id: "t1", similarity: 0.8 });
    mockQuery
      .mockResolvedValueOnce({ rows: [thought] })   // match_thoughts
      .mockResolvedValue({ rows: [] });               // thread queries + loop queries

    const result = await searchMemory({ query: "test query" });

    expect(Array.isArray(result.candidates)).toBe(true);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates[0].memory_type).toBe("thought");
    expect(result.candidates[0].id).toBe("t1");
    expect(result.diagnostics).toBeDefined();
    expect(typeof result.diagnostics.loopCandidateCount).toBe("number");
    expect(typeof result.diagnostics.modelMismatchExclusions).toBe("number");
  });

  it("loop query SQL includes status = 'open' filter", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    // We need to mock enough calls: match_thoughts, thread children, thread parents, mismatch count, loop query
    mockQuery
      .mockResolvedValueOnce({ rows: [] })   // match_thoughts
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })   // mismatch count
      .mockResolvedValueOnce({ rows: [] });               // loop query

    await searchMemory({ query: "test", memoryTypes: ["loops"] });

    // The loop query should be the third call (after mismatch count)
    const loopCall = mockQuery.mock.calls.find((call: any) =>
      typeof call[0] === "string" && call[0].includes("open_loops") && call[0].includes("ORDER BY"),
    );
    expect(loopCall).toBeDefined();
    expect(loopCall![0]).toContain("status = 'open'");
  });

  it("loop query SQL includes embedding IS NOT NULL", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })   // mismatch count
      .mockResolvedValueOnce({ rows: [] });               // loop query

    await searchMemory({ query: "test", memoryTypes: ["loops"] });

    const loopCall = mockQuery.mock.calls.find((call: any) =>
      typeof call[0] === "string" && call[0].includes("open_loops") && call[0].includes("ORDER BY"),
    );
    expect(loopCall).toBeDefined();
    expect(loopCall![0]).toContain("embedding IS NOT NULL");
  });

  it("loop query SQL includes embedding_model filter", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })   // mismatch count
      .mockResolvedValueOnce({ rows: [] });               // loop query

    await searchMemory({ query: "test", memoryTypes: ["loops"] });

    const loopCall = mockQuery.mock.calls.find((call: any) =>
      typeof call[0] === "string" && call[0].includes("open_loops") && call[0].includes("ORDER BY"),
    );
    expect(loopCall).toBeDefined();
    expect(loopCall![0]).toContain("embedding_model");
    // The model parameter should be passed
    expect(loopCall![1]).toContain("openai/text-embedding-3-small");
  });

  it("merges thought and loop candidates sorted by score", async () => {
    const thought = makeThought({ id: "t1", similarity: 0.7 });
    const loopRow = {
      id: "loop-1",
      content: "Follow up on design review",
      loop_type: "question",
      status: "open",
      source_thought_id: "t1",
      created_at: new Date().toISOString(),
      similarity: 0.9,
      embedding_model: "openai/text-embedding-3-small",
    };

    // Reset and use mockImplementation to route responses by SQL content
    mockQuery.mockReset();
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("match_thoughts")) {
        return Promise.resolve({ rows: [thought] });
      }
      if (sql.includes("COUNT(*)")) {
        return Promise.resolve({ rows: [{ count: 0 }] });
      }
      if (sql.includes("open_loops") && sql.includes("ORDER BY")) {
        return Promise.resolve({ rows: [loopRow] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await searchMemory({ query: "design review" });

    expect(result.candidates.length).toBe(2);
    // Loop has higher similarity so should be first after sort
    expect(result.candidates[0].memory_type).toBe("loop");
    expect(result.candidates[0].id).toBe("loop-1");
    expect(result.candidates[1].memory_type).toBe("thought");
  });
});

describe("formatContext", () => {
  it("returns empty message for no thoughts", () => {
    expect(formatContext([])).toContain("No relevant thoughts");
  });

  it("formats thoughts with metadata", () => {
    const thoughts: RetrievedThought[] = [
      {
        id: "t1",
        content: "We decided to use pgvector",
        metadata: { type: "decision", topics: ["memory", "architecture"], people: ["Liz"] },
        similarity: 0.92,
        created_at: "2026-03-05T00:00:00Z",
      },
    ];

    const output = formatContext(thoughts);
    expect(output).toContain("[Thought 1]");
    expect(output).toContain("relevance: 92%");
    expect(output).toContain("2026-03-05");
    expect(output).toContain("decision");
    expect(output).toContain("Topics: memory, architecture");
    expect(output).toContain("People: Liz");
    expect(output).toContain("We decided to use pgvector");
  });

  it("formats thread context", () => {
    const thoughts: RetrievedThought[] = [
      {
        id: "t1",
        content: "Main thought",
        metadata: { type: "note" },
        similarity: 0.8,
        created_at: "2026-03-01T00:00:00Z",
        thread: [
          { content: "Follow-up note about testing", created_at: "2026-03-02T00:00:00Z" },
        ],
      },
    ];

    const output = formatContext(thoughts);
    expect(output).toContain("[Thread] 1 related note:");
    expect(output).toContain("Follow-up note about testing");
    expect(output).toContain("2026-03-02");
  });
});
