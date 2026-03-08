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

import { searchWithReranking, retrieveContext, formatContext } from "../rag.js";
import type { RetrievedThought } from "../rag.js";

function makeThought(overrides: Partial<RetrievedThought> = {}): any {
  return {
    id: overrides.id || "t1",
    content: overrides.content || "Test thought",
    metadata: overrides.metadata || { type: "observation", topics: ["test"], people: [] },
    similarity: overrides.similarity ?? 0.8,
    created_at: overrides.created_at || new Date().toISOString(),
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
    // threshold=0.25, poolSize=15 by default
    expect(mockQuery.mock.calls[0][1]![1]).toBe(0.25);
    expect(mockQuery.mock.calls[0][1]![2]).toBe(15);
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
