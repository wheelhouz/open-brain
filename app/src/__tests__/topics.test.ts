import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

const mockCategorizeTopics = vi.fn();

vi.mock("../openrouter.js", () => ({
  openrouterRequest: vi.fn(),
  categorizeTopics: (...args: unknown[]) => mockCategorizeTopics(...args),
  generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
  extractMetadata: vi.fn().mockResolvedValue({
    type: "observation",
    topics: [],
    people: [],
    action_items: [],
    dates_mentioned: [],
    source_context: null,
  }),
  assignCategory: vi.fn().mockResolvedValue("General"),
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

  it("returns topics with counts and categories", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { topic: "api", count: "15", last_seen: "2026-03-04T00:00:00Z", category: "Development" },
        { topic: "testing", count: "8", last_seen: "2026-03-03T00:00:00Z", category: "Development" },
        { topic: "cooking", count: "3", last_seen: "2026-03-02T00:00:00Z", category: "Personal" },
      ],
    });

    const res = await app.request("/api/topics", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topics).toHaveLength(3);
    expect(body.topics[0].topic).toBe("api");
    expect(body.topics[0].count).toBe(15);
    expect(body.topics[0].last_seen).toBe("2026-03-04T00:00:00Z");
    expect(body.topics[0].category).toBe("Development");
    expect(body.categories).toEqual(["Development", "Personal"]);
  });

  it("returns Uncategorized when no topic_categories rows", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { topic: "api", count: "15", last_seen: "2026-03-04T00:00:00Z", category: "Uncategorized" },
      ],
    });

    const res = await app.request("/api/topics", { headers: AUTH });
    const body = await res.json();
    expect(body.topics[0].category).toBe("Uncategorized");
    expect(body.categories).toEqual(["Uncategorized"]);
  });

  it("returns empty array when no topics", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/topics", { headers: AUTH });
    const body = await res.json();
    expect(body.topics).toEqual([]);
    expect(body.categories).toEqual([]);
  });
});

describe("POST /api/topics/categorize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/topics/categorize", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("categorizes topics and returns result", async () => {
    // First call: fetch distinct topics
    mockQuery.mockResolvedValueOnce({
      rows: [{ topic: "api" }, { topic: "testing" }, { topic: "cooking" }],
    });

    mockCategorizeTopics.mockResolvedValue([
      { name: "Development", topics: ["api", "testing"] },
      { name: "Personal", topics: ["cooking"] },
    ]);

    // DELETE all
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT calls (3 topics)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await app.request("/api/topics/categorize", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.categories).toEqual(["Development", "Personal"]);
    expect(body.assigned).toBe(3);
  });

  it("returns empty when no topics exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.request("/api/topics/categorize", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    expect(body.categories).toEqual([]);
    expect(body.assigned).toBe(0);
  });
});
