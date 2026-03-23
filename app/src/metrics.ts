import client from "prom-client";

export const register = new client.Registry();

// Collect default Node.js metrics (GC, event loop, memory)
client.collectDefaultMetrics({ register });

// --- Counters ---
export const httpRequestsTotal = new client.Counter({
  name: "open_brain_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

export const capturesTotal = new client.Counter({
  name: "open_brain_captures_total",
  help: "Total thought captures",
  labelNames: ["status", "source"] as const,
  registers: [register],
});

export const openrouterCallsTotal = new client.Counter({
  name: "open_brain_openrouter_calls_total",
  help: "Total OpenRouter API calls",
  labelNames: ["operation", "model", "status", "source"] as const,
  registers: [register],
});

export const tokensTotal = new client.Counter({
  name: "open_brain_tokens_total",
  help: "Total tokens used",
  labelNames: ["operation", "model", "type", "source"] as const,
  registers: [register],
});

export const factsTotal = new client.Counter({
  name: "open_brain_facts_total",
  help: "Total fact operations",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const entityResolutionsTotal = new client.Counter({
  name: "open_brain_entity_resolutions_total",
  help: "Total entity resolutions",
  labelNames: ["state"] as const,
  registers: [register],
});

export const queueJobsTotal = new client.Counter({
  name: "open_brain_queue_jobs_total",
  help: "Total queue jobs",
  labelNames: ["status"] as const,
  registers: [register],
});

export const mcpToolCallsTotal = new client.Counter({
  name: "open_brain_mcp_tool_calls_total",
  help: "Total MCP tool calls",
  labelNames: ["tool", "status"] as const,
  registers: [register],
});

export const mcpSessionsCreatedTotal = new client.Counter({
  name: "open_brain_mcp_sessions_created_total",
  help: "Total MCP sessions created",
  registers: [register],
});

export const budgetCutoffTotal = new client.Counter({
  name: "open_brain_budget_cutoff_total",
  help: "Total budget cutoff events",
  registers: [register],
});

// --- Gauges ---
export const dbPoolTotal = new client.Gauge({
  name: "open_brain_db_pool_total",
  help: "DB pool total connections",
  registers: [register],
});

export const dbPoolIdle = new client.Gauge({
  name: "open_brain_db_pool_idle",
  help: "DB pool idle connections",
  registers: [register],
});

export const dbPoolWaiting = new client.Gauge({
  name: "open_brain_db_pool_waiting",
  help: "DB pool waiting connections",
  registers: [register],
});

export const queuePendingJobs = new client.Gauge({
  name: "open_brain_queue_pending_jobs",
  help: "Pending queue jobs",
  registers: [register],
});

export const mcpActiveSessions = new client.Gauge({
  name: "open_brain_mcp_active_sessions",
  help: "Active MCP sessions",
  registers: [register],
});

export const spendMonthToDate = new client.Gauge({
  name: "open_brain_spend_month_to_date_usd",
  help: "Month-to-date AI spend in USD",
  registers: [register],
});

// --- Histograms ---
export const httpDuration = new client.Histogram({
  name: "open_brain_http_duration_ms",
  help: "HTTP request duration in ms",
  labelNames: ["method", "route"] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register],
});

export const openrouterLatency = new client.Histogram({
  name: "open_brain_openrouter_latency_ms",
  help: "OpenRouter API latency in ms",
  labelNames: ["operation"] as const,
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register],
});

export const mcpToolDuration = new client.Histogram({
  name: "open_brain_mcp_tool_duration_ms",
  help: "MCP tool execution duration in ms",
  labelNames: ["tool"] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register],
});
