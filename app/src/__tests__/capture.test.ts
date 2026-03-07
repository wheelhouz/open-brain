import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockCapture = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: vi.fn(),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../pipeline.js", () => ({
  capturePipeline: (...args: unknown[]) => mockCapture(...args),
}));

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("POST /capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/capture", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing content", async () => {
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty content", async () => {
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for content exceeding max length", async () => {
    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x".repeat(51 * 1024) }),
    });
    expect(res.status).toBe(400);
  });

  it("captures a thought successfully", async () => {
    mockCapture.mockResolvedValue({
      id: "test-uuid",
      metadata: {
        type: "observation",
        topics: ["test"],
        people: [],
        action_items: [],
        dates_mentioned: [],
        source_context: null,
      },
      created_at: "2026-03-04T00:00:00Z",
    });

    const res = await app.request("/api/capture", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Test thought" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("test-uuid");
    expect(body.metadata.type).toBe("observation");
    expect(mockCapture).toHaveBeenCalledWith("Test thought", undefined, undefined);
  });

  it("passes source to pipeline", async () => {
    mockCapture.mockResolvedValue({
      id: "test-uuid",
      metadata: { type: "observation", topics: [], people: [], action_items: [], dates_mentioned: [], source_context: "web" },
      created_at: "2026-03-04T00:00:00Z",
    });

    await app.request("/api/capture", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Test thought", source: "web" }),
    });

    expect(mockCapture).toHaveBeenCalledWith("Test thought", "web", undefined);
  });
});
