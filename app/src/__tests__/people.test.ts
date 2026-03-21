import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("GET /api/people", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/people");
    expect(res.status).toBe(401);
  });

  it("returns people with counts from entities", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: "e1", name: "Sarah", mention_count: 12, last_seen: "2026-03-04T00:00:00Z" },
        { id: "e2", name: "Alex", mention_count: 5, last_seen: "2026-03-02T00:00:00Z" },
      ],
    });

    const res = await app.request("/api/people", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.people).toHaveLength(2);
    expect(body.people[0].person).toBe("Sarah");
    expect(body.people[0].count).toBe(12);

    // Verify entity-backed query
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("entities");
    expect(sql).toContain("entity_mentions");
  });

  it("returns empty array when no people", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/people", { headers: AUTH });
    const body = await res.json();
    expect(body.people).toEqual([]);
  });
});

describe("PATCH /api/people/:name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renames entity and adds old name as alias", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1" }] }) // entity lookup
      .mockResolvedValueOnce({ rows: [] }); // update

    const res = await app.request("/api/people/Sarah", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Sarah Connor" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.renamed).toBe(true);
    expect(body.from).toBe("Sarah");
    expect(body.to).toBe("Sarah Connor");

    // Verify entity rename query
    const updateSql = mockQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain("UPDATE entities");
    expect(updateSql).toContain("canonical_name");
    expect(updateSql).toContain("aliases");
  });

  it("returns 404 when entity not found", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/people/Unknown", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Someone" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 400 when names are the same", async () => {
    const res = await app.request("/api/people/Sarah", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Sarah" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/people/:name/thoughts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns thoughts via entity_mentions when entity exists", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1" }] }) // entity lookup
      .mockResolvedValueOnce({
        rows: [{ id: "t1", content: "Met Sarah", metadata: {}, created_at: "2026-03-04", updated_at: "2026-03-04" }],
      });

    const res = await app.request("/api/people/Sarah/thoughts", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thoughts).toHaveLength(1);

    // Verify entity_mentions join
    const sql = mockQuery.mock.calls[1][0] as string;
    expect(sql).toContain("entity_mentions");
  });

  it("falls back to metadata when entity not found", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // entity not found
      .mockResolvedValueOnce({ rows: [] }); // metadata fallback

    const res = await app.request("/api/people/Unknown/thoughts", { headers: AUTH });
    expect(res.status).toBe(200);

    // Verify metadata fallback
    const sql = mockQuery.mock.calls[1][0] as string;
    expect(sql).toContain("metadata->'people'");
  });
});
