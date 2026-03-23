import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "../mcp.js";
import { validateAccessKey } from "../auth.js";
import { logger } from "../logger.js";
import { mcpSessionsCreatedTotal, mcpActiveSessions } from "../metrics.js";

export const mcpRouter = new Hono();

// Session management: map sessionId -> { transport, createdAt }
const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  createdAt: number;
}

const sessions = new Map<string, SessionEntry>();

// Cleanup expired sessions every 5 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

// Prevent cleanup interval from keeping the process alive
if (cleanupInterval.unref) cleanupInterval.unref();

mcpRouter.all("/", async (c) => {
  // Auth check
  const header = c.req.header("Authorization");
  const queryKey = c.req.query("key");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : queryKey;

  if (queryKey && !header) {
    logger.warn({ event: "mcp_auth_deprecation", msg: "MCP auth via ?key= query param — use Authorization header instead" });
  }

  if (!token || !validateAccessKey(token)) {
    logger.warn({ event: "auth_failure", path: "/mcp", method: c.req.method });
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Check for existing session
  const sessionId = c.req.header("mcp-session-id");

  if (sessionId && sessions.has(sessionId)) {
    const entry = sessions.get(sessionId)!;
    return entry.transport.handleRequest(c.req.raw);
  }

  // For non-initialization requests with an invalid session, return 404
  if (sessionId && !sessions.has(sessionId)) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Cap sessions — reject new ones when limit reached
  if (sessions.size >= MAX_SESSIONS) {
    return c.json({ error: "Too many active sessions" }, 503);
  }

  // Create new transport for initialization
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, createdAt: Date.now() });
      mcpSessionsCreatedTotal.inc();
      mcpActiveSessions.set(sessions.size);
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
      mcpActiveSessions.set(sessions.size);
    },
  });

  const server = createMcpServer();
  await server.connect(transport);

  return transport.handleRequest(c.req.raw);
});
