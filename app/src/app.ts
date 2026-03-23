import { Hono } from "hono";
import type { Context, Next } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { isHealthy } from "./db.js";
import { auth } from "./middleware/auth.js";
import { requestLog } from "./middleware/requestLog.js";
import { logger } from "./logger.js";

declare module "hono" {
  interface ContextVariableMap {
    reqId: string;
  }
}
import { captureRouter } from "./routes/capture.js";
import { searchRouter } from "./routes/search.js";
import { thoughtsRouter } from "./routes/thoughts.js";
import { statsRouter } from "./routes/stats.js";
import { importRouter } from "./routes/import.js";
import { reviewRouter } from "./routes/review.js";
import { mcpRouter } from "./routes/mcp.js";
import { topicsRouter } from "./routes/topics.js";
import { peopleRouter } from "./routes/people.js";
import { chatRouter } from "./routes/chat.js";
import { loopsRouter } from "./routes/loops.js";
import { entitiesRouter } from "./routes/entities.js";
import { pendingFactsRouter } from "./routes/facts.js";
import { backfillRouter } from "./routes/backfill.js";
import { spendRouter } from "./routes/spend.js";
import { oauthRouter, wellKnownOAuth } from "./routes/oauth.js";
import { sourceContext } from "./openrouter.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const app = new Hono();

// Security headers — applied to all routes
app.use("*", async (c: Context, next: Next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

// Request logging
app.use("*", requestLog);

// Global error handler
app.onError((err, c) => {
  logger.error({ event: "unhandled_error", err: String(err), stack: err.stack });
  return c.json({ error: "Internal server error" }, 500);
});

// --- Rate limiting ---
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function rateLimit(limit: number, windowMs: number) {
  return async (c: Context, next: Next) => {
    const key = c.req.header("authorization") || c.req.header("x-forwarded-for") || "anon";
    const now = Date.now();
    const entry = rateLimits.get(key);
    if (!entry || now > entry.resetAt) {
      rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    } else if (entry.count >= limit) {
      return c.json({ error: "Too many requests" }, 429);
    } else {
      entry.count++;
    }
    await next();
  };
}

// Export for testing
export { rateLimits };

// OAuth endpoints — no auth required (they ARE the auth), rate limited
app.use("/oauth/*", rateLimit(10, 60_000));
app.route("/.well-known/oauth-authorization-server", wellKnownOAuth);
app.route("/oauth", oauthRouter);

// MCP endpoint — handles its own auth, rate limited separately (30/min)
app.use("/mcp", rateLimit(30, 60_000));
app.use("/mcp/*", async (c, next) => {
  return sourceContext.run("mcp", () => next());
});
app.route("/mcp", mcpRouter);

// Prometheus metrics — no auth (only reachable from Docker network)
import { register } from "./metrics.js";

app.get("/metrics", async (c) => {
  c.header("Content-Type", register.contentType);
  return c.text(await register.metrics());
});

// Health check — no auth required
app.get("/health", async (c) => {
  const dbOk = await isHealthy();
  if (!dbOk) {
    return c.json({ status: "error", db: "unreachable" }, 503);
  }
  return c.json({ status: "ok" });
});

// All API routes require auth, rate limited (60/min)
const api = new Hono();
api.use("*", rateLimit(60, 60_000));
api.use("*", async (c, next) => {
  return sourceContext.run("rest", () => next());
});
api.use("*", auth);
api.route("/capture", captureRouter);
api.route("/search", searchRouter);
api.route("/thoughts", thoughtsRouter);
api.route("/stats", statsRouter);
api.route("/import", importRouter);
api.route("/review", reviewRouter);
api.route("/topics", topicsRouter);
api.route("/people", peopleRouter);
api.route("/chat", chatRouter);
api.route("/loops", loopsRouter);
api.route("/facts/pending", pendingFactsRouter);
api.route("/entities", entitiesRouter);
api.route("/backfill", backfillRouter);
api.route("/spend", spendRouter);

app.route("/api", api);

// Static assets from frontend build
app.use("/assets/*", serveStatic({ root: "./static" }));
app.use("/favicon.svg", serveStatic({ root: "./static" }));

// SPA fallback — serve index.html for all non-API routes
const indexPath = "./static/index.html";
app.get("*", async (c) => {
  if (existsSync(indexPath)) {
    const html = await readFile(indexPath, "utf-8");
    return c.html(html);
  }
  return c.json({ error: "Frontend not built" }, 404);
});

export { app };
