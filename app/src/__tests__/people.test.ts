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

  it("returns people with counts", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { person: "Sarah", count: "12", last_seen: "2026-03-04T00:00:00Z" },
        { person: "Alex", count: "5", last_seen: "2026-03-02T00:00:00Z" },
      ],
    });

    const res = await app.request("/api/people", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.people).toHaveLength(2);
    expect(body.people[0].person).toBe("Sarah");
    expect(body.people[0].count).toBe(12);
  });

  it("returns empty array when no people", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/people", { headers: AUTH });
    const body = await res.json();
    expect(body.people).toEqual([]);
  });
});
