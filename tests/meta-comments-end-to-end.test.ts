// Task 1: Instagram + Facebook Page COMMENT automation, event -> action, with
// fakes only (no network, no Deno, no database):
//   signed webhook body (X-Hub-Signature-256) -> commentIngress.ts (account
//   resolution, flags/canary, self/loop, verb, 7-day private reply window,
//   keyword match, dedupe) -> flow_begin_comment_run (emulated: dedupe row +
//   run + outbox [reply_comment, message]) -> worker request shapes
//   (commentReply.ts public reply, deliveryCore.ts / multichannelSend.ts
//   private reply with recipient.comment_id).
// The SQL itself is covered by tests/flow-comment-replies-sql.test.mjs; this
// emulation keeps only the rules the edge code relies on.
// Run: node --experimental-strip-types --test tests/meta-comments-end-to-end.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {readFileSync} from "node:fs";
import {inspect} from "node:util";
import {verifyMetaWebhookSignature} from "../supabase/functions/milan-api/metaSignature.ts";
import {ingestSignedComments} from "../supabase/functions/milan-api/commentIngress.ts";
import {
  COMMENT_START_MAX_AGE_MS, PRIVATE_REPLY_WINDOW_MS, PRIVATE_REPLY_SEND_MARGIN_MS,
  commentCreatedTimeMs, commentStartAgeOk, normalizeMetaComments,
} from "../supabase/functions/milan-api/commentTrigger.ts";
import {OUTBOX_STALE_MINUTES} from "../supabase/functions/flow-outbox-worker/skipPolicy.ts";
import {executeCommentReply, type CommentClaim} from "../supabase/functions/flow-outbox-worker/commentReply.ts";
import {sendProviderMessage} from "../supabase/functions/flow-outbox-worker/deliveryCore.ts";
import {sendMultichannelMessage} from "../supabase/functions/flow-outbox-worker/multichannelSend.ts";
import {IG_SUBSCRIBED_FIELDS, IG_DM_SUBSCRIBED_FIELDS} from "../supabase/functions/meta-auth/instagramSubscription.ts";
import {FB_PAGE_SUBSCRIBED_FIELDS, FB_PAGE_DM_SUBSCRIBED_FIELDS} from "../supabase/functions/meta-auth/facebook.ts";

const SECRET = "e2e-app-secret";
const TA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IG_ACC = "11111111-1111-4111-8111-111111111111", IG_ACC_B = "22222222-2222-4222-8222-222222222222";
const FB_ACC = "33333333-3333-4333-8333-333333333333";
const IG_ID = "17841400000000001", PAGE_ID = "1122334455";
const IG_TOKEN = "IGAA-E2ECANARY-ig-token", PAGE_TOKEN = "EAA-E2ECANARY-page-token";
const NOW = 1_800_000_000_000; // a whole second
const REPLY = "راسلناك على الخاص", DM = "تفاصيل الأسعار";

// ------------------------------------------------------------------ fake DB
type Row = Record<string, any>;
const tick = () => new Promise((r) => setImmediate(r));
function orMatch(expr: string, row: Row): boolean {
  return expr.split(",").some((part) => {
    const [col, op, ...rest] = part.split(".");
    const val = rest.join(".");
    if (op === "is" && val === "null") return row[col] === null || row[col] === undefined;
    if (op === "neq") return row[col] !== null && row[col] !== undefined && String(row[col]) !== val;
    if (op === "eq") return String(row[col]) === val;
    throw new Error("unsupported or() " + part);
  });
}
class FakeDb {
  t: Record<string, Row[]> = {
    channel_accounts: [], automation_flow_activations: [], automation_flow_publications: [],
    automation_comment_replies: [], conversations: [], messages: [], automation_flow_runs: [],
    automation_flow_outbox: [], automation_flow_canary_accounts: [], automation_flow_tenant_switches: [],
  };
  calls: Array<{table: string; op: string; filters: string[]}> = [];
  rpcs: Array<{name: string; args: Row}> = [];
  messagesUnique = true;
  seq = 0;
  id() { return `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`; }
  from(table: string) { return new Q(this, table); }
  async rpc(name: string, args: Row) {
    this.rpcs.push({name, args});
    await tick();
    if (name !== "flow_begin_comment_run") return {data: null, error: {code: "42883"}};
    return {data: this.beginCommentRun(args), error: null};
  }
  /** Emulation of 20261029300000 flow_begin_comment_run (the rules the edge relies on). */
  beginCommentRun(a: Row): string | null {
    const acc = this.t.channel_accounts.find((r) => r.tenant_id === a.p_tenant && r.id === a.p_account);
    if (!acc || !acc.is_active || !acc.agent_enabled || !acc.auto_reply) return null;
    if (!this.t.automation_flow_canary_accounts.some((r) => r.tenant_id === a.p_tenant && r.channel_account_id === a.p_account)) return null;
    if (!this.t.automation_flow_tenant_switches.some((r) => r.tenant_id === a.p_tenant && r.enabled && r.production_approved)) return null;
    const act = this.t.automation_flow_activations.find((r) => r.tenant_id === a.p_tenant && r.channel_account_id === a.p_account &&
      r.flow_key === a.p_flow && r.revision === a.p_revision && r.is_active);
    const pub = act && this.t.automation_flow_publications.find((r) => r.tenant_id === a.p_tenant &&
      r.channel_account_id === a.p_account && r.flow_key === a.p_flow && r.revision === a.p_revision);
    const node = pub?.document.nodes.find((n: Row) => n.id === a.p_start && n.data.triggerMode === "comment");
    const reply = typeof node?.data.publicReplyText === "string" ? node.data.publicReplyText.trim() : null;
    const fx = a.p_effects as Row[];
    if (!reply || fx.length < 2 || fx[0].kind !== "reply_comment" || fx[0].payload.text !== reply ||
        fx[0].payload.commentId !== a.p_comment_id || fx.slice(1).some((e) => e.kind !== "message")) return null;
    // ON CONFLICT ON CONSTRAINT automation_comment_replies_comment_uq DO NOTHING
    if (this.t.automation_comment_replies.some((r) => r.tenant_id === a.p_tenant &&
      r.channel_account_id === a.p_account && r.comment_id === a.p_comment_id)) return null;
    const run = this.id();
    this.t.automation_comment_replies.push({id: this.id(), tenant_id: a.p_tenant, channel_account_id: a.p_account,
      platform: acc.platform, comment_id: a.p_comment_id, post_id: a.p_post_id, from_id: a.p_from_id,
      public_reply_text: reply, run_id: run, reply_status: "pending", reply_attempts: 0, dm_status: "pending"});
    this.t.automation_flow_runs.push({id: run, tenant_id: a.p_tenant, channel_account_id: a.p_account,
      platform: acc.platform, provider_event_id: "comment:" + a.p_comment_id, conversation_id: a.p_conversation});
    for (const e of fx) {
      if (this.t.automation_flow_outbox.some((o) => o.tenant_id === a.p_tenant && o.idempotency_key === e.idempotencyKey)) continue;
      this.t.automation_flow_outbox.push({id: this.id(), tenant_id: a.p_tenant, run_id: run, effect_kind: e.kind,
        idempotency_key: e.idempotencyKey, payload: e.payload, delivery_status: "pending"});
    }
    return run;
  }
}
class Q {
  filters: Array<(r: Row) => boolean> = [];
  desc: string[] = [];
  op = "select";
  row: Row | null = null;
  max = Infinity;
  db: FakeDb;
  table: string;
  constructor(db: FakeDb, table: string) { this.db = db; this.table = table; }
  select() { return this; }
  eq(c: string, v: unknown) { this.desc.push(`eq:${c}`); this.filters.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.desc.push(`in:${c}`); this.filters.push((r) => v.includes(r[c])); return this; }
  or(expr: string) { this.desc.push(`or:${expr}`); this.filters.push((r) => orMatch(expr, r)); return this; }
  limit(n: number) { this.max = n; return this; }
  order() { return this; }
  insert(row: Row) { this.op = "insert"; this.row = row; return this; }
  update(row: Row) { this.op = "update"; this.row = row; return this; }
  async exec(): Promise<{data: any; error: any}> {
    this.db.calls.push({table: this.table, op: this.op, filters: this.desc});
    await tick();
    const rows = this.db.t[this.table];
    if (this.op === "insert") {
      const r = {id: this.db.id(), ...this.row};
      if (this.table === "conversations" && rows.some((x) => x.tenant_id === r.tenant_id && x.wa_chat_id === r.wa_chat_id))
        return {data: null, error: {code: "23505"}};
      if (this.table === "messages" && this.db.messagesUnique &&
          rows.some((x) => x.tenant_id === r.tenant_id && x.wa_message_id === r.wa_message_id))
        return {data: null, error: {code: "23505"}};
      rows.push(r);
      return {data: r, error: null};
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") { for (const r of hit) Object.assign(r, this.row); return {data: hit, error: null}; }
    return {data: hit.slice(0, this.max), error: null};
  }
  async maybeSingle() {
    const r = await this.exec();
    if (r.error) return r;
    if (r.data.length > 1) return {data: null, error: {code: "PGRST116"}};
    return {data: r.data[0] ?? null, error: null};
  }
  async single() {
    const r = await this.exec();
    if (r.error) return r;
    if (Array.isArray(r.data)) return r.data.length === 1 ? {data: r.data[0], error: null} : {data: null, error: {code: "PGRST116"}};
    return r;
  }
  then(ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) { return this.exec().then(ok, bad); }
}

// ------------------------------------------------------------------ fixtures
const doc = (platform: "instagram" | "messenger", trig: Row = {}) => ({
  version: 3, name: "c",
  nodes: [{id: "start", data: {kind: "trigger", platform, triggerMode: "comment", publicReplyText: ` ${REPLY} `,
    commentScope: "all", commentMatchType: "keyword", keywords: "اسعار, price", ...trig}},
    {id: "dm", data: {kind: "message", text: DM, image: "", options: [], contentBlocks: []}}],
  edges: [{source: "start", target: "dm"}],
});
type Acc = {id: string; tenant: string; platform: "instagram" | "facebook"; ext: string; status?: string | null};
function world(accounts: Acc[], o: {trig?: Row; flowFor?: string[]} = {}) {
  const db = new FakeDb();
  for (const a of accounts) {
    db.t.channel_accounts.push({id: a.id, tenant_id: a.tenant, platform: a.platform, channel: a.platform, external_id: a.ext,
      status: a.status === undefined ? "active" : a.status, is_active: true, agent_enabled: true, auto_reply: true,
      access_token_encrypted: "enc:v1:x"});
    if (o.flowFor && !o.flowFor.includes(a.id)) continue;
    db.t.automation_flow_activations.push({tenant_id: a.tenant, channel_account_id: a.id, platform: a.platform,
      flow_key: "cflow", revision: 2, is_active: true});
    db.t.automation_flow_publications.push({tenant_id: a.tenant, channel_account_id: a.id, platform: a.platform,
      flow_key: "cflow", revision: 2, document: doc(a.platform === "facebook" ? "messenger" : "instagram", o.trig)});
    db.t.automation_flow_canary_accounts.push({tenant_id: a.tenant, channel_account_id: a.id, platform: a.platform});
    db.t.automation_flow_tenant_switches.push({tenant_id: a.tenant, enabled: true, production_approved: true});
  }
  return db;
}
const ENV = (canary: string, over: Row = {}): Record<string, string> => ({FLOW_COMMENT_AUTOMATION_ENABLED: "true",
  FLOW_DURABLE_INGRESS_ENABLED: "true", FLOW_MULTICHANNEL_ENABLED: "true", FLOW_DURABLE_CANARY_ACCOUNT_ID: canary, ...over});
const igChange = (id: string, text = "كم الأسعار؟", from = "990001") =>
  ({field: "comments", value: {id, text, from: {id: from, username: "sara"}, media: {id: "17900000000000009", media_product_type: "FEED"}}});
const fbChange = (id: string, o: Row = {}) => ({field: "feed", value: {item: "comment", verb: "add", comment_id: `${PAGE_ID}77_${id}`,
  post_id: `${PAGE_ID}_77`, parent_id: `${PAGE_ID}_77`, message: "What's the PRICE?", from: {id: "4455", name: "Ali"},
  created_time: NOW / 1000 - 60, ...o}});
const igBody = (changes: unknown[]) => ({object: "instagram", entry: [{id: IG_ID, time: NOW, changes}]});
const fbBody = (changes: unknown[]) => ({object: "page", entry: [{id: PAGE_ID, time: NOW / 1000, changes}]});
const sign = (raw: string, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

/** milan-api order: signature over the raw body FIRST, then per-entry comment ingest. */
async function deliver(db: FakeDb, body: unknown, env: Record<string, string>, sig?: string) {
  const raw = JSON.stringify(body);
  if (!await verifyMetaWebhookSignature(raw, sig ?? sign(raw), [SECRET])) return {verified: false, outcomes: [] as Row[]};
  const parsed = JSON.parse(raw);
  const outcomes: Row[] = [];
  for (const entry of parsed.entry ?? [])
    outcomes.push(await ingestSignedComments(db as never, parsed.object, entry, {
      env: (k) => env[k] ?? "", encrypt: async (s) => "enc:v1:" + Buffer.from(s).toString("hex"), nowMs: () => NOW,
    }));
  return {verified: true, outcomes};
}
const IG = (status?: string | null): Acc => ({id: IG_ACC, tenant: TA, platform: "instagram", ext: IG_ID, status});
const FB = (status?: string | null): Acc => ({id: FB_ACC, tenant: TA, platform: "facebook", ext: PAGE_ID, status});
const quiet = async <T>(fn: () => Promise<T>) => {
  const logs: unknown[] = [];
  const orig = {log: console.log, info: console.info, warn: console.warn, error: console.error};
  for (const k of ["log", "info", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a); };
  try { return {value: await fn(), logs}; } finally { Object.assign(console, orig); }
};

// ------------------------------------------------------------------ worker step (request shapes)
type Sent = {url: string; init: RequestInit};
async function workerSends(db: FakeDb, platform: "instagram" | "facebook") {
  const sends: Sent[] = [];
  const perform = (async (url: string, init: RequestInit) => {
    sends.push({url, init});
    return new Response(JSON.stringify(url.endsWith("/messages") ? {recipient_id: "1", message_id: "m_1"} : {id: "reply_1"}),
      {status: 200, headers: {"content-type": "application/json"}});
  }) as typeof fetch;
  const token = platform === "instagram" ? IG_TOKEN : PAGE_TOKEN;
  const ext = platform === "instagram" ? IG_ID : PAGE_ID;
  const reply = db.t.automation_flow_outbox.find((o) => o.effect_kind === "reply_comment")!;
  const cr = db.t.automation_comment_replies.find((r) => r.run_id === reply.run_id)!;
  const outcome = await executeCommentReply({
    claim: async (): Promise<CommentClaim> => ({outcome: "claimed", token: "lease", commentId: cr.comment_id,
      replyText: cr.public_reply_text, prior: "pending", attempts: 0}),
    finish: async (_t, result, replyId) => { if (result === "sent") Object.assign(cr, {reply_status: "sent", reply_id: replyId}); return result; },
    request: (commentId, text) => ({platform, token, externalId: ext, commentId, text}),
    perform,
  });
  assert.equal(outcome, "comment_reply_sent");
  // The DM is reachable only after the public reply is 'sent' (worker index.ts + SQL reserve rule).
  assert.equal(cr.reply_status, "sent");
  const dm = db.t.automation_flow_outbox.find((o) => o.effect_kind === "message" && o.run_id === reply.run_id)!;
  const req = {platform, token, externalId: ext, recipient: "990001", text: dm.payload.text, recipientCommentId: cr.comment_id};
  const mid = platform === "instagram" ? await sendProviderMessage(req, perform) : await sendMultichannelMessage(req, perform);
  assert.equal(mid, "m_1");
  for (const s of sends) assert.ok(!s.url.includes(token) && !s.url.includes("access_token"), "no token in any URL");
  return {sends, commentId: cr.comment_id as string};
}
const body = (s: Sent) => JSON.parse(String(s.init.body));
const headers = (s: Sent) => s.init.headers as Record<string, string>;

// ================================================================== tests
test("subscriptions: IG adds comments, FB adds feed; DM field lists unchanged", () => {
  assert.equal(IG_SUBSCRIBED_FIELDS, "messages,messaging_postbacks,messaging_seen,comments");
  assert.equal(FB_PAGE_SUBSCRIBED_FIELDS, "messages,messaging_postbacks,feed");
  assert.equal(IG_DM_SUBSCRIBED_FIELDS, "messages,messaging_postbacks,messaging_seen");
  assert.equal(FB_PAGE_DM_SUBSCRIBED_FIELDS, "messages,messaging_postbacks");
  // The subscribed names are exactly what the parser consumes.
  assert.equal(normalizeMetaComments(igBody([igChange("1801")])).length, 1);
  assert.equal(normalizeMetaComments(fbBody([fbChange("1")])).length, 1);
  assert.equal(normalizeMetaComments(igBody([{...igChange("1801"), field: "live_comments"}])).length, 0, "no unconsumed field");
});

test("IG end to end: signed comment -> one run [reply_comment, message] -> public reply + private reply request shapes", async () => {
  const db = world([IG()]);
  const {value: r, logs} = await quiet(() => deliver(db, igBody([igChange("1801", "كم الأسعار؟")]), ENV(IG_ACC)));
  assert.deepEqual(r, {verified: true, outcomes: [{started: 1}]});
  assert.equal(db.rpcs.length, 1);
  assert.equal(db.rpcs[0].args.p_tenant, TA);
  assert.deepEqual(db.t.automation_flow_outbox.map((o) => [o.effect_kind, o.payload.seq]), [["reply_comment", 0], ["message", 1]]);
  // Account lookup: platform + external id + the non-disconnected filter, limit 2.
  const acc = db.calls.find((c) => c.table === "channel_accounts")!;
  assert.deepEqual(acc.filters, ["eq:external_id", "eq:platform", "or:status.is.null,status.neq.disconnected"]);
  for (const c of db.calls.filter((c) => c.op === "select" && c.table !== "channel_accounts"))
    assert.ok(c.filters.includes("eq:tenant_id"), `${c.table} read is tenant-scoped`);
  for (const c of db.calls.filter((c) => c.op === "insert")) assert.ok(["conversations", "messages"].includes(c.table));
  assert.ok(db.t.messages.every((m) => m.tenant_id === TA) && db.t.conversations.every((c) => c.tenant_id === TA));
  assert.ok(!inspect(logs, {depth: null}).includes("الأسعار"), "comment text never logged");
  const {sends, commentId} = await workerSends(db, "instagram");
  assert.equal(commentId, "1801");
  assert.equal(sends[0].url, "https://graph.instagram.com/v21.0/1801/replies");
  assert.equal(sends[0].init.method, "POST");
  assert.equal(headers(sends[0]).authorization, `Bearer ${IG_TOKEN}`);
  assert.deepEqual(body(sends[0]), {message: REPLY});
  assert.equal(sends[1].url, "https://graph.instagram.com/v21.0/me/messages");
  assert.equal(headers(sends[1]).authorization, `Bearer ${IG_TOKEN}`);
  assert.deepEqual(body(sends[1]), {recipient: {comment_id: "1801"}, message: {text: DM}});
});

test("FB end to end: signed Page feed comment -> one run -> /{comment-id}/comments + Messenger private reply", async () => {
  const db = world([FB()]);
  const {value: r} = await quiet(() => deliver(db, fbBody([fbChange("9001")]), ENV(FB_ACC)));
  assert.deepEqual(r.outcomes, [{started: 1}]);
  const {sends, commentId} = await workerSends(db, "facebook");
  assert.equal(commentId, `${PAGE_ID}77_9001`);
  assert.equal(sends[0].url, `https://graph.facebook.com/v21.0/${commentId}/comments`);
  // Existing FB public reply shape: token in the JSON body (never the URL).
  assert.deepEqual(body(sends[0]), {message: REPLY, access_token: PAGE_TOKEN});
  assert.equal(sends[1].url, "https://graph.facebook.com/v21.0/me/messages");
  assert.equal(headers(sends[1]).authorization, `Bearer ${PAGE_TOKEN}`);
  assert.deepEqual(body(sends[1]), {recipient: {comment_id: commentId}, messaging_type: "RESPONSE", message: {text: DM}});
});

test("signature failure: nothing parsed, no database access", async () => {
  const db = world([IG()]);
  const b = igBody([igChange("1801")]);
  for (const sig of ["", "sha256=" + "0".repeat(64), sign(JSON.stringify(b), "other-secret")]) {
    const r = await deliver(db, b, ENV(IG_ACC), sig);
    assert.equal(r.verified, false);
  }
  assert.equal(db.calls.length + db.rpcs.length, 0);
});

test("account resolution: disconnected rows ignored; needs_reauth / ambiguous / unknown / wrong tenant never start", async () => {
  // Stale disconnected row of ANOTHER tenant + the live row: the live row wins.
  let db = world([IG(), {id: IG_ACC_B, tenant: TB, platform: "instagram", ext: IG_ID, status: "disconnected"}]);
  assert.deepEqual((await quiet(() => deliver(db, igBody([igChange("1801")]), ENV(IG_ACC)))).value.outcomes, [{started: 1}]);
  assert.equal(db.rpcs[0].args.p_tenant, TA);
  // Only a disconnected row: no account.
  db = world([IG("disconnected")]);
  assert.deepEqual((await quiet(() => deliver(db, igBody([igChange("1801")]), ENV(IG_ACC)))).value.outcomes, [{ineligible: 1}]);
  assert.equal(db.rpcs.length, 0);
  // needs_reauth / NULL status: ignored with a fixed tag, no ids/status in the log.
  for (const st of ["needs_reauth", null]) {
    db = world([IG(st)]);
    const q = await quiet(() => deliver(db, igBody([igChange("1801")]), ENV(IG_ACC)));
    assert.deepEqual(q.value.outcomes, [{ineligible: 1}]);
    assert.equal(db.rpcs.length, 0);
    const text = inspect(q.logs, {depth: null});
    assert.ok(text.includes("[comment-ingress] account not active — comments ignored"));
    assert.ok(!text.includes(IG_ID) && !text.includes(IG_ACC) && !text.includes(TA));
  }
  // Two live rows (two tenants): dropped, no second candidate tried.
  db = world([IG(), {id: IG_ACC_B, tenant: TB, platform: "instagram", ext: IG_ID}]);
  for (const canary of [IG_ACC, IG_ACC_B]) {
    const q = await quiet(() => deliver(db, igBody([igChange("1801")]), ENV(canary)));
    assert.deepEqual(q.value.outcomes, [{ineligible: 1}]);
    assert.ok(inspect(q.logs).includes("[comment-ingress] account lookup failed or ambiguous — comments ignored"));
  }
  assert.equal(db.rpcs.length, 0);
  // Unknown id / an Instagram row never answers a Page event (platform-scoped).
  db = world([IG()]);
  assert.deepEqual((await quiet(() => deliver(db, {object: "page", entry: [{id: IG_ID, changes: [fbChange("1")]}]}, ENV(IG_ACC)))).value.outcomes,
    [{ineligible: 1}]);
  // Wrong tenant: the id belongs to tenant B; tenant A's canary/flows are never used.
  db = world([{id: IG_ACC_B, tenant: TB, platform: "instagram", ext: IG_ID}]);
  assert.deepEqual((await quiet(() => deliver(db, igBody([igChange("1801")]), ENV(IG_ACC)))).value.outcomes, [{ineligible: 1}]);
  assert.equal(db.rpcs.length, 0);
  assert.deepEqual((await quiet(() => deliver(db, igBody([igChange("1802")]), ENV(IG_ACC_B)))).value.outcomes, [{started: 1}]);
  assert.equal(db.rpcs[0].args.p_tenant, TB);
  assert.equal(db.rpcs[0].args.p_account, IG_ACC_B);
});

test("eligibility: every flag fail-closed (no DB access); FB needs FLOW_MULTICHANNEL_ENABLED; canary + SQL activation", async () => {
  for (const over of [{FLOW_COMMENT_AUTOMATION_ENABLED: ""}, {FLOW_COMMENT_AUTOMATION_ENABLED: "TRUE"}, {FLOW_DURABLE_INGRESS_ENABLED: "1"}]) {
    const db = world([IG(), FB()]);
    assert.deepEqual((await deliver(db, igBody([igChange("1801")]), ENV(IG_ACC, over))).outcomes, [{}]);
    assert.deepEqual((await deliver(db, fbBody([fbChange("1")]), ENV(FB_ACC, over))).outcomes, [{}]);
    assert.equal(db.calls.length + db.rpcs.length, 0);
  }
  let db = world([FB()]);
  assert.deepEqual((await deliver(db, fbBody([fbChange("1")]), ENV(FB_ACC, {FLOW_MULTICHANNEL_ENABLED: ""}))).outcomes, [{}]);
  assert.equal(db.calls.length, 0);
  // Not the operator-selected canary account: no run.
  db = world([IG()]);
  assert.deepEqual((await quiet(() => deliver(db, igBody([igChange("1801")]), ENV("other")))).value.outcomes, [{ineligible: 1}]);
  assert.equal(db.rpcs.length, 0);
  // SQL side: no canary registration / no production approval -> the begin RPC refuses.
  db = world([IG()]);
  db.t.automation_flow_canary_accounts = [];
  assert.deepEqual((await quiet(() => deliver(db, igBody([igChange("1801")]), ENV(IG_ACC)))).value.outcomes, [{refused: 1}]);
  db = world([IG()]);
  db.t.automation_flow_tenant_switches[0].production_approved = false;
  assert.deepEqual((await quiet(() => deliver(db, igBody([igChange("1801")]), ENV(IG_ACC)))).value.outcomes, [{refused: 1}]);
  assert.equal(db.t.automation_flow_outbox.length, 0);
  // No active comment flow: nothing.
  db = world([IG()], {flowFor: []});
  assert.deepEqual((await quiet(() => deliver(db, igBody([igChange("1801")]), ENV(IG_ACC)))).value.outcomes, [{no_match: 1}]);
});

test("keyword matching: Arabic variants, case, any-of keywords, no match, empty, 'any comment'", async () => {
  const run = async (text: string, trig: Row = {}) => {
    const db = world([IG()], {trig});
    return (await quiet(() => deliver(db, igBody([igChange("1801", text)]), ENV(IG_ACC)))).value.outcomes[0];
  };
  for (const t of ["كم الأسعار؟", "كم الاسعار", "كم الأَسعار", "كم الأســعار", "PRICE please", "price"]) // alef/diacritic/tatweel/case
    assert.deepEqual(await run(t), {started: 1}, t);
  assert.deepEqual(await run("مرحبا"), {no_match: 1});
  assert.deepEqual(await run("   "), {}, "empty comment dropped");
  assert.deepEqual(await run("مرحبا", {commentMatchType: "any", keywords: ""}), {started: 1}, "any comment");
  assert.deepEqual(await run("كم الأسعار", {commentScope: "specific", commentPostId: "17900000000000010"}), {no_match: 1}, "other post");
});

test("dedupe: sequential and concurrent duplicate deliveries -> exactly one run and one reply/DM pair", async () => {
  // Sequential redelivery (edge dedupe read), even without a messages unique index.
  let db = world([IG()]);
  db.messagesUnique = false;
  const b = igBody([igChange("1801")]);
  assert.deepEqual((await quiet(() => deliver(db, b, ENV(IG_ACC)))).value.outcomes, [{started: 1}]);
  assert.deepEqual((await quiet(() => deliver(db, b, ENV(IG_ACC)))).value.outcomes, [{duplicate: 1}]);
  assert.equal(db.rpcs.length, 1);
  // Same comment twice in one body.
  db = world([IG()]);
  assert.deepEqual((await quiet(() => deliver(db, igBody([igChange("1801"), igChange("1801")]), ENV(IG_ACC)))).value.outcomes, [{started: 1}]);
  // Concurrent deliveries (both pass the edge read): the unique keys decide.
  for (const unique of [true, false]) {
    db = world([IG()]);
    db.messagesUnique = unique;
    db.t.conversations.push({id: "c1", tenant_id: TA, account_id: IG_ACC, wa_chat_id: "instagram:990001"});
    const both = await quiet(() => Promise.all([deliver(db, b, ENV(IG_ACC)), deliver(db, b, ENV(IG_ACC))]));
    const flat = both.value.flatMap((x) => x.outcomes);
    assert.equal(flat.filter((o) => o.started === 1).length, 1, `exactly one start (messages unique=${unique})`);
    assert.equal(db.t.automation_flow_runs.length, 1);
    assert.equal(db.t.automation_comment_replies.length, 1);
    assert.deepEqual(db.t.automation_flow_outbox.map((o) => o.effect_kind), ["reply_comment", "message"]);
  }
  // FB redelivery as well.
  db = world([FB()]);
  await quiet(() => deliver(db, fbBody([fbChange("9001")]), ENV(FB_ACC)));
  assert.deepEqual((await quiet(() => deliver(db, fbBody([fbChange("9001")]), ENV(FB_ACC)))).value.outcomes, [{duplicate: 1}]);
  assert.equal(db.t.automation_flow_runs.length, 1);
});

test("self/loop: own comments and our echoed public reply never start; FB edit/remove/hide verbs ignored", async () => {
  let db = world([IG()]);
  // Own account id (entry.id), keyword-matching text that differs from the reply text.
  assert.deepEqual((await quiet(() => deliver(db, igBody([igChange("1801", "شكراً، الأسعار بالخاص", IG_ID)]), ENV(IG_ACC)))).value.outcomes, [{}]);
  // Our public reply echoed under an unrecognized author id: loop breaker.
  db = world([IG()], {trig: {commentMatchType: "any", keywords: ""}});
  assert.deepEqual((await quiet(() => deliver(db, igBody([igChange("1802", REPLY, "5550001")]), ENV(IG_ACC)))).value.outcomes, [{self: 1}]);
  assert.equal(db.rpcs.length, 0);
  db = world([FB()]);
  assert.deepEqual((await quiet(() => deliver(db, fbBody([fbChange("1", {from: {id: PAGE_ID, name: "Page"}})]), ENV(FB_ACC)))).value.outcomes, [{}]);
  for (const verb of ["edited", "remove", "hide", "unhide"])
    assert.deepEqual((await quiet(() => deliver(db, fbBody([fbChange("2", {verb})]), ENV(FB_ACC)))).value.outcomes, [{}], verb);
  // Non-comment feed items (posts, reactions) never touch the database.
  assert.deepEqual((await deliver(db, fbBody([{field: "feed", value: {item: "reaction", verb: "add", post_id: `${PAGE_ID}_77`,
    from: {id: "4455"}}}, {field: "feed", value: {item: "status", verb: "add", post_id: `${PAGE_ID}_78`, message: "x", from: {id: PAGE_ID}}}]),
    ENV(FB_ACC))).outcomes, [{}]);
  assert.equal(db.calls.length + db.rpcs.length, 0);
  // A DM-only (old-field) Instagram event reaches no comment code path.
  assert.deepEqual((await deliver(db, {object: "instagram", entry: [{id: IG_ID, messaging: [{sender: {id: "1"}, message: {mid: "m", text: "hi"}}]}]},
    ENV(IG_ACC))).outcomes, [{}]);
  assert.equal(db.calls.length, 0);
});

test("private reply window: exact 7-day boundary (minus the send margin), missing / unparseable created_time", async () => {
  assert.equal(PRIVATE_REPLY_WINDOW_MS, 7 * 24 * 3600 * 1000);
  assert.equal(COMMENT_START_MAX_AGE_MS, PRIVATE_REPLY_WINDOW_MS - PRIVATE_REPLY_SEND_MARGIN_MS);
  // The DM can only be sent within OUTBOX_STALE_MINUTES (+ a 2-minute lease) of the run start.
  assert.ok(PRIVATE_REPLY_SEND_MARGIN_MS >= (OUTBOX_STALE_MINUTES + 2) * 60_000);
  const edgeSec = (NOW - COMMENT_START_MAX_AGE_MS) / 1000;
  const run = async (o: Row) => {
    const db = world([FB()]);
    const q = await quiet(() => deliver(db, fbBody([fbChange("9001", o)]), ENV(FB_ACC)));
    return {out: q.value.outcomes[0], rpcs: db.rpcs.length, logs: inspect(q.logs)};
  };
  assert.deepEqual((await run({created_time: edgeSec})).out, {started: 1}, "exactly at the boundary");
  const old = await run({created_time: edgeSec - 1});
  assert.deepEqual([old.out, old.rpcs], [{too_old: 1}, 0], "one second past the boundary");
  assert.ok(old.logs.includes("[comment-ingress] comment older than the private reply window — not started"));
  assert.deepEqual((await run({created_time: (NOW - 8 * 24 * 3600 * 1000) / 1000})).out, {too_old: 1});
  // Missing / unparseable / future: judged by receipt time (live webhook only).
  for (const ct of [undefined, "yesterday", null, {}, (NOW + 3600_000) / 1000])
    assert.deepEqual((await run({created_time: ct})).out, {started: 1}, String(ct));
  assert.equal(normalizeMetaComments(fbBody([fbChange("9001")]))[0].createdTimeMs, NOW - 60_000);
  assert.equal("createdTimeMs" in normalizeMetaComments(igBody([igChange("1801")]))[0], false);
  // ISO and ms forms.
  assert.equal(commentCreatedTimeMs("2027-01-15T08:00:00+0000"), Date.parse("2027-01-15T08:00:00Z"));
  assert.equal(commentCreatedTimeMs(NOW), NOW);
  assert.equal(commentCreatedTimeMs(NOW / 1000), NOW);
  assert.equal(commentStartAgeOk(NOW - COMMENT_START_MAX_AGE_MS, NOW), true);
  assert.equal(commentStartAgeOk(NOW - COMMENT_START_MAX_AGE_MS - 1, NOW), false);
  // Instagram comment webhooks carry no created_time: started on receipt.
  const db = world([IG()]);
  assert.deepEqual((await quiet(() => deliver(db, igBody([igChange("1801")]), ENV(IG_ACC)))).value.outcomes, [{started: 1}]);
});

test("one private reply per comment: a comment flow has exactly one DM effect; the worker sends it as recipient.comment_id", () => {
  const w = readFileSync("supabase/functions/flow-outbox-worker/index.ts", "utf8");
  // DM only while the activity row says dm 'pending' and the public reply is 'sent'.
  assert.match(w, /if\(cr\.dm_status!=="pending"\|\|effect\.effect_kind!=="message"\|\|typeof cr\.comment_id!=="string"\)\{/);
  // Comment runs: a disconnected / needs_reauth account never replies (held).
  assert.ok(w.includes('select("id,tenant_id,platform,status,is_active,agent_enabled,auto_reply,external_id,access_token_encrypted")'));
  const guard = w.indexOf('if(commentRun&&account.status!=="active"){report("blocked");continue;}');
  assert.ok(guard > 0 && guard < w.indexOf('if(effect.effect_kind==="reply_comment"){'), "guard before the public reply");
  // The DM activity mirror runs for the Facebook (multichannel) branch too.
  const mc = w.indexOf("if(multichannel){\n    let multichannelFailure");
  const mirrorMc = w.indexOf("await mirrorCommentDm(sent);");
  assert.ok(mc > 0 && mirrorMc > mc && mirrorMc < w.indexOf("const res=await executeOnce({"));
  assert.ok(w.indexOf("await mirrorCommentDm(res);") > w.indexOf("const res=await executeOnce({"));
  assert.equal(w.split('.from("automation_comment_replies")\n     .update({dm_status:dm').length, 2, "one mirror implementation");
});

test("milan-api wiring: comment ingest only after the signature check; meta-auth uses the new subscription helper", () => {
  const idx = readFileSync("supabase/functions/milan-api/index.ts", "utf8");
  const sig = idx.indexOf("const sigOk = await verifyMetaSignature(");
  assert.ok(sig > 0 && idx.indexOf("await ingestSignedComments(") > sig);
  const meta = readFileSync("supabase/functions/meta-auth/index.ts", "utf8");
  assert.ok(meta.includes("await subscribeInstagramWebhooks(IG_GRAPH_V, token, { fetch, errCode: metaErrCode });"));
  const ingress = readFileSync("supabase/functions/milan-api/commentIngress.ts", "utf8");
  assert.ok(ingress.includes('.or("status.is.null,status.neq.disconnected")\n  .limit(2);'));
});
