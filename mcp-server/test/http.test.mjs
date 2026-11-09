// Remote HTTP server: auth, tenant scoping, CORS, limits. In-process app on an ephemeral port,
// in-memory fake Supabase (no network). JWTs are minted locally with jose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createFakeSupabase } from "./fakeSupabase.mjs";
import { createFlowStore } from "../dist/store.js";
import { createHttpApp } from "../dist/httpApp.js";
import { supabaseTenantLookup, createAuthenticator } from "../dist/auth.js";
import { loadHttpConfig, ConfigError } from "../dist/config.js";

const SECRET = "test-jwt-secret-0123456789-abcdefghijklmnop";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // no tenant
const entry = fileURLToPath(new URL("../dist/http-server.js", import.meta.url));

async function start({ allowSecretHeader = false, rateLimitPerMinute = 10_000, layout = "columns" } = {}) {
  const flows = createFakeSupabase({ layout });
  const tenants = createFakeSupabase({ table: "tenants" });
  tenants.rows.push({ id: T1, user_id: U1 }, { id: T2, user_id: U2 });
  const logs = [];
  const app = createHttpApp({
    store: createFlowStore(flows, layout, flows.table), lookupTenant: supabaseTenantLookup(tenants),
    jwtSecret: SECRET, allowSecretHeader, rateLimitPerMinute: rateLimitPerMinute ?? undefined, log: m => logs.push(m),
  });
  const server = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, flows, tenants, logs, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

const key = new TextEncoder().encode(SECRET);
async function jwt(claims = {}, { sub = U1, exp = "1h", secret = key, aud = "authenticated" } = {}) {
  let b = new SignJWT({ role: "authenticated", ...claims }).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
  if (sub) b = b.setSubject(sub);
  if (aud) b = b.setAudience(aud);
  if (typeof exp === "number") b = b.setExpirationTime(exp); else b = b.setExpirationTime(exp);
  return b.sign(secret);
}

const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
let rpcId = 0;
async function rpc(base, method, params, headers = {}) {
  const res = await fetch(base + "/mcp", { method: "POST", headers: { ...H, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { res, body };
}
const call = (base, auth, name, args) => rpc(base, "tools/call", { name, arguments: args }, auth);
const payload = r => { const t = r.body.result.content[0].text; return JSON.parse(t.slice(t.indexOf("\n") + 1)); };
const bearer = t => ({ Authorization: "Bearer " + t });

test("GET /health -> 200", async () => {
  const s = await start();
  try {
    const r = await fetch(s.base + "/health");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: "ok", transport: "http" });
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-powered-by"), null);
  } finally { await s.close(); }
});

test("401 for missing / garbage / expired / wrong-signature / anon-role / no-sub tokens", async () => {
  const s = await start();
  try {
    const now = Math.floor(Date.now() / 1000);
    const cases = {
      none: {},
      basic: { Authorization: "Basic abc" },
      garbage: bearer("not-a-jwt"),
      garbage3: bearer("aaa.bbb.ccc"),
      expired: bearer(await jwt({}, { exp: now - 120 })),
      wrongSig: bearer(await jwt({}, { secret: new TextEncoder().encode("another-secret-another-secret-0123456789") })),
      wrongAud: bearer(await jwt({}, { aud: "other" })),
      anonRole: bearer(await jwt({ role: "anon" })),
      noSub: bearer(await jwt({}, { sub: null })),
    };
    for (const [name, h] of Object.entries(cases)) {
      const { res, body } = await rpc(s.base, "tools/list", {}, h);
      assert.equal(res.status, 401, name);
      assert.match(res.headers.get("www-authenticate"), /^Bearer /, name);
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.error.code, -32001);
      assert.doesNotMatch(JSON.stringify(body), /exp|signature|JWS|JWT/i, name);
    }
  } finally { await s.close(); }
});

test("valid token: tools/list works and no schema exposes tenant_id (official MCP client)", async () => {
  const s = await start();
  const transport = new StreamableHTTPClientTransport(new URL(s.base + "/mcp"), { requestInit: { headers: bearer(await jwt()) } });
  const client = new Client({ name: "http-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ["add_node", "connect_nodes", "create_flow", "list_flows"]);
    for (const t of tools) {
      assert.ok(!("tenant_id" in (t.inputSchema.properties ?? {})), t.name);
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
    }
    assert.doesNotMatch(JSON.stringify(tools.map(t => t.inputSchema)), /tenant_id/);
    const r = await client.callTool({ name: "create_flow", arguments: { name: "Via client" } });
    assert.equal(r.isError, undefined);
    assert.equal(s.flows.rows[0].tenant_id, T1);
  } finally { await client.close(); await s.close(); }
});

for (const layout of ["columns", "drafts"]) {
  test(`[${layout}] create -> add_node -> connect -> list scoped to token tenant; cross-tenant refused`, async () => {
    const s = await start({ layout });
    try {
      const a = bearer(await jwt({}, { sub: U1 }));             // resolved via tenants table -> T1
      const b = bearer(await jwt({ app_metadata: { tenant_id: T2 } }, { sub: U3 })); // claim -> T2
      const c = await call(s.base, a, "create_flow", { name: "Welcome" });
      assert.equal(c.res.status, 200);
      assert.equal(c.body.result.isError, undefined, JSON.stringify(c.body));
      const flow = payload(c);
      assert.equal(flow.tenant_id, T1);
      const m = payload(await call(s.base, a, "add_node", { flow_id: flow.flow_id, node_type: "message", position_x: 0, position_y: 200, data: { text: "Hi" } })).node;
      const e = payload(await call(s.base, a, "add_node", { flow_id: flow.flow_id, node_type: "end", position_x: 0, position_y: 400 })).node;
      for (const [src, dst] of [[flow.trigger_node.id, m.id], [m.id, e.id]]) {
        const r = await call(s.base, a, "connect_nodes", { flow_id: flow.flow_id, source_node_id: src, target_node_id: dst });
        assert.equal(r.body.result.isError, undefined, JSON.stringify(r.body));
      }
      const listA = payload(await call(s.base, a, "list_flows", {}));
      assert.equal(listA.tenant_id, T1);
      assert.equal(listA.flows.length, 1);
      assert.equal(listA.flows[0].nodeCount, 3);
      assert.equal(listA.flows[0].edgeCount, 2);

      // Tenant B: cannot see, read or modify A's flow; error identical to a non-existent id.
      const listB = payload(await call(s.base, b, "list_flows", {}));
      assert.equal(listB.tenant_id, T2);
      assert.equal(listB.flows.length, 0);
      const before = JSON.stringify(s.flows.rows);
      const addB = await call(s.base, b, "add_node", { flow_id: flow.flow_id, node_type: "end", position_x: 1, position_y: 1 });
      const conB = await call(s.base, b, "connect_nodes", { flow_id: flow.flow_id, source_node_id: m.id, target_node_id: e.id, source_handle: "next" });
      const missing = await call(s.base, b, "add_node", { flow_id: "doesNotExist", node_type: "end", position_x: 1, position_y: 1 });
      for (const r of [addB, conB]) {
        assert.equal(r.body.result.isError, true);
        assert.equal(r.body.result.content[0].text.replace(flow.flow_id, "X"), missing.body.result.content[0].text.replace("doesNotExist", "X"));
      }
      assert.equal(JSON.stringify(s.flows.rows), before, "B changed nothing");

      // Client-supplied tenant_id is rejected by the strict schemas, for every tool.
      for (const [name, args] of [["create_flow", { name: "x", tenant_id: T2 }], ["list_flows", { tenant_id: T2 }],
        ["add_node", { flow_id: flow.flow_id, node_type: "end", position_x: 1, position_y: 1, tenant_id: T1 }],
        ["connect_nodes", { flow_id: flow.flow_id, source_node_id: m.id, target_node_id: e.id, tenant_id: T1 }]]) {
        const r = await call(s.base, b, name, args);
        assert.equal(r.body.result.isError, true, name);
        assert.match(r.body.result.content[0].text, /tenant_id/, name);
      }
      assert.equal(JSON.stringify(s.flows.rows), before, "rejected calls wrote nothing");
    } finally { await s.close(); }
  });
}

test("tenant resolution: top-level claim, invalid claim falls back to lookup, unknown user -> 403, lookup cached", async () => {
  const s = await start();
  try {
    assert.equal(payload(await call(s.base, bearer(await jwt({ tenant_id: T2 }, { sub: "not-a-uuid" })), "list_flows", {})).tenant_id, T2);
    assert.equal(payload(await call(s.base, bearer(await jwt({ tenant_id: "nope" }, { sub: U1 })), "list_flows", {})).tenant_id, T1);
    // user_metadata is user-editable and must be ignored.
    const r = await call(s.base, bearer(await jwt({ user_metadata: { tenant_id: T1 } }, { sub: U3 })), "list_flows", {});
    assert.equal(r.res.status, 403);
    assert.equal(r.body.error.code, -32003);
    const lookups = s.tenants.calls.length;
    await call(s.base, bearer(await jwt({}, { sub: U2 })), "list_flows", {});
    await call(s.base, bearer(await jwt({}, { sub: U2 })), "list_flows", {});
    assert.equal(s.tenants.calls.length, lookups + 1, "second lookup served from cache");
    s.tenants.failNext = { code: "XX000" };
    const down = await call(s.base, bearer(await jwt({}, { sub: U3 })), "list_flows", {});
    assert.equal(down.res.status, 503);
  } finally { await s.close(); }
});

test("authenticator cache is bounded", async () => {
  let n = 0;
  const a = createAuthenticator({ jwtSecret: SECRET, allowSecretHeader: false, cacheMax: 3, lookupTenant: async () => ({ tenantId: T1, n: n++ }) });
  for (const sub of [U1, U2, U3, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"])
    assert.equal((await a.authenticate({ authorization: "Bearer " + await jwt({}, { sub }) })).ok, true);
  assert.equal(a.cacheSize(), 3);
});

test("X-Milano-Tenant: ignored when flag off, honored when on", async () => {
  const off = await start();
  try {
    const r = await rpc(off.base, "tools/list", {}, { "X-Milano-Tenant": T1 });
    assert.equal(r.res.status, 401);
  } finally { await off.close(); }
  const on = await start({ allowSecretHeader: true });
  try {
    const r = await call(on.base, { "X-Milano-Tenant": T2 }, "list_flows", {});
    assert.equal(r.res.status, 200);
    assert.equal(payload(r).tenant_id, T2);
    assert.ok(on.logs.some(l => /TESTING ONLY/.test(l)));
    assert.ok(!on.logs.some(l => l.includes(T2)), "tenant-supplied value not logged");
    assert.equal((await rpc(on.base, "tools/list", {}, { "X-Milano-Tenant": "junk" })).res.status, 401);
    // A Bearer token always wins and is still verified.
    assert.equal((await rpc(on.base, "tools/list", {}, { "X-Milano-Tenant": T1, Authorization: "Bearer a.b.c" })).res.status, 401);
  } finally { await on.close(); }
});

test("CORS: allowed origin, disallowed origin, no origin, preflight", async () => {
  const s = await start();
  try {
    const tok = bearer(await jwt());
    const ok = await rpc(s.base, "tools/list", {}, { ...tok, Origin: "https://claude.ai" });
    assert.equal(ok.res.status, 200);
    assert.equal(ok.res.headers.get("access-control-allow-origin"), "https://claude.ai");
    assert.match(ok.res.headers.get("access-control-expose-headers"), /Mcp-Session-Id/i);
    const bad = await rpc(s.base, "tools/list", {}, { ...tok, Origin: "https://evil.example" });
    assert.equal(bad.res.status, 403);
    assert.equal(bad.res.headers.get("access-control-allow-origin"), null);
    const health = await fetch(s.base + "/health", { headers: { Origin: "https://evil.example" } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("access-control-allow-origin"), null);
    const none = await rpc(s.base, "tools/list", {}, tok);
    assert.equal(none.res.status, 200);
    assert.equal(none.res.headers.get("access-control-allow-origin"), null);
    const pre = await fetch(s.base + "/mcp", { method: "OPTIONS", headers: { Origin: "http://localhost:6274",
      "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type,mcp-protocol-version" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "http://localhost:6274");
    for (const h of ["Authorization", "Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version", "Accept", "X-Milano-Tenant"])
      assert.match(pre.headers.get("access-control-allow-headers"), new RegExp(h, "i"));
    const preBad = await fetch(s.base + "/mcp", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
    assert.equal(preBad.status, 403);
    assert.equal(preBad.headers.get("access-control-allow-origin"), null);
  } finally { await s.close(); }
});

test("rate limit: 429 after 20 requests per minute", async () => {
  const s = await start({ rateLimitPerMinute: null }) // null -> production default (20);
  try {
    for (let i = 0; i < 20; i++) assert.equal((await rpc(s.base, "tools/list", {})).res.status, 401, "req " + i);
    const r = await rpc(s.base, "tools/list", {});
    assert.equal(r.res.status, 429);
    assert.equal(r.body.error.code, -32029);
    assert.ok(r.res.headers.get("ratelimit"));
  } finally { await s.close(); }
});

test("body handling: invalid JSON 400, oversized 413, non-object 400, wrong content-type 415, GET/DELETE 405, 404", async () => {
  const s = await start();
  try {
    const tok = bearer(await jwt());
    const post = (body, headers = {}) => fetch(s.base + "/mcp", { method: "POST", headers: { ...H, ...tok, ...headers }, body });
    let r = await post("{not json");
    assert.equal(r.status, 400);
    const pj = await r.json();
    assert.equal(pj.error.code, -32700);
    assert.doesNotMatch(JSON.stringify(pj), /at .*\.js|SyntaxError/);
    r = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(300 * 1024) } }));
    assert.equal(r.status, 413);
    assert.equal((await post("[1,2]")).status, 400);
    assert.equal((await post('"str"')).status, 400);
    assert.equal((await post("x=1", { "Content-Type": "text/plain" })).status, 415);
    for (const method of ["GET", "DELETE"]) {
      r = await fetch(s.base + "/mcp", { method, headers: tok });
      assert.equal(r.status, 405, method);
      assert.equal((await r.json()).jsonrpc, "2.0");
    }
    assert.equal((await fetch(s.base + "/nope")).status, 404);
  } finally { await s.close(); }
});

test("env validation (HTTP only)", () => {
  const base = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc-key-do-not-leak", SUPABASE_JWT_SECRET: SECRET };
  assert.throws(() => loadHttpConfig({}), e => e instanceof ConfigError &&
    /SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET/.test(e.message));
  assert.throws(() => loadHttpConfig({ ...base, SUPABASE_JWT_SECRET: "short" }), e => /too short/.test(e.message) && !e.message.includes("short\""));
  assert.throws(() => loadHttpConfig({ ...base, MCP_ALLOW_SECRET_HEADER: "true", NODE_ENV: "production" }), /Refusing to start/);
  assert.throws(() => loadHttpConfig({ ...base, TRUST_PROXY: "true" }), /TRUST_PROXY/);
  assert.throws(() => loadHttpConfig({ ...base, PORT: "abc" }), /PORT/);
  const c = loadHttpConfig({ ...base, TRUST_PROXY: "1" });
  assert.equal(c.port, 8080);
  assert.equal(c.trustProxy, 1);
  assert.equal(c.allowSecretHeader, false);
  assert.equal(loadHttpConfig({ ...base, MCP_ALLOW_SECRET_HEADER: "true" }).allowSecretHeader, true);
});

test("built entry refuses to start in production with the test header flag, and with missing env", () => {
  const env = { PATH: process.env.PATH ?? "", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "svc-key-do-not-leak",
    SUPABASE_JWT_SECRET: SECRET, MCP_ALLOW_SECRET_HEADER: "true", NODE_ENV: "production", PORT: "0" };
  const r = spawnSync(process.execPath, [entry], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to start/);
  assert.doesNotMatch(r.stderr, /svc-key-do-not-leak|test-jwt-secret/);
  const r2 = spawnSync(process.execPath, [entry], { env: { PATH: env.PATH, SUPABASE_URL: env.SUPABASE_URL }, encoding: "utf8", timeout: 10000 });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /Missing required environment variable\(s\): SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET/);
});
