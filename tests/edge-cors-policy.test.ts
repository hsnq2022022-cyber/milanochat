// T5-D2: CORS hardening for milan-api, the shared helper (_shared/cors.ts,
// also used by `api`), channels, agent-prompt and conversation-previews.
//
// Policy under test:
// - trusted (dashboard / JWT / claim-token / webhook / cron callers): echo the
//   request Origin ONLY on an exact match with the trusted allow-list
//   (production Pages origin, local Vite dev origins, SITE_URL's https origin,
//   ALLOWED_ORIGINS), always `Vary: Origin`; otherwise no ACAO. Requests are
//   still served (status / body unchanged); a missing Origin works normally.
// - public `*` ONLY for milan-api's website Widget actions (widget.js,
//   widget_public, widget_session, widget_message), never with credentials.
// - Access-Control-Allow-Credentials is never sent.
// - `api` (operator-only /health, /db-test) gets no ACAO at all.
// Behavioural: the pure helpers are imported directly; the three small
// functions' REAL index.ts are type-stripped and their Deno.serve handlers
// driven with Requests (same harness as edge-small-functions-error-leak).
// milan-api/index.ts cannot be loaded under Node, so its entry point is pinned
// at source level and its policy module (corsPolicy.ts) is tested directly.
// Run: node --experimental-strip-types --test tests/edge-cors-policy.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import * as SHARED_CORS from "../supabase/functions/_shared/cors.ts";
import {
  APP_ORIGIN, DEV_ORIGINS, applyCors, canonicalOrigin, corsHeadersFor, PUBLIC_CORS_POLICY,
  trustedCorsPolicy, trustedOrigins, withCors, corsHeaders, handleCors,
} from "../supabase/functions/_shared/cors.ts";
import {milanApiCorsPolicy, withMilanCors, WIDGET_PUBLIC_ACTIONS} from "../supabase/functions/milan-api/corsPolicy.ts";

const FN = "supabase/functions";
const read = (p: string) => readFileSync(p, "utf8");
const SRC = {
  shared: read(`${FN}/_shared/cors.ts`),
  milanPolicy: read(`${FN}/milan-api/corsPolicy.ts`),
  milan: read(`${FN}/milan-api/index.ts`),
  channels: read(`${FN}/channels/index.ts`),
  agentPrompt: read(`${FN}/agent-prompt/index.ts`),
  previews: read(`${FN}/conversation-previews/index.ts`),
  api: read(`${FN}/api/index.ts`),
};

const ACAO = "access-control-allow-origin";
const ACAC = "access-control-allow-credentials";
const noEnv = () => undefined;
const envOf = (e: Record<string, string>) => (k: string) => e[k];
const reqFrom = (origin: string | null, url = "https://x.supabase.co/functions/v1/fn", init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (origin !== null) headers.set("origin", origin);
  return new Request(url, {...init, headers});
};

const LOOKALIKES = [
  "https://hsnq2022022-cyber.github.io.evil.com",
  "https://evilhsnq2022022-cyber.github.io",
  "https://x.hsnq2022022-cyber.github.io",
  "https://hsnq2022022-cyber.github.io/",
  "https://hsnq2022022-cyber.github.io/milanochat/",
  "https://hsnq2022022-cyber.github.io:443",
  "https://hsnq2022022-cyber.github.io:8443",
  "http://hsnq2022022-cyber.github.io",
  "HTTPS://HSNQ2022022-CYBER.GITHUB.IO",
  "https://hsnq2022022-cyber.github.io, https://evil.com",
  "https://evil.com",
  "https://github.io",
  "null",
  "",
  "*",
  "http://localhost:3001",
  "http://localhost",
  "https://localhost:3000",
  "http://localhost:3000.evil.com",
  "http://127.0.0.1:3000/",
];

// ================================================================ pure helper
test("trusted: the production origin gets ACAO = that exact origin + Vary: Origin, never credentials", () => {
  const h = corsHeadersFor(reqFrom(APP_ORIGIN), trustedCorsPolicy(noEnv));
  assert.deepEqual(h, {"Vary": "Origin", "Access-Control-Allow-Origin": "https://hsnq2022022-cyber.github.io"});
  for (const o of DEV_ORIGINS) {
    assert.equal(corsHeadersFor(reqFrom(o), trustedCorsPolicy(noEnv))["Access-Control-Allow-Origin"], o);
  }
  assert.deepEqual([...DEV_ORIGINS].sort(),
    ["http://127.0.0.1:3000", "http://127.0.0.1:5173", "http://localhost:3000", "http://localhost:5173"]);
});

test("trusted: foreign, null and look-alike origins get no ACAO (Vary: Origin still sent)", () => {
  const policy = trustedCorsPolicy(envOf({SITE_URL: "https://app.example.com/path", ALLOWED_ORIGINS: "https://ops.example.com"}));
  for (const o of LOOKALIKES) {
    const h = corsHeadersFor(reqFrom(o), policy);
    assert.deepEqual(h, {"Vary": "Origin"}, "rejected: " + JSON.stringify(o));
  }
  for (const o of ["https://app.example.com.evil.com", "https://app.example.com/", "http://app.example.com",
    "https://x.ops.example.com", "https://ops.example.com:444"]) {
    assert.deepEqual(corsHeadersFor(reqFrom(o), policy), {"Vary": "Origin"}, o);
  }
});

test("trusted: a missing Origin (curl / server-to-server / webhook) gets no reflected origin", () => {
  assert.deepEqual(corsHeadersFor(reqFrom(null), trustedCorsPolicy(noEnv)), {"Vary": "Origin"});
});

test("env: SITE_URL's https origin and exact ALLOWED_ORIGINS entries only", () => {
  const set = trustedOrigins(envOf({
    SITE_URL: "https://app.example.com/dashboard?x=1",
    ALLOWED_ORIGINS: " https://ops.example.com ,https://a.example.com/,https://b.example.com/x,*,null,http://c.example.com," +
      "https://user:pw@d.example.com,https://*.example.com,https://a_b.example.com,http://localhost:4173,ftp://e.example.com,https://f.example.com:8443",
  }));
  assert.deepEqual([...set].sort(), [
    "http://127.0.0.1:3000", "http://127.0.0.1:5173", "http://localhost:3000", "http://localhost:4173",
    "http://localhost:5173", "https://app.example.com", "https://f.example.com:8443", "https://hsnq2022022-cyber.github.io",
    "https://ops.example.com",
  ]);
  assert.ok(!trustedOrigins(envOf({SITE_URL: "http://app.example.com"})).has("http://app.example.com"), "SITE_URL must be https");
  assert.ok(!trustedOrigins(envOf({SITE_URL: "not a url"})).has("null"));
  for (const bad of ["*", "null", "", "https://a.example.com/", "https://a.example.com/p", "http://a.example.com",
    "https://u@a.example.com", "data:text/html,x", "file:///etc/passwd", "https://a.example.com?q", "https://a.example.com#f"]) {
    assert.equal(canonicalOrigin(bad), null, bad);
  }
  assert.equal(canonicalOrigin("https://a.example.com"), "https://a.example.com");
});

test("public (Widget only): `*` and nothing else; never credentials, never a reflected origin", () => {
  for (const o of ["https://shop.customer.example", "null", null, "https://evil.example"]) {
    assert.deepEqual(corsHeadersFor(reqFrom(o), PUBLIC_CORS_POLICY), {"Access-Control-Allow-Origin": "*"});
  }
});

test("applyCors: replaces handler ACAO / credentials, keeps status, body and other headers, merges Vary", async () => {
  const inner = new Response(JSON.stringify({error: "x"}), {status: 401, headers: {
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "authorization", "content-type": "application/json", "Vary": "Accept-Encoding",
  }});
  const out = applyCors(inner, corsHeadersFor(reqFrom("https://evil.example"), trustedCorsPolicy(noEnv)));
  assert.equal(out.status, 401);
  assert.equal(out.headers.get(ACAO), null);
  assert.equal(out.headers.get(ACAC), null);
  assert.equal(out.headers.get("access-control-allow-headers"), "authorization");
  assert.equal(out.headers.get("content-type"), "application/json");
  assert.equal(out.headers.get("vary"), "Accept-Encoding, Origin");
  assert.deepEqual(await out.json(), {error: "x"});
  const again = applyCors(new Response(null, {status: 204, headers: {Vary: "origin"}}),
    corsHeadersFor(reqFrom(APP_ORIGIN), trustedCorsPolicy(noEnv)));
  assert.equal(again.headers.get("vary"), "origin");
  assert.equal(again.headers.get(ACAO), APP_ORIGIN);
  // Immutable headers (Response.redirect): rebuilt with the same status.
  const redir = applyCors(Response.redirect("https://example.com/next", 302),
    corsHeadersFor(reqFrom(APP_ORIGIN), trustedCorsPolicy(noEnv)));
  assert.equal(redir.status, 302);
  assert.equal(redir.headers.get("location"), "https://example.com/next");
  assert.equal(redir.headers.get(ACAO), APP_ORIGIN);
});

test("withCors preflight: allowed origin => handler status + ACAO echo; rejected => same status, no ACAO", async () => {
  const inner = (req: Request) => req.method === "OPTIONS"
    ? new Response("ok", {status: 200, headers: {"Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}})
    : new Response("{}", {status: 200});
  const h = withCors(() => trustedCorsPolicy(noEnv), inner);
  const pre = (origin: string | null) => h(reqFrom(origin, undefined, {method: "OPTIONS", headers: {
    "access-control-request-method": "POST", "access-control-request-headers": "authorization, apikey, content-type"}}));
  const ok = await pre(APP_ORIGIN);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get(ACAO), APP_ORIGIN);
  assert.equal(ok.headers.get("vary"), "Origin");
  assert.match(ok.headers.get("access-control-allow-methods")!, /\bPOST\b/);
  assert.match(ok.headers.get("access-control-allow-headers")!, /authorization.*apikey.*content-type/);
  assert.equal(ok.headers.get(ACAC), null);
  for (const o of ["https://evil.example", "https://hsnq2022022-cyber.github.io.evil.com", "null", null]) {
    const bad = await pre(o);
    assert.equal(bad.status, 200, String(o));
    assert.equal(bad.headers.get(ACAO), null, String(o));
    assert.equal(bad.headers.get(ACAC), null);
  }
});

test("api (shared corsHeaders / handleCors): no ACAO at all — operator-only, no browser caller", () => {
  assert.equal(Object.keys(corsHeaders).some((k) => k.toLowerCase() === ACAO), false);
  const pre = handleCors(reqFrom(APP_ORIGIN, undefined, {method: "OPTIONS"}))!;
  assert.equal(pre.status, 200);
  assert.equal(pre.headers.get(ACAO), null);
  assert.equal(handleCors(reqFrom(APP_ORIGIN)), null);
});

// ================================================================ milan-api policy
const MILAN = "https://x.supabase.co/functions/v1/milan-api";
const CUSTOMER_SITES = ["https://shop.customer.example", "https://www.another-store.sa", "http://localhost:8080"];

test("milan-api widget actions: `*` from any customer site, also for a body-less preflight; no credentials", () => {
  assert.deepEqual([...WIDGET_PUBLIC_ACTIONS].sort(), ["widget.js", "widget_message", "widget_public", "widget_session"]);
  for (const action of WIDGET_PUBLIC_ACTIONS) {
    for (const o of [...CUSTOMER_SITES, APP_ORIGIN, null]) {
      for (const method of ["OPTIONS", "GET", "POST"]) {
        const req = reqFrom(o, `${MILAN}?action=${encodeURIComponent(action)}&token=wt_x`, {method});
        const res = withMilanCors(req, new Response("{}", {status: 200, headers: {"Access-Control-Allow-Origin": "*"}}), noEnv);
        assert.equal(res.headers.get(ACAO), "*", `${action} ${o} ${method}`);
        assert.equal(res.headers.get(ACAC), null);
      }
    }
  }
});

test("milan-api dashboard / claim-token / create_tenant actions: trusted origins only", () => {
  for (const action of ["summary", "conversations", "messages", "reply", "claim_account", "widget_dashboard_list",
    "widget_dashboard_create", "knowledge_add", "pay_create", "bind_number", "qa_test", "create_tenant", "comment_activity", "", "unknown"]) {
    const ok = withMilanCors(reqFrom(APP_ORIGIN, `${MILAN}?action=${action}`, {method: "POST"}), new Response("{}"), noEnv);
    assert.equal(ok.headers.get(ACAO), APP_ORIGIN, action);
    assert.equal(ok.headers.get("vary"), "Origin");
    for (const o of [...CUSTOMER_SITES.slice(0, 2), ...LOOKALIKES]) {
      const pre = withMilanCors(reqFrom(o, `${MILAN}?action=${action}`, {method: "OPTIONS"}),
        new Response("ok", {status: 200, headers: {"Access-Control-Allow-Origin": "*"}}), noEnv);
      assert.equal(pre.status, 200);
      assert.equal(pre.headers.get(ACAO), null, `${action} ${o}`);
    }
  }
  // ALLOWED_ORIGINS / SITE_URL extend the trusted set for these actions, not widget ones.
  const env = envOf({ALLOWED_ORIGINS: "https://ops.example.com"});
  assert.equal(withMilanCors(reqFrom("https://ops.example.com", `${MILAN}?action=summary`), new Response("{}"), env)
    .headers.get(ACAO), "https://ops.example.com");
});

test("milan-api action look-alikes never select the public policy (same first-value lookup as the handler)", () => {
  for (const q of ["action=Widget_public", "action=widget_public_x", "action=widget_publi", "action=summary&action=widget_public",
    "Action=widget_public", "action=widget.js%00", "action=%20widget_public"]) {
    const p = milanApiCorsPolicy(reqFrom("https://evil.example", `${MILAN}?${q}`), noEnv);
    assert.equal(p.kind, "trusted", q);
  }
  assert.equal(milanApiCorsPolicy(reqFrom(null, `${MILAN}?action=widget_session&action=summary`), noEnv).kind, "public");
});

test("milan-api webhook / cron actions (server-to-server): unaffected, no ACAO without a trusted Origin", () => {
  for (const action of ["whatsapp_webhook", "instagram_webhook", "pay_webhook", "inbound_recovery_tick"]) {
    for (const method of ["GET", "POST"]) {
      const res = withMilanCors(reqFrom(null, `${MILAN}?action=${action}`, {method}),
        new Response("challenge", {status: 200, headers: {"content-type": "text/plain"}}), noEnv);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get(ACAO), null);
      assert.equal(res.headers.get("content-type"), "text/plain");
      assert.equal(withMilanCors(reqFrom("https://evil.example", `${MILAN}?action=${action}`, {method}),
        new Response("x"), noEnv).headers.get(ACAO), null);
    }
  }
});

test("milan-api index.ts entry: every response passes through withMilanCors; OPTIONS still precedes the body read", () => {
  const m = SRC.milan;
  const once = (s: string) => { assert.equal(m.split(s).length, 2, "exactly once: " + s.slice(0, 60)); return m.indexOf(s); };
  const entry = once("Deno.serve(async (req) => {\n  // T5-D2: the handler below is unchanged; only the CORS origin headers of its\n" +
    "  // response (preflight included) are set per action and request Origin.\n  return withMilanCors(req, await milanApiHandler(req), env);\n});\n");
  const fnStart = once("const milanApiHandler = (async (req: Request) => {\n  if (req.method === \"OPTIONS\") {\n");
  assert.ok(fnStart > entry);
  assert.ok(once("const limitedBody = await readBodyLimited(") > fnStart, "OPTIONS answered before the body read");
  assert.ok(m.endsWith("  }\n});\n"), "handler closing unchanged");
  assert.equal(m.split("Deno.serve(").length, 2, "single Deno.serve");
  assert.equal(m.split("milanApiHandler").length, 3, "declared once, called once (from the entry only)");
  assert.match(m, /import \{ withMilanCors \} from "\.\/corsPolicy\.ts";/);
  assert.match(m, /const env = \(k: string\) => Deno\.env\.get\(k\) \?\? "";/);
  const cors = m.slice(m.indexOf("const CORS = {"), m.indexOf("};", m.indexOf("const CORS = {")));
  assert.match(cors, /"Access-Control-Allow-Headers":\s*"authorization, x-client-info, apikey, content-type, x-tenant-token"/);
  assert.doesNotMatch(m, /["']Access-Control-Allow-Origin["']/i, "no ACAO header literal left in milan-api/index.ts");
});

// ================================================================ source guards
test("source guard: no wildcard ACAO and no Allow-Credentials outside the justified Widget policy", () => {
  for (const [name, s] of Object.entries(SRC)) {
    // Only a quoted header literal counts (comments may mention the header).
    assert.doesNotMatch(s, /["']Access-Control-Allow-Credentials["']\s*[:,]/i, name);
    const wild = s.match(/["']Access-Control-Allow-Origin["']\s*:\s*["']\*["']/g) ?? [];
    if (name === "shared") {
      assert.equal(wild.length, 1, "shared: exactly one `*` (the public Widget policy)");
      assert.match(s, /if \(policy\.kind === "public"\) return \{ "Access-Control-Allow-Origin": "\*" \};/);
    } else {
      assert.equal(wild.length, 0, name + ": no literal wildcard ACAO");
    }
  }
  // The only consumer of PUBLIC_CORS_POLICY is milan-api's Widget action set.
  for (const [name, s] of Object.entries(SRC)) {
    if (name !== "shared" && name !== "milanPolicy") assert.doesNotMatch(s, /PUBLIC_CORS_POLICY/, name);
  }
  assert.match(SRC.milanPolicy, /WIDGET_PUBLIC_ACTIONS\.has\(actionOf\(req\)\) \? PUBLIC_CORS_POLICY : trustedCorsPolicy\(env\)/);
  // ACAO is set only via exact Set membership (no prefix / suffix / regex matching).
  assert.match(SRC.shared, /if \(origin !== null && policy\.origins\.has\(origin\)\) h\["Access-Control-Allow-Origin"\] = origin;/);
  assert.doesNotMatch(SRC.shared, /startsWith\(|endsWith\(|\.includes\(origin|\.test\(origin/);
});

test("source guard: channels, agent-prompt and conversation-previews wrap Deno.serve with the trusted policy", () => {
  const WRAP = "Deno.serve(withCors(() => trustedCorsPolicy((k) => Deno.env.get(k)), async (req: Request) => {\n";
  for (const name of ["channels", "agentPrompt", "previews"] as const) {
    const s = SRC[name];
    assert.match(s, /^import \{ withCors, trustedCorsPolicy \} from "\.\.\/_shared\/cors\.ts";$/m, name);
    assert.equal(s.split(WRAP).length, 2, name);
    assert.equal(s.split("Deno.serve(").length, 2, name + ": single Deno.serve");
    assert.ok(s.endsWith("  }\n}));\n"), name);
    assert.ok(s.indexOf('if (req.method === "OPTIONS")') > s.indexOf(WRAP), name);
  }
  assert.doesNotMatch(SRC.channels, /x-hub-signature-256|\bPUT\b/, "channels: only the headers / methods its callers use");
  assert.match(SRC.api, /^import \{ corsHeaders, handleCors \} from "\.\.\/_shared\/cors\.ts";$/m);
});

test("Widget bootstrap (server/public/widget.js) sends no credentials and only Content-Type", () => {
  const w = read("server/public/widget.js");
  assert.doesNotMatch(w, /credentials\s*:/, "fetch credentials default (no cookies cross-origin)");
  assert.doesNotMatch(w, /[Aa]uthorization|x-tenant-token|apikey/);
  const calls = w.match(/fetch\(`\$\{baseUrl\}\/functions\/v1\/milan-api\?action=([a-z_.]+)/g) ?? [];
  const actions = calls.map((c) => c.split("action=")[1]).sort();
  assert.ok(actions.length >= 3);
  for (const a of actions) assert.ok(WIDGET_PUBLIC_ACTIONS.has(a), "widget.js calls only public widget actions: " + a);
});

// ================================================================ real small functions
type Log = [string, unknown[]];
function load(src: string, imports: Record<string, unknown>, env: Record<string, string | undefined>) {
  let js = stripTypeScriptTypes(src, {mode: "strip"});
  js = js.replace(/^\s*import\s*\{([^}]*)\}\s*from\s*["'][^"']+["'];?/gm,
    (_m, names: string) => `const {${names}} = __imports;`);
  assert.ok(!/^\s*import\b/m.test(js), "all imports replaced");
  const logs: Log[] = [];
  const cons: any = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) cons[k] = (...a: unknown[]) => logs.push([k, a]);
  let handler: ((r: Request) => Promise<Response>) | null = null;
  const Deno = {serve: (h: any) => { handler = h; }, env: {get: (k: string) => env[k]}};
  new Function("Deno", "__imports", "console", js)(Deno, {...SHARED_CORS, ...imports}, cons);
  assert.ok(handler, "Deno.serve handler captured");
  return handler as unknown as (r: Request) => Promise<Response>;
}
const fakeClient = () => ({
  from: () => { throw new Error("no db in CORS tests"); },
  auth: {getUser: async () => ({data: {user: null}, error: {message: "bad"}})},
});
const ENV = {SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "srk"};
const FUNCS = [
  {name: "channels", url: "https://x.supabase.co/functions/v1/channels/accounts", method: "GET",
    h: (env: Record<string, string | undefined>) => load(SRC.channels, {createClient: fakeClient,
      issueOAuthState: async () => ({ok: false, code: "no_tenant"}), oauthStateSecret: () => "s"}, env)},
  {name: "agent-prompt", url: "https://x.supabase.co/functions/v1/agent-prompt", method: "GET",
    h: (env: Record<string, string | undefined>) => load(SRC.agentPrompt, {createClient: fakeClient}, env)},
  {name: "conversation-previews", url: "https://x.supabase.co/functions/v1/conversation-previews", method: "POST",
    h: (env: Record<string, string | undefined>) => load(SRC.previews, {createClient: fakeClient}, env)},
];

for (const f of FUNCS) {
  test(`${f.name}: preflight + unauthenticated call — ACAO only for trusted origins, statuses / bodies unchanged`, async () => {
    const h = f.h(ENV);
    const pre = (o: string | null) => h(reqFrom(o, f.url, {method: "OPTIONS", headers: {
      "access-control-request-method": f.method, "access-control-request-headers": "authorization, apikey, content-type, x-client-info"}}));
    for (const o of [APP_ORIGIN, "http://localhost:3000"]) {
      const r = await pre(o);
      assert.equal(r.status, 200);
      assert.equal(await r.text(), "ok");
      assert.equal(r.headers.get(ACAO), o);
      assert.equal(r.headers.get("vary"), "Origin");
      assert.equal(r.headers.get(ACAC), null);
      const allowH = r.headers.get("access-control-allow-headers")!;
      for (const x of ["authorization", "apikey", "content-type", "x-client-info"]) assert.ok(allowH.includes(x), x);
      assert.ok(r.headers.get("access-control-allow-methods")!.includes(f.method));
    }
    for (const o of ["https://evil.example", "https://hsnq2022022-cyber.github.io.evil.com", "http://hsnq2022022-cyber.github.io", "null", null]) {
      const r = await pre(o);
      assert.equal(r.status, 200, String(o));
      assert.equal(r.headers.get(ACAO), null, String(o));
      assert.equal(r.headers.get(ACAC), null);
    }
    // Real request without a token: 401 JSON either way; only the ACAO differs.
    const bodies: string[] = [];
    for (const o of [APP_ORIGIN, "https://evil.example", null]) {
      const r = await h(reqFrom(o, f.url, {method: f.method, body: f.method === "POST" ? "{}" : undefined}));
      assert.equal(r.status, 401, `${f.name} ${o}`);
      assert.match(r.headers.get("content-type")!, /^application\/json/);
      assert.equal(r.headers.get(ACAO), o === APP_ORIGIN ? APP_ORIGIN : null, String(o));
      assert.equal(r.headers.get("vary"), "Origin");
      bodies.push(await r.text());
    }
    assert.ok(bodies.every((b) => b === bodies[0]), "same body for every origin");
    // ALLOWED_ORIGINS extends the trusted set.
    const h2 = f.h({...ENV, ALLOWED_ORIGINS: "https://ops.example.com"});
    assert.equal((await h2(reqFrom("https://ops.example.com", f.url, {method: "OPTIONS"}))).headers.get(ACAO), "https://ops.example.com");
  });
}

test("api (/health) through the real shared helper: no ACAO for any origin, status unchanged", async () => {
  const h = load(SRC.api, {getAdminClient: () => { throw new Error("unused"); }}, ENV);
  for (const o of [APP_ORIGIN, "https://evil.example", null]) {
    const r = await h(reqFrom(o, "https://x.supabase.co/functions/v1/api/health"));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get(ACAO), null);
    const p = await h(reqFrom(o, "https://x.supabase.co/functions/v1/api/health", {method: "OPTIONS"}));
    assert.equal(p.status, 200);
    assert.equal(p.headers.get(ACAO), null);
  }
});
