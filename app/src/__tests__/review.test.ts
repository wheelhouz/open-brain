import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockQuery = vi.fn();
const mockChat = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", () => {
  const { AsyncLocalStorage } = require("node:async_hooks");
  return {
    chatCompletion: (...args: unknown[]) => mockChat(...args),
    sourceContext: new AsyncLocalStorage(),
  };
});

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("GET /review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty review when no thoughts", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/review", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total_thoughts).toBe(0);
    expect(body.themes).toEqual([]);
  });

  it("returns structured review using open_loops and entities", async () => {
    // Call 1: thoughts query
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "1",
          content: "Met with Sarah about API",
          metadata: {
            type: "meeting_note",
            topics: ["api"],
          },
          created_at: new Date().toISOString(),
        },
        {
          id: "2",
          content: "New idea for caching",
          metadata: {
            type: "idea",
            topics: ["api", "performance"],
          },
          created_at: new Date().toISOString(),
        },
      ],
    });

    // Call 2: open_loops query
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "loop-1",
          content: "Rewrite API",
          loop_type: "task",
          source_thought_id: "1",
          created_at: new Date().toISOString(),
        },
      ],
    });

    // Call 3: entities/people query
    mockQuery.mockResolvedValueOnce({
      rows: [
        { canonical_name: "Sarah", mention_count: 3 },
      ],
    });

    mockChat.mockResolvedValue("Focus on completing the API rewrite.");

    const res = await app.request("/api/review", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total_thoughts).toBe(2);
    expect(body.open_action_items).toHaveLength(1);
    expect(body.open_action_items[0].item).toBe("Rewrite API");
    expect(body.open_action_items[0].loop_type).toBe("task");
    expect(body.top_people[0].name).toBe("Sarah");
    expect(body.top_people[0].mentions).toBe(3);
    expect(body.themes.length).toBeGreaterThan(0);

    // Verify open_loops query was made
    const loopsSql = mockQuery.mock.calls[1][0] as string;
    expect(loopsSql).toContain("open_loops");

    // Verify entities query was made
    const peopleSql = mockQuery.mock.calls[2][0] as string;
    expect(peopleSql).toContain("entities");
    expect(peopleSql).toContain("entity_mentions");
  });
});
