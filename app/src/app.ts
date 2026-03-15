import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { isHealthy } from "./db.js";
import { auth } from "./middleware/auth.js";
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
import { oauthRouter, wellKnownOAuth } from "./routes/oauth.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const app = new Hono();

// OAuth endpoints — no auth required (they ARE the auth)
app.route("/.well-known/oauth-authorization-server", wellKnownOAuth);
app.route("/oauth", oauthRouter);

// MCP endpoint — handles its own auth (supports query param auth for clients)
app.route("/mcp", mcpRouter);

// Health check — no auth required
app.get("/health", async (c) => {
  const dbOk = await isHealthy();
  if (!dbOk) {
    return c.json({ status: "error", db: "unreachable" }, 503);
  }
  return c.json({ status: "ok" });
});

// All API routes require auth
const api = new Hono();
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
api.route("/entities", entitiesRouter);

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
