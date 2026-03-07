import { Hono } from "hono";
import { config } from "../config.js";

const oauthRouter = new Hono();

// In-memory stores (single-user app, no persistence needed)
const authCodes = new Map<string, { expiresAt: number; redirectUri: string }>();
const registeredClients = new Map<
  string,
  { clientSecret: string; redirectUris: string[] }
>();

function getOrigin(c: { req: { header: (name: string) => string | undefined; url: string } }): string {
  const proto = c.req.header("x-forwarded-proto") || "http";
  const host = c.req.header("x-forwarded-host") || c.req.header("host");
  if (host) return `${proto}://${host}`;
  return new URL(c.req.url).origin;
}

// RFC 8414 — OAuth Authorization Server Metadata (exported separately for root mounting)
export const wellKnownOAuth = new Hono();
wellKnownOAuth.get("/", (c) => {
  const issuer = getOrigin(c);
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    code_challenge_methods_supported: ["S256"],
  });
});

// Dynamic Client Registration (RFC 7591)
oauthRouter.post("/register", async (c) => {
  const body = await c.req.json();
  const clientId = crypto.randomUUID();
  const clientSecret = crypto.randomUUID();
  const redirectUris: string[] = body.redirect_uris || [];

  registeredClients.set(clientId, { clientSecret, redirectUris });

  return c.json(
    {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUris,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
    },
    201,
  );
});

// Authorization endpoint — renders a simple login page
oauthRouter.get("/authorize", (c) => {
  const clientId = c.req.query("client_id") || "";
  const redirectUri = c.req.query("redirect_uri") || "";
  const state = c.req.query("state") || "";
  const codeChallenge = c.req.query("code_challenge") || "";
  const codeChallengeMethod = c.req.query("code_challenge_method") || "";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Brain — Authorize</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1e293b; border-radius: 12px; padding: 2rem; width: 100%;
            max-width: 400px; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { font-size: 0.875rem; color: #94a3b8; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.875rem; margin-bottom: 0.5rem; }
    input[type="password"] { width: 100%; padding: 0.625rem; border-radius: 6px;
           border: 1px solid #334155; background: #0f172a; color: #e2e8f0;
           font-size: 1rem; margin-bottom: 1rem; }
    button { width: 100%; padding: 0.625rem; border-radius: 6px; border: none;
             background: #3b82f6; color: white; font-size: 1rem; cursor: pointer; }
    button:hover { background: #2563eb; }
    .error { color: #f87171; font-size: 0.875rem; margin-bottom: 1rem; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Open Brain</h1>
    <p>An application is requesting access to your brain. Enter your access key to authorize.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
      <label for="access_key">Access Key</label>
      <input type="password" id="access_key" name="access_key" required autofocus>
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;

  return c.html(html);
});

// Authorization endpoint — POST handler (validates key, issues code)
oauthRouter.post("/authorize", async (c) => {
  const body = await c.req.parseBody();
  const accessKey = body["access_key"] as string;
  const redirectUri = body["redirect_uri"] as string;
  const state = body["state"] as string;
  const codeChallenge = body["code_challenge"] as string;
  const codeChallengeMethod = body["code_challenge_method"] as string;

  if (accessKey !== config.brainAccessKey) {
    return c.html(
      `<!DOCTYPE html><html><body style="font-family:system-ui;background:#0f172a;color:#f87171;display:flex;align-items:center;justify-content:center;min-height:100vh">
        <p>Invalid access key. <a href="javascript:history.back()" style="color:#3b82f6">Try again</a></p>
      </body></html>`,
      401,
    );
  }

  const code = crypto.randomUUID();
  authCodes.set(code, {
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min
    redirectUri,
    ...(codeChallenge && codeChallengeMethod === "S256"
      ? { codeChallenge }
      : {}),
  });

  // Store code challenge on the entry if present
  if (codeChallenge && codeChallengeMethod === "S256") {
    (authCodes.get(code) as Record<string, unknown>).codeChallenge =
      codeChallenge;
  }

  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);

  return c.redirect(url.toString());
});

// Token endpoint — exchanges code for access token
oauthRouter.post("/token", async (c) => {
  const contentType = c.req.header("content-type") || "";
  let grantType: string;
  let code: string;
  let codeVerifier: string;

  if (contentType.includes("application/json")) {
    const body = await c.req.json();
    grantType = body.grant_type;
    code = body.code;
    codeVerifier = body.code_verifier || "";
  } else {
    const body = await c.req.parseBody();
    grantType = body["grant_type"] as string;
    code = body["code"] as string;
    codeVerifier = (body["code_verifier"] as string) || "";
  }

  if (grantType !== "authorization_code") {
    return c.json({ error: "unsupported_grant_type" }, 400);
  }

  const entry = authCodes.get(code);
  if (!entry || entry.expiresAt < Date.now()) {
    authCodes.delete(code);
    return c.json({ error: "invalid_grant" }, 400);
  }

  // PKCE verification
  const storedChallenge = (entry as Record<string, unknown>).codeChallenge as
    | string
    | undefined;
  if (storedChallenge && codeVerifier) {
    const encoder = new TextEncoder();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(codeVerifier),
    );
    const computed = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    if (computed !== storedChallenge) {
      authCodes.delete(code);
      return c.json({ error: "invalid_grant" }, 400);
    }
  }

  authCodes.delete(code);

  // Issue the brain access key as the OAuth token
  return c.json({
    access_token: config.brainAccessKey,
    token_type: "Bearer",
    expires_in: 3600 * 24 * 365, // effectively never
  });
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export { oauthRouter };
