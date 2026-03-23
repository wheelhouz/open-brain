import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "../mcp.js";
import { validateAccessKey } from "../auth.js";

export const mcpRouter = new Hono();

// Session management: map sessionId -> transport
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

mcpRouter.all("/", async (c) => {
  // Auth check
  const header = c.req.header("Authorization");
  const queryKey = c.req.query("key");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : queryKey;

  if (!token || !validateAccessKey(token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Check for existing session
  const sessionId = c.req.header("mcp-session-id");

  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId)!;
    return transport.handleRequest(c.req.raw);
  }

  // For non-initialization requests with an invalid session, return 404
  if (sessionId && !sessions.has(sessionId)) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Create new transport for initialization
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      sessions.set(id, transport);
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });

  const server = createMcpServer();
  await server.connect(transport);

  return transport.handleRequest(c.req.raw);
});
