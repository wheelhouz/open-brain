import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveEntityMentions } from "../entities.js";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../config.js", () => ({
  config: { entityFuzzyThreshold: 0.35 },
}));

describe("resolveEntityMentions", () => {
  beforeEach(() => vi.resetAllMocks());

  it("matches existing entity by exact canonical_name", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["Alice"], "thought-1");

    expect(mockQuery.mock.calls[0][0]).toContain("lower(canonical_name) = lower($1)");
    expect(mockQuery.mock.calls[0][1]).toEqual(["Alice"]);
    expect(mockQuery.mock.calls[1][0]).toContain("INSERT INTO entity_mentions");
    expect(mockQuery.mock.calls[1][1]).toEqual([
      "entity-1", "thought-1", "Alice", "alice", "auto_linked_exact", 1.0, '{"match_type":"canonical"}',
    ]);
  });

  it("matches existing entity by alias when no exact match", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "entity-2" }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["Al"], "thought-1");

    expect(mockQuery.mock.calls[1][0]).toContain("ILIKE ANY(aliases)");
    expect(mockQuery.mock.calls[2][1][0]).toBe("entity-2");
    expect(mockQuery.mock.calls[2][1][1]).toBe("thought-1");
  });

  it("creates new entity when no match found", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "new-entity" }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["NewPerson"], "thought-1");

    expect(mockQuery.mock.calls[3][0]).toContain("INSERT INTO entities");
    expect(mockQuery.mock.calls[3][1]).toEqual(["NewPerson"]);
    expect(mockQuery.mock.calls[4][1][0]).toBe("new-entity");
    expect(mockQuery.mock.calls[4][1][1]).toBe("thought-1");
  });

  it("handles case insensitivity", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["alice"], "thought-1");

    expect(mockQuery.mock.calls[0][0]).toContain("lower(canonical_name) = lower($1)");
    expect(mockQuery.mock.calls[0][1]).toEqual(["alice"]);
  });

  it("skips empty and whitespace-only names", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["", "  ", "Alice"], "thought-1");

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("processes multiple names independently", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "entity-2" }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["Alice", "Bob"], "thought-1");

    expect(mockQuery).toHaveBeenCalledTimes(7);
  });

  it("is idempotent — duplicate mentions use ON CONFLICT DO NOTHING", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["Alice"], "thought-1");

    expect(mockQuery.mock.calls[1][0]).toContain("ON CONFLICT");
    expect(mockQuery.mock.calls[1][0]).toContain("DO NOTHING");
  });

  it("fuzzy matches entity above threshold and appends alias", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "entity-bob", sim: 0.5 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["Bobby"], "thought-1");

    expect(mockQuery.mock.calls[2][0]).toContain("similarity");
    expect(mockQuery.mock.calls[2][1]).toEqual(["Bobby"]);
    expect(mockQuery.mock.calls[3][0]).toContain("array_append");
    expect(mockQuery.mock.calls[3][1]).toEqual(["Bobby", "entity-bob"]);
    expect(mockQuery.mock.calls[4][1][0]).toBe("entity-bob");
    expect(mockQuery.mock.calls[4][1][1]).toBe("thought-1");
  });

  it("creates new entity when fuzzy match is below threshold", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "entity-far", sim: 0.2 }] })
      .mockResolvedValueOnce({ rows: [{ id: "new-entity" }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["Xenomorph"], "thought-1");

    expect(mockQuery.mock.calls[3][0]).toContain("INSERT INTO entities");
    expect(mockQuery.mock.calls[3][1]).toEqual(["Xenomorph"]);
    expect(mockQuery.mock.calls[4][1][0]).toBe("new-entity");
    expect(mockQuery.mock.calls[4][1][1]).toBe("thought-1");
  });

  it("fuzzy match alias append uses correct query with dedup guard", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "entity-alex", sim: 0.45 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["Alexander"], "thought-1");

    const aliasQuery = mockQuery.mock.calls[3][0];
    expect(aliasQuery).toContain("array_append");
    expect(aliasQuery).toContain("NOT ($1 = ANY(aliases))");
    expect(mockQuery.mock.calls[3][1]).toEqual(["Alexander", "entity-alex"]);
  });

  // New tests for MentionMap return type

  it("returns MentionMap with exact match resolution", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await resolveEntityMentions(["Alice"], "thought-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      raw_mention_text: "Alice",
      normalized_mention_text: "alice",
      entity_id: "entity-1",
      resolution_state: "auto_linked_exact",
      resolution_confidence: 1.0,
      resolution_metadata: { match_type: "canonical" },
    });
  });

  it("returns MentionMap with alias match resolution", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "entity-2" }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await resolveEntityMentions(["Al"], "thought-1");

    expect(result[0]).toEqual(
      expect.objectContaining({
        resolution_state: "auto_linked_alias",
        resolution_confidence: 1.0,
        resolution_metadata: expect.objectContaining({ match_type: "alias" }),
      }),
    );
  });

  it("returns MentionMap with fuzzy match resolution", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "entity-3", sim: 0.72 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await resolveEntityMentions(["Bobby"], "thought-1");

    expect(result[0]).toEqual(
      expect.objectContaining({
        resolution_state: "auto_linked_fuzzy",
        resolution_confidence: 0.72,
        resolution_metadata: { match_type: "fuzzy", similarity: 0.72 },
      }),
    );
  });

  it("returns MentionMap with new_entity_created resolution", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "new-entity" }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await resolveEntityMentions(["Zara"], "thought-1");

    expect(result[0]).toEqual(
      expect.objectContaining({
        resolution_state: "new_entity_created",
        resolution_confidence: 1.0,
        resolution_metadata: null,
      }),
    );
  });
});
