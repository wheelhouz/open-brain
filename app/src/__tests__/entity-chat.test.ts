import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockGenerateEmbedding = vi.fn();

vi.mock("../db.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}));

vi.mock("pgvector", () => ({
  default: { toSql: (v: number[]) => `[${v.join(",")}]` },
}));

import { buildEntityGroundingContext, formatEntityGroundingPrompt } from "../entity-chat.js";

describe("buildEntityGroundingContext", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it("includes entity identity (name, aliases, type)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1", canonical_name: "Maya Patel", entity_type: "person", aliases: ["Maya"] }] }) // entity
      .mockResolvedValueOnce({ rows: [] }) // disputed facts
      .mockResolvedValueOnce({ rows: [] }) // semantic facts
      .mockResolvedValueOnce({ rows: [] }); // thoughts

    const ctx = await buildEntityGroundingContext("e1", "Where is Maya from?");
    expect(ctx.entity.canonical_name).toBe("Maya Patel");
    expect(ctx.entity.aliases).toEqual(["Maya"]);
    expect(ctx.entity.entity_type).toBe("person");
  });

  it("retrieves facts by embedding similarity to query", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1", canonical_name: "Maya", entity_type: "person", aliases: [] }] })
      .mockResolvedValueOnce({ rows: [] }) // disputed
      .mockResolvedValueOnce({
        rows: [
          { id: "f1", predicate: "from", object_display_text: "Porto", status: "active", confidence: 0.9, valid_at_start: null, valid_at_end: null, similarity: 0.85 },
        ],
      }) // semantic
      .mockResolvedValueOnce({ rows: [] }) // evidence
      .mockResolvedValueOnce({ rows: [] }); // thoughts

    const ctx = await buildEntityGroundingContext("e1", "Where is Maya from?");
    expect(ctx.facts).toHaveLength(1);
    expect(ctx.facts[0].predicate).toBe("from");
    expect(ctx.facts[0].object_display_text).toBe("Porto");
  });

  it("always includes disputed facts regardless of match score", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1", canonical_name: "Maya", entity_type: "person", aliases: [] }] })
      .mockResolvedValueOnce({
        rows: [{ id: "f-disputed", predicate: "lives_in", object_display_text: "Portland", status: "disputed", confidence: 0.9, valid_at_start: null, valid_at_end: null }],
      }) // disputed
      .mockResolvedValueOnce({ rows: [] }) // semantic (limited by remaining slots)
      .mockResolvedValueOnce({ rows: [] }) // evidence
      .mockResolvedValueOnce({ rows: [] }); // thoughts

    const ctx = await buildEntityGroundingContext("e1", "unrelated query");
    expect(ctx.facts.some((f) => f.id === "f-disputed")).toBe(true);
  });

  it("caps total facts at configured limit", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1", canonical_name: "Maya", entity_type: "person", aliases: [] }] })
      .mockResolvedValueOnce({ rows: [] }) // disputed
      .mockResolvedValueOnce({
        rows: Array.from({ length: 12 }, (_, i) => ({
          id: `f${i}`, predicate: `pred${i}`, object_display_text: `val${i}`, status: "active", confidence: 0.9, valid_at_start: null, valid_at_end: null, similarity: 0.8,
        })),
      }) // semantic
      .mockResolvedValueOnce({ rows: [] }) // evidence
      .mockResolvedValueOnce({ rows: [] }); // thoughts

    const ctx = await buildEntityGroundingContext("e1", "query");
    expect(ctx.facts.length).toBeLessThanOrEqual(12);
  });

  it("loads evidence for selected facts only", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1", canonical_name: "Maya", entity_type: "person", aliases: [] }] })
      .mockResolvedValueOnce({ rows: [] }) // disputed
      .mockResolvedValueOnce({
        rows: [{ id: "f1", predicate: "from", object_display_text: "Porto", status: "active", confidence: 0.9, valid_at_start: null, valid_at_end: null, similarity: 0.8 }],
      }) // semantic
      .mockResolvedValueOnce({
        rows: [
          { fact_id: "f1", excerpt: "grew up in Porto", evidence_type: "extraction" },
        ],
      }) // evidence
      .mockResolvedValueOnce({ rows: [] }); // thoughts

    const ctx = await buildEntityGroundingContext("e1", "Where is Maya from?");
    expect(ctx.facts[0].evidence).toHaveLength(1);
    expect(ctx.facts[0].evidence[0].excerpt).toBe("grew up in Porto");
    // Verify evidence query was called with fact IDs
    const evidenceCall = mockQuery.mock.calls[3];
    expect(evidenceCall[0]).toContain("entity_fact_evidence");
    expect(evidenceCall[1]).toEqual([["f1"]]);
  });

  it("retrieves recent entity-filtered thoughts", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1", canonical_name: "Maya", entity_type: "person", aliases: [] }] })
      .mockResolvedValueOnce({ rows: [] }) // disputed
      .mockResolvedValueOnce({ rows: [] }) // semantic
      .mockResolvedValueOnce({
        rows: [
          { id: "t1", content: "Met Maya at the cafe", created_at: "2026-03-15T10:00:00Z", similarity: 0.75 },
        ],
      }); // thoughts

    const ctx = await buildEntityGroundingContext("e1", "When did I last see Maya?");
    expect(ctx.thoughts).toHaveLength(1);
    expect(ctx.thoughts[0].content).toBe("Met Maya at the cafe");
    // Verify thoughts query joins entity_mentions
    const thoughtsCall = mockQuery.mock.calls[3];
    expect(thoughtsCall[0]).toContain("entity_mentions");
  });

  it("returns error when entity does not exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(buildEntityGroundingContext("nonexistent", "query")).rejects.toThrow("Entity not found");
  });
});

describe("formatEntityGroundingPrompt", () => {
  it("formats entity with facts and thoughts", () => {
    const result = formatEntityGroundingPrompt({
      entity: { id: "e1", canonical_name: "Maya Patel", entity_type: "person", aliases: ["Maya"] },
      facts: [
        {
          id: "f1",
          predicate: "from",
          object_display_text: "Porto",
          status: "active",
          confidence: 0.95,
          valid_at_start: null,
          valid_at_end: null,
          evidence: [{ excerpt: "grew up in Porto", evidence_type: "extraction" }],
        },
        {
          id: "f2",
          predicate: "lives_in",
          object_display_text: "Portland",
          status: "disputed",
          confidence: 0.7,
          valid_at_start: null,
          valid_at_end: null,
          evidence: [],
        },
      ],
      thoughts: [
        { id: "t1", content: "Met Maya at the cafe", created_at: "2026-03-15T10:00:00Z", similarity: 0.8 },
      ],
    });

    expect(result).toContain("Maya Patel");
    expect(result).toContain("Also known as: Maya");
    expect(result).toContain("[active] from: Porto");
    expect(result).toContain("[disputed] lives_in: Portland");
    expect(result).toContain("confidence: 70%");
    expect(result).toContain("Evidence: grew up in Porto");
    expect(result).toContain("Met Maya at the cafe");
  });
});
