import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: "0" }] });

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
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

const MCP_HEADERS = {
  ...AUTH,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function mcpInit(): Promise<string> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: MCP_HEADERS,
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
  const sessionId = res.headers.get("mcp-session-id") || "";
  return sessionId;
}

async function mcpCall(sessionId: string, method: string, params: unknown, id = 2) {
  return app.request("/mcp", {
    method: "POST",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
  });
}

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
      headers: MCP_HEADERS,
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

describe("MCP fact tools", () => {
  it("registers all fact-related tools", async () => {
    const sessionId = await mcpInit();

    const res = await mcpCall(sessionId, "tools/list", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    const toolNames = body.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("list_entity_facts");
    expect(toolNames).toContain("add_entity_fact");
    expect(toolNames).toContain("review_entity_fact");
    expect(toolNames).toContain("resolve_fact_conflict");
  });

  it("list_entity_facts returns facts by entity name", async () => {
    const sessionId = await mcpInit();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "f1", predicate: "from", object_display_text: "Porto" }] });

    const res = await mcpCall(sessionId, "tools/call", {
      name: "list_entity_facts",
      arguments: { entity_name: "Maya" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.content[0].text).toContain("Porto");
  });

  it("list_entity_facts filters by review_state", async () => {
    const sessionId = await mcpInit();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await mcpCall(sessionId, "tools/call", {
      name: "list_entity_facts",
      arguments: { entity_name: "Maya", review_state: "pending" },
    });

    const factQuery = mockQuery.mock.calls[1];
    expect(factQuery[0]).toContain("review_state = $");
  });

  it("list_entity_facts respects limit", async () => {
    const sessionId = await mcpInit();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1" }] })
      .mockResolvedValueOnce({ rows: [] });

    await mcpCall(sessionId, "tools/call", {
      name: "list_entity_facts",
      arguments: { entity_name: "Maya", limit: 5 },
    });

    const factQuery = mockQuery.mock.calls[1];
    expect(factQuery[1]).toContain(5);
  });

  it("add_entity_fact adds manual fact as active/accepted", async () => {
    const sessionId = await mcpInit();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1", canonical_name: "Maya" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "f1" }] });

    const res = await mcpCall(sessionId, "tools/call", {
      name: "add_entity_fact",
      arguments: { entity_name: "Maya", predicate: "from", value: "Porto", source_kind: "manual" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.content[0].text).toContain("active/accepted");
  });

  it("add_entity_fact adds agent fact as tentative/pending", async () => {
    const sessionId = await mcpInit();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1", canonical_name: "Maya" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "f1" }] });

    const res = await mcpCall(sessionId, "tools/call", {
      name: "add_entity_fact",
      arguments: { entity_name: "Maya", predicate: "from", value: "Porto" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.content[0].text).toContain("tentative/pending");
  });

  it("add_entity_fact returns conflict when conflicting fact exists", async () => {
    const sessionId = await mcpInit();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "e1", canonical_name: "Maya" }] })
      .mockResolvedValueOnce({ rows: [{ id: "f-old", predicate: "from", object_display_text: "Seattle", status: "active" }] });

    const res = await mcpCall(sessionId, "tools/call", {
      name: "add_entity_fact",
      arguments: { entity_name: "Maya", predicate: "from", value: "Porto" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.content[0].text).toContain("Conflict");
    expect(body.result.content[0].text).toContain("Seattle");
  });

  it("review_entity_fact accepts a pending fact", async () => {
    const sessionId = await mcpInit();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "f1", entity_id: "e1", predicate: "from", object_display_text: "Porto", review_state: "pending", canonical_name: "Maya" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await mcpCall(sessionId, "tools/call", {
      name: "review_entity_fact",
      arguments: { fact_id: "f1", action: "accept" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.content[0].text).toContain("Accepted");
  });

  it("review_entity_fact rejects a pending fact", async () => {
    const sessionId = await mcpInit();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "f1", entity_id: "e1", predicate: "from", object_display_text: "Porto", review_state: "pending", canonical_name: "Maya" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await mcpCall(sessionId, "tools/call", {
      name: "review_entity_fact",
      arguments: { fact_id: "f1", action: "reject" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.content[0].text).toContain("Rejected");
  });

  it("review_entity_fact returns conflict on accept when conflict exists", async () => {
    const sessionId = await mcpInit();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "f1", entity_id: "e1", predicate: "from", object_display_text: "Porto", review_state: "pending", canonical_name: "Maya" }] })
      .mockResolvedValueOnce({ rows: [{ id: "f2", predicate: "from", object_display_text: "Seattle", status: "active" }] });

    const res = await mcpCall(sessionId, "tools/call", {
      name: "review_entity_fact",
      arguments: { fact_id: "f1", action: "accept" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.content[0].text).toContain("conflicts");
    expect(body.result.content[0].text).toContain("Seattle");
  });

  it("resolve_fact_conflict replaces existing with new", async () => {
    const sessionId = await mcpInit();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "f1", entity_id: "e1", predicate: "from", object_display_text: "Porto", canonical_name: "Maya" }] })
      .mockResolvedValueOnce({ rows: [{ id: "f-old", object_display_text: "Seattle" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await mcpCall(sessionId, "tools/call", {
      name: "resolve_fact_conflict",
      arguments: { fact_id: "f1", action: "replace_existing_with_new" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.content[0].text).toContain("active");
    expect(body.result.content[0].text).toContain("superseded");
  });

  it("resolve_fact_conflict keeps both disputed", async () => {
    const sessionId = await mcpInit();
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "f1", entity_id: "e1", predicate: "from", object_display_text: "Porto", canonical_name: "Maya" }] });

    const res = await mcpCall(sessionId, "tools/call", {
      name: "resolve_fact_conflict",
      arguments: { fact_id: "f1", action: "keep_both_disputed" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.content[0].text).toContain("disputed");
  });
});
