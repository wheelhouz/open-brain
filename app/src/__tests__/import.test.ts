import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockCapture = vi.fn();
const mockQuery = vi.fn();
const mockNormalize = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../pipeline.js", () => ({
  capturePipeline: (...args: unknown[]) => mockCapture(...args),
}));

vi.mock("../openrouter.js", () => ({
  normalizeContent: (...args: unknown[]) => mockNormalize(...args),
}));

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("POST /import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] }); // No duplicates by default
    mockCapture.mockResolvedValue({
      id: "uuid", metadata: { type: "observation" }, created_at: "2026-03-04",
    });
  });

  it("returns 400 for empty thoughts array", async () => {
    const res = await app.request("/api/import", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ thoughts: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("imports thoughts successfully", async () => {
    const res = await app.request("/api/import", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        thoughts: [
          { content: "Thought 1" },
          { content: "Thought 2" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.errors).toHaveLength(0);
  });

  it("skips duplicates", async () => {
    // First call returns existing row (duplicate), second returns empty
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "existing" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.request("/api/import", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        thoughts: [
          { content: "Duplicate" },
          { content: "New thought" },
        ],
      }),
    });

    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(1);
  });

  it("normalizes content when requested", async () => {
    mockNormalize.mockResolvedValue("Normalized content");

    const res = await app.request("/api/import", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        thoughts: [{ content: "Raw note" }],
        options: { normalize: true },
      }),
    });

    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(mockNormalize).toHaveBeenCalledWith("Raw note");
    expect(mockCapture).toHaveBeenCalledWith("Normalized content", "import");
  });

  it("reports errors for invalid entries", async () => {
    const res = await app.request("/api/import", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        thoughts: [
          { content: "" },
          { content: "Valid" },
        ],
      }),
    });

    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].index).toBe(0);
  });
});
