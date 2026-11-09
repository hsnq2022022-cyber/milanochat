// S8: Widget answers are paid for BEFORE the LLM call
// (supabase/functions/milan-api/widgetBilling.ts + its call sites in
// index.ts). The real SQL semantics (20261029280000) are exercised end to end
// in tests/security-tenant-isolation-sql.test.mjs; this suite covers the
// module contract with an in-memory model and the index.ts placement.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  widgetBillingEnabled, widgetIdempotencyKey, reserveWidgetAnswer, commitWidgetAnswer, releaseWidgetAnswer,
  widgetBillingEarlyReply, WIDGET_UNAVAILABLE_REPLY, WIDGET_BUSY_REPLY, type RpcClient, type WidgetReservation,
} from "../supabase/functions/milan-api/widgetBilling.ts";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", S = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** In-memory model of widget_credit_reserve / commit / release (tenant row lock = JS turn). */
function model(credits: number, active = true) {
  const st = {credits, active, rows: new Map<string, {status: string; session: string; answer: string | null}>(), calls: [] as string[]};
  const rpc: RpcClient = {
    rpc: async (fn, a) => {
      st.calls.push(fn);
      const k = String(a.p_key);
      const row = st.rows.get(k);
      if (fn === "widget_credit_reserve") {
        if (row && row.session !== a.p_session_id) return {data: {status: "invalid"}, error: null};
        if (row?.status === "reserved") return {data: {status: "in_flight"}, error: null};
        if (row?.status === "committed") return {data: {status: "duplicate", answer_message_id: row.answer}, error: null};
        if (!st.active || st.credits <= 0) return {data: {status: "no_credit"}, error: null};
        st.credits--;
        st.rows.set(k, {status: "reserved", session: String(a.p_session_id), answer: null});
        return {data: {status: "reserved", remaining: st.credits}, error: null};
      }
      if (fn === "widget_credit_commit") {
        if (row?.status !== "reserved") return {data: row?.status === "committed" ? "already" : "not_reserved", error: null};
        row.status = "committed"; row.answer = String(a.p_answer_message_id);
        return {data: "committed", error: null};
      }
      if (fn === "widget_credit_release") {
        if (row?.status !== "reserved") return {data: "noop", error: null};
        row.status = "released"; st.credits++;
        return {data: "released", error: null};
      }
      return {data: null, error: {code: "PGRST202"}};
    },
  };
  return {st, rpc};
}
function msgs() {
  const rows: any[] = [];
  const from = (table: string) => {
    assert.equal(table, "widget_messages");
    const f: Record<string, unknown> = {};
    const b: any = {
      select: () => b, eq: (k: string, v: unknown) => { f[k] = v; return b; },
      maybeSingle: async () => ({data: rows.find((r) => Object.entries(f).every(([k, v]) => r[k] === v)) ?? null, error: null}),
      insert: async (row: any) => { rows.push({id: "m" + (rows.length + 1), ...row}); return {error: null}; },
    };
    return b;
  };
  return {rows, from};
}
/** Same billing order as index.ts widget_message (after S3 + the existing refusals). */
async function turn(rpc: RpcClient, store: ReturnType<typeof msgs>, message: string, flag: string | undefined,
  llm: () => Promise<string | null>) {
  const ids = {tenantId: T, widgetId: "w", sessionId: S};
  const bill = await reserveWidgetAnswer(rpc, {enabled: widgetBillingEnabled(flag), tenantId: T, sessionId: S, message});
  const early = await widgetBillingEarlyReply(store, bill, ids);
  if (early) return early;
  let answer: string | null;
  try { answer = await llm(); } catch { await releaseWidgetAnswer(rpc, T, bill); return {kind: "error"}; }
  if (!answer) { await releaseWidgetAnswer(rpc, T, bill); return {kind: "refusal"}; }
  await store.from("widget_messages").insert({session_id: S, tenant_id: T, direction: "out", body: answer, kind: "answer"});
  return {kind: "answer", reply: answer, billingStatus: await commitWidgetAnswer(rpc, T, bill, store.rows.at(-1).id)};
}

test("flag: billing is ON unless WIDGET_BILLING_V2_ENABLED is exactly 'false' (kill switch)", () => {
  for (const v of [undefined, null, "", "true", "1", "on", "no", "0"]) assert.equal(widgetBillingEnabled(v as any), true, String(v));
  for (const v of ["false", " false ", "FALSE"]) assert.equal(widgetBillingEnabled(v), false, v);
});

test("OLD behaviour: credits 1 + flag unset gave unlimited free answers (proof the model detects it)", async () => {
  const {st} = model(1);
  let answers = 0;
  // old index.ts: only `credits <= 0` refused; the debit ran only when the flag was "true"
  for (let i = 0; i < 5; i++) { if (st.credits <= 0) break; answers++; }
  assert.equal(answers, 5);
  assert.equal(st.credits, 1);
});

test("0 credits / inactive: blocked before the LLM with the existing refusal reply and row", async () => {
  for (const [c, active] of [[0, true], [3, false]] as const) {
    const {rpc} = model(c, active), store = msgs();
    let llm = 0;
    const r = await turn(rpc, store, "hi", undefined, async () => { llm++; return "x"; });
    assert.deepEqual(r, {reply: WIDGET_UNAVAILABLE_REPLY, kind: "error"});
    assert.equal(llm, 0);
    assert.equal(store.rows.length, 1);
    assert.deepEqual({...store.rows[0], id: undefined}, {id: undefined, session_id: S, widget_id: "w", tenant_id: T, direction: "out", body: WIDGET_UNAVAILABLE_REPLY, kind: "error"});
  }
});

test("1 credit = exactly one answer, then blocked; double submit charged once and replayed", async () => {
  const {st, rpc} = model(1), store = msgs();
  let llm = 0;
  const ask = async () => { llm++; return "answer"; };
  const a = await turn(rpc, store, "q", undefined, ask);
  assert.equal(a.kind, "answer"); assert.equal((a as any).billingStatus, "charged");
  const again = await turn(rpc, store, "q", undefined, ask);
  assert.deepEqual(again, {reply: "answer", kind: "answer"}, "same key: replay of the saved answer");
  const other = await turn(rpc, store, "another", undefined, ask);
  assert.equal(other.kind, "error");
  assert.equal(llm, 1); assert.equal(st.credits, 0);
});

test("concurrent double submit: one reservation, the other gets the busy reply (no LLM, no charge)", async () => {
  const {st, rpc} = model(5), store = msgs();
  let llm = 0;
  const slow = async () => { llm++; await new Promise((r) => setTimeout(r, 20)); return "a"; };
  const out = await Promise.all([turn(rpc, store, "x", "true", slow), turn(rpc, store, "x", "true", slow)]);
  assert.equal(llm, 1); assert.equal(st.credits, 4);
  assert.ok(out.some((o) => o.kind === "error" && (o as any).reply === WIDGET_BUSY_REPLY));
});

test("LLM failure / no answer: the reserved credit is released", async () => {
  const {st, rpc} = model(2), store = msgs();
  assert.equal((await turn(rpc, store, "a", undefined, async () => { throw new Error("down"); })).kind, "error");
  assert.equal((await turn(rpc, store, "b", undefined, async () => null)).kind, "refusal");
  assert.equal(st.credits, 2);
  assert.deepEqual(st.calls, ["widget_credit_reserve", "widget_credit_release", "widget_credit_reserve", "widget_credit_release"]);
});

test("kill switch 'false': no billing RPC, legacy uncharged path", async () => {
  const {st, rpc} = model(1), store = msgs();
  for (const q of ["1", "2", "3"]) assert.equal((await turn(rpc, store, q, "false", async () => "ok") as any).billingStatus, "deferred");
  assert.equal(st.calls.length, 0); assert.equal(st.credits, 1);
});

test("fail closed: RPC error / exception / unknown status -> unavailable (no LLM)", async () => {
  for (const rpc of [
    {rpc: async () => ({data: null, error: {code: "42883"}})},
    {rpc: async () => { throw new Error("network"); }},
    {rpc: async () => ({data: {status: "weird"}, error: null})},
    {rpc: async () => ({data: {status: "invalid"}, error: null})},
  ] as RpcClient[]) {
    const r = await reserveWidgetAnswer(rpc, {enabled: true, tenantId: T, sessionId: S, message: "m"});
    assert.deepEqual(r, {kind: "unavailable"});
    assert.equal((await widgetBillingEarlyReply(msgs(), r, {tenantId: T, widgetId: "w", sessionId: S}))!.kind, "error");
  }
  // commit failure keeps the charge (pending); release / commit are no-ops for "off"
  const bad: RpcClient = {rpc: async () => ({data: null, error: {code: "XX"}})};
  assert.equal(await commitWidgetAnswer(bad, T, {kind: "charge", key: "k"}, "m1"), "pending");
  const calls: string[] = [];
  const spy: RpcClient = {rpc: async (fn) => { calls.push(fn); return {data: null, error: null}; }};
  const off: WidgetReservation = {kind: "off"};
  assert.equal(await commitWidgetAnswer(spy, T, off, "m1"), "deferred");
  await releaseWidgetAnswer(spy, T, off);
  assert.equal(calls.length, 0);
});

test("replay is tenant + session scoped; a missing answer falls back to the busy reply", async () => {
  const store = msgs();
  await store.from("widget_messages").insert({session_id: "other", tenant_id: T, body: "secret", kind: "answer"});
  const r = await widgetBillingEarlyReply(store, {kind: "replay", answerMessageId: "m1"}, {tenantId: T, widgetId: "w", sessionId: S});
  assert.deepEqual(r, {reply: WIDGET_BUSY_REPLY, kind: "error"});
});

test("idempotency key: stable per session + text / client id, distinct otherwise, no customer text", async () => {
  const k1 = await widgetIdempotencyKey(S, "price?");
  assert.match(k1.key, /^w1:[0-9a-f]{64}$/); assert.equal(k1.replaySeconds, 120);
  assert.deepEqual(await widgetIdempotencyKey(S, "price?"), k1);
  assert.notEqual((await widgetIdempotencyKey(S, "price!")).key, k1.key);
  assert.notEqual((await widgetIdempotencyKey("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "price?")).key, k1.key);
  const c = await widgetIdempotencyKey(S, "price?", "client-msg-0001");
  assert.equal(c.replaySeconds, 86400); assert.notEqual(c.key, k1.key);
  assert.equal((await widgetIdempotencyKey(S, "other text", "client-msg-0001")).key, c.key, "client id wins over text");
  assert.deepEqual(await widgetIdempotencyKey(S, "price?", "bad id!"), k1, "invalid client id ignored");
  assert.doesNotMatch(k1.key, /price/);
});

/* ---------------------------------------------------------------- index.ts placement */
const IDX = readFileSync("supabase/functions/milan-api/index.ts", "utf8");
test("index.ts widget_message: S3 gates first, reserve before the LLM, release on every no-answer path, commit after save", () => {
  const a = IDX.indexOf('      "widget_message"\n    ) {');
  const w = IDX.slice(a, IDX.indexOf("       إجراءات رمز الجلسة", a));
  const at = (s: string) => { const i = w.indexOf(s); assert.ok(i > 0, s); return i; };
  const ip = at("rules: widgetIpRules"), scope = at("rules: () => widgetScopeRules(found.tenant.id, session.id)");
  const reserve = at("await reserveWidgetAnswer(sb, {"), early = at("if (widgetEarly) return json(widgetEarly);");
  const llm = at("await answerFromKnowledge(");
  assert.ok(ip < scope && scope < reserve && reserve < early && early < llm);
  assert.match(w, /enabled: widgetBillingEnabled\(env\("WIDGET_BILLING_V2_ENABLED"\)\)/);
  assert.equal(w.split("await releaseWidgetAnswer(sb, found.tenant.id, widgetBill);").length - 1, 3, "LLM error, refusal, save failure");
  const catchAt = at("} catch (e) {\n        await releaseWidgetAnswer(");
  assert.ok(catchAt > llm);
  assert.ok(at("await commitWidgetAnswer(\n        sb,found.tenant.id,widgetBill,savedWidgetReply.id);") > at('.from("widget_messages")\n        .insert({'));
  assert.doesNotMatch(w, /chargeWidgetReply|=== ?"true"\)\{\n\s+const charge/);
});
