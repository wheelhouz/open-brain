import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

// Mock db module
vi.mock("../db.js", () => ({
  pool: {},
  query: vi.fn().mockResolvedValue({ rows: [{ count: "0" }] }),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

import { isHealthy } from "../db.js";

describe("GET /health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 when db is healthy", async () => {
    vi.mocked(isHealthy).mockResolvedValue(true);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("returns 503 when db is unreachable", async () => {
    vi.mocked(isHealthy).mockResolvedValue(false);
    const res = await app.request("/health");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("error");
  });
});

describe("Auth middleware", () => {
  it("returns 401 without auth header", async () => {
    const res = await app.request("/api/stats");
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const res = await app.request("/api/stats", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("passes with correct token", async () => {
    const key = process.env.BRAIN_ACCESS_KEY || "";
    const res = await app.request("/api/stats", {
      headers: { Authorization: `Bearer ${key}` },
    });
    // Should get 200 (stats) rather than 401
    expect(res.status).toBe(200);
  });
});
