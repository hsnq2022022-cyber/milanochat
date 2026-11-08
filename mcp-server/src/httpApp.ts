import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FlowStore } from "./store.js";
import { registerRemoteFlowTools } from "./tools.js";
import { createAuthenticator, type TenantLookup } from "./auth.js";

export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  "https://claude.ai", "https://chat.openai.com", "https://cursor.com", "http://localhost:6274",
]);

export type HttpAppOptions = {
  store: FlowStore;
  lookupTenant: TenantLookup;
  jwtSecret: string;
  allowSecretHeader: boolean;
  allowedTenantId?: string | null;
  trustProxy?: false | number;
  rateLimitPerMinute?: number;
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

export function createHttpApp(opts: HttpAppOptions) {
  const log = opts.log ?? ((m: string) => process.stderr.write("[milanochat-flows-mcp:http] " + m + "\n"));
  const auth = createAuthenticator({
    jwtSecret: opts.jwtSecret, allowSecretHeader: opts.allowSecretHeader,
    lookupTenant: opts.lookupTenant, allowedTenantId: opts.allowedTenantId ?? null,
  });

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
    exposedHeaders: ["Mcp-Session-Id"],
    maxAge: 600,
  });

  app.get("/health", corsMw, (_req, res) => { res.json({ status: "ok", transport: "http" }); });

  const limiter = rateLimit({
    windowMs: 60_000, limit: opts.rateLimitPerMinute ?? 20,
    standardHeaders: "draft-7", legacyHeaders: false,
    skip: req => req.method === "OPTIONS",
    handler: (_req, res) => { res.status(429).json(rpcError(-32029, "Too many requests, slow down.")); },
  });

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
    async (req, res, next) => {
      try {
        const out = await auth.authenticate({
          authorization: req.get("authorization") ?? undefined,
          xMilanoTenant: opts.allowSecretHeader ? req.get("x-milano-tenant") ?? undefined : undefined,
        });
        if (!out.ok) {
          if (out.status === 401) {
            res.set("WWW-Authenticate", out.reason === "invalid" ? 'Bearer realm="milanochat-mcp", error="invalid_token"' : 'Bearer realm="milanochat-mcp"');
            res.status(401).json(rpcError(-32001, "Unauthorized: a valid Bearer token is required."));
          } else if (out.status === 403) {
            res.status(403).json(rpcError(-32003, "Forbidden: no workspace is linked to this account."));
          } else {
            res.status(503).json(rpcError(-32002, "Authentication backend unavailable, retry later."));
          }
          return;
        }
        if (out.via === "test-header") log("WARNING: request authenticated by X-Milano-Tenant test header (MCP_ALLOW_SECRET_HEADER=true). TESTING ONLY.");
        res.locals.tenantId = out.tenantId;
        next();
      } catch (e) { next(e); }
    },
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
