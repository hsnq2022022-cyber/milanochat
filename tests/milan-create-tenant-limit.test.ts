// T5-S1: create_tenant is rate limited by the DB-backed limiter
// (public.milan_rate_limit_hit, migration 20261029250000) through the
// FAIL-CLOSED abuseGuards.rateGateStrict: 5 per 10 minutes AND 20 per 24 hours
// per hashed client IP, checked BEFORE any body use or the tenants insert.
// Limiter error / exception / malformed result => 503, never an in-memory
// fallback. index.ts cannot be imported under Node (Deno.serve), so the call
// order inside the create_tenant case is pinned at source level.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  rateGateStrict, createTenantRules, CREATE_TENANT_LIMITS, hashIp, RATE_LIMIT_RPC, type RpcClient,
} from "../supabase/functions/milan-api/abuseGuards.ts";

const IDX = readFileSync(process.env.MILAN_IDX ?? "supabase/functions/milan-api/index.ts", "utf8");
const CORS = {"Access-Control-Allow-Origin": "*"};
const SALT = "test-salt";
const IP = "203.0.113.77";
const hdr = (ip: string) => new Headers({"x-forwarded-for": `${ip}, 10.0.0.1`});

/** In-memory model of public.milan_rate_limit_hit (fixed window, every call counts). */
function fakeDb(now: () => number) {
  const rows = new Map<string, number>();
  const calls: Array<Record<string, unknown>> = [];
  const rpc: RpcClient = {
    rpc: async (fn, a) => {
      calls.push({fn, ...a});
      const w = Number(a.p_window_seconds) * 1000;
      const start = Math.floor(now() / w) * w;
      const k = `${a.p_key}|${start}`;
      const hits = (rows.get(k) ?? 0) + 1;
      rows.set(k, hits);
      return {data: {allowed: hits <= Number(a.p_limit), hits, retry_after: Math.ceil((start + w - now()) / 1000)}, error: null};
    },
  };
  return {rpc, calls, rows};
}

/** Mirrors the create_tenant case: limiter first, then (only if allowed) the insert. */
async function createTenant(rpc: RpcClient, headers: Headers, salt: string, insert: () => void) {
  const limited = await rateGateStrict({rpc, headers, salt, cors: CORS, rules: createTenantRules});
  if (limited) return limited;
  insert();
  return new Response(JSON.stringify({tenantId: "t", claimToken: "c"}), {status: 200});
}

async function captureWarn<T>(fn: () => Promise<T>): Promise<{out: T; logs: string}> {
  const orig = console.warn;
  const lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
  try { return {out: await fn(), logs: lines.join("\n")}; } finally { console.warn = orig; }
}

test("policy: 5 / 600 s and 20 / 86400 s on DISTINCT keys (windows align at UTC midnight)", () => {
  assert.deepEqual(CREATE_TENANT_LIMITS, {per10Min: 5, per24h: 20});
  const r = createTenantRules("h");
  assert.deepEqual(r.map((x) => [x.limit, x.windowSec]), [[5, 600], [20, 86400]]);
  assert.notEqual(r[0].key, r[1].key);
  for (const x of r) assert.ok(x.key.length <= 200);
});

test("below the limits: insert runs and the success response is unchanged", async () => {
  const t = Date.UTC(2026, 10, 16, 12, 0, 5);
  const db = fakeDb(() => t);
  let inserts = 0;
  for (let i = 0; i < 5; i++) {
    const res = await createTenant(db.rpc, hdr(IP), SALT, () => inserts++);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {tenantId: "t", claimToken: "c"});
  }
  assert.equal(inserts, 5);
  assert.ok(db.calls.every((c) => c.fn === RATE_LIMIT_RPC));
  assert.equal(db.calls.length, 10, "both windows are hit on every attempt");
});

test("the 6th attempt within 10 minutes gets 429 + Retry-After and no insert", async () => {
  const t = Date.UTC(2026, 10, 16, 12, 0, 5);
  const db = fakeDb(() => t);
  let inserts = 0;
  const st: number[] = [];
  let last: Response | null = null;
  for (let i = 0; i < 6; i++) { last = await captureWarn(() => createTenant(db.rpc, hdr(IP), SALT, () => inserts++)).then((x) => x.out); st.push(last.status); }
  assert.deepEqual(st, [200, 200, 200, 200, 200, 429]);
  assert.equal(inserts, 5);
  assert.ok(Number(last!.headers.get("Retry-After")) >= 1);
  const b = await last!.json();
  assert.equal(b.code, "RATE_LIMITED");
});

test("the 21st attempt within 24 hours gets 429 even with every 10-minute window fresh", async () => {
  let t = Date.UTC(2026, 10, 16, 0, 0, 5);
  const db = fakeDb(() => t);
  let inserts = 0;
  const st: number[] = [];
  for (let i = 0; i < 21; i++) {
    t = Date.UTC(2026, 10, 16, 0, 0, 5) + i * 11 * 60_000; // new 10-min window each time, same UTC day
    const r = await captureWarn(() => createTenant(db.rpc, hdr(IP), SALT, () => inserts++));
    st.push(r.out.status);
  }
  assert.deepEqual(st, [...Array(20).fill(200), 429]);
  assert.equal(inserts, 20);
});

test("rejected attempts still count (every attempt hits both windows)", async () => {
  const t = Date.UTC(2026, 10, 16, 12, 0, 5);
  const db = fakeDb(() => t);
  for (let i = 0; i < 8; i++) await captureWarn(() => createTenant(db.rpc, hdr(IP), SALT, () => {}));
  const counts = [...db.rows.values()].sort((a, b) => a - b);
  assert.deepEqual(counts, [8, 8]);
});

for (const [name, rpc] of [
  ["rpc error", {rpc: async () => ({data: null, error: {code: "PGRST202", message: "x"}})}],
  ["thrown exception", {rpc: async () => { throw new Error("network"); }}],
  ["null data", {rpc: async () => ({data: null, error: null})}],
  ["allowed not boolean", {rpc: async () => ({data: {allowed: "true", retry_after: 1}, error: null})}],
  ["non-object data", {rpc: async () => ({data: "ok", error: null})}],
  ["second window fails", (() => { let n = 0; return {rpc: async () => (++n % 2 === 0 ? {data: null, error: {message: "x"}} : {data: {allowed: true, hits: 1, retry_after: 1}, error: null})}; })()],
] as Array<[string, RpcClient]>) {
  test(`fail closed (${name}): 503 generic body, insert NEVER called, no in-memory fallback`, async () => {
    let inserts = 0;
    for (let i = 0; i < 3; i++) {
      const {out: res, logs} = await captureWarn(() => createTenant(rpc, hdr(IP), SALT, () => inserts++));
      assert.equal(res.status, 503);
      const b = await res.json();
      assert.equal(b.code, "SERVICE_UNAVAILABLE");
      assert.match(b.error, /الخدمة غير متاحة مؤقتًا/);
      assert.doesNotMatch(JSON.stringify(b), /PGRST|network|x"/);
      assert.match(logs, /limiter_fail_closed/);
      assert.doesNotMatch(logs, /fallback/);
    }
    assert.equal(inserts, 0);
  });
}

for (const [name, h, salt] of [
  ["missing IP", new Headers(), SALT],
  ["empty IP", new Headers({"x-forwarded-for": ""}), SALT],
  ["malformed IP", new Headers({"x-forwarded-for": "not an ip<script>"}), SALT],
  ["missing salt", hdr(IP), ""],
] as Array<[string, Headers, string]>) {
  test(`${name}: cannot bypass - shares one strict "unknown" bucket`, async () => {
    const t = Date.UTC(2026, 10, 16, 12, 0, 5);
    const db = fakeDb(() => t);
    const st: number[] = [];
    for (let i = 0; i < 6; i++) st.push((await captureWarn(() => createTenant(db.rpc, h, salt, () => {}))).out.status);
    assert.deepEqual(st, [200, 200, 200, 200, 200, 429]);
    const unknownHash = await hashIp("unknown", salt);
    assert.ok(db.calls.every((c) => String(c.p_key).endsWith(unknownHash)));
  });
}

test("unknown callers from different header shapes share ONE bucket", async () => {
  const t = Date.UTC(2026, 10, 16, 12, 0, 5);
  const db = fakeDb(() => t);
  const shapes = [new Headers(), new Headers({"x-forwarded-for": ""}), new Headers({"x-forwarded-for": "zz"}), new Headers({"cf-connecting-ip": "bad ip"}), new Headers(), new Headers()];
  const st: number[] = [];
  for (const h of shapes) st.push((await captureWarn(() => createTenant(db.rpc, h, SALT, () => {}))).out.status);
  assert.deepEqual(st, [200, 200, 200, 200, 200, 429]);
});

test("no raw IP in the RPC key or in logs", async () => {
  const t = Date.UTC(2026, 10, 16, 12, 0, 5);
  const db = fakeDb(() => t);
  let logs = "";
  for (let i = 0; i < 7; i++) logs += (await captureWarn(() => createTenant(db.rpc, hdr(IP), SALT, () => {}))).logs;
  const failing: RpcClient = {rpc: async () => { throw new Error("boom " + IP); }};
  logs += (await captureWarn(() => createTenant(failing, hdr(IP), SALT, () => {}))).logs;
  assert.match(logs, /create_tenant_ip_10m/);
  for (const c of db.calls) {
    assert.ok(!String(c.p_key).includes(IP));
    assert.ok(!String(c.p_key).includes(SALT));
    assert.match(String(c.p_key), /^ct:ipd?:[0-9a-f]{32}$/);
  }
  assert.ok(!logs.includes(IP) && !logs.includes(SALT) && !logs.includes("milan-rl:v1"));
  const h = await hashIp(IP.toLowerCase(), SALT);
  assert.ok(!logs.includes(h), "the IP hash is not logged either");
});

test("index.ts: create_tenant runs rateGateStrict(createTenantRules) FIRST, before body use and the insert", () => {
  const start = IDX.indexOf('case "create_tenant": {');
  assert.ok(start > 0);
  const end = IDX.indexOf("case \"pay_webhook\"", start);
  assert.ok(end > start);
  const blk = IDX.slice(start, end);
  const gate = blk.indexOf("await rateGateStrict({");
  const ret = blk.indexOf("if (ctLimited) return ctLimited;");
  const bodyUse = blk.search(/\bbody\b(?!\s*use)/);
  const insert = blk.indexOf('.from("tenants")');
  assert.ok(gate > 0, "limiter call present");
  assert.ok(/rateGateStrict\(\{\s*rpc: sb, headers: req\.headers, salt: env\("RATE_LIMIT_IP_SALT"\), cors: CORS,\s*rules: createTenantRules,\s*\}\)/.test(blk), "strict gate with createTenantRules + platform headers + salt");
  assert.ok(ret > gate, "early return on 429/503");
  assert.ok(insert > ret, "insert after the limiter");
  // first code statement of the case is the limiter (only comments before it)
  const before = blk.slice('case "create_tenant": {'.length, gate).replace(/\/\/.*$/gm, "").trim();
  assert.equal(before, "const ctLimited =");
  assert.ok(bodyUse === -1 || bodyUse > ret, "no body use before the limiter");
  assert.doesNotMatch(blk, /\brateGate\(/, "never the in-memory-fallback rateGate");
  assert.equal(IDX.split("rateGateStrict(").length - 1, 1, "only create_tenant uses the strict gate");
});
