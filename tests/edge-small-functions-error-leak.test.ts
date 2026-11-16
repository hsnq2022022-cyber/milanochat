// T5-S3: internal DB / PostgREST / exception text (message, details, hint,
// stack, relation / constraint names, row values such as tokens or phone
// numbers, file paths) never reaches a client response body or a log line in
// four small Edge functions:
//   supabase/functions/channels/index.ts
//   supabase/functions/agent-prompt/index.ts
//   supabase/functions/conversation-previews/index.ts
//   supabase/functions/api/index.ts   (/db-test)
// Statuses, response shapes / keys and intentional messages are unchanged.
// Behavioural: each REAL index.ts is type-stripped, its imports are replaced
// by fakes, and Deno.serve's handler is captured and driven with Requests
// against a fake Supabase client and a captured console. No Deno, no network,
// no database.
// Run: node --experimental-strip-types --test tests/edge-small-functions-error-leak.test.ts
// Mutation runs may point at a modified copy via CHANNELS_IDX / AGENT_PROMPT_IDX /
// PREVIEWS_IDX / API_IDX.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {inspect} from "node:util";
import {stripTypeScriptTypes} from "node:module";
// T5-D2: the REAL shared CORS helper (pure) backs the "../_shared/cors.ts" import.
import * as SHARED_CORS from "../supabase/functions/_shared/cors.ts";

const FN = "supabase/functions";
const SRC = {
  channels: readFileSync(process.env.CHANNELS_IDX ?? `${FN}/channels/index.ts`, "utf8"),
  agentPrompt: readFileSync(process.env.AGENT_PROMPT_IDX ?? `${FN}/agent-prompt/index.ts`, "utf8"),
  previews: readFileSync(process.env.PREVIEWS_IDX ?? `${FN}/conversation-previews/index.ts`, "utf8"),
  api: readFileSync(process.env.API_IDX ?? `${FN}/api/index.ts`, "utf8"),
};

// ---------------------------------------------------------------- canaries
const TOKEN = "tok_LEAKCANARY_access_9f8e7d";
const PHONE = "+966500000123";
const PATH = "/var/lib/postgresql/data/LEAKCANARY";
const DB_ERR = {
  message: `relation "channel_accounts" does not exist LEAKCANARY`,
  details: `Key (access_token_encrypted)=(${TOKEN}) already exists; phone ${PHONE}`,
  hint: `violates constraint "channel_accounts_lc_key" at ${PATH}`,
  code: "42P01",
};
const THROWN = Object.assign(
  new Error(`connect ECONNREFUSED LEAKCANARY ${TOKEN} ${PHONE} ${PATH} relation "tenants"`),
  {details: "LEAKCANARY details", hint: "LEAKCANARY hint"},
);
const CANARIES = ["LEAKCANARY", TOKEN, PHONE, PATH, "relation", "does not exist", "channel_accounts_lc_key",
  "access_token_encrypted", "violates", "ECONNREFUSED", "SUPABASE_SERVICE_ROLE_KEY", "Missing"];

function rendered(x: unknown) {
  let s = "";
  try { s += JSON.stringify(x); } catch { /* cyclic */ }
  s += "\n" + inspect(x, {depth: null, showHidden: true});
  if (x instanceof Error) s += "\n" + String(x) + "\n" + x.message + "\n" + (x.stack ?? "");
  return s;
}
function assertNoLeak(what: string, x: unknown) {
  const r = rendered(x);
  for (const s of CANARIES) assert.ok(!r.includes(s), what + ": never contains " + s);
}

// ---------------------------------------------------------------- fakes
type Q = {table: string; op: string; filters: [string, unknown][]; payload?: unknown};
type Resolver = (q: Q) => {data?: unknown; error?: unknown} | Promise<never>;

function fakeClient(opts: {resolve?: Resolver; getUser?: (t: string) => unknown}) {
  const resolve = opts.resolve ?? (() => ({data: null, error: null}));
  const builder = (table: string) => {
    const q: Q = {table, op: "select", filters: []};
    const run = () => Promise.resolve().then(() => {
      const r = resolve(q) as {data?: unknown; error?: unknown};
      return {data: r?.data ?? null, error: r?.error ?? null};
    });
    const b: any = {
      select() { return b; },
      update(p: unknown) { q.op = "update"; q.payload = p; return b; },
      insert(p: unknown) { q.op = "insert"; q.payload = p; return b; },
      eq(k: string, v: unknown) { q.filters.push([k, v]); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { q.op = q.op === "select" ? "select1" : q.op; return run(); },
      then(ok: any, ko: any) { return run().then(ok, ko); },
    };
    return b;
  };
  return {
    from: builder,
    auth: {
      getUser: async (t: string) =>
        opts.getUser ? opts.getUser(t) : t === "good" ? {data: {user: {id: "u1"}}, error: null}
          : {data: {user: null}, error: {message: "LEAKCANARY bad jwt"}},
    },
  };
}

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
  const Deno = {
    serve: (h: any) => { handler = h; },
    env: {get: (k: string) => env[k]},
  };
  new Function("Deno", "__imports", "console", js)(Deno, {...SHARED_CORS, ...imports}, cons);
  assert.ok(handler, "Deno.serve handler captured");
  return {handler: handler as unknown as (r: Request) => Promise<Response>, logs};
}

async function call(h: (r: Request) => Promise<Response>, url: string, init: RequestInit & {token?: string} = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const res = await h(new Request(url, {...init, headers}));
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* text */ }
  return {status: res.status, body, text};
}

const ENV = {SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "srk"};
const TENANT = {id: "t1", user_id: "u1", agent_system_prompt: "hi"};
const DB_MSG = "تعذر إتمام العملية — حاول مرة أخرى";
const INTERNAL_AR = "خطأ داخلي";

function assertLogsSafe(logs: Log[]) {
  assertNoLeak("logs", logs);
  for (const [, args] of logs) for (const a of args) {
    if (a && typeof a === "object") {
      for (const k of Object.keys(a)) assert.ok(["tag", "code"].includes(k), "log object keys only tag/code: " + k);
      const code = (a as any).code;
      if (code !== undefined) assert.match(String(code), /^(?:[0-9A-Z]{5}|PGRST\d{3}|unknown)$/);
    } else {
      assert.equal(typeof a, "string");
    }
  }
}
function hasLog(logs: Log[], tag: string | undefined, code: string) {
  return logs.some(([, a]) => a.some((x: any) => x && typeof x === "object" && x.code === code && (tag === undefined || x.tag === tag)));
}

// ================================================================ channels
function channels(resolve: Resolver, opts: {getUser?: (t: string) => unknown; env?: Record<string, string | undefined>} = {}) {
  const client = fakeClient({resolve, getUser: opts.getUser});
  return load(SRC.channels, {
    createClient: () => client,
    issueOAuthState: async () => ({ok: false, code: "no_tenant"}),
    oauthStateSecret: () => "s",
  }, opts.env ?? ENV);
}
const CH = "https://x.supabase.co/functions/v1/channels";
const chResolve = (over: Partial<Record<string, any>>): Resolver => (q) => {
  if (q.table === "tenants") return {data: TENANT};
  const k = `${q.table}:${q.op}`;
  if (k in over) return over[k];
  return {data: null};
};

test("channels PATCH /accounts/:id DB error -> 500 fixed Arabic, coarse log", async () => {
  const {handler, logs} = channels(chResolve({"channel_accounts:update": {error: DB_ERR}}));
  const r = await call(handler, `${CH}/accounts/a1`, {method: "PATCH", token: "good", body: JSON.stringify({auto_reply: false})});
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, {error: DB_MSG});
  assertNoLeak("response", r.text);
  assertLogsSafe(logs);
  assert.ok(hasLog(logs, "account_update", "42P01"));
});

test("channels DELETE /accounts/:id DB error -> 500 fixed Arabic, coarse log", async () => {
  const {handler, logs} = channels(chResolve({"channel_accounts:update": {error: DB_ERR}}));
  const r = await call(handler, `${CH}/accounts/a1`, {method: "DELETE", token: "good"});
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, {error: DB_MSG});
  assertNoLeak("response", r.text);
  assertLogsSafe(logs);
  assert.ok(hasLog(logs, "account_delete", "42P01"));
});

test("channels GET /accounts DB error -> 200 [] (unchanged), log has no error text", async () => {
  const {handler, logs} = channels(chResolve({"channel_accounts:select": {error: DB_ERR}}));
  const r = await call(handler, `${CH}/accounts`, {token: "good"});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
  assertLogsSafe(logs);
  assert.ok(hasLog(logs, "accounts_select", "42P01"));
});

test("channels thrown exception / missing config -> 500 { error: 'خطأ داخلي' }", async () => {
  {
    const {handler, logs} = channels(() => { throw THROWN; });
    const r = await call(handler, `${CH}/accounts`, {token: "good"});
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, {error: INTERNAL_AR});
    assertNoLeak("response", r.text);
    assertLogsSafe(logs);
  }
  {
    const {handler, logs} = channels(() => ({data: null}), {getUser: () => { throw THROWN; }});
    const r = await call(handler, `${CH}/summary`, {token: "good"});
    assert.deepEqual([r.status, r.body], [500, {error: INTERNAL_AR}]);
    assertLogsSafe(logs);
  }
  {
    // getAdmin() throws "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    const {handler, logs} = channels(() => ({data: null}), {env: {}});
    const r = await call(handler, `${CH}/accounts`, {token: "good"});
    assert.deepEqual([r.status, r.body], [500, {error: INTERNAL_AR}]);
    assertNoLeak("response", r.text);
    assertLogsSafe(logs);
  }
});

test("channels intentional messages, statuses and shapes are preserved", async () => {
  const {handler} = channels(chResolve({}));
  assert.deepEqual(await call(handler, `${CH}/accounts`).then((r) => [r.status, r.body]), [401, {error: "غير مصرح"}]);
  assert.deepEqual(await call(handler, `${CH}/accounts`, {token: "bad"}).then((r) => [r.status, r.body]), [401, {error: "جلسة غير صالحة"}]);
  const p = (b: unknown) => call(handler, `${CH}/accounts/a1`, {method: "PATCH", token: "good", body: JSON.stringify(b)}).then((r) => [r.status, r.body]);
  assert.deepEqual(await p({status: "weird"}), [400, {error: "حالة غير صالحة"}]);
  assert.deepEqual(await p({}), [400, {error: "لا توجد حقول للتعديل"}]);
  assert.deepEqual(await p({auto_reply: true}), [404, {error: "الحساب غير موجود"}]);
  assert.deepEqual(await call(handler, `${CH}/nope`, {token: "good"}).then((r) => [r.status, r.body]), [404, {error: "Not found", path: ["nope"]}]);

  const noTenant = channels((q) => ({data: q.table === "tenants" ? null : []})).handler;
  assert.deepEqual(await call(noTenant, `${CH}/accounts`, {token: "good"}).then((r) => [r.status, r.body]), [404, {error: "لا يوجد حساب مرتبط"}]);

  const ok = channels(chResolve({
    "channel_accounts:update": {data: {id: "a1", tenant_id: "t1", channel: "instagram", auto_reply: false}},
  })).handler;
  const u = await call(ok, `${CH}/accounts/a1`, {method: "PATCH", token: "good", body: JSON.stringify({auto_reply: false})});
  assert.equal(u.status, 200);
  assert.equal(u.body.id, "a1");
  assert.equal(u.body.autoReply, false);
  const d = await call(ok, `${CH}/accounts/a1`, {method: "DELETE", token: "good"});
  assert.deepEqual([d.status, d.body], [200, {ok: true}]);
  const st = await call(ok, `${CH}/meta/status`);
  assert.equal(st.status, 200);
  assert.deepEqual(Object.keys(st.body).sort(), ["appReviewNote", "channels", "configured", "developersUrl"]);
});

// ================================================================ agent-prompt
function agentPrompt(resolve: Resolver, opts: {getUser?: (t: string) => unknown; env?: Record<string, string | undefined>} = {}) {
  const client = fakeClient({resolve, getUser: opts.getUser});
  return load(SRC.agentPrompt, {createClient: () => client}, opts.env ?? ENV);
}
const AP = "https://x.supabase.co/functions/v1/agent-prompt";

test("agent-prompt POST DB error -> 500 fixed Arabic, coarse log", async () => {
  const {handler, logs} = agentPrompt((q) => q.op === "update" ? {error: DB_ERR} : {data: TENANT});
  const r = await call(handler, AP, {method: "POST", token: "good", body: JSON.stringify({prompt: "x"})});
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, {error: DB_MSG});
  assertNoLeak("response", r.text);
  assertLogsSafe(logs);
  assert.ok(hasLog(logs, "prompt_update", "42P01"));
});

test("agent-prompt thrown exception -> 500 { error: 'خطأ داخلي' }", async () => {
  const {handler, logs} = agentPrompt(() => ({data: TENANT}), {getUser: () => { throw THROWN; }});
  const r = await call(handler, AP, {token: "good"});
  assert.deepEqual([r.status, r.body], [500, {error: INTERNAL_AR}]);
  assertNoLeak("response", r.text);
  assertLogsSafe(logs);
  const t = agentPrompt(() => { throw THROWN; });
  const r2 = await call(t.handler, AP, {token: "good"});
  assert.deepEqual([r2.status, r2.body], [500, {error: INTERNAL_AR}]);
  assertLogsSafe(t.logs);
});

test("agent-prompt intentional messages, statuses and shapes are preserved", async () => {
  const {handler} = agentPrompt(() => ({data: TENANT}));
  const s = (r: {status: number; body: unknown}) => [r.status, r.body];
  assert.deepEqual(s(await call(handler, AP)), [401, {error: "غير مصرح"}]);
  assert.deepEqual(s(await call(handler, AP, {token: "bad"})), [401, {error: "جلسة غير صالحة"}]);
  assert.deepEqual(s(await call(handler, AP, {token: "good"})), [200, {prompt: "hi"}]);
  assert.deepEqual(s(await call(handler, AP, {method: "POST", token: "good", body: JSON.stringify({prompt: 1})})), [400, {error: "prompt يجب أن يكون نصًا"}]);
  assert.deepEqual(s(await call(handler, AP, {method: "POST", token: "good", body: JSON.stringify({prompt: "x".repeat(8001)})})), [400, {error: "prompt يتجاوز الحد الأقصى (8000 حرف)"}]);
  assert.deepEqual(s(await call(handler, AP, {method: "POST", token: "good", body: JSON.stringify({prompt: "ok"})})), [200, {ok: true}]);
  assert.deepEqual(s(await call(handler, AP, {method: "PUT", token: "good"})), [405, {error: "Method not allowed"}]);
  const nt = agentPrompt(() => ({data: null})).handler;
  assert.deepEqual(s(await call(nt, AP, {token: "good"})), [404, {error: "لا يوجد حساب مرتبط"}]);
  const ne = agentPrompt(() => ({data: TENANT}), {env: {}}).handler;
  assert.deepEqual(s(await call(ne, AP, {token: "good"})), [500, {error: "إعدادات الخادم ناقصة"}]);
});

// ================================================================ conversation-previews
function previews(resolve: Resolver, opts: {getUser?: (t: string) => unknown; env?: Record<string, string | undefined>} = {}) {
  const client = fakeClient({resolve, getUser: opts.getUser});
  return load(SRC.previews, {createClient: () => client}, opts.env ?? ENV);
}
const PV = "https://x.supabase.co/functions/v1/conversation-previews";

test("conversation-previews conversations DB error -> 500 fixed text, coarse log", async () => {
  const {handler, logs} = previews((q) => q.table === "conversations" ? {error: DB_ERR} : {data: TENANT});
  const r = await call(handler, PV, {method: "POST", token: "good", body: "{}"});
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, {error: "internal error"});
  assertNoLeak("response", r.text);
  assertLogsSafe(logs);
  assert.ok(hasLog(logs, "conversations_select", "42P01"));
});

test("conversation-previews thrown exception -> 500 { error: 'internal error' }", async () => {
  const {handler, logs} = previews(() => ({data: TENANT}), {getUser: () => { throw THROWN; }});
  const r = await call(handler, PV, {method: "POST", token: "good", body: "{}"});
  assert.deepEqual([r.status, r.body], [500, {error: "internal error"}]);
  assertNoLeak("response", r.text);
  assertLogsSafe(logs);
});

test("conversation-previews intentional messages, statuses and shapes are preserved", async () => {
  const s = (r: {status: number; body: unknown}) => [r.status, r.body];
  const {handler, logs} = previews((q) => {
    if (q.table === "tenants") return {data: TENANT};
    if (q.table === "conversations") return {data: [{id: "c1"}, {id: "c2"}, {id: "c3"}]};
    const conv = q.filters.find(([k]) => k === "conversation_id")?.[1];
    if (conv === "c1") return {data: {body_encrypted: "hello"}};
    if (conv === "c2") throw THROWN; // per-conversation failure -> skipped silently
    return {data: null};
  });
  assert.deepEqual(s(await call(handler, PV, {method: "POST", token: "good", body: "{}"})), [200, {previews: {c1: "hello"}}]);
  assertLogsSafe(logs);
  assert.deepEqual(s(await call(handler, PV, {method: "POST", body: "{}"})), [401, {error: "unauthorized"}]);
  assert.deepEqual(s(await call(handler, PV, {method: "POST", token: "bad", body: "{}"})), [401, {error: "invalid session"}]);
  const nt = previews(() => ({data: null})).handler;
  assert.deepEqual(s(await call(nt, PV, {method: "POST", token: "good", body: "{}"})), [404, {error: "no linked account"}]);
  const ne = previews(() => ({data: null}), {env: {}}).handler;
  assert.deepEqual(s(await call(ne, PV, {method: "POST", token: "good", body: "{}"})), [500, {error: "server config missing"}]);
});

// ================================================================ api /db-test
function api(getAdminClient: () => unknown) {
  return load(SRC.api, {
    corsHeaders: {"Access-Control-Allow-Origin": "*"},
    handleCors: (req: Request) => req.method === "OPTIONS" ? new Response("ok") : null,
    getAdminClient,
  }, {...ENV, API_DB_TEST_SECRET: DBT_SECRET});
}
const API = "https://x.supabase.co/functions/v1/api";
// /db-test is operator-only (see tests/api-db-test-auth.test.ts); fake per-run value.
const DBT_SECRET = `fake-${crypto.randomUUID()}`;

test("api /db-test DB error -> 500 generic body, same keys, coarse log", async () => {
  const {handler, logs} = api(() => fakeClient({resolve: () => ({error: DB_ERR})}));
  const r = await call(handler, `${API}/db-test`, {token: DBT_SECRET});
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, {ok: false, database: false, error: "Database test failed"});
  assertNoLeak("response", r.text);
  assertLogsSafe(logs);
  assert.ok(hasLog(logs, undefined, "42P01"));
});

test("api /db-test thrown exception (e.g. missing env) -> 500 generic body", async () => {
  for (const thrown of [THROWN, new Error("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY")]) {
    const {handler, logs} = api(() => { throw thrown; });
    const r = await call(handler, `${API}/db-test`, {token: DBT_SECRET});
    assert.deepEqual([r.status, r.body], [500, {ok: false, database: false, error: "Database test failed"}]);
    assertNoLeak("response", r.text);
    assertLogsSafe(logs);
  }
});

test("api /db-test success exposes only {ok, database, rows}; /health and 404 unchanged", async () => {
  const {handler} = api(() => fakeClient({resolve: () => ({data: [{id: "acc-secret-id"}]})}));
  const r = await call(handler, `${API}/db-test`, {token: DBT_SECRET});
  assert.deepEqual([r.status, r.body], [200, {ok: true, database: true, rows: 1}]);
  assert.ok(!r.text.includes("acc-secret-id"));
  const h = await call(handler, `${API}/health`);
  assert.equal(h.status, 200);
  assert.deepEqual(Object.keys(h.body).sort(), ["ok", "service", "timestamp"]);
  assert.deepEqual(await call(handler, `${API}/x`).then((x) => [x.status, x.body]), [404, {error: "Not found"}]);
});

// ================================================================ source guard
// No error message / details / hint / stack is read anywhere in the four files,
// and no console call receives a raw error object. Allow-list (exact, justified):
//  - channels: `{ code: error.code ?? "unknown" }` in the oauth-state store log
//    (pre-existing S5 code; PostgREST code only, no message).
const ALLOW = new Set(['console.error("[channels] oauth state store failed", { code: error.code ?? "unknown" })']);
for (const [name, src] of Object.entries(SRC)) {
  test(`source guard: ${name} never forwards error text`, () => {
    assert.ok(!/\.\s*(?:message|details|hint|stack)\b/.test(src), `${name}: no .message/.details/.hint/.stack access`);
    const calls = src.match(/console\.\w+\((?:[^()]|\([^()]*\))*\)/g) ?? [];
    for (const raw of calls) {
      if (ALLOW.has(raw)) continue;
      const c = raw.replace(/\bsafeErrCode\(\s*(?:e|err|error|convErr)\s*\)/g, "SAFE");
      assert.ok(!/[(,]\s*(?:e|err|error|convErr|userErr)\s*[,)]/.test(c), `${name}: raw error object logged: ${c}`);
      assert.ok(!/\b(?:e|err|error|convErr|userErr)\s*\./.test(c), `${name}: error property logged: ${c}`);
    }
    // Every `error:` value in a response body is a string literal / template or an UPPER_CASE constant.
    // (`{ data, error: userErr } = await ...` destructuring is not a response and is skipped.)
    let n = 0;
    for (const m of src.matchAll(/\berror:\s*("[^"]*"|`[^`]*`|[^,}\n]+)(\s*\}\s*=)?/g)) {
      if (m[2]) continue;
      if (/^unknown$|^unknown\)/.test(m[1].trim())) continue; // `(error: unknown, ...)` parameter type
      n++;
      assert.match(m[1].trim(), /^(?:"[^"]*"|`[^`]*`|[A-Z][A-Z0-9_]*)$/, `${name}: unsafe error value: ${m[0]}`);
    }
    assert.ok(n > 0, `${name}: located response error values`);
  });
}
