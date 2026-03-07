import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockQuery = vi.fn();
const mockChat = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", () => ({
  chatCompletion: (...args: unknown[]) => mockChat(...args),
}));

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

  it("returns structured review with themes and action items", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: "1",
          content: "Met with Sarah about API",
          metadata: {
            type: "meeting_note",
            topics: ["api"],
            people: ["Sarah"],
            action_items: ["Rewrite API"],
          },
          created_at: new Date().toISOString(),
        },
        {
          id: "2",
          content: "New idea for caching",
          metadata: {
            type: "idea",
            topics: ["api", "performance"],
            people: [],
            action_items: [],
          },
          created_at: new Date().toISOString(),
        },
      ],
    });

    mockChat.mockResolvedValue("Focus on completing the API rewrite.");

    const res = await app.request("/api/review", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total_thoughts).toBe(2);
    expect(body.open_action_items).toHaveLength(1);
    expect(body.open_action_items[0].item).toBe("Rewrite API");
    expect(body.top_people[0].name).toBe("Sarah");
    expect(body.themes.length).toBeGreaterThan(0);
  });
});
