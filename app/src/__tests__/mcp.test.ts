import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

vi.mock("../db.js", () => ({
  pool: {},
  query: vi.fn().mockResolvedValue({ rows: [{ count: "0" }] }),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
  extractMetadata: vi.fn().mockResolvedValue({
    type: "observation", topics: [], people: [],
    action_items: [], dates_mentioned: [], source_context: null,
  }),
  chatCompletion: vi.fn().mockResolvedValue("Summary"),
  normalizeContent: vi.fn().mockImplementation((c: string) => Promise.resolve(c)),
}));

vi.mock("pgvector", () => ({
  default: { toSql: (v: number[]) => `[${v.join(",")}]` },
}));

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("MCP endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        id: 1,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("handles MCP initialization", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        ...AUTH,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
        id: 1,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("open-brain");
  });

  it("supports query param auth", async () => {
    const key = process.env.BRAIN_ACCESS_KEY;
    const res = await app.request(`/mcp?key=${key}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
        id: 1,
      }),
    });

    expect(res.status).toBe(200);
  });
});
