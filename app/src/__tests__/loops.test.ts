import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../app.js";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../pipeline.js", () => ({
  capturePipeline: vi.fn(),
}));

vi.mock("../openrouter.js", () => ({
  generateEmbedding: vi.fn(),
  extractMetadata: vi.fn(),
  chatCompletion: vi.fn(),
}));

vi.mock("pgvector", () => ({
  default: { toSql: vi.fn((v: unknown) => v) },
}));

const AUTH = { Authorization: `Bearer ${process.env.BRAIN_ACCESS_KEY}` };

describe("GET /api/loops", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/loops");
    expect(res.status).toBe(401);
  });

  it("returns loops with default open status filter", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: "loop-1",
          content: "Do the thing",
          loop_type: "task",
          status: "open",
          resolution: null,
          source_thought_id: null,
          snoozed_until: null,
          created_at: "2026-03-14T00:00:00Z",
          closed_at: null,
          evidence_count: "1",
          last_evidence_at: "2026-03-14T00:00:00Z",
          source_preview: null,
        },
      ],
    });

    const res = await app.request("/api/loops", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.loops).toHaveLength(1);
    expect(body.loops[0].content).toBe("Do the thing");
    expect(body.loops[0].evidence_count).toBe(1);
  });

  it("filters by source_thought_id returning all statuses", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: "loop-1",
          content: "Open task",
          loop_type: "task",
          status: "open",
          resolution: null,
          source_thought_id: "thought-1",
          snoozed_until: null,
          created_at: "2026-03-14T00:00:00Z",
          closed_at: null,
          evidence_count: "1",
          last_evidence_at: "2026-03-14T00:00:00Z",
          source_preview: "Source thought content",
        },
        {
          id: "loop-2",
          content: "Closed task",
          loop_type: "task",
          status: "closed",
          resolution: "Done",
          source_thought_id: "thought-1",
          snoozed_until: null,
          created_at: "2026-03-13T00:00:00Z",
          closed_at: "2026-03-14T00:00:00Z",
          evidence_count: "1",
          last_evidence_at: "2026-03-13T00:00:00Z",
          source_preview: "Source thought content",
        },
      ],
    });

    const res = await app.request("/api/loops?source_thought_id=thought-1", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.loops).toHaveLength(2);
    // Verify query uses source_thought_id filter, not status filter
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("source_thought_id = $1"),
      expect.arrayContaining(["thought-1"]),
    );
  });

  it("returns last_evidence_at and source_preview fields", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: "loop-1",
          content: "Check the docs",
          loop_type: "task",
          status: "open",
          resolution: null,
          source_thought_id: "thought-1",
          snoozed_until: null,
          created_at: "2026-03-14T00:00:00Z",
          closed_at: null,
          evidence_count: "3",
          last_evidence_at: "2026-03-15T12:00:00Z",
          source_preview: "Meeting notes from Monday standup about deployment",
        },
      ],
    });

    const res = await app.request("/api/loops", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.loops[0].last_evidence_at).toBe("2026-03-15T12:00:00Z");
    expect(body.loops[0].source_preview).toBe("Meeting notes from Monday standup about deployment");
    expect(body.loops[0].evidence_count).toBe(3);
  });

  it("filters by status and loop_type", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/loops?status=closed&loop_type=question", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.loops).toHaveLength(0);
    // Verify query was called with status and type params
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = $1"),
      expect.arrayContaining(["closed", "question"]),
    );
  });
});

describe("GET /api/loops/:id", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 404 for non-existent loop", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/loops/nonexistent", { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it("returns loop with evidence", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: "loop-1",
          content: "Task content",
          loop_type: "task",
          status: "open",
          resolution: null,
          source_thought_id: "thought-1",
          snoozed_until: null,
          created_at: "2026-03-14T00:00:00Z",
          closed_at: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "thought-1",
          content: "Source thought",
          metadata: {},
          created_at: "2026-03-14T00:00:00Z",
          noted_at: "2026-03-14T00:00:00Z",
        }],
      });

    const res = await app.request("/api/loops/loop-1", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("Task content");
    expect(body.evidence).toHaveLength(1);
  });
});

describe("POST /api/loops", () => {
  beforeEach(() => vi.resetAllMocks());

  it("creates a loop", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: "new-loop", created_at: "2026-03-14T00:00:00Z" }],
      })
      .mockResolvedValueOnce({ rows: [] }); // evidence link (no source thought)

    const res = await app.request("/api/loops", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "New task" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("new-loop");
  });

  it("returns 400 for empty content", async () => {
    const res = await app.request("/api/loops", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/loops/:id", () => {
  beforeEach(() => vi.resetAllMocks());

  it("closes a loop with resolution", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "loop-1", status: "open" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.request("/api/loops/loop-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed", resolution: "Done" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(true);
    // Verify UPDATE query includes closed_at
    expect(mockQuery.mock.calls[1][0]).toContain("closed_at = now()");
  });

  it("snoozes a loop", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "loop-1", status: "open" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.request("/api/loops/loop-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "snoozed", snoozed_until: "2026-03-21T00:00:00Z" }),
    });
    expect(res.status).toBe(200);
  });

  it("reopens a closed loop", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "loop-1", status: "closed" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.request("/api/loops/loop-1", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "open" }),
    });
    expect(res.status).toBe(200);
    // Verify reopen clears closed_at and snoozed_until
    expect(mockQuery.mock.calls[1][0]).toContain("closed_at = NULL");
    expect(mockQuery.mock.calls[1][0]).toContain("snoozed_until = NULL");
  });

  it("returns 404 for non-existent loop", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/loops/nonexistent", {
      method: "PATCH",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/loops/:id", () => {
  beforeEach(() => vi.resetAllMocks());

  it("deletes a loop", async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });

    const res = await app.request("/api/loops/loop-1", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
  });

  it("returns 404 for non-existent loop", async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });

    const res = await app.request("/api/loops/nonexistent", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/loops/:id/evidence", () => {
  beforeEach(() => vi.resetAllMocks());

  it("links a thought as evidence", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "loop-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await app.request("/api/loops/loop-1/evidence", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ thought_id: "thought-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.linked).toBe(true);
  });

  it("returns 404 for non-existent loop", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await app.request("/api/loops/nonexistent/evidence", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ thought_id: "thought-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for missing thought_id", async () => {
    const res = await app.request("/api/loops/loop-1/evidence", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/loops/:id/evidence/:thoughtId", () => {
  beforeEach(() => vi.resetAllMocks());

  it("unlinks a thought from evidence", async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });

    const res = await app.request("/api/loops/loop-1/evidence/thought-1", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM open_loop_evidence"),
      ["loop-1", "thought-1"],
    );
  });

  it("returns 404 for non-existent evidence link", async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });

    const res = await app.request("/api/loops/loop-1/evidence/nonexistent", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });
});
