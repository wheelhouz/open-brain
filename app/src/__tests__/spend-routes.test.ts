import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    generateEmbedding: vi.fn(),
    extractMetadata: vi.fn(),
    chatCompletion: vi.fn(),
    chatCompletionStream: vi.fn(),
    normalizeContent: vi.fn(),
    rewriteQuery: vi.fn(),
    categorizeTopics: vi.fn(),
    categorizeMissing: vi.fn(),
    assignCategory: vi.fn(),
    sourceContext: new AsyncLocalStorage(),
  };
});

import { app } from "../app.js";

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("GET /api/spend/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/spend/summary");
    expect(res.status).toBe(401);
  });

  it("returns summary with today/this_month/all_time shape", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ calls: "15", tokens: "5000", usd: "0.025000" }] }) // today
      .mockResolvedValueOnce({ rows: [{ calls: "120", tokens: "40000", usd: "0.200000" }] }) // this month
      .mockResolvedValueOnce({ rows: [{ calls: "500", tokens: "200000", usd: "1.000000" }] }); // all time

    const res = await app.request("/api/spend/summary", { headers: AUTH });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("today");
    expect(body).toHaveProperty("this_month");
    expect(body).toHaveProperty("all_time");

    expect(body.today.calls).toBe(15);
    expect(body.today.tokens).toBe(5000);
    expect(typeof body.today.estimated_usd).toBe("number");

    expect(body.this_month.calls).toBe(120);
    expect(body.this_month.tokens).toBe(40000);

    expect(body.all_time.calls).toBe(500);
    expect(body.all_time.tokens).toBe(200000);
  });

  it("returns numeric values (not strings) for calls and tokens", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ calls: "0", tokens: "0", usd: "0" }] })
      .mockResolvedValueOnce({ rows: [{ calls: "0", tokens: "0", usd: "0" }] })
      .mockResolvedValueOnce({ rows: [{ calls: "0", tokens: "0", usd: "0" }] });

    const res = await app.request("/api/spend/summary", { headers: AUTH });
    const body = await res.json();

    expect(typeof body.today.calls).toBe("number");
    expect(typeof body.today.tokens).toBe("number");
    expect(typeof body.today.estimated_usd).toBe("number");
  });
});

describe("GET /api/spend/breakdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/spend/breakdown");
    expect(res.status).toBe(401);
  });

  it("returns breakdown with expected shape", async () => {
    const opRows = [{ operation: "embed_capture", calls: "50", tokens: "10000", usd: "0.02" }];
    const modelRows = [{ model: "openai/text-embedding-3-small", calls: "50", tokens: "10000", usd: "0.02" }];
    const sourceRows = [{ source: "rest", calls: "50", tokens: "10000", usd: "0.02" }];
    const dailyRows = [{ date: "2026-03-22", calls: "10", tokens: "2000", usd: "0.004" }];

    mockQuery
      .mockResolvedValueOnce({ rows: opRows })
      .mockResolvedValueOnce({ rows: modelRows })
      .mockResolvedValueOnce({ rows: sourceRows })
      .mockResolvedValueOnce({ rows: dailyRows });

    const res = await app.request("/api/spend/breakdown", { headers: AUTH });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("period_days");
    expect(body).toHaveProperty("by_operation");
    expect(body).toHaveProperty("by_model");
    expect(body).toHaveProperty("by_source");
    expect(body).toHaveProperty("daily");

    expect(body.period_days).toBe(30); // default
    expect(body.by_operation).toHaveLength(1);
    expect(body.by_model).toHaveLength(1);
    expect(body.by_source).toHaveLength(1);
    expect(body.daily).toHaveLength(1);
  });

  it("respects period query param (capped at 365)", async () => {
    mockQuery
      .mockResolvedValue({ rows: [] });

    const res = await app.request("/api/spend/breakdown?period=400", { headers: AUTH });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period_days).toBe(365); // capped at 365
  });

  it("uses custom period query param", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/spend/breakdown?period=7", { headers: AUTH });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period_days).toBe(7);
  });
});

describe("GET /api/spend/budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/spend/budget");
    expect(res.status).toBe(401);
  });

  it("returns budget info with expected shape", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ usd: "3.500000" }] });

    const res = await app.request("/api/spend/budget", { headers: AUTH });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("monthly_budget_usd");
    expect(body).toHaveProperty("month_to_date_usd");
    expect(body).toHaveProperty("percent_used");
    expect(body).toHaveProperty("alert_threshold_pct");
    expect(body).toHaveProperty("alert_triggered");
    expect(body).toHaveProperty("hard_cutoff_usd");

    expect(typeof body.monthly_budget_usd).toBe("number");
    expect(typeof body.month_to_date_usd).toBe("number");
    expect(typeof body.percent_used).toBe("number");
    expect(typeof body.alert_triggered).toBe("boolean");
  });

  it("alert_triggered is false when no budget set", async () => {
    // Default monthlyBudgetUsd is 0 in test env
    mockQuery.mockResolvedValueOnce({ rows: [{ usd: "3.5" }] });

    const res = await app.request("/api/spend/budget", { headers: AUTH });
    const body = await res.json();

    // When budget = 0, pctUsed = 0 so alert_triggered should be false
    expect(body.alert_triggered).toBe(false);
    expect(body.percent_used).toBe(0);
  });
});
