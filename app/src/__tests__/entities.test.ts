import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../pipeline.js", () => ({
  capturePipeline: vi.fn(),
}));

vi.mock("../openrouter.js", () => {
  const { AsyncLocalStorage } = require("node:async_hooks");
  return {
    generateEmbedding: vi.fn(),
    extractMetadata: vi.fn(),
    chatCompletion: vi.fn(),
    sourceContext: new AsyncLocalStorage(),
  };
});

vi.mock("pgvector", () => ({
  default: { toSql: vi.fn((v: unknown) => v) },
}));

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("GET /api/entities", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/entities");
    expect(res.status).toBe(401);
  });

  it("returns entities list with mention counts", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: "entity-1",
          canonical_name: "Alice",
          entity_type: "person",
          aliases: ["Alice", "Al"],
          attributes: {},
          mention_count: "5",
          last_seen: "2026-03-14T00:00:00Z",
          created_at: "2026-03-01T00:00:00Z",
        },
      ],
    });

    const res = await app.request("/api/entities", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entities).toHaveLength(1);
    expect(body.entities[0].canonical_name).toBe("Alice");
    expect(body.entities[0].mention_count).toBe(5);
  });

  it("filters by type", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/entities?type=person", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("entity_type = $1"),
      expect.arrayContaining(["person"]),
    );
  });
});

describe("GET /api/entities/:id", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 404 for non-existent entity", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/entities/nonexistent", { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it("returns entity detail with mention count", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: "entity-1",
          canonical_name: "Bob",
          entity_type: "person",
          aliases: ["Bob", "Bobby"],
          attributes: {},
          mention_count: "3",
          last_seen: "2026-03-14T00:00:00Z",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-10T00:00:00Z",
        },
      ],
    });

    const res = await app.request("/api/entities/entity-1", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canonical_name).toBe("Bob");
    expect(body.mention_count).toBe(3);
  });
});

describe("PATCH /api/entities/:id", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 404 for non-existent entity", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/entities/nonexistent", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ canonical_name: "New Name" }),
    });
    expect(res.status).toBe(404);
  });

  it("updates canonical_name and renames across thoughts", async () => {
    mockQuery
      // SELECT existing entity
      .mockResolvedValueOnce({ rows: [{ id: "entity-1", canonical_name: "Old Name" }] })
      // SELECT conflict check — no conflict
      .mockResolvedValueOnce({ rows: [] })
      // UPDATE entities
      .mockResolvedValueOnce({ rows: [] })
      // UPDATE thoughts metadata.people
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.request("/api/entities/entity-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ canonical_name: "New Name" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(true);
    // Verify the rename query updates thoughts metadata
    expect(mockQuery).toHaveBeenCalledTimes(4);
    expect(mockQuery.mock.calls[3][0]).toContain("UPDATE thoughts");
    expect(mockQuery.mock.calls[3][1]).toEqual(["Old Name", "New Name"]);
  });

  it("returns 409 when renaming to an existing entity name", async () => {
    mockQuery
      // SELECT existing entity
      .mockResolvedValueOnce({ rows: [{ id: "entity-1", canonical_name: "Old Name" }] })
      // SELECT conflict check
      .mockResolvedValueOnce({ rows: [{ id: "entity-2", canonical_name: "Alice" }] });

    const res = await app.request("/api/entities/entity-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ canonical_name: "Alice" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.conflict).toBe("name_exists");
    expect(body.existing_entity.id).toBe("entity-2");
    expect(body.existing_entity.canonical_name).toBe("Alice");
  });

  it("proceeds with rename when no conflict exists", async () => {
    mockQuery
      // SELECT existing entity
      .mockResolvedValueOnce({ rows: [{ id: "entity-1", canonical_name: "Old Name" }] })
      // SELECT conflict check — no conflict
      .mockResolvedValueOnce({ rows: [] })
      // UPDATE entities
      .mockResolvedValueOnce({ rows: [] })
      // UPDATE thoughts metadata.people
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.request("/api/entities/entity-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ canonical_name: "New Name" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(true);
  });

  it("updates aliases without renaming thoughts", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "entity-1", canonical_name: "Alice" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.request("/api/entities/entity-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ aliases: ["Alice", "Al", "Ally"] }),
    });
    expect(res.status).toBe(200);
    // No third call — name didn't change, so no thought rename
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/entities/merge", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 400 for missing ids", async () => {
    const res = await app.request("/api/entities/merge", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: "a" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for merging entity with itself", async () => {
    const res = await app.request("/api/entities/merge", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: "same-id", target_id: "same-id" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when source or target not found", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "target", canonical_name: "Bob", aliases: ["Bob"] }] });

    const res = await app.request("/api/entities/merge", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: "missing", target_id: "target" }),
    });
    expect(res.status).toBe(404);
  });

  it("merges source into target", async () => {
    mockQuery
      // Fetch source
      .mockResolvedValueOnce({ rows: [{ id: "src", canonical_name: "Bob", aliases: ["Bob", "Bobby"] }] })
      // Fetch target
      .mockResolvedValueOnce({ rows: [{ id: "tgt", canonical_name: "Robert", aliases: ["Robert", "Rob"] }] })
      // Reassign mentions
      .mockResolvedValueOnce({ rows: [] })
      // Source facts
      .mockResolvedValueOnce({ rows: [] })
      // Target facts
      .mockResolvedValueOnce({ rows: [] })
      // Update target aliases
      .mockResolvedValueOnce({ rows: [] })
      // Update thoughts metadata
      .mockResolvedValueOnce({ rows: [] })
      // Delete source
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.request("/api/entities/merge", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: "src", target_id: "tgt" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merged).toBe(true);
    expect(body.target_id).toBe("tgt");
    expect(body.aliases).toContain("Robert");
    expect(body.aliases).toContain("Rob");
    expect(body.aliases).toContain("Bob");
    expect(body.aliases).toContain("Bobby");
  });

  it("moves facts from source to target entity", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "src", canonical_name: "Bob", aliases: ["Bob"] }] })
      .mockResolvedValueOnce({ rows: [{ id: "tgt", canonical_name: "Robert", aliases: ["Robert"] }] })
      .mockResolvedValueOnce({ rows: [] }) // reassign mentions
      .mockResolvedValueOnce({ rows: [{ id: "sf1", predicate: "works_at", object_display_text: "Acme", status: "active" }] }) // source facts
      .mockResolvedValueOnce({ rows: [] }) // target facts (no match)
      .mockResolvedValueOnce({ rows: [] }) // move fact to target
      .mockResolvedValueOnce({ rows: [] }) // update aliases
      .mockResolvedValueOnce({ rows: [] }) // update thoughts
      .mockResolvedValueOnce({ rows: [] }); // delete source

    const res = await app.request("/api/entities/merge", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: "src", target_id: "tgt" }),
    });
    expect(res.status).toBe(200);
    // Verify fact was moved to target
    const moveCall = mockQuery.mock.calls[5];
    expect(moveCall[0]).toContain("UPDATE entity_facts SET entity_id");
    expect(moveCall[1]).toContain("tgt");
    expect(moveCall[1]).toContain("sf1");
  });

  it("deduplicates same-meaning facts and merges evidence", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "src", canonical_name: "Bob", aliases: ["Bob"] }] })
      .mockResolvedValueOnce({ rows: [{ id: "tgt", canonical_name: "Robert", aliases: ["Robert"] }] })
      .mockResolvedValueOnce({ rows: [] }) // reassign mentions
      .mockResolvedValueOnce({ rows: [{ id: "sf1", predicate: "from", object_display_text: "Porto", status: "tentative" }] }) // source facts
      .mockResolvedValueOnce({ rows: [{ id: "tf1", predicate: "from", object_display_text: "Porto", status: "tentative" }] }) // target facts (same meaning)
      .mockResolvedValueOnce({ rows: [] }) // move evidence
      .mockResolvedValueOnce({ rows: [] }) // delete source fact
      .mockResolvedValueOnce({ rows: [] }) // update aliases
      .mockResolvedValueOnce({ rows: [] }) // update thoughts
      .mockResolvedValueOnce({ rows: [] }); // delete source

    const res = await app.request("/api/entities/merge", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: "src", target_id: "tgt" }),
    });
    expect(res.status).toBe(200);
    // Evidence moved to target fact
    const evidenceCall = mockQuery.mock.calls[5];
    expect(evidenceCall[0]).toContain("UPDATE entity_fact_evidence SET fact_id");
    expect(evidenceCall[1]).toEqual(["tf1", "sf1"]);
    // Source fact deleted
    const deleteCall = mockQuery.mock.calls[6];
    expect(deleteCall[0]).toContain("DELETE FROM entity_facts");
    expect(deleteCall[1]).toEqual(["sf1"]);
  });

  it("keeps stronger status on deduplicated facts (active > tentative)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "src", canonical_name: "Bob", aliases: ["Bob"] }] })
      .mockResolvedValueOnce({ rows: [{ id: "tgt", canonical_name: "Robert", aliases: ["Robert"] }] })
      .mockResolvedValueOnce({ rows: [] }) // reassign mentions
      .mockResolvedValueOnce({ rows: [{ id: "sf1", predicate: "from", object_display_text: "Porto", status: "active" }] }) // source: active
      .mockResolvedValueOnce({ rows: [{ id: "tf1", predicate: "from", object_display_text: "Porto", status: "tentative" }] }) // target: tentative
      .mockResolvedValueOnce({ rows: [] }) // move evidence
      .mockResolvedValueOnce({ rows: [] }) // update target fact status to active
      .mockResolvedValueOnce({ rows: [] }) // delete source fact
      .mockResolvedValueOnce({ rows: [] }) // update aliases
      .mockResolvedValueOnce({ rows: [] }) // update thoughts
      .mockResolvedValueOnce({ rows: [] }); // delete source

    const res = await app.request("/api/entities/merge", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: "src", target_id: "tgt" }),
    });
    expect(res.status).toBe(200);
    // Target fact status updated to active (stronger)
    const statusCall = mockQuery.mock.calls[6];
    expect(statusCall[0]).toContain("UPDATE entity_facts SET status");
    expect(statusCall[1]).toContain("active");
    expect(statusCall[1]).toContain("tf1");
  });

  it("does not collapse similar-but-not-identical facts", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "src", canonical_name: "Bob", aliases: ["Bob"] }] })
      .mockResolvedValueOnce({ rows: [{ id: "tgt", canonical_name: "Robert", aliases: ["Robert"] }] })
      .mockResolvedValueOnce({ rows: [] }) // reassign mentions
      .mockResolvedValueOnce({ rows: [{ id: "sf1", predicate: "from", object_display_text: "Porto", status: "active" }] }) // source
      .mockResolvedValueOnce({ rows: [{ id: "tf1", predicate: "from", object_display_text: "Lisbon", status: "active" }] }) // target (different value)
      .mockResolvedValueOnce({ rows: [] }) // move fact (not deduplicate)
      .mockResolvedValueOnce({ rows: [] }) // update aliases
      .mockResolvedValueOnce({ rows: [] }) // update thoughts
      .mockResolvedValueOnce({ rows: [] }); // delete source

    const res = await app.request("/api/entities/merge", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: "src", target_id: "tgt" }),
    });
    expect(res.status).toBe(200);
    // Should move, not merge
    const moveCall = mockQuery.mock.calls[5];
    expect(moveCall[0]).toContain("UPDATE entity_facts SET entity_id");
  });
});

describe("GET /api/entities/:id/thoughts", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns paginated thoughts mentioning entity", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: "thought-1",
          content: "Met with Alice today",
          metadata: { people: ["Alice"] },
          created_at: "2026-03-14T00:00:00Z",
        },
      ],
    });

    const res = await app.request("/api/entities/entity-1/thoughts", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thoughts).toHaveLength(1);
    expect(body.thoughts[0].content).toContain("Alice");
    expect(body.next_cursor).toBeNull();
  });

  it("returns next_cursor when more results exist", async () => {
    // Default limit is 20, so returning 21 rows triggers hasMore
    const rows = Array.from({ length: 21 }, (_, i) => ({
      id: `thought-${i}`,
      content: `Thought ${i}`,
      metadata: {},
      created_at: `2026-03-${String(14 - i).padStart(2, "0")}T00:00:00Z`,
    }));
    mockQuery.mockResolvedValue({ rows });

    const res = await app.request("/api/entities/entity-1/thoughts", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thoughts).toHaveLength(20);
    expect(body.next_cursor).not.toBeNull();
  });

  it("supports cursor pagination", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request(
      "/api/entities/entity-1/thoughts?cursor=2026-03-10T00:00:00Z",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("created_at < $"),
      expect.arrayContaining(["2026-03-10T00:00:00Z"]),
    );
  });
});
