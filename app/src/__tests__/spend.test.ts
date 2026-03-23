import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

// Use vi.hoisted so mockConfig is initialized before vi.mock factory runs
const mockConfig = vi.hoisted(() => ({
  port: 8420,
  databaseUrl: "postgres://x",
  brainAccessKey: "test",
  openrouterApiKey: "x",
  embeddingModel: "openai/text-embedding-3-small",
  extractionModel: "openai/gpt-4o-mini",
  chatModel: "anthropic/claude-sonnet-4-6",
  maxContentLength: 50 * 1024,
  entityFuzzyThreshold: 0.35,
  factConfidenceThreshold: 0.80,
  monthlyBudgetUsd: 0,
  spendAlertThresholdPct: 80,
  spendHardCutoffUsd: 0,
}));

vi.mock("../config.js", () => ({ config: mockConfig }));

import { estimateCost, recordUsage, checkBudget, BudgetExceededError } from "../spend.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset config to defaults before each test
  mockConfig.spendHardCutoffUsd = 0;
  mockConfig.monthlyBudgetUsd = 0;
});

describe("estimateCost", () => {
  it("returns correct cost for known model (openai/text-embedding-3-small)", () => {
    // prompt: 0.00002/1K, completion: 0/1K
    const cost = estimateCost("openai/text-embedding-3-small", 1000, 0);
    expect(cost).toBeCloseTo(0.00002);
  });

  it("returns correct cost for known model (anthropic/claude-sonnet-4-6)", () => {
    // prompt: 0.003/1K, completion: 0.015/1K
    // 1000/1000 * 0.003 + 500/1000 * 0.015 = 0.003 + 0.0075 = 0.0105
    const cost = estimateCost("anthropic/claude-sonnet-4-6", 1000, 500);
    expect(cost).toBeCloseTo(0.0105);
  });

  it("returns correct cost for known model (openai/gpt-4o-mini)", () => {
    // prompt: 0.00015/1K, completion: 0.0006/1K
    // 2000/1000 * 0.00015 + 1000/1000 * 0.0006 = 0.0003 + 0.0006 = 0.0009
    const cost = estimateCost("openai/gpt-4o-mini", 2000, 1000);
    expect(cost).toBeCloseTo(0.0009);
  });

  it("falls back to default pricing for unknown model", () => {
    // fallback: prompt: 0.001/1K, completion: 0.002/1K
    // 1000/1000 * 0.001 + 1000/1000 * 0.002 = 0.001 + 0.002 = 0.003
    const cost = estimateCost("unknown/model-xyz", 1000, 1000);
    expect(cost).toBeCloseTo(0.003);
  });

  it("returns 0 cost for zero tokens", () => {
    const cost = estimateCost("openai/gpt-4o-mini", 0, 0);
    expect(cost).toBe(0);
  });
});

describe("recordUsage", () => {
  it("calls query with correct INSERT shape", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const event = {
      operation: "embed_capture",
      model: "openai/text-embedding-3-small",
      source: "rest",
      promptTokens: 100,
      completionTokens: 0,
      totalTokens: 100,
      latencyMs: 250,
      success: true,
    };

    await recordUsage(event);

    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO ai_usage_log");
    expect(sql).toContain("operation");
    expect(sql).toContain("model");
    expect(sql).toContain("source");
    expect(sql).toContain("prompt_tokens");
    expect(sql).toContain("completion_tokens");
    expect(sql).toContain("total_tokens");
    expect(sql).toContain("estimated_cost_usd");
    expect(sql).toContain("latency_ms");
    expect(sql).toContain("success");

    expect(params[0]).toBe("embed_capture");
    expect(params[1]).toBe("openai/text-embedding-3-small");
    expect(params[2]).toBe("rest");
    expect(params[3]).toBe(100);
    expect(params[4]).toBe(0);
    expect(params[5]).toBe(100);
    expect(typeof params[6]).toBe("number"); // estimated_cost_usd
    expect(params[7]).toBe(250);
    expect(params[8]).toBe(true);
    expect(params[9]).toBeNull(); // errorCode not set → null
  });

  it("includes errorCode when provided", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const event = {
      operation: "embed_capture",
      model: "openai/text-embedding-3-small",
      source: "rest",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: 100,
      success: false,
      errorCode: "429",
    };

    await recordUsage(event);

    expect(mockQuery).toHaveBeenCalledOnce();
    const [, params] = mockQuery.mock.calls[0];
    expect(params[9]).toBe("429");
  });

  it("swallows DB errors and does not throw", async () => {
    mockQuery.mockRejectedValue(new Error("DB connection failed"));

    const event = {
      operation: "test",
      model: "openai/gpt-4o-mini",
      source: "rest",
      promptTokens: 50,
      completionTokens: 50,
      totalTokens: 100,
      latencyMs: 200,
      success: true,
    };

    // Should not throw — fire-and-forget error handling
    await expect(recordUsage(event)).resolves.toBeUndefined();
  });
});

// checkBudget has a module-level 60s cache. Each test resets modules to get a fresh
// cache-free instance.
describe("checkBudget", () => {
  it("returns immediately (no query) when disabled (cutoff = 0)", async () => {
    mockConfig.spendHardCutoffUsd = 0;
    vi.resetModules();
    const { checkBudget: freshCheckBudget } = await import("../spend.js");
    await freshCheckBudget();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("does not throw when under budget", async () => {
    mockConfig.spendHardCutoffUsd = 10.0;
    mockQuery.mockResolvedValue({ rows: [{ total: "5.0" }] });
    vi.resetModules();
    const { checkBudget: freshCheckBudget } = await import("../spend.js");

    await expect(freshCheckBudget()).resolves.toBeUndefined();
  });

  it("throws BudgetExceededError when over budget", async () => {
    mockConfig.spendHardCutoffUsd = 5.0;
    mockQuery.mockResolvedValue({ rows: [{ total: "7.5" }] });
    vi.resetModules();
    const { checkBudget: freshCheckBudget, BudgetExceededError: FreshBudgetExceededError } = await import("../spend.js");

    await expect(freshCheckBudget()).rejects.toThrow(FreshBudgetExceededError);
    // Second call hits the cache (result: false) and should also throw
    await expect(freshCheckBudget()).rejects.toThrow("AI budget exceeded");
  });
});
