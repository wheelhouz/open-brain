import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../config.js", () => ({
  config: { entityFuzzyThreshold: 0.35 },
}));

import { resolveEntityCandidates } from "../entities.js";

describe("resolveEntityCandidates", () => {
  beforeEach(() => vi.resetAllMocks());

  it("resolves known entity by exact canonical_name", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "entity-1" }] });

    const result = await resolveEntityCandidates(["Alice"]);

    expect(result).toEqual([{ name: "Alice", entity_id: "entity-1" }]);
    expect(mockQuery.mock.calls[0][0]).toContain("lower(canonical_name) = lower($1)");
  });

  it("resolves known entity by alias", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // exact miss
      .mockResolvedValueOnce({ rows: [{ id: "entity-2" }] }); // alias hit

    const result = await resolveEntityCandidates(["Al"]);

    expect(result).toEqual([{ name: "Al", entity_id: "entity-2" }]);
    expect(mockQuery.mock.calls[1][0]).toContain("ILIKE ANY(aliases)");
  });

  it("resolves known entity by fuzzy match above threshold", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // exact miss
      .mockResolvedValueOnce({ rows: [] }) // alias miss
      .mockResolvedValueOnce({ rows: [{ id: "entity-3", sim: 0.5 }] }); // fuzzy hit

    const result = await resolveEntityCandidates(["Allice"]);

    expect(result).toEqual([{ name: "Allice", entity_id: "entity-3" }]);
  });

  it("returns null entity_id for unknown names", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // exact miss
      .mockResolvedValueOnce({ rows: [] }) // alias miss
      .mockResolvedValueOnce({ rows: [] }); // fuzzy miss

    const result = await resolveEntityCandidates(["Xyzzy"]);

    expect(result).toEqual([{ name: "Xyzzy", entity_id: null }]);
  });

  it("returns null when fuzzy match is below threshold", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "entity-far", sim: 0.2 }] });

    const result = await resolveEntityCandidates(["Zzz"]);

    expect(result).toEqual([{ name: "Zzz", entity_id: null }]);
  });

  it("resolves multiple names independently", async () => {
    // Alice: exact hit
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "entity-a" }] });
    // Unknown: all miss
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await resolveEntityCandidates(["Alice", "Unknown"]);

    expect(result).toEqual([
      { name: "Alice", entity_id: "entity-a" },
      { name: "Unknown", entity_id: null },
    ]);
  });

  it("skips empty and whitespace-only names", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "entity-1" }] });

    const result = await resolveEntityCandidates(["", "  ", "Alice"]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Alice");
  });

  it("is read-only — all queries are SELECTs", async () => {
    // Run through all 3 resolution paths (all miss → unresolvable)
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await resolveEntityCandidates(["Test"]);

    // Verify every query starts with SELECT
    for (const call of mockQuery.mock.calls) {
      const sql = call[0] as string;
      expect(sql.trim().toUpperCase()).toMatch(/^SELECT/);
    }
  });

  it("does not INSERT, UPDATE, or DELETE", async () => {
    // Exact match path
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "entity-1" }] });
    await resolveEntityCandidates(["Alice"]);

    // Reset and try fuzzy match path
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "entity-2", sim: 0.5 }] });
    await resolveEntityCandidates(["Allice"]);

    for (const call of mockQuery.mock.calls) {
      const sql = (call[0] as string).trim().toUpperCase();
      expect(sql).not.toMatch(/^INSERT/);
      expect(sql).not.toMatch(/^UPDATE/);
      expect(sql).not.toMatch(/^DELETE/);
    }
  });
});

describe("QueryRewrite intent fields", () => {
  it("rewriteQuery returns new fields in fallback", async () => {
    // We need to test the actual rewriteQuery function
    vi.doUnmock("../openrouter.js");

    // Mock the fetch to simulate OpenRouter failure → fallback
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    // Re-import to get the real function
    const { rewriteQuery } = await import("../openrouter.js");

    const result = await rewriteQuery([{ role: "user", content: "What about Liz?" }]);

    expect(result.memory_types).toEqual(["all"]);
    expect(result.prefer_open_loops).toBe(false);
    expect(result.entity_candidate_names).toEqual([]);
    expect(result.intent_type).toBe("informational");
    expect(result.search_query).toBe("What about Liz?");

    globalThis.fetch = originalFetch;
  });
});
