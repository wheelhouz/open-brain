import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockQuery = vi.fn();
const mockEmbedding = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", () => ({
  generateEmbedding: (...args: unknown[]) => mockEmbedding(...args),
}));

vi.mock("pgvector", () => ({
  default: { toSql: (v: number[]) => `[${v.join(",")}]` },
}));

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("POST /search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 without query", async () => {
    const res = await app.request("/api/search", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns search results", async () => {
    mockEmbedding.mockResolvedValue(new Array(1536).fill(0));
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: "uuid-1",
          content: "Test thought",
          metadata: { type: "observation" },
          similarity: 0.92,
          created_at: "2026-03-04T00:00:00Z",
        },
      ],
    });

    const res = await app.request("/api/search", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].similarity).toBe(0.92);
  });

  it("enforces max limit of 100", async () => {
    mockEmbedding.mockResolvedValue(new Array(1536).fill(0));
    const thoughts = Array.from({ length: 150 }, (_, i) => ({
      id: `uuid-${i}`,
      content: `Thought ${i}`,
      metadata: { type: "observation" },
      similarity: 0.9 - i * 0.001,
      created_at: new Date().toISOString(),
    }));
    mockQuery.mockResolvedValue({ rows: thoughts });

    const res = await app.request("/api/search", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test", limit: 500 }),
    });

    const body = await res.json();
    expect(body.results.length).toBeLessThanOrEqual(100);
  });
});
