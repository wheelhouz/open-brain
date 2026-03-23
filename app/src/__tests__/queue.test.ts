import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("../db.js", () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", () => {
  const { AsyncLocalStorage } = require("node:async_hooks");
  return {
    generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
    sourceContext: new AsyncLocalStorage(),
  };
});

vi.mock("pgvector", () => ({
  default: { toSql: vi.fn((v: number[]) => `[${v.join(",")}]`) },
}));

import {
  enqueueEmbeddingJob,
  claimNextJob,
  scheduleBackfillSweep,
  stopEmbeddingWorker,
} from "../queue.js";

afterEach(() => {
  vi.resetAllMocks();
  stopEmbeddingWorker();
});

describe("enqueueEmbeddingJob", () => {
  it("inserts a job with ON CONFLICT DO NOTHING", async () => {
    // First call: pending count check, second call: INSERT
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await enqueueEmbeddingJob("loop-1", "openai/text-embedding-3-small");

    expect(mockQuery).toHaveBeenCalledTimes(2);
    // First call checks pending count
    const countSql = mockQuery.mock.calls[0][0] as string;
    expect(countSql).toContain("status = 'pending'");
    // Second call inserts the job
    const sql = mockQuery.mock.calls[1][0] as string;
    expect(sql).toContain("INSERT INTO embedding_jobs");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    const params = mockQuery.mock.calls[1][1] as string[];
    const payload = JSON.parse(params[0]);
    expect(payload.loop_id).toBe("loop-1");
    expect(payload.target_model).toBe("openai/text-embedding-3-small");
  });

  it("skips insert when queue depth cap is reached", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "500" }] });

    await enqueueEmbeddingJob("loop-1", "openai/text-embedding-3-small");

    // Only the count query should be called — no INSERT
    expect(mockQuery).toHaveBeenCalledOnce();
  });
});

describe("claimNextJob", () => {
  it("uses FOR UPDATE SKIP LOCKED to atomically claim a job", async () => {
    const fakeJob = {
      id: "job-1",
      job_type: "loop_embedding",
      status: "claimed",
      payload_json: { loop_id: "loop-1", model: "test-model" },
      attempt_count: 1,
    };
    mockQuery.mockResolvedValue({ rows: [fakeJob] });

    const job = await claimNextJob("loop_embedding");

    expect(job).toEqual(fakeJob);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'claimed'");
    expect(sql).toContain("RETURNING *");
  });

  it("returns null when no jobs are available", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const job = await claimNextJob("loop_embedding");

    expect(job).toBeNull();
  });
});

describe("scheduleBackfillSweep", () => {
  beforeEach(() => vi.resetAllMocks());

  it("backfills thought provenance", async () => {
    // 1. thought provenance update
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // 2. unembedded loops query
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await scheduleBackfillSweep();

    const provenanceSql = mockQuery.mock.calls[0][0] as string;
    expect(provenanceSql).toContain("UPDATE thoughts");
    expect(provenanceSql).toContain("embedding_model IS NULL");
    expect(provenanceSql).toContain("embedding IS NOT NULL");
  });

  it("queries for unembedded loops excluding failed jobs", async () => {
    // 1. thought provenance
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // 2. unembedded loops
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await scheduleBackfillSweep();

    const sweepSql = mockQuery.mock.calls[1][0] as string;
    expect(sweepSql).toContain("open_loops");
    expect(sweepSql).toContain("embedding IS NULL");
    expect(sweepSql).toContain("NOT EXISTS");
    expect(sweepSql).toContain("status = 'failed'");
  });

  it("enqueues jobs for unembedded loops and triggers worker", async () => {
    // 1. thought provenance
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // 2. unembedded loops
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "loop-a" }, { id: "loop-b" }],
    });
    // 3. pending count check for loop-a
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    // 4. enqueue for loop-a
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 5. pending count check for loop-b
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] });
    // 6. enqueue for loop-b
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 7+ drain calls (recover stale, claim) — no jobs
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await scheduleBackfillSweep();

    // Verify two enqueue calls happened
    const enqueueCalls = mockQuery.mock.calls.filter((call) =>
      (call[0] as string).includes("INSERT INTO embedding_jobs"),
    );
    expect(enqueueCalls).toHaveLength(2);
  });
});
