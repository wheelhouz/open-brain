import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

// Mock config to keep spendHardCutoffUsd = 0 (budget check disabled)
vi.mock("../config.js", () => ({
  config: {
    port: 8420,
    databaseUrl: "postgres://x",
    brainAccessKey: "test",
    openrouterApiKey: "test-key",
    embeddingModel: "openai/text-embedding-3-small",
    extractionModel: "openai/gpt-4o-mini",
    chatModel: "anthropic/claude-sonnet-4-6",
    maxContentLength: 50 * 1024,
    entityFuzzyThreshold: 0.35,
    factConfidenceThreshold: 0.80,
    monthlyBudgetUsd: 0,
    spendAlertThresholdPct: 80,
    spendHardCutoffUsd: 0, // budget check disabled
  },
}));

import { openrouterRequest } from "../openrouter.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openrouterRequest spend tracking integration", () => {
  it("calls recordUsage (INSERT into ai_usage_log) after a successful request", async () => {
    const fakeResponse = {
      choices: [{ message: { content: "hello" } }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 100,
        total_tokens: 150,
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => fakeResponse,
    });

    // Allow INSERT to ai_usage_log to proceed
    mockQuery.mockResolvedValue({ rows: [] });

    await openrouterRequest("/chat/completions", {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "test" }],
    }, "test_operation");

    // recordUsage is fire-and-forget (void), so we need to flush the microtask queue
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockQuery).toHaveBeenCalled();
    const insertCall = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO ai_usage_log"),
    );
    expect(insertCall).toBeDefined();

    const [sql, params] = insertCall!;
    expect(sql).toContain("INSERT INTO ai_usage_log");
    expect(params[0]).toBe("test_operation"); // operation
    expect(params[1]).toBe("openai/gpt-4o-mini"); // model
    expect(params[3]).toBe(50);  // prompt_tokens
    expect(params[4]).toBe(100); // completion_tokens
    expect(params[5]).toBe(150); // total_tokens
    expect(params[8]).toBe(true); // success
  });

  it("records failed requests with success=false and errorCode", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    });

    mockQuery.mockResolvedValue({ rows: [] });

    await expect(
      openrouterRequest("/chat/completions", {
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "test" }],
      }, "test_operation"),
    ).rejects.toThrow("OpenRouter");

    // Flush microtasks for the fire-and-forget recordUsage
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockQuery).toHaveBeenCalled();
    const insertCall = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO ai_usage_log"),
    );
    expect(insertCall).toBeDefined();

    const [, params] = insertCall!;
    expect(params[8]).toBe(false); // success = false
    expect(params[9]).toBe("429"); // errorCode
  });

  it("records correct token counts from response usage field", async () => {
    const fakeResponse = {
      data: [{ embedding: Array.from({ length: 1536 }, () => 0.1) }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 0,
        total_tokens: 8,
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => fakeResponse,
    });

    mockQuery.mockResolvedValue({ rows: [] });

    await openrouterRequest("/embeddings", {
      model: "openai/text-embedding-3-small",
      input: "test text",
    }, "embed_capture");

    await new Promise((resolve) => setTimeout(resolve, 10));

    const insertCall = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO ai_usage_log"),
    );
    expect(insertCall).toBeDefined();

    const [, params] = insertCall!;
    expect(params[0]).toBe("embed_capture"); // operation
    expect(params[1]).toBe("openai/text-embedding-3-small"); // model
    expect(params[3]).toBe(8);  // prompt_tokens
    expect(params[4]).toBe(0);  // completion_tokens
    expect(params[5]).toBe(8);  // total_tokens
  });
});
