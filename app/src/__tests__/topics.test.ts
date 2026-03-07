import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("GET /api/topics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/topics");
    expect(res.status).toBe(401);
  });

  it("returns topics with counts", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { topic: "api", count: "15", last_seen: "2026-03-04T00:00:00Z" },
        { topic: "testing", count: "8", last_seen: "2026-03-03T00:00:00Z" },
      ],
    });

    const res = await app.request("/api/topics", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topics).toHaveLength(2);
    expect(body.topics[0].topic).toBe("api");
    expect(body.topics[0].count).toBe(15);
    expect(body.topics[0].last_seen).toBe("2026-03-04T00:00:00Z");
  });

  it("returns empty array when no topics", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/topics", { headers: AUTH });
    const body = await res.json();
    expect(body.topics).toEqual([]);
  });
});
