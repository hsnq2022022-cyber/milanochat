#!/usr/bin/env node
/**
 * Milanochat flows MCP server, remote Streamable HTTP transport (stateless: one McpServer +
 * transport per POST /mcp). Tenant comes only from the verified token: an OAuth 2.1 access token
 * (MCP_OAUTH_ENABLED=true), a Supabase user JWT (MCP_ALLOW_STATIC_BEARER) or, TESTING ONLY,
 * X-Milano-Tenant when MCP_ALLOW_SECRET_HEADER=true (refused when NODE_ENV=production).
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { ConfigError, loadHttpConfig } from "./config.js";
import { createFlowStore } from "./store.js";
import { supabaseTenantLookup } from "./auth.js";
import { createHttpApp, TEST_HEADER_WARNING, type HttpOAuthOptions } from "./httpApp.js";
import { createMemoryOAuthStore, createPgOAuthStore, type OAuthStore } from "./oauthStore.js";
import { supabasePasswordLogin } from "./oauthPages.js";

const log = (msg: string) => process.stderr.write("[milanochat-flows-mcp:http] " + msg + "\n");

function main(): void {
  let config;
  try { config = loadHttpConfig(process.env); }
  catch (e) {
    log(e instanceof ConfigError ? "Configuration error: " + e.message : "Configuration error.");
    process.exit(1);
  }
  if (config.allowSecretHeader) process.stderr.write(TEST_HEADER_WARNING + "\n");

  const client = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  let oauth: HttpOAuthOptions | null = null;
  let oauthStore: OAuthStore | null = null;
  const o = config.oauth;
  if (o) {
    if (o.databaseUrl) {
      let ssl: pg.PoolConfig["ssl"] = false;
      if (o.databaseSsl === "verify") {
        let ca: string | undefined;
        if (o.databaseSslCaFile) {
          try { ca = readFileSync(o.databaseSslCaFile, "utf8"); }
          catch { log("Configuration error: DATABASE_SSL_CA_FILE could not be read."); process.exit(1); }
        }
        ssl = { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
      } else if (o.databaseSsl === "no-verify") {
        log("WARNING: DATABASE_SSL=no-verify: the database connection is encrypted but the server certificate is NOT verified.");
        ssl = { rejectUnauthorized: false };
      }
      const pool = new pg.Pool({ connectionString: o.databaseUrl, ssl, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
      pool.on("error", e => log("database pool error: " + ((e as { code?: string }).code ?? e.name)));
      oauthStore = createPgOAuthStore(pool);
    } else {
      process.stderr.write("WARNING: OAuth store is IN-MEMORY (no DATABASE_URL): LOCAL DEVELOPMENT ONLY. Clients, grants and tokens are lost on restart.\n");
      oauthStore = createMemoryOAuthStore();
    }
    if (!o.cookieSecure) log("WARNING: MCP_INSECURE_COOKIES=true: session cookie sent over plain http (local development only).");
    if (o.cookieSecure && config.trustProxy === false && o.publicOrigin.startsWith("https:"))
      log("note: secure session cookies need req.secure; behind a TLS proxy (ngrok/Railway) set TRUST_PROXY=1 or login will loop.");
    oauth = {
      publicOrigin: o.publicOrigin, issuer: o.issuer, resource: o.resource, signingSecret: o.signingSecret,
      sessionSecret: o.sessionSecret, cookieSecure: o.cookieSecure, maxClientsPerHour: o.maxClientsPerHour,
      store: oauthStore, passwordLogin: supabasePasswordLogin(config.supabaseUrl, o.anonKey),
    };
    const store = oauthStore;
    const sweep = () => { store.cleanup(Date.now()).catch(e => log("oauth cleanup failed: " + ((e as { code?: string }).code ?? (e as Error).name))); };
    sweep();
    setInterval(sweep, 15 * 60 * 1000).unref();
  }
  if (config.allowStaticBearer && config.production) log("note: MCP_ALLOW_STATIC_BEARER=true in production: Supabase user JWTs are accepted as Bearer tokens.");

  const app = createHttpApp({
    store: createFlowStore(client, config.storage, config.table),
    lookupTenant: supabaseTenantLookup(client),
    jwtSecret: config.jwtSecret,
    allowSecretHeader: config.allowSecretHeader,
    allowStaticBearer: config.allowStaticBearer,
    oauth,
    allowedTenantId: config.allowedTenantId,
    trustProxy: config.trustProxy,
    log,
  });
  const server = app.listen(config.port, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : config.port;
    log(`ready on port ${port} (POST /mcp, GET /health; ${config.storage} storage; oauth: ${o ? `on (${oauthStore?.kind} store)` : "off"}; static bearer: ${config.allowStaticBearer ? "on" : "off"}; test header: ${config.allowSecretHeader ? "ON (TESTING ONLY)" : "off"})`);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on("error", e => { log("listen error: " + ((e as NodeJS.ErrnoException).code ?? e.name)); process.exit(1); });
  const stop = () => server.close(() => { void (oauthStore?.close() ?? Promise.resolve()).finally(() => process.exit(0)); });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();
