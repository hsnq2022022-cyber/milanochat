// Spawns the built server over stdio with the official MCP client. No live Supabase is contacted
// for tools/list; the tool call below targets a closed local port on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const FAKE_KEY = "test-service-role-key-DO-NOT-LEAK";

test("tools/list exposes 4 tools with required position params", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry], stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: FAKE_KEY },
  });
  let stderr = "";
  transport.stderr?.on("data", d => { stderr += d; });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ["add_node", "connect_nodes", "create_flow", "list_flows"]);
    const add = tools.find(t => t.name === "add_node");
    for (const p of ["flow_id", "node_type", "position_x", "position_y"]) assert.ok(add.inputSchema.required.includes(p), p);
    assert.equal(add.inputSchema.properties.position_x.type, "number");
    assert.equal(add.inputSchema.properties.position_y.type, "number");
    assert.deepEqual(add.inputSchema.properties.node_type.enum, ["message", "question", "delay", "condition", "end"]);
    const conn = tools.find(t => t.name === "connect_nodes");
    assert.deepEqual([...conn.inputSchema.required].sort(), ["flow_id", "source_node_id", "target_node_id"]);
    assert.deepEqual(tools.find(t => t.name === "create_flow").inputSchema.required.sort(), ["name", "tenant_id"]);

    const bad = await client.callTool({ name: "add_node", arguments: { flow_id: "x", node_type: "message", position_x: 1 } });
    assert.equal(bad.isError, true);
    // Unreachable DB -> isError result, no secret in output.
    const r = await client.callTool({ name: "list_flows", arguments: { tenant_id: "11111111-1111-4111-8111-111111111111" } });
    assert.equal(r.isError, true);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(FAKE_KEY));
  } finally {
    await client.close();
  }
  assert.match(stderr, /ready/);
  assert.doesNotMatch(stderr, new RegExp(FAKE_KEY));
});

test("fails fast with a clear stderr message when credentials are missing", () => {
  const r = spawnSync(process.execPath, [entry], { env: { PATH: process.env.PATH ?? "", SUPABASE_URL: "https://x.supabase.co" }, encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /Missing required environment variable\(s\): SUPABASE_SERVICE_ROLE_KEY/);
  const r2 = spawnSync(process.execPath, [entry], { env: { PATH: process.env.PATH ?? "", SUPABASE_URL: "http://example.com", SUPABASE_SERVICE_ROLE_KEY: FAKE_KEY }, encoding: "utf8", timeout: 10000 });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /https/);
  assert.doesNotMatch(r2.stderr, new RegExp(FAKE_KEY));
});
