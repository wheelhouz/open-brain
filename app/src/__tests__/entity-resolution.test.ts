import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveEntityMentions } from "../entities.js";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

describe("resolveEntityMentions", () => {
  beforeEach(() => vi.resetAllMocks());

  it("matches existing entity by exact canonical_name", async () => {
    // Exact match returns entity
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] })
      // Upsert mention
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["Alice"], "thought-1");

    // Should query for exact match
    expect(mockQuery.mock.calls[0][0]).toContain("lower(canonical_name) = lower($1)");
    expect(mockQuery.mock.calls[0][1]).toEqual(["Alice"]);
    // Should upsert mention with matched entity
    expect(mockQuery.mock.calls[1][0]).toContain("INSERT INTO entity_mentions");
    expect(mockQuery.mock.calls[1][1]).toEqual(["entity-1", "thought-1"]);
  });

  it("matches existing entity by alias when no exact match", async () => {
    mockQuery
      // No exact match
      .mockResolvedValueOnce({ rows: [] })
      // Alias match
      .mockResolvedValueOnce({ rows: [{ id: "entity-2" }] })
      // Upsert mention
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["Al"], "thought-1");

    expect(mockQuery.mock.calls[1][0]).toContain("ILIKE ANY(aliases)");
    expect(mockQuery.mock.calls[2][1]).toEqual(["entity-2", "thought-1"]);
  });

  it("creates new entity when no match found", async () => {
    mockQuery
      // No exact match
      .mockResolvedValueOnce({ rows: [] })
      // No alias match
      .mockResolvedValueOnce({ rows: [] })
      // Create new entity
      .mockResolvedValueOnce({ rows: [{ id: "new-entity" }] })
      // Upsert mention
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["NewPerson"], "thought-1");

    // Verify INSERT into entities
    expect(mockQuery.mock.calls[2][0]).toContain("INSERT INTO entities");
    expect(mockQuery.mock.calls[2][1]).toEqual(["NewPerson"]);
    // Verify mention linked to new entity
    expect(mockQuery.mock.calls[3][1]).toEqual(["new-entity", "thought-1"]);
  });

  it("handles case insensitivity", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["alice"], "thought-1");

    // The SQL uses lower() for case-insensitive matching
    expect(mockQuery.mock.calls[0][0]).toContain("lower(canonical_name) = lower($1)");
    expect(mockQuery.mock.calls[0][1]).toEqual(["alice"]);
  });

  it("skips empty and whitespace-only names", async () => {
    // Alice exact match + mention upsert
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["", "  ", "Alice"], "thought-1");

    // Only Alice should trigger queries (exact match + mention)
    // Empty and whitespace names are skipped
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("processes multiple names independently", async () => {
    mockQuery
      // Alice: exact match
      .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] })
      .mockResolvedValueOnce({ rows: [] })
      // Bob: no exact, no alias, create new
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "entity-2" }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["Alice", "Bob"], "thought-1");

    // 2 queries for Alice (exact match + mention) + 4 for Bob (exact + alias + create + mention)
    expect(mockQuery).toHaveBeenCalledTimes(6);
  });

  it("is idempotent — duplicate mentions use ON CONFLICT DO NOTHING", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "entity-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityMentions(["Alice"], "thought-1");

    expect(mockQuery.mock.calls[1][0]).toContain("ON CONFLICT DO NOTHING");
  });
});
