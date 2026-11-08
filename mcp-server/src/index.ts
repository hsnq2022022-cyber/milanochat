#!/usr/bin/env node
/**
 * Milanochat flows MCP server (stdio only).
 * stdout is the MCP protocol channel: all logging goes to stderr.
 */
import { createClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createFlowStore } from "./store.js";
import { registerFlowTools } from "./tools.js";

const log = (msg: string) => process.stderr.write("[milanochat-flows-mcp] " + msg + "\n");
// Any stray console.log/info from dependencies must not corrupt the protocol stream.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

async function main(): Promise<void> {
  let config;
  try { config = loadConfig(process.env); }
  catch (e) {
    log(e instanceof ConfigError ? "Configuration error: " + e.message : "Configuration error.");
    process.exit(1);
  }

  const client = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const store = createFlowStore(client, config.storage, config.table);

  const server = new McpServer({ name: "milanochat-flows", version: "0.1.0" });
  registerFlowTools(server, { store, allowedTenantId: config.allowedTenantId, logError: log });

  await server.connect(new StdioServerTransport());
  log(`ready (${store.description}; tenant lock: ${config.allowedTenantId ? "on" : "OFF - any tenant_id accepted"})`);
}

main().catch(e => {
  log("fatal: " + (e instanceof Error ? e.name : "error"));
  process.exit(1);
});
