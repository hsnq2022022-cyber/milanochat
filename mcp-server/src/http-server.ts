#!/usr/bin/env node
/**
 * Milanochat flows MCP server, remote Streamable HTTP transport (stateless: one McpServer +
 * transport per POST /mcp). Tenant comes only from the verified Bearer JWT (or, TESTING ONLY,
 * X-Milano-Tenant when MCP_ALLOW_SECRET_HEADER=true; refused when NODE_ENV=production).
 */
import { createClient } from "@supabase/supabase-js";
import { ConfigError, loadHttpConfig } from "./config.js";
import { createFlowStore } from "./store.js";
import { supabaseTenantLookup } from "./auth.js";
import { createHttpApp, TEST_HEADER_WARNING } from "./httpApp.js";

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
  const app = createHttpApp({
    store: createFlowStore(client, config.storage, config.table),
    lookupTenant: supabaseTenantLookup(client),
    jwtSecret: config.jwtSecret,
    allowSecretHeader: config.allowSecretHeader,
    allowedTenantId: config.allowedTenantId,
    trustProxy: config.trustProxy,
    log,
  });
  const server = app.listen(config.port, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : config.port;
    log(`ready on port ${port} (POST /mcp, GET /health; ${config.storage} storage; test header: ${config.allowSecretHeader ? "ON (TESTING ONLY)" : "off"})`);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on("error", e => { log("listen error: " + ((e as NodeJS.ErrnoException).code ?? e.name)); process.exit(1); });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();
