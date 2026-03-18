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

import { processFactCandidates, normalizePredicate, renderFactEmbeddingText } from "../facts.js";
import type { MentionResolution } from "../entities.js";

describe("normalizePredicate", () => {
  it("lowercases and trims", () => {
    expect(normalizePredicate("  Birthday  ")).toBe("birthday");
  });

  it("collapses whitespace", () => {
    expect(normalizePredicate("works  at")).toBe("works at");
  });

  it("strips trailing punctuation", () => {
    expect(normalizePredicate("from:")).toBe("from");
    expect(normalizePredicate("born_on.")).toBe("born_on");
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
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 0.5, excerpt: "..." }],
      "thought-1",
      mentionMap,
    );

    // No DB queries for fact insertion
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("skips candidates for unresolved entities", async () => {
    const unresolvedMap: MentionResolution[] = [
      { ...mentionMap[0], resolution_state: "pending_review" },
    ];

    await processFactCandidates(
      [{ entity: "Maya", predicate: "from", value: "Porto", display: "Porto", confidence: 0.9, excerpt: "..." }],
      "thought-1",
      unresolvedMap,
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
    );

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain("tentative"); // not disputed
  });
});
