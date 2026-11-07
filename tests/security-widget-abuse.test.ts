// S3 / S4: rate limits for the public widget and the claim-token AI actions
// (supabase/functions/milan-api/abuseGuards.ts) and their placement in
// milan-api/index.ts (BEFORE any LLM / embedding / URL fetch / heavy write).
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  createLimiter, checkRules, rateGate, clientIp, hashIp, memoryHit, fallbackLimit,
  widgetIpRules, widgetScopeRules, aiActionRules, knowledgeAddRules, CLAIM_AI_ACTIONS,
  WIDGET_LIMITS, type RpcClient, type MemoryStore,
} from "../supabase/functions/milan-api/abuseGuards.ts";

/** In-memory model of public.milan_rate_limit_hit (fixed window, atomic). */
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
const failingRpc: RpcClient = {rpc: async () => ({data: null, error: {code: "PGRST202", message: "x"}})};
const throwingRpc: RpcClient = {rpc: async () => { throw new Error("network"); }};
const hdr = (ip: string) => new Headers({"x-forwarded-for": `${ip}, 10.0.0.1`});
const CORS = {"Access-Control-Allow-Origin": "*"};

test("widget: the 11th message in a minute from one IP gets 429 + Retry-After (DB limiter)", async () => {
  let t = Date.UTC(2026, 10, 7, 12, 0, 5);
  const db = fakeDb(() => t);
  const statuses: number[] = [];
  let last: Response | null = null;
  for (let i = 0; i < 11; i++) {
    last = await rateGate({rpc: db.rpc, headers: hdr("203.0.113.7"), salt: "s", cors: CORS, rules: widgetIpRules, now: () => t, store: new Map()});
    statuses.push(last ? last.status : 200);
  }
  assert.deepEqual(statuses, [...Array(10).fill(200), 429]);
  assert.equal(last!.headers.get("Retry-After"), "55");
  assert.equal(last!.headers.get("Access-Control-Allow-Origin"), "*");
  const body = await last!.json();
  assert.equal(body.code, "RATE_LIMITED");
  // the raw IP never reaches the DB
  for (const c of db.calls) assert.doesNotMatch(String(c.p_key), /203\.0\.113\.7/);
  // another IP is independent; next window resets
  assert.equal(await rateGate({rpc: db.rpc, headers: hdr("198.51.100.1"), salt: "s", cors: CORS, rules: widgetIpRules, store: new Map()}), null);
  t += 60_000;
  assert.equal(await rateGate({rpc: db.rpc, headers: hdr("203.0.113.7"), salt: "s", cors: CORS, rules: widgetIpRules, now: () => t, store: new Map()}), null);
});

test("widget: per-session and per-tenant caps", async () => {
  const t = Date.UTC(2026, 10, 7, 12, 0, 0);
  const db = fakeDb(() => t);
  const lim = createLimiter({rpc: db.rpc, now: () => t, store: new Map()});
  const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let blocked: any = null;
  let n = 0;
  while (!blocked && n < 1000) { blocked = await checkRules(lim, widgetScopeRules(T, "session-1")); n++; }
  assert.equal(n, WIDGET_LIMITS.sessionPerHour + 1);
  assert.equal(blocked.code, "widget_session");
  // many sessions of one tenant hit the tenant cap
  blocked = null; n = 0;
  while (!blocked && n < 1000) { blocked = await checkRules(lim, widgetScopeRules(T, `s-${n}`)); n++; }
  assert.equal(blocked.code, "widget_tenant");
  assert.equal(n, WIDGET_LIMITS.tenantPerMinute - WIDGET_LIMITS.sessionPerHour + 1);
});

test("limiter DB error -> stricter in-memory limit (never unlimited, never skipped)", async () => {
  for (const rpc of [failingRpc, throwingRpc, {rpc: async () => ({data: {weird: 1}, error: null})} as RpcClient]) {
    const store: MemoryStore = new Map();
    const t = Date.UTC(2026, 10, 7, 12, 0, 0);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await rateGate({rpc, headers: hdr("203.0.113.7"), salt: "s", cors: CORS, rules: widgetIpRules, now: () => t, store});
      statuses.push(r ? r.status : 200);
    }
    assert.equal(fallbackLimit(10), 5);
    assert.deepEqual(statuses, [...Array(5).fill(200), ...Array(6).fill(429)]);
  }
  assert.equal(fallbackLimit(1), 1);
});

test("memory store prunes expired windows only", () => {
  const store: MemoryStore = new Map();
  for (let i = 0; i < 5001; i++) store.set(`old${i}`, {windowStart: 0, windowMs: 60_000, hits: 1});
  store.set("live", {windowStart: 1_000_000, windowMs: 3_600_000, hits: 3});
  memoryHit(store, {key: "k", limit: 10, windowSec: 60, code: "c"}, 1_000_000);
  assert.equal(store.has("live"), true);
  assert.equal(store.has("old0"), false);
});

test("client IP: x-forwarded-for first hop, then cf-connecting-ip; hashed with salt", async () => {
  assert.equal(clientIp(new Headers({"x-forwarded-for": " 203.0.113.9 , 10.0.0.1"})), "203.0.113.9");
  assert.equal(clientIp(new Headers({"cf-connecting-ip": "2001:db8::1"})), "2001:db8::1");
  assert.equal(clientIp(new Headers({"x-forwarded-for": "<script>"})), "unknown");
  assert.equal(clientIp(new Headers()), "unknown");
  const a = await hashIp("203.0.113.9", "salt1"), b = await hashIp("203.0.113.9", "salt2");
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test("AI claim actions: per-IP and per-tenant rules", async () => {
  const t = Date.UTC(2026, 10, 7, 12, 0, 0);
  const db = fakeDb(() => t);
  const T = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const st: number[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await rateGate({rpc: db.rpc, headers: hdr("203.0.113.8"), salt: "s", cors: CORS, rules: (h) => aiActionRules(h, T), now: () => t, store: new Map()});
    st.push(r ? r.status : 200);
  }
  assert.deepEqual(st, [...Array(10).fill(200), 429]);
  // many IPs (fresh tenants via public create_tenant) still hit the tenant cap
  const T2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  let n = 0, r: Response | null = null;
  while (!r && n < 500) {
    r = await rateGate({rpc: db.rpc, headers: hdr(`198.51.100.${n % 250}`), salt: "s", cors: CORS, rules: (h) => aiActionRules(h, T2), now: () => t, store: new Map()});
    n++;
  }
  assert.equal(n, 31);
  assert.deepEqual([...CLAIM_AI_ACTIONS].sort(), ["ingest_text", "qa_extract", "qa_save", "qa_test"]);
  assert.equal(knowledgeAddRules(T)[0].key, `kb:t:${T}`);
});

/* ---------------------------------------------------------------- index.ts placement */
const IDX = readFileSync("supabase/functions/milan-api/index.ts", "utf8");
const block = (start: string, end: string) => {
  const a = IDX.indexOf(start);
  assert.ok(a >= 0, start);
  return IDX.slice(a, IDX.indexOf(end, a));
};

test("widget_message: IP limit before any lookup; session/tenant caps before the first write and the LLM", () => {
  const w = block('      "widget_message"\n    ) {', "    /* ═══════════════════════════════════════════════════════════════════\n       إجراءات رمز الجلسة");
  const ip = w.indexOf("rules: widgetIpRules");
  const scope = w.indexOf("rules: () => widgetScopeRules(found.tenant.id, session.id)");
  assert.ok(ip > 0 && scope > 0);
  assert.ok(ip < w.indexOf("await publicWidget("), "IP gate before the widget lookup");
  for (const heavy of ['.from(\n          "widget_messages"\n        )\n        .insert(', "await answerFromKnowledge(", "chargeWidgetReply("]) {
    const at = w.indexOf(heavy);
    assert.ok(at > 0, heavy);
    assert.ok(scope < at, `caps before ${heavy.trim().slice(0, 30)}`);
  }
  // billing refusal (inactive / no credits) runs before the LLM regardless of WIDGET_BILLING_V2_ENABLED
  const inactive = w.indexOf("found.tenant.is_active ===\n        false");
  const credits = w.indexOf("if (credits <= 0) {");
  const llm = w.indexOf("await answerFromKnowledge(");
  const flag = w.indexOf('env("WIDGET_BILLING_V2_ENABLED")');
  assert.ok(inactive > 0 && credits > 0 && inactive < llm && credits < llm && llm < flag);
});

test("claim AI actions and knowledge_add are gated before fetch / LLM / embeddings", () => {
  const c = block("    const claimActions = [", "        /* ─────────────────────────────────────────────────────────────\n           حالة واتساب");
  const gate = c.indexOf("if (CLAIM_AI_ACTIONS.has(action)) {");
  assert.ok(gate > c.indexOf('"رمز الجلسة غير صالح"') && gate < c.indexOf("switch (action) {"));
  const k = block('      case "knowledge_add": {', "await extractFromUrl(");
  assert.match(k, /rules: \(\) => knowledgeAddRules\(tenant\.id\)/);
  assert.ok(k.indexOf("if (kbLimited) return kbLimited;") < k.indexOf("const {\n          url,"));
});
