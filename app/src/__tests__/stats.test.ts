import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("GET /stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns aggregate statistics", async () => {
    // Mock all 6 parallel queries
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: "42" }] }) // total
      .mockResolvedValueOnce({ rows: [{ type: "observation", count: "20" }, { type: "task", count: "10" }] }) // types
      .mockResolvedValueOnce({ rows: [{ topic: "api", count: "15" }] }) // topics
      .mockResolvedValueOnce({ rows: [{ person: "Sarah", count: "8" }] }) // people
      .mockResolvedValueOnce({ rows: [{ source: "web", count: "30" }] }) // sources
      .mockResolvedValueOnce({ rows: [{ date: "2026-03-04", count: "5" }] }); // daily

    const res = await app.request("/api/stats", { headers: AUTH });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(42);
    expect(body.types).toHaveLength(2);
    expect(body.topics[0].topic).toBe("api");
    expect(body.people[0].person).toBe("Sarah");
    expect(body.daily).toHaveLength(1);
  });
});
