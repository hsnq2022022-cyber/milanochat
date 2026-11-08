import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FlowStore } from "./store.js";
import { registerRemoteFlowTools } from "./tools.js";
import { createAuthenticator, type AuthOutcome, type TenantLookup } from "./auth.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { decodeProtectedHeader } from "jose";
import type { OAuthStore } from "./oauthStore.js";
import { createOAuthProvider, MCP_SCOPE, type OAuthProviderBundle } from "./oauthProvider.js";
import { consentRouter, sessionMiddleware, type PasswordLogin } from "./oauthPages.js";

export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  "https://claude.ai", "https://chat.openai.com", "https://chatgpt.com", "https://cursor.com", "http://localhost:6274",
]);

export type HttpOAuthOptions = {
  publicOrigin: string;
  issuer: string;
  resource: string;
  signingSecret: string;
  sessionSecret: string;
  cookieSecure: boolean;
  maxClientsPerHour: number;
  store: OAuthStore;
  passwordLogin: PasswordLogin;
  now?: () => number;
};

export type RateLimits = { mcp: number; authorize: number; token: number; register: number; login: number; consent: number };
export const DEFAULT_RATE_LIMITS: RateLimits = { mcp: 20, authorize: 10, token: 10, register: 5, login: 5, consent: 30 };

export type HttpAppOptions = {
  store: FlowStore;
  lookupTenant: TenantLookup;
  jwtSecret: string;
  allowSecretHeader: boolean;
  allowedTenantId?: string | null;
  trustProxy?: false | number;
  rateLimitPerMinute?: number;
  /** Per-minute, per-IP limits; `mcp` defaults to rateLimitPerMinute ?? 20. */
  rateLimits?: Partial<RateLimits>;
  /** Supabase-JWT static bearer fallback (default true; HttpConfig turns it off in production unless MCP_ALLOW_STATIC_BEARER=true). */
  allowStaticBearer?: boolean;
  /** OAuth 2.1 authorization server + resource server mode (MCP_OAUTH_ENABLED=true). */
  oauth?: HttpOAuthOptions | null;
  log?: (msg: string) => void;
};

export const TEST_HEADER_WARNING = [
  "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  "!! WARNING: MCP_ALLOW_SECRET_HEADER=true (TESTING ONLY)                 !!",
  "!! Requests WITHOUT a token are accepted and the tenant is taken from   !!",
  "!! the X-Milano-Tenant header. Anyone who can reach this port can edit  !!",
  "!! ANY tenant's flows with the service-role key. Never use in production.",
  "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
].join("\n");

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

function isOAuthAccessToken(token: string): boolean {
  try { return decodeProtectedHeader(token).typ === "at+jwt"; } catch { return false; }
}

/**
 * /mcp authentication. OAuth access tokens (typ at+jwt) are verified (signature, exp, iss, aud = this
 * resource, scope mcp:tools, not revoked) and the tenant is resolved ONLY from tenants.user_id = sub.
 * Anything else falls through to the legacy authenticator (static Supabase JWT / test header, each
 * behind its flag). No client-supplied tenant is ever accepted in OAuth mode.
 */
export function requireOAuthTenant(d: {
  bundle: OAuthProviderBundle | null;
  resourceMetadataUrl: string | null;
  authenticate: (h: { authorization?: string; xMilanoTenant?: string }) => Promise<AuthOutcome>;
  resolveUserTenant: (sub: string) => Promise<AuthOutcome>;
  allowSecretHeader: boolean;
  log: (m: string) => void;
}) {
  const meta = d.resourceMetadataUrl ? `resource_metadata="${d.resourceMetadataUrl}"` : null;
  const unauthorized = (res: Response, invalid: boolean) => {
    const h = meta
      ? (invalid ? `Bearer error="invalid_token", ${meta}` : `Bearer ${meta}, scope="${MCP_SCOPE}"`)
      : (invalid ? 'Bearer realm="milanochat-mcp", error="invalid_token"' : 'Bearer realm="milanochat-mcp"');
    res.set("WWW-Authenticate", h).status(401).json(rpcError(-32001, "Unauthorized: a valid Bearer token is required."));
  };
  const fail = (res: Response, out: Extract<AuthOutcome, { ok: false }>) => {
    if (out.status === 401) unauthorized(res, out.reason === "invalid");
    else if (out.status === 403) res.status(403).json(rpcError(-32003, "Forbidden: no workspace is linked to this account."));
    else res.status(503).json(rpcError(-32002, "Authentication backend unavailable, retry later."));
  };
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authorization = req.get("authorization") ?? undefined;
      const m = authorization ? /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization.trim()) : null;
      if (d.bundle && m && isOAuthAccessToken(m[1]!)) {
        let v;
        try { v = await d.bundle.verifyAccess(m[1]!); }
        catch { fail(res, { ok: false, status: 503, reason: "unavailable" }); return; }
        if (v === "invalid" || v === "revoked") { unauthorized(res, true); return; }
        if (!v.scopes.includes(MCP_SCOPE)) {
          res.set("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${MCP_SCOPE}"${meta ? ", " + meta : ""}`)
            .status(403).json(rpcError(-32003, "Forbidden: insufficient scope."));
          return;
        }
        const out = await d.resolveUserTenant(v.sub);
        if (!out.ok) { fail(res, out); return; }
        res.locals.tenantId = out.tenantId;
        next();
        return;
      }
      const out = await d.authenticate({
        authorization,
        xMilanoTenant: d.allowSecretHeader ? req.get("x-milano-tenant") ?? undefined : undefined,
      });
      if (!out.ok) { fail(res, out); return; }
      if (out.via === "test-header") d.log("WARNING: request authenticated by X-Milano-Tenant test header (MCP_ALLOW_SECRET_HEADER=true). TESTING ONLY.");
      res.locals.tenantId = out.tenantId;
      next();
    } catch (e) { next(e); }
  };
}

export function createHttpApp(opts: HttpAppOptions) {
  const log = opts.log ?? ((m: string) => process.stderr.write("[milanochat-flows-mcp:http] " + m + "\n"));
  const auth = createAuthenticator({
    jwtSecret: opts.jwtSecret, allowSecretHeader: opts.allowSecretHeader, allowStaticBearer: opts.allowStaticBearer ?? true,
    lookupTenant: opts.lookupTenant, allowedTenantId: opts.allowedTenantId ?? null,
  });
  const limits: RateLimits = { ...DEFAULT_RATE_LIMITS, mcp: opts.rateLimitPerMinute ?? DEFAULT_RATE_LIMITS.mcp, ...opts.rateLimits };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", opts.trustProxy ?? false);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  const originAllowed = (o: string | undefined) => o === undefined || ALLOWED_ORIGINS.has(o);
  const corsMw = cors({
    origin: (origin, cb) => cb(null, origin !== undefined && ALLOWED_ORIGINS.has(origin)),
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version", "Accept", "X-Milano-Tenant"],
    exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
    maxAge: 600,
  });

  app.get("/health", corsMw, (_req, res) => { res.json({ status: "ok", transport: "http" }); });

  const limiter = rateLimit({
    windowMs: 60_000, limit: limits.mcp,
    standardHeaders: "draft-7", legacyHeaders: false,
    skip: req => req.method === "OPTIONS",
    handler: (_req, res) => { res.status(429).json(rpcError(-32029, "Too many requests, slow down.")); },
  });

  let bundle: OAuthProviderBundle | null = null;
  let resourceMetadataUrl: string | null = null;
  if (opts.oauth) {
    const o = opts.oauth;
    bundle = createOAuthProvider({
      store: o.store, issuer: o.issuer, resource: o.resource, signingSecret: o.signingSecret,
      maxClientsPerHour: o.maxClientsPerHour, now: o.now,
    });
    const b = bundle;
    resourceMetadataUrl = o.publicOrigin + "/.well-known/oauth-protected-resource";
    const oauthLimiter = (limit: number) => rateLimit({
      windowMs: 60_000, limit, standardHeaders: "draft-7", legacyHeaders: false,
      skip: req => req.method === "OPTIONS",
      handler: (_req, res) => { res.status(429).json({ error: "too_many_requests", error_description: "Too many requests, slow down." }); },
    });
    const oauthJson = (status: number, error: string, description: string) => (_req: Request, res: Response) => {
      res.status(status).json({ error, error_description: description });
    };
    const sessionMw = sessionMiddleware({ secret: o.sessionSecret, secure: o.cookieSecure, trustProxy: (opts.trustProxy ?? false) !== false });

    app.use("/authorize", oauthLimiter(limits.authorize), sessionMw, express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 20 }),
      async (req, res, next) => {
        // Exact redirect_uri match (the SDK alone would accept any port on a loopback redirect).
        try {
          const q = (req.method === "POST" ? req.body : req.query) ?? {};
          if (typeof q.client_id !== "string") { next(); return; }
          const c = await b.getClient(q.client_id);
          if (!c) { next(); return; } // SDK answers 400 invalid_client (no redirect)
          if (q.redirect_uri !== undefined && (typeof q.redirect_uri !== "string" || !c.redirectUris.includes(q.redirect_uri))) {
            oauthJson(400, "invalid_request", "Unregistered redirect_uri")(req, res);
            return;
          }
          const redirectUri = typeof q.redirect_uri === "string" ? q.redirect_uri : c.redirectUris.length === 1 ? c.redirectUris[0]! : null;
          // PKCE S256 is mandatory; reject missing / plain here so the error redirect keeps `state`.
          if (redirectUri && (q.code_challenge_method !== "S256" || typeof q.code_challenge !== "string")) {
            const u = new URL(redirectUri);
            u.searchParams.set("error", "invalid_request");
            u.searchParams.set("error_description", "PKCE with code_challenge_method=S256 is required");
            if (typeof q.state === "string" && q.state.length <= 1000) u.searchParams.set("state", q.state);
            u.searchParams.set("iss", o.issuer);
            res.redirect(302, u.href);
            return;
          }
          next();
        } catch (e) { next(e); }
      });
    // Hashed client secrets: authenticate confidential clients here, before the SDK token/revoke handlers.
    const clientAuth = async (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "POST") { next(); return; }
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (req.get("authorization")) { oauthJson(401, "invalid_client", "Use client_secret_post or a public client")(req, res); return; }
        if (await b.verifyClientSecret(body.client_id, body.client_secret) !== "ok") {
          oauthJson(401, "invalid_client", "Client authentication failed")(req, res);
          return;
        }
        delete body.client_secret;
        next();
      } catch { oauthJson(503, "temporarily_unavailable", "Try again later")(req, res); }
    };
    const tokenForm = express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 20 });
    app.use("/token", oauthLimiter(limits.token), tokenForm, clientAuth);
    app.use("/revoke", oauthLimiter(limits.token), tokenForm, clientAuth);
    app.use("/register", oauthLimiter(limits.register), express.json({ limit: "16kb", strict: true }));

    app.get("/.well-known/oauth-protected-resource", cors(), (_req, res) => {
      res.json({
        resource: o.resource, authorization_servers: [o.issuer], scopes_supported: [MCP_SCOPE],
        bearer_methods_supported: ["header"], resource_name: "Milanochat flows",
      });
    });
    app.use(mcpAuthRouter({
      provider: b.provider, issuerUrl: new URL(o.issuer), resourceServerUrl: new URL(o.resource),
      scopesSupported: [MCP_SCOPE], resourceName: "Milanochat flows",
      authorizationOptions: { rateLimit: false }, tokenOptions: { rateLimit: false },
      revocationOptions: { rateLimit: false }, clientRegistrationOptions: { rateLimit: false, clientSecretExpirySeconds: 0 },
    }));
    app.use("/consent", sessionMw);
    app.use(consentRouter({
      bundle: b, publicOrigin: o.publicOrigin, issuer: o.issuer, passwordLogin: o.passwordLogin,
      resolveUserTenant: sub => auth.resolveUserTenant(sub),
      loginLimiter: oauthLimiter(limits.login), consentLimiter: oauthLimiter(limits.consent), log,
    }));
  }

  // Browser requests from other origins are refused outright (also covers preflight).
  app.use("/mcp", (req, res, next) => {
    if (!originAllowed(req.get("origin"))) { res.status(403).json(rpcError(-32003, "Origin not allowed.")); return; }
    next();
  }, corsMw, limiter);

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.set("Allow", "POST").status(405).json(rpcError(-32000, "Method not allowed. This server is stateless: use POST /mcp."));
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const jsonBody = express.json({ limit: "256kb", strict: true, type: "application/json" });

  app.post("/mcp",
    (req, res, next) => {
      if (!req.is("application/json")) { res.status(415).json(rpcError(-32700, "Content-Type must be application/json.")); return; }
      next();
    },
    requireOAuthTenant({
      bundle, resourceMetadataUrl, authenticate: h => auth.authenticate(h), resolveUserTenant: sub => auth.resolveUserTenant(sub),
      allowSecretHeader: opts.allowSecretHeader, log,
    }),
    jsonBody,
    (req, res, next) => {
      if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
        res.status(400).json(rpcError(-32600, "Invalid request: body must be a single JSON-RPC object."));
        return;
      }
      next();
    },
    async (req, res, next) => {
      const server = new McpServer({ name: "milanochat-flows", version: "0.1.0" });
      registerRemoteFlowTools(server, { store: opts.store, tenantId: res.locals.tenantId as string, logError: log });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) { next(e); }
    },
  );

  app.use((_req, res) => { res.status(404).json(rpcError(-32601, "Not found.")); });

  // Global error handler: never leaks stack traces or internals.
  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (e as { type?: string } | null)?.type;
    if (res.headersSent) { res.end(); return; }
    if (type === "entity.parse.failed") { res.status(400).json(rpcError(-32700, "Parse error: invalid JSON.")); return; }
    if (type === "entity.too.large") { res.status(413).json(rpcError(-32600, "Request body too large (max 256kb).")); return; }
    if (type === "encoding.unsupported" || type === "charset.unsupported") { res.status(415).json(rpcError(-32600, "Unsupported body encoding.")); return; }
    log("unexpected http error: " + (e instanceof Error ? e.name : typeof e));
    res.status(500).json(rpcError(-32603, "Internal server error."));
  });

  return app;
}
