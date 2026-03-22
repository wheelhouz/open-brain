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

vi.mock("../config.js", () => ({
  config: { factConfidenceThreshold: 0.80 },
}));

vi.mock("pgvector", () => ({
  default: { toSql: (v: number[]) => `[${v.join(",")}]` },
}));

import { processFactCandidates, normalizePredicate, renderFactEmbeddingText, isValidPredicateShape } from "../facts.js";
import type { MentionResolution } from "../entities.js";

describe("normalizePredicate", () => {
  it("lowercases and trims", () => {
    expect(normalizePredicate("  Birthday  ")).toBe("birthday");
  });

  it("converts spaces to underscores", () => {
    expect(normalizePredicate("works at")).toBe("works_at");
    expect(normalizePredicate("Works At")).toBe("works_at");
  });

  it("collapses whitespace to single underscore", () => {
    expect(normalizePredicate("works  at")).toBe("works_at");
  });

  it("is idempotent for snake_case input", () => {
    expect(normalizePredicate("works_at")).toBe("works_at");
  });

  it("converts hyphens to underscores", () => {
    expect(normalizePredicate("co-owns")).toBe("co_owns");
  });

  it("strips trailing punctuation", () => {
    expect(normalizePredicate("from:")).toBe("from");
    expect(normalizePredicate("born_on.")).toBe("born_on");
  });

  it("strips leading/trailing underscores", () => {
    expect(normalizePredicate("_works_at_")).toBe("works_at");
  });
});

describe("isValidPredicateShape", () => {
  it("accepts valid predicates", () => {
    expect(isValidPredicateShape("works_at")).toEqual({ valid: true });
    expect(isValidPredicateShape("from")).toEqual({ valid: true });
    expect(isValidPredicateShape("co_owns")).toEqual({ valid: true });
  });

  it("rejects empty predicate", () => {
    expect(isValidPredicateShape("")).toEqual({ valid: false, reason: "empty_predicate" });
  });

  it("rejects predicates longer than 40 chars", () => {
    expect(isValidPredicateShape("a".repeat(41))).toEqual({ valid: false, reason: "predicate_too_long" });
  });

  it("rejects predicates with more than 3 tokens", () => {
    expect(isValidPredicateShape("mentioned_that_she_prefers")).toEqual({ valid: false, reason: "predicate_too_many_tokens" });
  });

  it("rejects denylist predicates", () => {
    expect(isValidPredicateShape("related_to")).toEqual({ valid: false, reason: "predicate_denylist" });
    expect(isValidPredicateShape("said")).toEqual({ valid: false, reason: "predicate_denylist" });
  });
});

describe("renderFactEmbeddingText", () => {
  it("renders canonical format", () => {
    expect(renderFactEmbeddingText("Maya Patel", "from", "Porto"))
      .toBe("Maya Patel — from — Porto");
  });
});

describe("processFactCandidates", () => {
  const mentionMap: MentionResolution[] = [
    {
      raw_mention_text: "Maya",
      normalized_mention_text: "maya",
      entity_id: "entity-1",
      resolution_state: "auto_linked_exact",
      resolution_confidence: 1.0,
      resolution_metadata: { match_type: "canonical" },
    },
  ];

  beforeEach(() => {
    mockQuery.mockReset();
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it("skips candidates below confidence threshold", async () => {
    await processFactCandidates(
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 0.5, excerpt: "from Porto" }],
      "thought-1",
      mentionMap,
      "Maya is from Porto",
    );

    // No DB queries for fact insertion
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("skips candidates for unresolved entities", async () => {
    const unresolvedMap: MentionResolution[] = [
      { ...mentionMap[0], resolution_state: "pending_review" },
    ];

    await processFactCandidates(
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 0.9, excerpt: "from Porto" }],
      "thought-1",
      unresolvedMap,
      "Maya is from Porto",
    );

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("inserts new fact as tentative/pending when no conflict", async () => {
    // Existing facts query returns empty
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no existing facts
      .mockResolvedValueOnce({ rows: [{ id: "fact-1" }] }) // insert fact
      .mockResolvedValueOnce({ rows: [] }); // insert evidence

    await processFactCandidates(
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 0.9, excerpt: "grew up in Porto" }],
      "thought-1",
      mentionMap,
      "Maya grew up in Porto and loves the city",
    );

    // Verify fact insert
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO entity_facts");
    expect(insertCall[1]).toContain("entity-1"); // entity_id
    expect(insertCall[1]).toContain("from"); // predicate
    expect(insertCall[0]).toContain("tentative"); // status in SQL
    expect(insertCall[0]).toContain("pending"); // review_state in SQL

    // Verify evidence insert
    const evidenceCall = mockQuery.mock.calls[2];
    expect(evidenceCall[0]).toContain("INSERT INTO entity_fact_evidence");
    expect(evidenceCall[1]).toContain("fact-1");
    expect(evidenceCall[1]).toContain("thought-1");
  });

  it("attaches evidence to existing same-meaning fact instead of duplicating", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: "existing-fact", predicate: "from", object_display_text: "Porto", object_value_json: null, status: "active" }],
      }) // existing facts
      .mockResolvedValueOnce({ rows: [] }) // update updated_at
      .mockResolvedValueOnce({ rows: [] }); // insert evidence

    await processFactCandidates(
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 0.9, excerpt: "born in Porto" }],
      "thought-1",
      mentionMap,
      "Maya was born in Porto",
    );

    // Should NOT insert a new fact
    const calls = mockQuery.mock.calls.map((c) => c[0]);
    expect(calls.filter((sql: string) => sql.includes("INSERT INTO entity_facts"))).toHaveLength(0);
    // Should update updated_at on existing fact
    expect(calls[1]).toContain("UPDATE entity_facts");
    // Should insert evidence for existing fact
    expect(mockQuery.mock.calls[2][1]).toContain("existing-fact");
  });

  it("marks both facts disputed on conflict with active fact", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: "existing-fact", predicate: "lives_in", object_display_text: "Seattle", object_value_json: null, status: "active" }],
      }) // existing facts
      .mockResolvedValueOnce({ rows: [{ id: "new-fact" }] }) // insert new fact as disputed
      .mockResolvedValueOnce({ rows: [] }) // mark existing as disputed
      .mockResolvedValueOnce({ rows: [] }); // insert evidence

    await processFactCandidates(
      [{ entity: "Maya", predicate: "lives_in", value: "Portland", display: "Portland", confidence: 0.9, excerpt: "moved to Portland" }],
      "thought-1",
      mentionMap,
      "Maya moved to Portland last year",
    );

    // New fact inserted as disputed
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain("disputed");

    // Existing fact updated to disputed
    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[0]).toContain("UPDATE entity_facts");
    expect(updateCall[0]).toContain("disputed");
    expect(updateCall[1]).toContain("existing-fact");
  });

  it("inserts normally when conflict only with superseded fact", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: "old-fact", predicate: "lives_in", object_display_text: "Seattle", object_value_json: null, status: "superseded" }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "new-fact" }] }) // insert as tentative (not disputed)
      .mockResolvedValueOnce({ rows: [] }); // insert evidence

    await processFactCandidates(
      [{ entity: "Maya", predicate: "lives_in", value: "Portland", display: "Portland", confidence: 0.9, excerpt: "now in Portland" }],
      "thought-1",
      mentionMap,
      "Maya is now in Portland",
    );

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain("tentative"); // not disputed
  });

  it("logs structured event when candidate is below confidence threshold", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await processFactCandidates(
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 0.5, excerpt: "from Porto" }],
      "thought-1",
      mentionMap,
      "Maya is from Porto",
    );

    const logCalls = logSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(logCalls).toContainEqual(expect.objectContaining({
      event: "fact_skipped",
      reason: "confidence_below_threshold",
      thoughtId: "thought-1",
      entity: "Maya",
    }));
    logSpy.mockRestore();
  });

  it("logs structured event when entity is unresolved", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const unresolvedMap: MentionResolution[] = [
      { ...mentionMap[0], resolution_state: "pending_review" },
    ];

    await processFactCandidates(
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 0.9, excerpt: "from Porto" }],
      "thought-1",
      unresolvedMap,
      "Maya is from Porto",
    );

    const logCalls = logSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(logCalls).toContainEqual(expect.objectContaining({
      event: "fact_skipped",
      reason: "entity_unresolved",
      thoughtId: "thought-1",
      entity: "Maya",
      resolution_state: "pending_review",
    }));
    logSpy.mockRestore();
  });

  it("clamps out-of-range confidence to 0 and logs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await processFactCandidates(
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 1.5, excerpt: "from Porto" }],
      "thought-1",
      mentionMap,
      "Maya is from Porto",
    );

    const logCalls = logSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(logCalls).toContainEqual(expect.objectContaining({
      event: "fact_candidate_clamped",
      thoughtId: "thought-1",
      original: 1.5,
    }));
    // After clamping to 0, it should be below threshold and skipped
    expect(logCalls).toContainEqual(expect.objectContaining({
      event: "fact_skipped",
      reason: "confidence_below_threshold",
    }));
    expect(mockQuery).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
