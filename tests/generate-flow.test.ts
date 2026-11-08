// generate-flow Edge Function (supabase/functions/generate-flow). Pure modules
// only: index.ts (npm: client + Deno.serve) is type-checked with deno check.
// Credits use an injectable in-memory fake of the flow_ai_generation_* RPCs
// (20261029310000; the real SQL is exercised in
// tests/flow-ai-generations-sql.test.mjs). No live Gemini or database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_HEAD, parseLlmText, validateLlmFlow } from "../supabase/functions/generate-flow/schema.ts";
import { delayParts, toFrontendDocument } from "../supabase/functions/generate-flow/convert.ts";
import { CreditError, FLOW_AI_COST, supabaseCreditPort, type CreditPort } from "../supabase/functions/generate-flow/credits.ts";
import { LlmError, createGeminiCall, GEMINI_HOST } from "../supabase/functions/generate-flow/gemini.ts";
import { APPROVED_ORIGIN, MESSAGES, handleGenerateFlow, type Deps } from "../supabase/functions/generate-flow/handler.ts";
import { importFlow, validateDocument, outputs, type FlowDocument } from "../src/flow/model.ts";
import type { Limiter } from "../supabase/functions/milan-api/abuseGuards.ts";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER_T = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";
const R1 = "44444444-4444-4444-8444-444444444444";
const R2 = "55555555-5555-4555-8555-555555555555";

const GOOD = {
  nodes: [
    { id: "t", type: "trigger", data: { channel: "instagram" } },
    { id: "m", type: "message", data: { text: "أهلاً بك!\nكيف نساعدك؟", extra: "dropped" }, position: { x: 9, y: 9 } },
    { id: "q", type: "question", data: { text: "اختر الخدمة", options: [{ id: "o1", label: "الأسعار" }, { id: "o2", label: "موظف" }] } },
    { id: "d", type: "delay", data: { seconds: 7200 } },
    { id: "c", type: "condition", data: { variable: "message", operator: "contains", value: "نعم" } },
    { id: "m2", type: "message", data: { text: "شكرًا" } },
    { id: "e", type: "end" },
    { id: "e2", type: "end" },
  ],
  edges: [
    { source: "t", target: "m", sourceHandle: "next" },
    { source: "m", target: "q", sourceHandle: "next" },
    { source: "q", target: "d", sourceHandle: "o1" },
    { source: "q", target: "e", sourceHandle: "o2" },
    { source: "d", target: "c", sourceHandle: "next" },
    { source: "c", target: "m2", sourceHandle: "true" },
    { source: "c", target: "e2", sourceHandle: "false" },
    { source: "m2", target: "e" },
  ],
};
const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x));
const reason = (v: unknown) => { const r = validateLlmFlow(v); assert.equal(r.ok, false); return (r as { reason: string }).reason; };

/* ───────────── schema / validator ───────────── */

test("system prompt starts with the mandated sentence verbatim and appends a schema", () => {
  assert.equal(SYSTEM_PROMPT_HEAD,
    "You are an expert flow builder. Return ONLY a valid JSON object with `{ nodes: [], edges: [] }`. Do not use markdown.");
  assert.ok(SYSTEM_PROMPT.startsWith(SYSTEM_PROMPT_HEAD));
  for (const k of ["trigger", "message", "question", "delay", "condition", "end", "sourceHandle", '"true"', '"false"'])
    assert.ok(SYSTEM_PROMPT.includes(k), k);
});

test("valid output passes; unknown fields dropped; controls stripped", () => {
  const raw = clone(GOOD) as any;
  raw.nodes[1].data.text = "مرحبا\u0000‮\u0007 بك";
  raw.injected = { evil: true };
  const r = validateLlmFlow(raw);
  assert.ok(r.ok);
  const m = r.flow.nodes[1] as any;
  assert.equal(m.data.text, "مرحبا بك");
  assert.equal(m.data.extra, undefined);
  assert.equal(m.position, undefined);
  assert.equal((r.flow as any).injected, undefined);
  assert.equal(r.flow.edges[7].sourceHandle, "next");
});

test("parseLlmText strips a stray code fence and rejects non-JSON / oversized text", () => {
  assert.ok(parseLlmText("```json\n" + JSON.stringify(GOOD) + "\n```").ok);
  assert.ok(parseLlmText(JSON.stringify(GOOD)).ok);
  assert.equal(parseLlmText("Here is your flow: {").ok, false);
  assert.equal(parseLlmText(null).ok, false);
  assert.equal(parseLlmText(" ".repeat(200_001)).ok, false);
});

test("validator rejects malformed, oversized and structurally invalid outputs", () => {
  assert.match(reason([]), /root/);
  assert.match(reason({ nodes: [] , edges: [] }), /nodes:count/);
  const many = { nodes: [{ id: "t", type: "trigger", data: { channel: "instagram" } },
    ...Array.from({ length: 30 }, (_, i) => ({ id: "n" + i, type: "end" }))], edges: [] };
  assert.match(reason(many), /nodes:count/);
  const edges = clone(GOOD) as any; edges.edges = Array.from({ length: 61 }, () => ({ source: "t", target: "m" }));
  assert.match(reason(edges), /edges:count/);
  const dup = clone(GOOD) as any; dup.nodes[2].id = "m"; assert.match(reason(dup), /duplicate_id/);
  const twoTriggers = clone(GOOD) as any; twoTriggers.nodes[6] = { id: "e", type: "trigger", data: { channel: "whatsapp" } };
  assert.match(reason(twoTriggers), /trigger_count/);
  const noTrigger = clone(GOOD) as any; noTrigger.nodes.shift(); assert.match(reason(noTrigger), /trigger_count/);
  const dangling = clone(GOOD) as any; dangling.edges.push({ source: "m2", target: "ghost" }); assert.match(reason(dangling), /dangling/);
  const self = clone(GOOD) as any; self.edges[7] = { source: "m2", target: "m2" }; assert.match(reason(self), /self_loop/);
  const intoT = clone(GOOD) as any; intoT.edges[7] = { source: "m2", target: "t" }; assert.match(reason(intoT), /into_trigger/);
  const badHandle = clone(GOOD) as any; badHandle.edges[2].sourceHandle = "next"; assert.match(reason(badHandle), /handle/);
  const condHandle = clone(GOOD) as any; condHandle.edges[5].sourceHandle = "yes"; assert.match(reason(condHandle), /handle/);
  const endOut = clone(GOOD) as any; endOut.edges.push({ source: "e", target: "m2" }); assert.match(reason(endOut), /handle/);
  const dupHandle = clone(GOOD) as any; dupHandle.edges.push({ source: "t", target: "q", sourceHandle: "next" });
  assert.match(reason(dupHandle), /duplicate_handle/);
  const unreachable = clone(GOOD) as any; unreachable.nodes.push({ id: "lost", type: "end" }); assert.match(reason(unreachable), /unreachable/);
  const kind = clone(GOOD) as any; kind.nodes[5].type = "request"; assert.match(reason(kind), /kind/);
  const channel = clone(GOOD) as any; channel.nodes[0].data.channel = "telegram"; assert.match(reason(channel), /channel/);
  const badId = clone(GOOD) as any; badId.nodes[1].id = "a b<"; assert.match(reason(badId), /id/);
  const delay = clone(GOOD) as any; delay.nodes[3].data.seconds = 0; assert.match(reason(delay), /seconds/);
  delay.nodes[3].data.seconds = 1.5; assert.match(reason(delay), /seconds/);
  const op = clone(GOOD) as any; op.nodes[4].data.operator = "regex"; assert.match(reason(op), /operator/);
  const variable = clone(GOOD) as any; variable.nodes[4].data.variable = "__proto__"; assert.match(reason(variable), /variable/);
  const noOpts = clone(GOOD) as any; noOpts.nodes[2].data.options = []; assert.match(reason(noOpts), /options/);
  const tooMany = clone(GOOD) as any; tooMany.nodes[2].data.options = Array.from({ length: 11 }, (_, i) => ({ id: "x" + i, label: "L" }));
  assert.match(reason(tooMany), /options/);
});

test("validator rejects injection and oversized text", () => {
  const long = clone(GOOD) as any; long.nodes[1].data.text = "ا".repeat(1001); assert.match(reason(long), /too_long/);
  const html = clone(GOOD) as any; html.nodes[1].data.text = "hi <img src=x onerror=alert(1)>"; assert.match(reason(html), /markup/);
  const script = clone(GOOD) as any; script.nodes[1].data.text = "click javascript:alert(1)"; assert.match(reason(script), /markup/);
  const urlLabel = clone(GOOD) as any; urlLabel.nodes[2].data.options[0].label = "https://evil.example"; assert.match(reason(urlLabel), /markup/);
  const wwwLabel = clone(GOOD) as any; wwwLabel.nodes[2].data.options[0].label = "www.evil"; assert.match(reason(wwwLabel), /markup/);
  const angle = clone(GOOD) as any; angle.nodes[4].data.value = "<b>"; assert.match(reason(angle), /markup/);
  const longLabel = clone(GOOD) as any; longLabel.nodes[2].data.options[0].label = "x".repeat(21); assert.match(reason(longLabel), /too_long/);
  const empty = clone(GOOD) as any; empty.nodes[1].data.text = " \u0000 "; assert.match(reason(empty), /empty/);
  const resHandle = clone(GOOD) as any; resHandle.nodes[2].data.options[0].id = "next"; assert.match(reason(resHandle), /dup/);
});

/* ───────────── conversion ───────────── */

test("conversion yields the real frontend shape and passes validateDocument with 0 errors", () => {
  const r = validateLlmFlow(GOOD); assert.ok(r.ok);
  const c = toFrontendDocument(r.flow); assert.ok(c.ok);
  const { nodes, edges } = c.document;
  assert.equal(nodes.length, 8); assert.equal(edges.length, 8);
  const UUID = /^[0-9a-f-]{36}$/;
  nodes.forEach((n, i) => {
    assert.equal(n.type, "flowNode"); assert.match(n.id, UUID);
    assert.deepEqual(n.position, { x: 100, y: i * 150 });
  });
  const [t, m, q, d, cond] = nodes;
  assert.equal(t.data.kind, "trigger"); assert.equal(t.data.platform, "instagram"); assert.equal(t.data.triggerMode, "message");
  assert.equal(m.data.text, "أهلاً بك!\nكيف نساعدك؟");
  assert.equal(q.data.inputMode, "buttons");
  assert.deepEqual(q.data.options.map(o => o.label), ["الأسعار", "موظف"]);
  q.data.options.forEach(o => { assert.match(o.id, UUID); assert.notEqual(o.id, "o1"); });
  assert.equal(d.data.delayValue, 2); assert.equal(d.data.delayUnit, "hours");
  assert.equal(cond.data.conditionField, "message"); assert.equal(cond.data.operator, "contains"); assert.equal(cond.data.conditionValue, "نعم");
  for (const e of edges) {
    assert.equal(e.type, "flowEdge"); assert.equal(e.targetHandle, "in"); assert.match(e.id, UUID);
    const from = nodes.find(n => n.id === e.source)!;
    assert.ok(outputs(from).some(p => p.id === e.sourceHandle));
    assert.equal(typeof e.data?.label, "string");
  }
  assert.deepEqual(edges.filter(e => e.source === cond.id).map(e => e.sourceHandle).sort(), ["no", "yes"]);
  assert.deepEqual(edges.filter(e => e.source === q.id).map(e => e.sourceHandle).sort(), q.data.options.map(o => o.id).sort());
  const doc: FlowDocument = { version: 3, name: "x", nodes, edges };
  assert.deepEqual(validateDocument(doc).filter(i => i.severity === "error"), []);
  const imported = importFlow(JSON.parse(JSON.stringify(doc)))!;
  assert.deepEqual(validateDocument(imported).filter(i => i.severity === "error"), []);
});

test("conversion maps every channel and delay unit; frontend-invalid graphs are refused", () => {
  assert.deepEqual(delayParts(30), { delayValue: 30, delayUnit: "seconds" });
  assert.deepEqual(delayParts(120), { delayValue: 2, delayUnit: "minutes" });
  assert.deepEqual(delayParts(86400 * 3), { delayValue: 3, delayUnit: "days" });
  for (const channel of ["instagram", "messenger", "whatsapp"]) {
    const raw = clone(GOOD) as any; raw.nodes[0].data.channel = channel;
    const r = validateLlmFlow(raw); assert.ok(r.ok);
    const c = toFrontendDocument(r.flow); assert.ok(c.ok, channel);
    assert.equal(c.document.nodes[0].data.platform, channel);
  }
  // Structurally fine for the LLM schema but the editor rejects it
  // (question option without destination): must be a validation failure.
  const missing = clone(GOOD) as any; missing.edges.splice(3, 1);
  const r = validateLlmFlow(missing); assert.ok(r.ok);
  assert.deepEqual(toFrontendDocument(r.flow), { ok: false, reason: "convert:validate" });
  // A cycle without an exit is rejected by the editor too.
  const cyc = { nodes: [{ id: "t", type: "trigger", data: { channel: "instagram" } },
    { id: "a", type: "delay", data: { seconds: 5 } }, { id: "b", type: "delay", data: { seconds: 5 } }],
    edges: [{ source: "t", target: "a" }, { source: "a", target: "b" }, { source: "b", target: "a" }] };
  const rc = validateLlmFlow(cyc); assert.ok(rc.ok);
  assert.equal(toFrontendDocument(rc.flow).ok, false);
});

/* ───────────── handler with injected credit model ───────────── */

/** In-memory fake of the flow_ai_generation_* RPCs (20261029310000) (one JS turn = tenant row lock). */
function creditModel(credits: number, opts: { staleMs?: number; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? 180_000;
  const st = {
    credits, calls: [] as string[],
    rows: new Map<string, { status: "reserved" | "committed" | "released"; hash: string; doc: unknown; at: number; charges: number; refunds: number }>(),
  };
  const sweep = (tenant: string) => {
    for (const [k, r] of st.rows) if (k.startsWith(tenant + "|") && r.status === "reserved" && now() - r.at > staleMs) {
      r.status = "released"; r.refunds++; st.credits += FLOW_AI_COST;
    }
  };
  const port: CreditPort = {
    async reserve(tenant, req, hash, cost) {
      st.calls.push("reserve"); sweep(tenant);
      const k = tenant + "|" + req, row = st.rows.get(k);
      if (row && row.hash !== hash) return { status: "mismatch" };
      if (row?.status === "reserved") return { status: "in_flight" };
      if (row?.status === "committed") return { status: "cached", document: row.doc };
      if (st.credits < cost) return { status: "no_credit" };
      st.credits -= cost;
      st.rows.set(k, { status: "reserved", hash, doc: null, at: now(), charges: (row?.charges ?? 0) + 1, refunds: row?.refunds ?? 0 });
      return { status: "reserved" };
    },
    async commit(tenant, req, doc) {
      st.calls.push("commit");
      const row = st.rows.get(tenant + "|" + req);
      if (row?.status !== "reserved") return row?.status === "committed" ? "already" : "not_reserved";
      row.status = "committed"; row.doc = JSON.parse(JSON.stringify(doc)); return "committed";
    },
    async release(tenant, req) {
      st.calls.push("release");
      const row = st.rows.get(tenant + "|" + req);
      if (row?.status !== "reserved") return "noop";
      row.status = "released"; row.refunds++; st.credits += FLOW_AI_COST; return "released";
    },
  };
  return { st, port };
}

const allowAll: Limiter = { hit: async () => ({ allowed: true, retryAfter: 1, source: "db" }) };

function setup(o: { credits?: number; llm?: (s: string, u: string) => Promise<string>; flag?: string; tenant?: string | null;
  limiter?: Limiter; credits_port?: CreditPort; staleMs?: number; now?: () => number } = {}) {
  const model = creditModel(o.credits ?? 20, { staleMs: o.staleMs, now: o.now });
  const llmCalls: Array<{ system: string; user: string }> = [];
  const logs: Array<Record<string, string>> = [];
  const deps: Deps = {
    env: k => k === "FLOW_AI_BUILDER_ENABLED" ? (o.flag ?? "true") : k === "RATE_LIMIT_IP_SALT" ? "salt" : "",
    authUser: async jwt => jwt === "valid-jwt-token-abcdef" ? { id: U } : null,
    tenantForUser: async uid => uid === U && o.tenant !== null ? { id: o.tenant ?? T } : null,
    limiter: o.limiter ?? allowAll,
    credits: o.credits_port ?? model.port,
    llm: async (system, user) => { llmCalls.push({ system, user }); return (o.llm ?? (async () => JSON.stringify(GOOD)))(system, user); },
    log: (_m, meta) => logs.push(meta),
  };
  return { model, deps, llmCalls, logs };
}

const req = (body: unknown, h: Record<string, string> = {}) => new Request("https://x.supabase.co/functions/v1/generate-flow", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { origin: APPROVED_ORIGIN, authorization: "Bearer valid-jwt-token-abcdef", "content-type": "application/json", ...h },
});
const body = (o: Record<string, unknown> = {}) => ({ prompt: "رحّب بالعميل واسأله عن الخدمة", tenant_id: T, request_id: R1, ...o });
const call = async (deps: Deps, b: unknown = body(), h?: Record<string, string>) => {
  const res = await handleGenerateFlow(req(b, h), deps);
  return { status: res.status, json: await res.json() as any, headers: res.headers };
};

test("success: charges 5 once, returns the frontend document, CORS like siblings", async () => {
  const { model, deps, llmCalls } = setup({ credits: 12 });
  const r = await call(deps);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true); assert.equal(r.json.cached, false); assert.equal(r.json.credits_charged, 5);
  assert.equal(r.json.document.nodes.length, 8); assert.equal(r.json.document.nodes[0].type, "flowNode");
  assert.deepEqual(validateDocument({ version: 3, name: "x", ...r.json.document }).filter((i: any) => i.severity === "error"), []);
  assert.equal(model.st.credits, 7);
  assert.equal(llmCalls.length, 1);
  assert.ok(llmCalls[0].system.startsWith(SYSTEM_PROMPT_HEAD));
  assert.ok(llmCalls[0].user.includes("رحّب بالعميل"));
  assert.equal(r.headers.get("access-control-allow-origin"), APPROVED_ORIGIN);
  assert.deepEqual(model.st.calls, ["reserve", "commit"]);
});

test("idempotent duplicate request_id: cached result, charged once, LLM once", async () => {
  const { model, deps, llmCalls } = setup({ credits: 12 });
  const a = await call(deps), b = await call(deps);
  assert.equal(b.status, 200); assert.equal(b.json.cached, true); assert.equal(b.json.credits_charged, 5);
  assert.deepEqual(b.json.document, a.json.document);
  assert.equal(model.st.credits, 7); assert.equal(llmCalls.length, 1);
  // A new request_id is a new, separately charged generation.
  const c = await call(deps, body({ request_id: R2 }));
  assert.equal(c.json.cached, false); assert.equal(model.st.credits, 2);
});

test("concurrent duplicates: one charge, one LLM call; the other gets in_flight then the cache", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const { model, deps, llmCalls } = setup({ credits: 12, llm: async () => { await gate; return JSON.stringify(GOOD); } });
  const p1 = call(deps), p2 = call(deps);
  await new Promise(r => setTimeout(r, 10));
  release();
  const [a, b] = await Promise.all([p1, p2]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const busy = a.status === 409 ? a : b;
  assert.equal(busy.json.error, "rate_limited"); assert.equal(busy.json.message, MESSAGES.inFlight);
  assert.equal(model.st.credits, 7); assert.equal(llmCalls.length, 1);
  const again = await call(deps);
  assert.equal(again.json.cached, true); assert.equal(model.st.credits, 7);
});

test("same request_id with a different prompt is refused without charge", async () => {
  const { model, deps } = setup({ credits: 12 });
  await call(deps);
  const r = await call(deps, body({ prompt: "وصف آخر" }));
  assert.equal(r.status, 422); assert.equal(r.json.error, "invalid_request");
  assert.equal(r.json.message, MESSAGES.requestReused);
  assert.equal(model.st.credits, 7);
});

test("reserve 'invalid' (unknown tenant / bad args) -> 400 invalid_request, no LLM", async () => {
  const { model, deps, llmCalls } = setup();
  deps.credits = { ...model.port, reserve: async () => ({ status: "invalid" }) };
  const r = await call(deps);
  assert.equal(r.status, 400); assert.equal(r.json.error, "invalid_request");
  assert.equal(llmCalls.length, 0);
});

test("insufficient credits (<5): 402, no charge, no LLM call", async () => {
  const { model, deps, llmCalls } = setup({ credits: 4 });
  const r = await call(deps);
  assert.equal(r.status, 402);
  assert.deepEqual(r.json, { ok: false, error: "insufficient_credits", message: "رصيدك غير كافٍ لتوليد التدفق بالذكاء الاصطناعي" });
  assert.equal(model.st.credits, 4); assert.equal(llmCalls.length, 0);
  assert.deepEqual(model.st.calls, ["reserve"]);
});

test("LLM failure and timeout refund the reservation", async () => {
  for (const [err, status] of [[new LlmError("http"), 502], [new LlmError("timeout"), 504], [new Error("boom"), 502]] as const) {
    const { model, deps } = setup({ credits: 10, llm: async () => { throw err; } });
    const r = await call(deps);
    assert.equal(r.status, status);
    assert.deepEqual(r.json, { ok: false, error: "ai_unavailable", message: "حدث خطأ في الاتصال بالذكاء الاصطناعي، تم استرداد الرصيد" });
    assert.equal(model.st.credits, 10);
    assert.deepEqual(model.st.calls, ["reserve", "release"]);
  }
});

test("validation failure (malformed / injection / editor-invalid) refunds the reservation", async () => {
  const bad = [
    "not json at all",
    JSON.stringify({ nodes: [{ id: "t", type: "trigger", data: { channel: "instagram" } }], edges: [] }),
    JSON.stringify({ ...GOOD, nodes: GOOD.nodes.map((n, i) => i === 1 ? { ...n, data: { text: "<script>x</script>" } } : n) }),
    JSON.stringify({ ...GOOD, edges: GOOD.edges.filter((_, i) => i !== 3) }),
  ];
  for (const text of bad) {
    const { model, deps, logs } = setup({ credits: 10, llm: async () => text });
    const r = await call(deps);
    assert.equal(r.status, 422);
    assert.deepEqual(r.json, { ok: false, error: "generation_failed", message: "فشل توليد التدفق، تم استرداد الرصيد" });
    assert.equal(model.st.credits, 10);
    assert.deepEqual(model.st.calls, ["reserve", "release"]);
    // Logs carry only codes, never prompt or model content.
    assert.ok(!JSON.stringify(logs).includes("script") && !JSON.stringify(logs).includes("رحّب"));
  }
});

test("refund is idempotent and a retry with the same request_id is allowed after a refund", async () => {
  let fail = true;
  const { model, deps, llmCalls } = setup({ credits: 5, llm: async () => { if (fail) throw new LlmError("network"); return JSON.stringify(GOOD); } });
  const first = await call(deps);
  assert.equal(first.status, 502); assert.equal(model.st.credits, 5);
  assert.equal(await model.port.release(T, R1), "noop");
  assert.equal(await model.port.release(T, R1), "noop");
  assert.equal(model.st.credits, 5);
  fail = false;
  const retry = await call(deps);
  assert.equal(retry.status, 200); assert.equal(retry.json.cached, false);
  assert.equal(model.st.credits, 0); assert.equal(llmCalls.length, 2);
  const row = model.st.rows.get(T + "|" + R1)!;
  assert.equal(row.charges - row.refunds, 1);
});

test("crash after reserve: the stale reservation is swept back (no lost refund)", async () => {
  let t = 1_000_000;
  const { model } = setup({ credits: 5, now: () => t });
  assert.deepEqual(await model.port.reserve(T, R1, "h", 5), { status: "reserved" });
  assert.equal(model.st.credits, 0);
  // Function "crashed": no commit/release. Still fresh -> in_flight, no double charge.
  assert.deepEqual(await model.port.reserve(T, R1, "h", 5), { status: "in_flight" });
  t += 181_000;
  assert.deepEqual(await model.port.reserve(T, R2, "h2", 5), { status: "reserved" }); // sweep refunded R1 first
  assert.equal(model.st.rows.get(T + "|" + R1)!.status, "released");
  assert.equal(model.st.credits, 0);
  // A late commit after the sweep must not hand out an unpaid flow.
  assert.equal(await model.port.commit(T, R1, {}), "not_reserved");
});

test("commit reporting not_reserved returns no document", async () => {
  const { model, deps } = setup({ credits: 10 });
  deps.credits = { ...model.port, commit: async () => "not_reserved" };
  const r = await call(deps);
  assert.equal(r.status, 503); assert.equal(r.json.document, undefined);
});

test("commit RPC error: release attempted, no document returned", async () => {
  const { model, deps } = setup({ credits: 10 });
  deps.credits = { ...model.port, commit: async () => { throw new CreditError(); } };
  const r = await call(deps);
  assert.equal(r.status, 503); assert.equal(r.json.document, undefined);
  assert.equal(model.st.credits, 10);
});

test("tenant mismatch / missing tenant / unauthenticated are rejected before any charge", async () => {
  const s1 = setup();
  const mismatch = await call(s1.deps, body({ tenant_id: OTHER_T }));
  assert.equal(mismatch.status, 403); assert.equal(mismatch.json.error, "unauthorized");
  assert.deepEqual(s1.model.st.calls, []); assert.equal(s1.llmCalls.length, 0);
  const s2 = setup({ tenant: null });
  assert.equal((await call(s2.deps)).status, 403);
  const s3 = setup();
  const anon = await call(s3.deps, body(), { authorization: "Bearer someone-elses-token" });
  assert.equal(anon.status, 401); assert.equal(anon.json.error, "unauthorized");
  const noBearer = await call(s3.deps, body(), { authorization: "" });
  assert.equal(noBearer.status, 401);
  const origin = await call(s3.deps, body(), { origin: "https://evil.example" });
  assert.equal(origin.status, 403);
  assert.deepEqual(s3.model.st.calls, []);
});

test("feature flag off (absent or not exactly 'true') -> disabled, nothing called", async () => {
  for (const flag of ["", "false", "TRUE", "1"]) {
    const { model, deps, llmCalls } = setup({ flag });
    const r = await call(deps);
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { ok: false, error: "disabled", message: MESSAGES.disabled });
    assert.deepEqual(model.st.calls, []); assert.equal(llmCalls.length, 0);
  }
});

test("invalid requests: prompt bounds, uuids, JSON, size", async () => {
  const { model, deps } = setup();
  for (const b of [body({ prompt: "" }), body({ prompt: "   " }), body({ prompt: "ا".repeat(1501) }), body({ prompt: 5 }),
    body({ request_id: "nope" }), body({ tenant_id: undefined }), "{bad json", "[]"]) {
    const r = await call(deps, b);
    assert.equal(r.status, 400, JSON.stringify(b).slice(0, 40)); assert.equal(r.json.error, "invalid_request");
  }
  assert.equal((await call(deps, body({ prompt: "ا".repeat(1500) }))).status, 200);
  const big = await call(deps, JSON.stringify(body({ pad: "x".repeat(20_000) })));
  assert.equal(big.status, 413);
  assert.equal(model.st.calls.filter(c => c === "reserve").length, 1);
});

test("rate limited (IP or tenant) -> 429 before any charge", async () => {
  const limiter: Limiter = { hit: async rule => ({ allowed: !rule.key.startsWith("gf:t:"), retryAfter: 30, source: "db" }) };
  const { model, deps, llmCalls } = setup({ limiter });
  const r = await call(deps);
  assert.equal(r.status, 429); assert.equal(r.json.error, "rate_limited"); assert.equal(r.headers.get("retry-after"), "30");
  assert.deepEqual(model.st.calls, []); assert.equal(llmCalls.length, 0);
  const ipBlock: Limiter = { hit: async rule => ({ allowed: !rule.key.startsWith("gf:ip:"), retryAfter: 9, source: "memory" }) };
  const s = setup({ limiter: ipBlock });
  assert.equal((await call(s.deps)).status, 429);
});

test("credit service unavailable (RPCs absent until approved) fails closed: no LLM call", async () => {
  const rpcMissing = supabaseCreditPort({ rpc: async () => ({ data: null, error: { code: "PGRST202" } }) });
  const { deps, llmCalls } = setup({ credits_port: rpcMissing });
  const r = await call(deps);
  assert.equal(r.status, 503); assert.equal(r.json.error, "ai_unavailable");
  assert.equal(llmCalls.length, 0);
  const noLlm = setup(); noLlm.deps.llm = null;
  assert.equal((await call(noLlm.deps)).status, 503);
  assert.deepEqual(noLlm.model.st.calls, []);
});

test("supabaseCreditPort maps RPC names/args and rejects unexpected payloads", async () => {
  const seen: Array<[string, Record<string, unknown>]> = [];
  const replies: Record<string, unknown> = { flow_ai_generation_reserve: { status: "cached", document: { nodes: [], edges: [] } },
    flow_ai_generation_commit: "committed", flow_ai_generation_release: "released" };
  const port = supabaseCreditPort({ rpc: async (fn, args) => { seen.push([fn, args]); return { data: replies[fn], error: null }; } });
  assert.deepEqual(await port.reserve(T, R1, "abc", 5), { status: "cached", document: { nodes: [], edges: [] } });
  assert.equal(await port.commit(T, R1, { nodes: [] }), "committed");
  assert.equal(await port.release(T, R1), "released");
  assert.deepEqual(seen[0], ["flow_ai_generation_reserve", { p_tenant_id: T, p_request_id: R1, p_prompt_sha256: "abc", p_cost: 5 }]);
  const weird = supabaseCreditPort({ rpc: async () => ({ data: { status: "free_money" }, error: null }) });
  await assert.rejects(weird.reserve(T, R1, "abc", 5), CreditError);
});

/* ───────────── Gemini adapter ───────────── */

test("Gemini: fixed host, key in header (not URL), JSON mode, one retry on 5xx, none on 4xx", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let n = 0;
  const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"nodes":[],' }, { text: '"edges":[]}' }] } }] }), { status: 200 });
  const fetcher = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return ++n === 1 ? new Response("x", { status: 503 }) : ok(); }) as unknown as typeof fetch;
  const llm = createGeminiCall({ apiKey: "AIzaTEST", model: "gemini-2.5-flash", fetcher, retryDelayMs: 0 });
  assert.equal(await llm("sys", "user"), '{"nodes":[],"edges":[]}');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, GEMINI_HOST + "/v1beta/models/gemini-2.5-flash:generateContent");
  assert.ok(!seen[0].url.includes("AIzaTEST"));
  assert.equal((seen[0].init.headers as Record<string, string>)["x-goog-api-key"], "AIzaTEST");
  const sent = JSON.parse(String(seen[0].init.body));
  assert.equal(sent.generationConfig.responseMimeType, "application/json");
  assert.equal(sent.systemInstruction.parts[0].text, "sys");

  let m = 0;
  const f400 = (async () => { m++; return new Response("bad", { status: 400 }); }) as unknown as typeof fetch;
  await assert.rejects(createGeminiCall({ apiKey: "k", model: "x", fetcher: f400, retryDelayMs: 0 })("s", "u"), LlmError);
  assert.equal(m, 1);

  let k = 0;
  const fTimeout = (async () => { k++; const e = new Error("t"); e.name = "TimeoutError"; throw e; }) as unknown as typeof fetch;
  await assert.rejects(createGeminiCall({ apiKey: "k", model: "x", fetcher: fTimeout, retryDelayMs: 0 })("s", "u"),
    (e: unknown) => e instanceof LlmError && e.code === "timeout");
  assert.equal(k, 2, "at most one retry");

  // Path injection via model name falls back to the default model on the fixed host.
  const hostSeen: string[] = [];
  const fh = (async (url: string) => { hostSeen.push(url); return ok(); }) as unknown as typeof fetch;
  await createGeminiCall({ apiKey: "k", model: "../../evil.com/x?", fetcher: fh })("s", "u");
  assert.ok(hostSeen[0].startsWith(GEMINI_HOST + "/v1beta/models/gemini-2.5-flash:"));
});

test("source guards: no stored-flow access, no content logging, flag read fail-closed", () => {
  const src = ["handler.ts", "index.ts", "credits.ts", "gemini.ts", "convert.ts", "schema.ts"]
    .map(f => readFileSync("supabase/functions/generate-flow/" + f, "utf8")).join("\n");
  assert.ok(!/automation_flow_publications|automation_flow_activations|\.delete\(/.test(src));
  assert.ok(!/console\.(log|warn|error)\([^)]*(prompt|text|document)\b/.test(src));
  assert.ok(src.includes('deps.env("FLOW_AI_BUILDER_ENABLED") !== "true"'));
  assert.ok(!/\?key=/.test(src));
});
