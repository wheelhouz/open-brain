import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockQuery = vi.fn();
const mockGenerateEmbedding = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../pipeline.js", () => ({
  capturePipeline: vi.fn(),
}));

vi.mock("../openrouter.js", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  extractMetadata: vi.fn(),
  chatCompletion: vi.fn(),
}));

vi.mock("pgvector", () => ({
  default: { toSql: vi.fn((v: unknown) => `[${String(v)}]`) },
}));

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("GET /api/entities/:entityId/facts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("returns facts for an entity, excluding rejected by default", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: "fact-1", entity_id: "e1", predicate: "from", object_display_text: "Porto", status: "active", review_state: "accepted" },
      ],
    });

    const res = await app.request("/api/entities/e1/facts", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts).toHaveLength(1);
    expect(mockQuery.mock.calls[0][0]).toContain("review_state != 'rejected'");
  });

  it("filters by status when provided", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/entities/e1/facts?status=active", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[0][0]).toContain("status = $");
  });

  it("filters by review_state when provided", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/entities/e1/facts?review_state=pending", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[0][0]).toContain("review_state = $");
  });
});

describe("GET /api/entities/:entityId/facts/:factId", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("returns single fact with evidence array", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "fact-1", predicate: "from", object_display_text: "Porto" }] })
      .mockResolvedValueOnce({ rows: [{ id: "ev-1", fact_id: "fact-1", excerpt: "born in Porto" }] });

    const res = await app.request("/api/entities/e1/facts/fact-1", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fact.predicate).toBe("from");
    expect(body.evidence).toHaveLength(1);
  });

  it("returns 404 when fact not found", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/entities/e1/facts/missing", { headers: AUTH });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/entities/:entityId/facts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("creates manual fact as active/accepted", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ canonical_name: "Maya" }] }) // entity lookup
      .mockResolvedValueOnce({ rows: [] }) // no existing facts
      .mockResolvedValueOnce({ rows: [{ id: "new-fact", predicate: "from", object_display_text: "Porto", status: "active", review_state: "accepted" }] }) // insert
      .mockResolvedValueOnce({ rows: [] }); // evidence

    const res = await app.request("/api/entities/e1/facts", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ predicate: "from", value: "Porto" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.fact.status).toBe("active");
    expect(body.fact.review_state).toBe("accepted");
  });

  it("runs insertion contract — deduplicates same-meaning fact", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ canonical_name: "Maya" }] }) // entity lookup
      .mockResolvedValueOnce({ rows: [{ id: "existing", predicate: "from", object_display_text: "Porto", status: "active" }] }); // existing fact

    const res = await app.request("/api/entities/e1/facts", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ predicate: "from", value: "Porto" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deduplicated).toBe(true);
  });

  it("runs insertion contract — returns 409 on conflict with active fact", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ canonical_name: "Maya" }] }) // entity lookup
      .mockResolvedValueOnce({ rows: [{ id: "existing", predicate: "from", object_display_text: "Seattle", status: "active" }] }); // conflicting fact

    const res = await app.request("/api/entities/e1/facts", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ predicate: "from", value: "Porto" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("PATCH /api/entities/:entityId/facts/:factId", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("updates predicate and display text for accepted fact", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "fact-1", status: "active", review_state: "accepted", predicate: "from", object_display_text: "Porto" }] }) // fact lookup
      .mockResolvedValueOnce({ rows: [{ canonical_name: "Maya" }] }) // entity for embedding
      .mockResolvedValueOnce({ rows: [{ id: "fact-1", predicate: "born_in", object_display_text: "Lisbon" }] }); // update

    const res = await app.request("/api/entities/e1/facts/fact-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ predicate: "born_in", object_display_text: "Lisbon" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 409 for disputed fact", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "fact-1", status: "disputed", review_state: "pending", predicate: "from", object_display_text: "Porto" }] });

    const res = await app.request("/api/entities/e1/facts/fact-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ object_display_text: "Lisbon" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 409 for superseded fact", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "fact-1", status: "superseded", review_state: "accepted", predicate: "from", object_display_text: "Porto" }] });

    const res = await app.request("/api/entities/e1/facts/fact-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ object_display_text: "Lisbon" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/entities/:entityId/facts/:factId/accept", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("accepts pending fact when no conflict", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "fact-1", predicate: "from", review_state: "pending" }] }) // fact lookup
      .mockResolvedValueOnce({ rows: [] }) // no conflicts
      .mockResolvedValueOnce({ rows: [] }); // update

    const res = await app.request("/api/entities/e1/facts/fact-1/accept", {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
  });

  it("returns 409 with conflict details when active fact conflicts", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "fact-1", predicate: "from", review_state: "pending" }] })
      .mockResolvedValueOnce({ rows: [{ id: "fact-2", predicate: "from", object_display_text: "Seattle", status: "active" }] });

    const res = await app.request("/api/entities/e1/facts/fact-1/accept", {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(409);
  });

  it("returns 409 when disputed fact exists for same predicate", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "fact-1", predicate: "from", review_state: "pending" }] })
      .mockResolvedValueOnce({ rows: [{ id: "fact-2", predicate: "from", object_display_text: "Seattle", status: "disputed" }] });

    const res = await app.request("/api/entities/e1/facts/fact-1/accept", {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/entities/:entityId/facts/:factId/reject", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("sets review_state to rejected", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: "fact-1" }] });

    const res = await app.request("/api/entities/e1/facts/fact-1/reject", {
      method: "POST",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rejected).toBe(true);
  });
});

describe("POST /api/entities/:entityId/facts/:factId/resolve-conflict", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("replace_existing_with_new: new active, old superseded", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "new-fact", predicate: "from", entity_id: "e1" }] }) // new fact
      .mockResolvedValueOnce({ rows: [{ id: "old-fact" }] }) // old fact
      .mockResolvedValueOnce({ rows: [] }) // update new
      .mockResolvedValueOnce({ rows: [] }); // update old

    const res = await app.request("/api/entities/e1/facts/new-fact/resolve-conflict", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "replace_existing_with_new" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolved).toBe(true);
    // Verify new fact set to active
    expect(mockQuery.mock.calls[2][0]).toContain("active");
    // Verify old fact set to superseded
    expect(mockQuery.mock.calls[3][0]).toContain("superseded");
  });

  it("mark_old_as_past: old superseded with valid_at_end", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "new-fact", predicate: "lives_in", entity_id: "e1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "old-fact" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.request("/api/entities/e1/facts/new-fact/resolve-conflict", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_old_as_past" }),
    });
    expect(res.status).toBe(200);
    // Both replace_existing_with_new and mark_old_as_past do the same: new → active, old → superseded
    expect(mockQuery.mock.calls[3][0]).toContain("superseded");
  });

  it("mark_old_as_wrong: old rejected, new active", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "new-fact", predicate: "from", entity_id: "e1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "old-fact" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.request("/api/entities/e1/facts/new-fact/resolve-conflict", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_old_as_wrong" }),
    });
    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[3][0]).toContain("rejected");
  });

  it("keep_both_disputed: accepts new fact but keeps both disputed", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "new-fact", predicate: "from", entity_id: "e1" }] })
      .mockResolvedValueOnce({ rows: [] }); // accept pending fact

    const res = await app.request("/api/entities/e1/facts/new-fact/resolve-conflict", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "keep_both_disputed" }),
    });
    expect(res.status).toBe(200);
    // 2 queries: fact lookup + accept pending
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toContain("review_state = 'accepted'");
  });
});

describe("GET /api/facts/pending", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("returns cross-entity pending facts with entity name", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: "fact-1", predicate: "from", object_display_text: "Porto", entity_name: "Maya", review_state: "pending", created_at: "2026-03-17" },
      ],
    });

    const res = await app.request("/api/facts/pending", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts).toHaveLength(1);
    expect(body.facts[0].entity_name).toBe("Maya");
  });

  it("supports cursor pagination", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/facts/pending?cursor=2026-03-17T00:00:00Z", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[0][0]).toContain("created_at < $");
  });
});
