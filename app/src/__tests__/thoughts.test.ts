import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  extractMetadata: vi.fn().mockResolvedValue({
    type: "idea",
    topics: ["testing"],
    people: [],
    action_items: [],
    dates_mentioned: [],
    source_context: null,
  }),
}));

vi.mock("pgvector", () => ({
  default: { toSql: (v: number[]) => `[${v.join(",")}]` },
}));

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("GET /thoughts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns paginated thoughts", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: "1", content: "thought 1", metadata: {}, created_at: "2026-03-04", updated_at: "2026-03-04" },
        { id: "2", content: "thought 2", metadata: {}, created_at: "2026-03-03", updated_at: "2026-03-03" },
      ],
    });

    const res = await app.request("/api/thoughts?limit=2", {
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thoughts).toHaveLength(2);
    expect(body.next_cursor).toBeNull();
  });

  it("returns next_cursor when more results exist", async () => {
    // Return limit + 1 rows to signal there's more
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `${i}`, content: `t${i}`, metadata: {},
      created_at: `2026-03-0${3 - i}`, updated_at: `2026-03-0${3 - i}`,
    }));
    mockQuery.mockResolvedValue({ rows });

    const res = await app.request("/api/thoughts?limit=2", {
      headers: AUTH,
    });

    const body = await res.json();
    expect(body.thoughts).toHaveLength(2);
    expect(body.next_cursor).toBe("2026-03-02");
  });

  it("includes loop_count in response", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: "1", content: "thought 1", metadata: {}, created_at: "2026-03-04", updated_at: "2026-03-04", thread_count: 0, loop_count: 3 },
      ],
    });

    const res = await app.request("/api/thoughts?limit=1", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thoughts[0].loop_count).toBe(3);
    // Verify SQL includes loop_count subquery
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("loop_count");
  });

  it("filters by type", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await app.request("/api/thoughts?type=task", { headers: AUTH });

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("metadata->>'type'");
    expect(mockQuery.mock.calls[0][1][0]).toBe("task");
  });
});

describe("GET /thoughts/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a single thought", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: "uuid-1", content: "test", metadata: {}, created_at: "2026-03-04", updated_at: "2026-03-04" }],
    });

    const res = await app.request("/api/thoughts/uuid-1", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("uuid-1");
  });

  it("returns 404 for non-existent thought", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/thoughts/nonexistent", { headers: AUTH });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /thoughts/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("soft-deletes a thought", async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: "uuid-1" }] });

    const res = await app.request("/api/thoughts/uuid-1", {
      method: "DELETE",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
  });

  it("returns 404 for non-existent thought", async () => {
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });

    const res = await app.request("/api/thoughts/nonexistent", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/thoughts/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates content and re-embeds", async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        id: "uuid-1", content: "updated text", metadata: { type: "observation", topics: [] },
        created_at: "2026-03-04", updated_at: "2026-03-05",
      }],
    });

    const res = await app.request("/api/thoughts/uuid-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "updated text" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("uuid-1");
    expect(body.content).toBe("updated text");

    const { generateEmbedding } = await import("../openrouter.js");
    expect(generateEmbedding).toHaveBeenCalledWith("updated text");
  });

  it("re-processes metadata when reprocess=true", async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        id: "uuid-1", content: "updated", metadata: { type: "idea", topics: ["testing"] },
        created_at: "2026-03-04", updated_at: "2026-03-05",
      }],
    });

    const res = await app.request("/api/thoughts/uuid-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "updated", reprocess: true }),
    });

    expect(res.status).toBe(200);
    const { extractMetadata } = await import("../openrouter.js");
    expect(extractMetadata).toHaveBeenCalledWith("updated");
  });

  it("returns 400 if content is empty", async () => {
    const res = await app.request("/api/thoughts/uuid-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent thought", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/thoughts/uuid-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test" }),
    });
    expect(res.status).toBe(404);
  });
});
