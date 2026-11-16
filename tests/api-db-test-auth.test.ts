// T5-S3 follow-up: /db-test of supabase/functions/api/index.ts is operator-only.
//   - credential: `Authorization: Bearer <API_DB_TEST_SECRET>` (env secret NAME only;
//     no value is ever hardcoded — tests use a fresh fake value per run)
//   - SHA-256 digests of both values compared in constant time
//   - fail closed: unset / empty secret never grants access
//   - every rejection: identical generic 401 {"error":"Unauthorized"}, before any
//     database client is created or queried; credential / secret never logged
//   - authorized: unchanged contract {ok, database, rows} and generic 500 on failure
// Behavioural: the REAL index.ts is type-stripped, imports are replaced by fakes,
// and Deno.serve's handler is captured. No Deno, no network, no database.
// Run: node --experimental-strip-types --test tests/api-db-test-auth.test.ts
// Mutation runs may point at a modified copy via API_IDX.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {inspect} from "node:util";
import {stripTypeScriptTypes} from "node:module";

const API_PATH = process.env.API_IDX ?? "supabase/functions/api/index.ts";
const SRC = readFileSync(API_PATH, "utf8");
const SELF = readFileSync(new URL(import.meta.url), "utf8");
const API = "https://x.supabase.co/functions/v1/api";
const UNAUTH_TEXT = JSON.stringify({error: "Unauthorized"});

// Fake, per-run values. Never real-looking secrets.
const fake = () => `fake-${crypto.randomUUID()}`;

type Log = [string, unknown[]];
type Counters = {admin: number; from: number; select: number};

function fakeClient(c: Counters, result: () => {data?: unknown; error?: unknown}) {
  return {
    from(_t: string) {
      c.from++;
      const b: any = {
        select() { c.select++; return b; },
        limit() { return b; },
        then(ok: any, ko: any) {
          return Promise.resolve().then(() => {
            const r = result();
            return {data: r.data ?? null, error: r.error ?? null};
          }).then(ok, ko);
        },
      };
      return b;
    },
  };
}

function load(env: Record<string, string | undefined>,
  opts: {result?: () => {data?: unknown; error?: unknown}; throwOnAdmin?: unknown} = {}) {
  const counters: Counters = {admin: 0, from: 0, select: 0};
  const getAdminClient = () => {
    counters.admin++;
    if (opts.throwOnAdmin) throw opts.throwOnAdmin;
    return fakeClient(counters, opts.result ?? (() => ({data: [{id: "row-1"}]})));
  };
  const imports = {
    corsHeaders: {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"},
    handleCors: (req: Request) => req.method === "OPTIONS" ? new Response("ok", {status: 200}) : null,
    getAdminClient,
  };
  let js = stripTypeScriptTypes(SRC, {mode: "strip"});
  js = js.replace(/^\s*import\s*\{([^}]*)\}\s*from\s*["'][^"']+["'];?/gm,
    (_m, names: string) => `const {${names}} = __imports;`);
  assert.ok(!/^\s*import\b/m.test(js), "all imports replaced");
  const logs: Log[] = [];
  const cons: any = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) cons[k] = (...a: unknown[]) => logs.push([k, a]);
  let handler: ((r: Request) => Promise<Response>) | null = null;
  const Deno = {serve: (h: any) => { handler = h; }, env: {get: (k: string) => env[k]}};
  new Function("Deno", "__imports", "console", js)(Deno, imports, cons);
  assert.ok(handler, "Deno.serve handler captured");
  return {handler: handler as unknown as (r: Request) => Promise<Response>, logs, counters};
}

async function call(h: (r: Request) => Promise<Response>, path: string, authorization?: string, method = "GET") {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  const res = await h(new Request(API + path, {method, headers}));
  const text = await res.text();
  const hdrs = [...res.headers.entries()].sort().map(([k, v]) => `${k}:${v}`).join("\n");
  return {status: res.status, text, hdrs};
}

function rendered(x: unknown) {
  let s = "";
  try { s += JSON.stringify(x); } catch { /* cyclic */ }
  return s + "\n" + inspect(x, {depth: null, showHidden: true});
}

// Every way to be rejected while a secret IS configured.
function rejectedHeaders(secret: string): [string, string | undefined][] {
  const other = fake();
  return [
    ["missing header", undefined],
    ["empty header", ""],
    ["scheme only", "Bearer"],
    ["empty bearer", "Bearer "],
    ["whitespace bearer", "Bearer    "],
    ["basic scheme", `Basic ${secret}`],
    ["lowercase scheme", `bearer ${secret}`],
    ["token scheme", `Token ${secret}`],
    ["raw secret, no scheme", secret],
    ["no space", `Bearer${secret}`],
    ["double space", `Bearer  ${secret}`],
    ["wrong secret", `Bearer ${other}`],
    ["secret prefix", `Bearer ${secret.slice(0, -1)}`],
    ["secret + suffix", `Bearer ${secret}x`],
    ["secret upper-cased", `Bearer ${secret.toUpperCase()}`],
    ["secret twice", `Bearer ${secret} ${secret}`],
    ["oversized header", `Bearer ${secret}` + "a".repeat(9000)],
  ];
}

const REFERENCE = {status: 0, text: "", hdrs: ""};
async function reference() {
  if (!REFERENCE.status) {
    const {handler} = load({API_DB_TEST_SECRET: fake()});
    Object.assign(REFERENCE, await call(handler, "/db-test"));
  }
  return REFERENCE;
}

function assertUnauthorized(what: string, r: {status: number; text: string; hdrs: string}, ref: typeof REFERENCE,
  counters: Counters, logs: Log[], forbidden: string[]) {
  assert.equal(r.status, 401, what + ": 401");
  assert.equal(r.text, UNAUTH_TEXT, what + ": fixed generic body");
  assert.equal(r.text, ref.text, what + ": body byte-identical");
  assert.equal(r.hdrs, ref.hdrs, what + ": headers identical");
  assert.deepEqual(counters, {admin: 0, from: 0, select: 0}, what + ": no DB client / query");
  const out = r.text + r.hdrs + rendered(logs);
  for (const s of forbidden) if (s.length >= 4) assert.ok(!out.includes(s), what + ": no secret/credential in output");
  for (const [, args] of logs) for (const a of args) assert.equal(typeof a, "string", what + ": only fixed string logs");
}

test("configured secret: missing / malformed / empty / wrong credentials -> identical 401, DB never touched", async () => {
  const ref = await reference();
  const secret = fake();
  for (const [what, auth] of rejectedHeaders(secret)) {
    const {handler, logs, counters} = load({API_DB_TEST_SECRET: secret});
    const r = await call(handler, "/db-test", auth);
    assertUnauthorized(what, r, ref, counters, logs, [secret, auth ?? "", (auth ?? "").replace(/^\S+\s*/, "")]);
  }
});

test("fail closed: unset or empty API_DB_TEST_SECRET rejects every request identically", async () => {
  const ref = await reference();
  const anyValue = fake();
  const auths = [undefined, "", "Bearer", "Bearer ", `Bearer ${anyValue}`, "Bearer undefined", "Bearer null"];
  for (const env of [{}, {API_DB_TEST_SECRET: undefined}, {API_DB_TEST_SECRET: ""}] as Record<string, string | undefined>[]) {
    for (const auth of auths) {
      const {handler, logs, counters} = load(env);
      const r = await call(handler, "/db-test", auth);
      assertUnauthorized(`env=${JSON.stringify(env)} auth=${JSON.stringify(auth)}`, r, ref, counters, logs,
        [anyValue]);
    }
  }
});

test("correct secret -> unchanged success contract {ok, database, rows}", async () => {
  for (const [data, rows] of [[[{id: "row-1"}], 1], [[], 0], [null, 0]] as const) {
    const secret = fake();
    const {handler, logs, counters} = load({API_DB_TEST_SECRET: secret}, {result: () => ({data})});
    const r = await call(handler, "/db-test", `Bearer ${secret}`);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), {ok: true, database: true, rows});
    assert.deepEqual(Object.keys(JSON.parse(r.text)), ["ok", "database", "rows"]);
    assert.deepEqual(counters, {admin: 1, from: 1, select: 1});
    assert.ok(!r.text.includes(secret) && !rendered(logs).includes(secret));
    assert.ok(!r.text.includes("row-1"));
  }
  // POST is served the same as before (route has no method restriction).
  const secret = fake();
  const {handler} = load({API_DB_TEST_SECRET: secret});
  const r = await call(handler, "/db-test", `Bearer ${secret}`, "POST");
  assert.deepEqual([r.status, JSON.parse(r.text)], [200, {ok: true, database: true, rows: 1}]);
});

test("authorized query failure / thrown exception -> unchanged generic 500", async () => {
  const secret = fake();
  const generic = {ok: false, database: false, error: "Database test failed"};
  const a = load({API_DB_TEST_SECRET: secret}, {result: () => ({error: {message: "LEAKCANARY", code: "42P01"}})});
  const r1 = await call(a.handler, "/db-test", `Bearer ${secret}`);
  assert.deepEqual([r1.status, JSON.parse(r1.text)], [500, generic]);
  assert.deepEqual(a.counters, {admin: 1, from: 1, select: 1});
  const b = load({API_DB_TEST_SECRET: secret}, {throwOnAdmin: new Error("LEAKCANARY boom")});
  const r2 = await call(b.handler, "/db-test", `Bearer ${secret}`);
  assert.deepEqual([r2.status, JSON.parse(r2.text)], [500, generic]);
  for (const x of [r1.text, r2.text, rendered(a.logs), rendered(b.logs)]) {
    assert.ok(!x.includes("LEAKCANARY") && !x.includes(secret));
  }
});

test("OPTIONS preflight, /health and 404 are unchanged and need no credential", async () => {
  const {handler, counters} = load({});
  const o = await call(handler, "/db-test", undefined, "OPTIONS");
  assert.deepEqual([o.status, o.text], [200, "ok"]);
  const h = await call(handler, "/health");
  assert.equal(h.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(h.text)).sort(), ["ok", "service", "timestamp"]);
  const n = await call(handler, "/nope");
  assert.deepEqual([n.status, JSON.parse(n.text)], [404, {error: "Not found"}]);
  assert.deepEqual(counters, {admin: 0, from: 0, select: 0});
});

// ---------------------------------------------------------------- source guards
test("source guard: auth check precedes any DB call in the /db-test branch", () => {
  const branch = SRC.slice(SRC.indexOf('url.pathname.endsWith("/db-test")'));
  assert.ok(branch.length > 0 && SRC.includes('url.pathname.endsWith("/db-test")'));
  const auth = branch.indexOf("isDbTestAuthorized(req)");
  const admin = branch.indexOf("getAdminClient(");
  const from = branch.indexOf(".from(");
  assert.ok(auth > 0, "auth check present in branch");
  assert.ok(admin > auth && from > auth, "auth check before getAdminClient/.from");
  assert.match(branch.slice(auth - 40, auth + 120), /if\s*\(\s*!\s*\(\s*await\s+isDbTestAuthorized\(req\)\s*\)\s*\)\s*\{[\s\S]*?return dbTestUnauthorized\(\);/);
});

test("source guard: env secret read by name only, constant-time digest compare, fail closed", () => {
  assert.match(SRC, /Deno\.env\.get\("API_DB_TEST_SECRET"\)\s*\?\?\s*""/);
  assert.match(SRC, /crypto\.subtle\.digest\("SHA-256"/);
  const fn = SRC.slice(SRC.indexOf("function isDbTestAuthorized"), SRC.indexOf("function dbTestUnauthorized"));
  const cmp = SRC.slice(SRC.indexOf("function digestsEqual"), SRC.indexOf("async function isDbTestAuthorized"));
  assert.ok(fn.length > 0 && cmp.length > 0, "helpers located");
  // No direct string comparison of credential/secret values (=== / !== / startsWith on the secret).
  assert.ok(!/(?:presented|secret|header)\s*[!=]==?\s*(?:presented|secret|"Bearer )/.test(fn), "no direct value compare");
  assert.ok(!/(?:presented|secret)\s*\.\s*(?:startsWith|endsWith|includes|localeCompare)\(/.test(fn), "no partial compare");
  assert.match(fn, /digestsEqual\(\s*expectedDigest\s*,\s*presentedDigest\s*\)/);
  // Constant-time: accumulate XOR, no early exit inside the compare.
  assert.match(cmp, /diff\s*\|=/);
  assert.ok(!/\b(?:break|return\s+false)\b/.test(cmp) && !/[!=]==/.test(cmp.replace(/return diff === 0;/, "")),
    "no early-exit / per-byte equality in compare");
  // Fail closed: the boolean requires a non-empty configured secret.
  assert.match(fn, /return\s+secret\.length\s*>\s*0\s*&&\s*presented\.length\s*>\s*0\s*&&\s*wellFormed\s*&&\s*match\s*;/);
  assert.match(fn, /catch\s*\{\s*return false;\s*\}/);
});

test("source guard: single fixed unauthorized body; nothing credential-bearing logged; no literal secrets", () => {
  assert.equal((SRC.match(/status:\s*401/g) ?? []).length, 1, "exactly one 401 response");
  assert.match(SRC, /const DB_TEST_UNAUTHORIZED_BODY = JSON\.stringify\(\{ error: "Unauthorized" \}\);/);
  for (const c of SRC.match(/console\.\w+\((?:[^()]|\([^()]*\))*\)/g) ?? []) {
    assert.ok(!/\b(?:secret|presented|header|authorization|req)\b/i.test(c.replace(/^console\.\w+\("[^"]*"/, "")),
      "log never receives credential material: " + c);
  }
  // This test file itself only uses per-run fake values (fake-<uuid>).
  assert.ok(!/API_DB_TEST_SECRET:\s*["'`][^"'`]/.test(SELF), "test never hardcodes a non-empty secret value");
  // The only value bound to the secret name is the env read; no `"Bearer <literal>"` either.
  assert.ok(!/API_DB_TEST_SECRET\s*[:=]\s*["'`]/.test(SRC), "no inline secret assignment");
  assert.ok(!/["'`]Bearer [^"'`$]/.test(SRC), "no hardcoded bearer value");
});
