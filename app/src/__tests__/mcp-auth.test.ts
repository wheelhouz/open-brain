import { describe, it, expect, vi } from "vitest";
import { app } from "../app.js";

vi.mock("../db.js", () => ({
  pool: {},
  query: vi.fn().mockResolvedValue({ rows: [] }),
  isHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock("../openrouter.js", () => {
  const { AsyncLocalStorage } = require("node:async_hooks");
  return {
    generateEmbedding: vi.fn(),
    extractMetadata: vi.fn(),
    chatCompletion: vi.fn(),
    normalizeContent: vi.fn(),
    sourceContext: new AsyncLocalStorage(),
  };
});

vi.mock("pgvector", () => ({
  default: { toSql: (v: number[]) => `[${v.join(",")}]` },
}));

describe("RFC 9728 protected-resource metadata", () => {
  it("returns JSON at /.well-known/oauth-protected-resource", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("application/json");
    const body = await res.json();
    expect(body.resource).toMatch(/\/mcp$/);
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect(body.authorization_servers[0]).toBeTruthy();
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("also serves the path-specific /mcp variant", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toMatch(/\/mcp$/);
  });
});

describe("OAuth public origin detection", () => {
  it("uses https for public hosts when proxy proto headers are absent", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server", {
      headers: { Host: "brain.example.com" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe("https://brain.example.com");
    expect(body.authorization_endpoint).toBe(
      "https://brain.example.com/oauth/authorize",
    );
  });

  it("keeps localhost discovery on http", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server", {
      headers: { Host: "localhost:8420" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe("http://localhost:8420");
  });

  it("honors forwarded proto and host headers", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server", {
      headers: {
        Host: "localhost:8420",
        "X-Forwarded-Host": "brain.example.com",
        "X-Forwarded-Proto": "https",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe("https://brain.example.com");
  });

  it("parses RFC 7239 Forwarded headers", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server", {
      headers: {
        Host: "localhost:8420",
        Forwarded: "for=192.0.2.1;proto=https;host=brain.example.com",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe("https://brain.example.com");
  });
});

describe("OAuth dynamic client registration (RFC 7591)", () => {
  it("accepts registration without a bearer token", async () => {
    const res = await app.request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBeTruthy();
    expect(body.client_secret).toBeTruthy();
    expect(body.redirect_uris).toEqual([
      "https://claude.ai/api/mcp/auth_callback",
    ]);
    expect(body.client_secret_expires_at).toBe(0);
  });
});

describe("OAuth redirect URI allowlist", () => {
  async function authorizeWith(redirectUri: string) {
    return app.request(
      `/oauth/authorize?client_id=x&redirect_uri=${encodeURIComponent(redirectUri)}`,
    );
  }

  it("accepts localhost (http)", async () => {
    const res = await authorizeWith("http://localhost:3000/cb");
    expect(res.status).toBe(200);
  });

  it("accepts 127.0.0.1 (http)", async () => {
    const res = await authorizeWith("http://127.0.0.1:8080/cb");
    expect(res.status).toBe(200);
  });

  it("accepts https://claude.ai", async () => {
    const res = await authorizeWith("https://claude.ai/api/mcp/auth_callback");
    expect(res.status).toBe(200);
  });

  it("accepts subdomains of claude.ai over https", async () => {
    const res = await authorizeWith("https://app.claude.ai/cb");
    expect(res.status).toBe(200);
  });

  it("accepts *.anthropic.com over https", async () => {
    const res = await authorizeWith("https://console.anthropic.com/cb");
    expect(res.status).toBe(200);
  });

  it("rejects http://claude.ai (must be https)", async () => {
    const res = await authorizeWith("http://claude.ai/cb");
    expect(res.status).toBe(400);
  });

  it("rejects unknown hosts", async () => {
    const res = await authorizeWith("https://evil.example.com/cb");
    expect(res.status).toBe(400);
  });

  it("rejects malformed URIs", async () => {
    const res = await authorizeWith("not a url");
    expect(res.status).toBe(400);
  });
});

describe("/mcp 401 discovery hints", () => {
  it("emits WWW-Authenticate pointing at the resource metadata", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Host: "brain.example.com", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") || "";
    expect(wwwAuth).toMatch(/^Bearer/);
    expect(wwwAuth).toContain(
      "resource_metadata=",
    );
    expect(wwwAuth).toContain(
      "https://brain.example.com/.well-known/oauth-protected-resource",
    );
  });

  it("sets X-Accel-Buffering: no on /mcp responses", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.headers.get("x-accel-buffering")).toBe("no");
  });
});

describe("CORS on MCP and OAuth endpoints", () => {
  it("answers preflight for /mcp with permissive CORS", async () => {
    const res = await app.request("/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://claude.ai",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,mcp-session-id",
      },
    });
    // Hono's cors middleware short-circuits OPTIONS with 204
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
    const allowHeaders = (res.headers.get("access-control-allow-headers") || "").toLowerCase();
    expect(allowHeaders).toContain("authorization");
    expect(allowHeaders).toContain("mcp-session-id");
  });

  it("exposes mcp-session-id to the browser", async () => {
    const res = await app.request("/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://claude.ai",
        "Access-Control-Request-Method": "POST",
      },
    });
    const expose = (res.headers.get("access-control-expose-headers") || "").toLowerCase();
    expect(expose).toContain("mcp-session-id");
  });

  it("applies CORS to the oauth-protected-resource metadata endpoint", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource", {
      headers: { Origin: "https://claude.ai" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });
});
