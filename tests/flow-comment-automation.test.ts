// Comment automation: trigger config validation, webhook comment
// normalization (self-loop / dedupe), matching, and the public-reply-before-DM
// ordering / idempotency / failure-stops-DM rules of commentReply.ts.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  commentTriggerConfig, commentTriggerProblem, documentCommentTriggerProblem,
  normalizeMetaComments, commentMatches, normalizeCommentText, PUBLIC_REPLY_MAX,
} from "../supabase/functions/milan-api/commentTrigger.ts";
import {normalizeTriggerText} from "../src/flow/eventRouting.ts";
import {
  commentAutomationStep, dmClaimable, runReplyPhase, sendCommentReply, findExistingReply,
  classifyReplyFailure, COMMENT_REPLY_MAX_ATTEMPTS, type CommentAutomationState,
} from "../supabase/functions/flow-outbox-worker/commentReply.ts";

const trig = (o: Record<string, unknown>) => ({kind: "trigger", triggerMode: "comment", ...o});

test("config: camelCase document fields map to the snake_case model", () => {
  assert.deepEqual(commentTriggerConfig(trig({
    commentScope: "specific", commentPostId: " 17890000000000001 ", commentMatchType: "keyword",
    keywords: "سعر، أسعار, Price\n  price ", publicReplyText: "  راسلناك على الخاص  ",
  })), {
    target_scope: "specific", specific_post_id: "17890000000000001", match_type: "keyword",
    keywords: ["سعر", "اسعار", "price"], public_reply_text: "راسلناك على الخاص",
  });
  assert.deepEqual(commentTriggerConfig({target_scope: "all", match_type: "any", keywords: [], public_reply_text: "hi"}),
    {target_scope: "all", match_type: "any", keywords: [], public_reply_text: "hi"});
});

test("config: backward compatible defaults for documents without the new fields", () => {
  // scope absent -> all; match absent -> keyword when keywords exist, else any.
  assert.equal(commentTriggerConfig(trig({keywords: "", publicReplyText: "x"}))?.match_type, "any");
  assert.equal(commentTriggerConfig(trig({keywords: "a", publicReplyText: "x"}))?.match_type, "keyword");
  assert.equal(commentTriggerConfig(trig({publicReplyText: "x"}))?.target_scope, "all");
  // Non-comment documents: no new requirement at publication.
  assert.equal(documentCommentTriggerProblem({version: 3, nodes: [{id: "t", data: {kind: "trigger", triggerMode: "message"}}]}), null);
  assert.equal(documentCommentTriggerProblem({version: 3, nodes: [{id: "t", data: {kind: "trigger", triggerMode: "keyword", keywords: ""}}]}), null);
  assert.equal(documentCommentTriggerProblem(null), null);
});

test("config: server-side validation rejects every invalid shape", () => {
  const ok = {publicReplyText: "r"};
  const cases: Array<[Record<string, unknown>, string]> = [
    [{}, "public_reply_required"],
    [{publicReplyText: "   "}, "public_reply_required"],
    [{publicReplyText: 5}, "public_reply_required"],
    [{publicReplyText: "x".repeat(PUBLIC_REPLY_MAX + 1)}, "public_reply_too_long"],
    [{publicReplyText: "a\u0000b"}, "public_reply_invalid"],
    [{...ok, commentScope: "some"}, "comment_scope_invalid"],
    [{...ok, commentScope: "specific"}, "comment_post_id_required"],
    [{...ok, commentScope: "specific", commentPostId: "  "}, "comment_post_id_required"],
    [{...ok, commentScope: "specific", commentPostId: "../me?x=1"}, "comment_post_id_invalid"],
    [{...ok, commentScope: "specific", commentPostId: 123}, "comment_post_id_invalid"],
    [{...ok, commentMatchType: "regex"}, "comment_match_type_invalid"],
    [{...ok, commentMatchType: "keyword", keywords: ""}, "comment_keyword_required"],
    [{...ok, commentMatchType: "keyword", keywords: " , ،\n"}, "comment_keyword_required"],
    [{...ok, keywords: 7}, "comment_keywords_invalid"],
    [{...ok, keywords: ["a", 1]}, "comment_keywords_invalid"],
    [{...ok, keywords: "k".repeat(121)}, "comment_keyword_too_long"],
    [{...ok, keywords: "x".repeat(501)}, "comment_keywords_too_long"],
    [{...ok, keywords: Array.from({length: 41}, (_, i) => "w" + i)}, "comment_keywords_too_many"],
  ];
  for (const [data, code] of cases) assert.equal(commentTriggerProblem(trig(data)), code, JSON.stringify(data).slice(0, 80));
  assert.equal(commentTriggerProblem(trig({publicReplyText: "x".repeat(PUBLIC_REPLY_MAX)})), null);
  assert.equal(commentTriggerProblem(trig({...ok, commentScope: "specific", commentPostId: "1234_5678"})), null);
  assert.equal(documentCommentTriggerProblem({nodes: [{id: "t", data: trig({})}]}), "public_reply_required");
});

test("normalization is identical to src/flow/eventRouting.ts (Arabic-safe)", () => {
  for (const s of ["  أسعار  الاشتراك ", "ÉCOLE Price", "مـــرحبا", "إشتراك", "مستشفى", "سَعر", "Ａｂｃ"])
    assert.equal(normalizeCommentText(s), normalizeTriggerText(s));
});

const IG_ACCOUNT = "17841400000000001";
const igBody = (changes: unknown[]) => ({object: "instagram", entry: [{id: IG_ACCOUNT, time: 1, changes}]});
const igComment = (id: string, from = "990001", text = "كم السعر؟", media = "17900000000000009") =>
  ({field: "comments", value: {id, text, from: {id: from, username: "sara"}, media: {id: media, media_product_type: "FEED"}}});

test("webhook: instagram comments are extracted; own comments and duplicates dropped", () => {
  const out = normalizeMetaComments(igBody([
    igComment("1801"), igComment("1801"), // duplicate delivery inside one body
    igComment("1802", IG_ACCOUNT, "شكراً"), // the account itself (our public reply)
    igComment("1803", "777", "hi"),         // another own id (e.g. linked page)
    {field: "messages", value: {}}, {field: "comments", value: {id: "1804", text: "", from: {id: "1"}, media: {id: "2"}}},
    {field: "comments", value: {id: "x/../1", text: "a", from: {id: "1"}, media: {id: "2"}}},
  ]), ["777"]);
  assert.deepEqual(out, [{platform: "instagram", accountExternalId: IG_ACCOUNT, commentId: "1801",
    postId: "17900000000000009", parentId: null, text: "كم السعر؟", fromId: "990001", fromName: "sara"}]);
  assert.deepEqual(normalizeMetaComments({object: "whatsapp_business_account", entry: []}), []);
  assert.deepEqual(normalizeMetaComments("x"), []);
});

test("webhook: facebook page feed comments (verb add only)", () => {
  const body = {object: "page", entry: [{id: "1122334455", changes: [
    {field: "feed", value: {item: "comment", verb: "add", comment_id: "1122_9001", post_id: "1122334455_77",
      message: "price?", from: {id: "4455", name: "Ali"}, parent_id: "1122334455_77"}},
    {field: "feed", value: {item: "comment", verb: "edited", comment_id: "1122_9002", post_id: "1122334455_77", message: "x", from: {id: "4455"}}},
    {field: "feed", value: {item: "comment", verb: "add", comment_id: "1122_9003", post_id: "1122334455_77", message: "own", from: {id: "1122334455"}}},
    {field: "feed", value: {item: "reaction", verb: "add", post_id: "1122334455_77", from: {id: "4455"}}},
  ]}]};
  const out = normalizeMetaComments(body);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {platform: "facebook", accountExternalId: "1122334455", commentId: "1122_9001",
    postId: "1122334455_77", parentId: "1122334455_77", text: "price?", fromId: "4455", fromName: "Ali"});
});

test("matching: scope all/specific and match any/keyword", () => {
  const base = {public_reply_text: "r", keywords: [] as string[]};
  const c = {postId: "100", text: "شكد أسعار الاشتراك؟"};
  assert.equal(commentMatches({...base, target_scope: "all", match_type: "any"}, c), true);
  assert.equal(commentMatches({...base, target_scope: "specific", specific_post_id: "100", match_type: "any"}, c), true);
  assert.equal(commentMatches({...base, target_scope: "specific", specific_post_id: "101", match_type: "any"}, c), false);
  assert.equal(commentMatches({...base, target_scope: "specific", match_type: "any"}, c), false);
  const kw = commentTriggerConfig(trig({commentMatchType: "keyword", keywords: "اسعار, PRICE", publicReplyText: "r"}))!;
  assert.equal(commentMatches(kw, c), true); // alef folding: أسعار ~ اسعار
  assert.equal(commentMatches(kw, {postId: "1", text: "What's the Price"}), true);
  assert.equal(commentMatches(kw, {postId: "1", text: "hello"}), false);
  assert.equal(commentMatches({...base, target_scope: "all", match_type: "keyword"}, c), false);
});

const S = (o: Partial<CommentAutomationState>): CommentAutomationState =>
  ({replyStatus: "pending", replyAttempts: 0, dmStatus: "pending", ...o});

test("ordering: the DM is reachable only after the public reply is sent", () => {
  assert.deepEqual(commentAutomationStep(S({})), {action: "post_reply"});
  assert.deepEqual(commentAutomationStep(S({replyStatus: "attempting"})), {action: "none"});
  assert.deepEqual(commentAutomationStep(S({replyStatus: "uncertain"})), {action: "reconcile_reply"});
  assert.deepEqual(commentAutomationStep(S({replyStatus: "sent"})), {action: "send_dm"});
  assert.deepEqual(commentAutomationStep(S({replyStatus: "sent", dmStatus: "sent"})), {action: "none"});
  assert.deepEqual(commentAutomationStep(S({replyStatus: "failed"})), {action: "stop", replyStatus: "failed", dmStatus: "skipped"});
  assert.deepEqual(commentAutomationStep(S({replyAttempts: COMMENT_REPLY_MAX_ATTEMPTS})),
    {action: "stop", replyStatus: "failed", dmStatus: "skipped"});
  for (const r of ["pending", "attempting", "uncertain", "failed", "bogus", undefined])
    assert.equal(dmClaimable(r), false);
  assert.equal(dmClaimable("sent"), true);
});

type Call = {url: string; init?: RequestInit};
const fake = (responses: Array<Response | Error>) => {
  const calls: Call[] = [];
  const perform = (async (url: string, init?: RequestInit) => {
    calls.push({url, init});
    const r = responses.shift();
    if (!r) throw new Error("unexpected call");
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return {calls, perform};
};
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}});
const REQ = {platform: "instagram" as const, token: "IGQVJtok", externalId: IG_ACCOUNT, commentId: "1801", text: "راسلناك"};
const noJitter = () => 0;

test("reply: success posts once to the fixed Graph host, then (only then) the DM is next", async () => {
  const {calls, perform} = fake([res(200, {id: "1809"})]);
  const r = await runReplyPhase(S({}), REQ, perform, noJitter);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://graph.instagram.com/v21.0/1801/replies");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {message: "راسلناك"});
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer IGQVJtok");
  assert.equal(r?.replyId, "1809");
  assert.deepEqual(commentAutomationStep(r!.state), {action: "send_dm"});
  // Facebook page token / Facebook Page comment endpoints.
  const fb = fake([res(200, {id: "c1"}), res(200, {id: "c2"})]);
  await sendCommentReply({...REQ, token: "EAAtok"}, fb.perform);
  await sendCommentReply({...REQ, platform: "facebook", token: "EAAtok", externalId: "1122334455", commentId: "1122_9001"}, fb.perform);
  assert.equal(fb.calls[0].url, "https://graph.facebook.com/v21.0/1801/replies");
  assert.equal(fb.calls[1].url, "https://graph.facebook.com/v21.0/1122_9001/comments");
  assert.deepEqual(JSON.parse(String(fb.calls[1].init?.body)), {message: "راسلناك", access_token: "EAAtok"});
});

test("reply: unsafe ids/text never reach the network (SSRF-safe path)", async () => {
  for (const bad of [{commentId: "../me"}, {commentId: "1801?x=1"}, {commentId: "evil.com/1"},
    {externalId: "abc"}, {text: " "}, {text: "x".repeat(2201)}, {token: ""}]) {
    const {calls, perform} = fake([]);
    const r = await runReplyPhase(S({}), {...REQ, ...bad}, perform, noJitter);
    assert.equal(calls.length, 0);
    assert.equal(r?.state.replyStatus, "failed");
    assert.equal(r?.state.dmStatus, "skipped");
  }
});

test("failure stops the DM: permanent 4xx -> failed + dm skipped, no further calls", async () => {
  const {calls, perform} = fake([res(400, {error: {code: 100, message: "comment deleted"}})]);
  const r = await runReplyPhase(S({}), REQ, perform, noJitter);
  assert.equal(calls.length, 1);
  assert.deepEqual([r?.state.replyStatus, r?.state.dmStatus, r?.errorCode], ["failed", "skipped", "meta_100"]);
  assert.deepEqual(commentAutomationStep(r!.state), {action: "stop", replyStatus: "failed", dmStatus: "skipped"});
  assert.equal(dmClaimable(r!.state.replyStatus), false);
});

test("transient: throttling retries with backoff, bounded, DM never sent meanwhile", async () => {
  assert.equal(classifyReplyFailure(429, null), "retryable");
  assert.equal(classifyReplyFailure(400, 613), "retryable");
  assert.equal(classifyReplyFailure(503, null), "uncertain");
  assert.equal(classifyReplyFailure(403, 10), "permanent");
  let state = S({});
  for (let i = 1; i < COMMENT_REPLY_MAX_ATTEMPTS; i++) {
    const {perform} = fake([res(429, {error: {code: 4}})]);
    const r = (await runReplyPhase(state, REQ, perform, noJitter))!;
    assert.equal(r.state.replyStatus, "pending");
    assert.equal(r.retryDelaySeconds, 60 * 2 ** (i - 1) > 900 ? 900 : 60 * 2 ** (i - 1));
    assert.notEqual(commentAutomationStep(r.state).action, "send_dm");
    state = r.state;
  }
  const {perform} = fake([res(429, {error: {code: 4}})]);
  const last = (await runReplyPhase(state, REQ, perform, noJitter))!;
  assert.deepEqual([last.state.replyStatus, last.state.dmStatus, last.errorCode], ["failed", "skipped", "reply_attempts_exhausted"]);
});

test("idempotency: an uncertain attempt is reconciled, never blindly re-posted", async () => {
  // 1) timeout -> uncertain
  const t = fake([new Error("timeout")]);
  const r1 = (await runReplyPhase(S({}), REQ, t.perform, noJitter))!;
  assert.equal(r1.state.replyStatus, "uncertain");
  // 2) next tick: GET finds our reply (same author + text) -> sent, NO POST.
  const g = fake([res(200, {data: [
    {id: "1", text: "راسلناك", from: {id: "someone-else"}},
    {id: "1810", text: " راسلناك ", from: {id: IG_ACCOUNT}},
  ]})]);
  const r2 = (await runReplyPhase(r1.state, REQ, g.perform, noJitter))!;
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].init?.method, "GET");
  assert.ok(g.calls[0].url.startsWith("https://graph.instagram.com/v21.0/1801/replies?"));
  assert.deepEqual([r2.state.replyStatus, r2.replyId], ["sent", "1810"]);
  assert.deepEqual(commentAutomationStep(r2.state), {action: "send_dm"});
  // 3) once sent, a repeated tick never posts again.
  const again = fake([]);
  assert.equal(await runReplyPhase({...r2.state, dmStatus: "sent"}, REQ, again.perform), null);
  assert.equal(again.calls.length, 0);
  // Reconcile confirms absence -> pending (a fresh POST is then safe).
  const a = fake([res(200, {data: []})]);
  const r3 = (await runReplyPhase(r1.state, REQ, a.perform, noJitter))!;
  assert.equal(r3.state.replyStatus, "pending");
  // Reconcile read fails -> stays uncertain, no POST.
  const f = fake([res(500, {})]);
  const r4 = (await runReplyPhase(r1.state, REQ, f.perform, noJitter))!;
  assert.equal(r4.state.replyStatus, "uncertain");
  assert.equal(f.calls.length, 1);
  // 2xx without an id is uncertain too.
  const n = fake([res(200, {})]);
  assert.equal((await runReplyPhase(S({}), REQ, n.perform, noJitter))!.state.replyStatus, "uncertain");
  assert.equal(await findExistingReply({...REQ, commentId: "../x"}, fake([]).perform).catch(e => e.failure), "permanent");
});

test("flow-publication validates comment triggers at publish (422), after the document check", () => {
  const src = readFileSync("supabase/functions/flow-publication/index.ts", "utf8");
  const publish = src.slice(src.indexOf('if(action==="publish")'), src.indexOf('if(action==="list")'));
  const a = publish.indexOf('if(!doc)return error("Flow document is invalid or targets another channel",422);');
  const b = publish.indexOf("if(documentCommentTriggerProblem(doc)!==null)");
  const c = publish.indexOf('client.rpc("flow_publish_revision"');
  assert.ok(a > 0 && b > a && c > b, "validated before the publish RPC");
});

// ------------------------------------------------------------------ wiring
import {commentFlowPlan} from "../supabase/functions/milan-api/commentTrigger.ts";
import {ingestSignedComments,commentEffects} from "../supabase/functions/milan-api/commentIngress.ts";
import {readCommentActivity,decodeCursor,encodeCursor,COMMENT_ACTIVITY_MAX} from "../supabase/functions/milan-api/commentActivity.ts";
import {executeCommentReply,type CommentFinishResult} from "../supabase/functions/flow-outbox-worker/commentReply.ts";
import {sendProviderMessage} from "../supabase/functions/flow-outbox-worker/deliveryCore.ts";

const commentDoc = (over: Record<string, unknown> = {}, extra: {nodes?: unknown[]; edges?: unknown[]} = {}) => ({
  version: 3, name: "c",
  nodes: [{id: "start", data: {kind: "trigger", platform: "instagram", triggerMode: "comment", publicReplyText: " راسلناك ",
    commentScope: "all", commentMatchType: "keyword", keywords: "سعر", ...over}},
    {id: "dm", data: {kind: "message", text: " تفاصيل السعر ", image: "", options: [], contentBlocks: []}},
    ...(extra.nodes ?? [])],
  edges: [{source: "start", target: "dm"}, ...(extra.edges ?? [])],
});

test("commentFlowPlan: only trigger(comment) -> one plain DM (-> optional end)", () => {
  const p = commentFlowPlan(commentDoc(), "instagram")!;
  assert.deepEqual([p.triggerId, p.messageId, p.dmText, p.endId, p.config.public_reply_text], ["start", "dm", "تفاصيل السعر", null, "راسلناك"]);
  assert.equal(commentFlowPlan(commentDoc({}, {nodes: [{id: "e", data: {kind: "end"}}], edges: [{source: "dm", target: "e"}]}), "instagram")?.endId, "e");
  assert.equal(commentFlowPlan(commentDoc({platform: "messenger"}), "facebook")?.messageId, "dm");
  assert.equal(commentFlowPlan(commentDoc(), "facebook"), null, "platform mismatch");
  assert.equal(commentFlowPlan(commentDoc({triggerMode: "message"}), "instagram"), null);
  assert.equal(commentFlowPlan(commentDoc({publicReplyText: ""}), "instagram"), null, "invalid config");
  assert.equal(commentFlowPlan(commentDoc({}, {nodes: [{id: "q", data: {kind: "message", text: "2", options: [], contentBlocks: []}}],
    edges: [{source: "dm", target: "q"}]}), "instagram"), null, "a second DM is never allowed (one private reply)");
  const withButtons = commentDoc();
  (withButtons.nodes[1] as {data: Record<string, unknown>}).data.options = [{id: "a", label: "a"}];
  assert.equal(commentFlowPlan(withButtons, "instagram"), null);
  assert.equal(commentFlowPlan({...commentDoc(), edges: [{source: "start", target: "dm", sourceHandle: "x"}]}, "instagram"), null);
  assert.equal(commentFlowPlan({...commentDoc(), edges: []}, "instagram"), null);
  assert.equal(commentFlowPlan(null, "instagram"), null);
});

// Minimal chainable Supabase fake: records calls, returns per-table results.
type Res = {data: unknown; error: null | {code: string}};
function fakeDb(results: Record<string, Res | ((op: string, q: Record<string, unknown>) => Res)>) {
  const calls: Array<{table: string; op: string; q: Record<string, unknown>}> = [];
  const rpcs: Array<{name: string; args: Record<string, unknown>}> = [];
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    let op = "select";
    const resolve = () => {
      calls.push({table, op, q});
      const r = results[table + ":" + op] ?? results[table];
      return typeof r === "function" ? r(op, q) : r ?? {data: null, error: {code: "missing"}};
    };
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "limit", "order", "or", "is", "gt", "lte"])
      chain[m] = (...a: unknown[]) => { if (m !== "select" || op === "select") q[m + ":" + String(a[0])] = a[1] ?? a[0]; return chain; };
    chain.insert = (row: unknown) => { op = "insert"; q.row = row; return chain; };
    chain.update = (row: unknown) => { op = "update"; q.row = row; return chain; };
    chain.maybeSingle = async () => resolve();
    chain.single = async () => resolve();
    chain.then = (ok: (v: Res) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve()).then(ok, bad);
    return chain;
  };
  const rpc = async (name: string, args: Record<string, unknown>) => { rpcs.push({name, args}); return results["rpc:" + name] as Res ?? {data: null, error: {code: "missing"}}; };
  return {db: {from, rpc} as never, calls, rpcs};
}
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CONV = "44444444-4444-4444-8444-444444444444", MSG = "55555555-5555-4555-8555-555555555555";
const ENV: Record<string, string> = {FLOW_COMMENT_AUTOMATION_ENABLED: "true", FLOW_DURABLE_INGRESS_ENABLED: "true",
  FLOW_DURABLE_CANARY_ACCOUNT_ID: ACCOUNT};
const deps = (env = ENV) => ({env: (k: string) => env[k] ?? "", encrypt: async (s: string) => "enc:v1:" + Buffer.from(s).toString("hex")});
const entry = (changes: unknown[]) => ({id: IG_ACCOUNT, time: 1, changes});
const happy = (over: Record<string, Res> = {}) => fakeDb({
  channel_accounts: {data: [{id: ACCOUNT, tenant_id: TENANT, platform: "instagram", external_id: IG_ACCOUNT, status: "active"}], error: null},
  automation_flow_activations: {data: [{flow_key: "cig", revision: 3, is_active: true}], error: null},
  automation_flow_publications: {data: {document: commentDoc()}, error: null},
  automation_comment_replies: {data: [], error: null},
  "conversations:select": {data: {id: CONV, tenant_id: TENANT, account_id: ACCOUNT}, error: null},
  "messages:insert": {data: {id: MSG}, error: null},
  "rpc:flow_begin_comment_run": {data: "66666666-6666-4666-8666-666666666666", error: null},
  ...over,
});

test("ingress: flag OFF (or ingress OFF / not the canary) -> no database access", async () => {
  for (const env of [{}, {...ENV, FLOW_COMMENT_AUTOMATION_ENABLED: "false"}, {...ENV, FLOW_DURABLE_INGRESS_ENABLED: ""}]) {
    const f = happy();
    assert.deepEqual(await ingestSignedComments(f.db, "instagram", entry([igComment("1801")]), deps(env as Record<string, string>)), {});
    assert.equal(f.calls.length + f.rpcs.length, 0);
  }
  // Facebook Page comments additionally need FLOW_MULTICHANNEL_ENABLED.
  const fb = happy();
  assert.deepEqual(await ingestSignedComments(fb.db, "page", entry([]), deps()), {});
  assert.equal(fb.calls.length, 0);
  const other = happy();
  const r = await ingestSignedComments(other.db, "instagram", entry([igComment("1801")]), deps({...ENV, FLOW_DURABLE_CANARY_ACCOUNT_ID: "x"}));
  assert.deepEqual(r, {ineligible: 1});
  assert.equal(other.rpcs.length, 0);
});

test("ingress: matched comment -> persisted inbound + ONE begin RPC with reply-first effects", async () => {
  const f = happy();
  const r = await ingestSignedComments(f.db, "instagram", entry([igComment("1801", "990001", "كم السعر؟")]), deps());
  assert.deepEqual(r, {started: 1});
  assert.equal(f.rpcs.length, 1);
  const a = f.rpcs[0].args;
  assert.equal(f.rpcs[0].name, "flow_begin_comment_run");
  assert.deepEqual([a.p_tenant, a.p_account, a.p_conversation, a.p_inbound, a.p_comment_id, a.p_post_id, a.p_from_id, a.p_from_name,
    a.p_flow, a.p_revision, a.p_start, a.p_next, a.p_next_step],
    [TENANT, ACCOUNT, CONV, MSG, "1801", "17900000000000009", "990001", "sara", "cig", 3, "start", "dm", 1]);
  const fx = a.p_effects as Array<{kind: string; payload: Record<string, unknown>}>;
  assert.deepEqual(fx.map(e => [e.kind, e.payload.kind, e.payload.seq]), [["reply_comment", "reply_comment", 0], ["message", "message", 1]]);
  assert.equal(fx[0].payload.text, "راسلناك");
  assert.equal(fx[0].payload.commentId, "1801");
  assert.equal(fx[1].payload.text, "تفاصيل السعر");
  // Comment text only ever stored encrypted; inbound uses the comment event id.
  const ins = f.calls.find(c => c.table === "messages" && c.op === "insert")!.q.row as Record<string, unknown>;
  assert.equal(ins.wa_message_id, "comment:1801");
  assert.ok(String(ins.body_encrypted).startsWith("enc:v1:"));
  assert.equal(a.p_comment_encrypted, ins.body_encrypted);
  // Every read is tenant-scoped.
  for (const c of f.calls.filter(c => ["automation_flow_activations", "automation_flow_publications", "automation_comment_replies", "conversations"].includes(c.table)))
    assert.equal(c.q["eq:tenant_id"], TENANT, c.table);
});

test("ingress: duplicate, no keyword match, own comment and ambiguous flows never start a run", async () => {
  const dup = happy({automation_comment_replies: {data: [{id: "x"}], error: null}});
  assert.deepEqual(await ingestSignedComments(dup.db, "instagram", entry([igComment("1801")]), deps()), {duplicate: 1});
  assert.equal(dup.rpcs.length, 0);
  const nomatch = happy();
  assert.deepEqual(await ingestSignedComments(nomatch.db, "instagram", entry([igComment("1801", "1", "hello")]), deps()), {no_match: 1});
  assert.equal(nomatch.rpcs.length, 0);
  const self = happy();
  assert.deepEqual(await ingestSignedComments(self.db, "instagram", entry([igComment("1801", IG_ACCOUNT, "سعر")]), deps()), {});
  assert.equal(self.rpcs.length, 0);
  const amb = happy({automation_flow_activations: {data: [{flow_key: "a", revision: 1, is_active: true}, {flow_key: "b", revision: 1, is_active: true}], error: null}});
  assert.deepEqual(await ingestSignedComments(amb.db, "instagram", entry([igComment("1801")]), deps()), {ambiguous: 1});
  const redelivered = happy({"messages:insert": {data: null, error: {code: "23505"}}});
  assert.deepEqual(await ingestSignedComments(redelivered.db, "instagram", entry([igComment("1801")]), deps()), {duplicate: 1});
  assert.equal(redelivered.rpcs.length, 0);
  const refused = happy({"rpc:flow_begin_comment_run": {data: null, error: null}});
  assert.deepEqual(await ingestSignedComments(refused.db, "instagram", entry([igComment("1801")]), deps()), {refused: 1});
  const foreignConv = happy({"conversations:select": {data: {id: CONV, tenant_id: TENANT, account_id: "other"}, error: null}});
  assert.deepEqual(await ingestSignedComments(foreignConv.db, "instagram", entry([igComment("1801")]), deps()), {ineligible: 1});
});

test("commentEffects: idempotency keys are per flow/revision/comment", () => {
  const plan = commentFlowPlan(commentDoc(), "instagram")!;
  const c = normalizeMetaComments(igBody([igComment("1801")]))[0];
  const a = commentEffects("cig", 1, c, plan), b = commentEffects("cig", 1, c, plan);
  assert.deepEqual(a, b);
  assert.notEqual(a[0].idempotencyKey, a[1].idempotencyKey);
  assert.notEqual(commentEffects("cig", 2, c, plan)[0].idempotencyKey, a[0].idempotencyKey);
});

// executeCommentReply: claim -> post/reconcile -> finish; never a DM.
const claimed = (prior: "pending" | "uncertain" = "pending", attempts = 0) =>
  ({outcome: "claimed" as const, token: "tok", commentId: "1801", replyText: "راسلناك", prior, attempts});
function replyDeps(claim: unknown, responses: Array<Response | Error>) {
  const finishes: Array<[string, CommentFinishResult, string | null, string | null, number, boolean]> = [];
  const net = fake(responses);
  return {finishes, net, d: {
    claim: async () => claim as never,
    finish: async (t: string, r: CommentFinishResult, id: string | null, code: string | null, delay: number, posted: boolean) => {
      finishes.push([t, r, id, code, delay, posted]); return r === "absent" || r === "retry" ? r : r;
    },
    request: (commentId: string, text: string) => ({...REQ, commentId, text}),
    perform: net.perform, random: () => 0,
  }};
}
test("worker reply: sent / failed / retry / uncertain / reconcile map to the finish RPC", async () => {
  let x = replyDeps(claimed(), [res(200, {id: "1809"})]);
  assert.equal(await executeCommentReply(x.d), "comment_reply_sent");
  assert.deepEqual(x.finishes, [["tok", "sent", "1809", null, 0, true]]);
  x = replyDeps(claimed(), [res(400, {error: {code: 100}})]);
  assert.equal(await executeCommentReply(x.d), "comment_reply_failed");
  assert.deepEqual(x.finishes, [["tok", "failed", null, "meta_100", 0, true]]);
  x = replyDeps(claimed(), [res(429, {error: {code: 4}})]);
  assert.equal(await executeCommentReply(x.d), "comment_reply_retry");
  assert.deepEqual(x.finishes, [["tok", "retry", null, "meta_4", 60, true]]);
  x = replyDeps(claimed(), [new Error("timeout")]);
  assert.equal(await executeCommentReply(x.d), "comment_reply_uncertain");
  assert.equal(x.finishes[0][1], "uncertain");
  // Uncertain: GET only; found -> sent without counting a post.
  x = replyDeps(claimed("uncertain", 1), [res(200, {data: [{id: "1810", text: "راسلناك", from: {id: IG_ACCOUNT}}]})]);
  assert.equal(await executeCommentReply(x.d), "comment_reply_sent");
  assert.equal(x.net.calls[0].init?.method, "GET");
  assert.deepEqual(x.finishes, [["tok", "sent", "1810", null, 0, false]]);
  x = replyDeps(claimed("uncertain", 1), [res(200, {data: []})]);
  assert.equal(await executeCommentReply(x.d), "comment_reply_absent");
  assert.deepEqual(x.finishes, [["tok", "absent", null, "reply_absent_after_uncertain", 0, false]]);
  // Not claimable / claim error: no network, no finish.
  for (const c of [{outcome: "not_claimable"}, null]) {
    x = replyDeps(c, []);
    assert.match(await executeCommentReply(x.d), /not_claimable|claim_error/);
    assert.equal(x.net.calls.length + x.finishes.length, 0);
  }
});

test("deliveryCore: private reply uses recipient.comment_id; without it the body is byte-identical", async () => {
  const bodies: string[] = [];
  const perform = (async (_u: string, init?: RequestInit) => { bodies.push(String(init?.body)); return res(200, {message_id: "m1"}); }) as unknown as typeof fetch;
  const base = {platform: "instagram" as const, token: "IGQtok", externalId: IG_ACCOUNT, recipient: "990001", text: "hi"};
  await sendProviderMessage(base, perform);
  assert.equal(bodies[0], JSON.stringify({recipient: {id: "990001"}, message: {text: "hi"}}));
  await sendProviderMessage({...base, recipientCommentId: "1801"}, perform);
  assert.equal(bodies[1], JSON.stringify({recipient: {comment_id: "1801"}, message: {text: "hi"}}));
  await sendProviderMessage({...base, platform: "facebook", token: "EAA", recipientCommentId: "11_22"}, perform);
  assert.deepEqual(JSON.parse(bodies[2]).recipient, {comment_id: "11_22"});
  for (const bad of ["../x", "1801?a=1", ""])
    await assert.rejects(sendProviderMessage({...base, recipientCommentId: bad}, perform), /Invalid private reply/);
  await assert.rejects(sendProviderMessage({...base, platform: "whatsapp", recipientCommentId: "1"}, perform));
});

test("comment_activity: tenant-scoped, bounded, strict cursor, status mapping, server-side decrypt", async () => {
  const rows = [
    {id: "r3", tenant_id: TENANT, from_name: "Sara", comment_text_encrypted: "enc:A", created_at: "2026-11-08T10:00:03.000000+00:00",
      reply_status: "sent", public_reply_text: "راسلناك", dm_status: "sent"},
    {id: "r2", tenant_id: TENANT, from_name: null, comment_text_encrypted: "enc:B", created_at: "2026-11-08T10:00:02.000000+00:00",
      reply_status: "uncertain", public_reply_text: "x", dm_status: "pending"},
    {id: "77777777-7777-4777-8777-777777777777", tenant_id: TENANT, from_name: "Ali", comment_text_encrypted: "enc:C", created_at: "2026-11-08T10:00:01.000000+00:00",
      reply_status: "failed", public_reply_text: "y", dm_status: "skipped"},
    {id: "foreign", tenant_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", comment_text_encrypted: "enc:Z", created_at: "2026-11-08T10:00:00Z",
      reply_status: "sent", public_reply_text: "z", dm_status: "sent"},
  ];
  const f = fakeDb({automation_comment_replies: (_op, q) => ({data: rows.slice(0, Number(q["limit:" + q["limit:undefined"]]) || 99), error: null})});
  const decrypted: string[] = [];
  const dec = async (e: string) => { decrypted.push(e); if (e === "enc:B") throw new Error("bad key"); return "plain:" + e; };
  const r = await readCommentActivity(f.db, TENANT, {limit: 100}, dec);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.items.map(i => [i.id, i.customerName, i.commentText, i.publicReplyStatus, i.publicReplyText, i.dmStatus]), [
    ["r3", "Sara", "plain:enc:A", "sent", "راسلناك", "sent"],
    ["r2", null, null, "pending", "x", "pending"],
    ["77777777-7777-4777-8777-777777777777", "Ali", "plain:enc:C", "failed", "y", "skipped"],
  ]);
  assert.ok(!decrypted.includes("enc:Z"), "another tenant's row is never decrypted");
  assert.equal(r.nextCursor, null);
  const q = f.calls[0].q;
  assert.equal(q["eq:tenant_id"], TENANT);
  assert.equal(q["limit:101"], 101);
  // Pagination: limit 2 -> nextCursor from the 2nd row (fake returns 3 rows).
  const p = fakeDb({automation_comment_replies: {data: rows.slice(0, 3), error: null}});
  const r2 = await readCommentActivity(p.db, TENANT, {limit: 2}, async e => e);
  assert.ok(r2.ok && r2.items.length === 2);
  // Invalid input / failures leak nothing.
  for (const limit of [0, 101, 1.5, "10", -1])
    assert.deepEqual(await readCommentActivity(p.db, TENANT, {limit}, async e => e), {ok: false, error: "invalid_limit", status: 400});
  for (const cursor of ["not base64!", btoa("x"), btoa(JSON.stringify(["2026-11-08", "id"])), btoa(JSON.stringify(["2026-11-08T10:00:00Z,id.gt.0", TENANT]))])
    assert.deepEqual(await readCommentActivity(p.db, TENANT, {cursor}, async e => e), {ok: false, error: "invalid_cursor", status: 400});
  const good = encodeCursor("2026-11-08T10:00:02.000000+00:00", "77777777-7777-4777-8777-777777777777");
  assert.deepEqual(decodeCursor(good), {createdAt: "2026-11-08T10:00:02.000000+00:00", id: "77777777-7777-4777-8777-777777777777"});
  const c = fakeDb({automation_comment_replies: {data: [], error: null}});
  await readCommentActivity(c.db, TENANT, {cursor: good}, async e => e);
  assert.equal(c.calls[0].q["or:created_at.lt.2026-11-08T10:00:02.000000+00:00,and(created_at.eq.2026-11-08T10:00:02.000000+00:00,id.lt.77777777-7777-4777-8777-777777777777)"] !== undefined, true);
  const e = fakeDb({automation_comment_replies: {data: null, error: {code: "42501"}}});
  assert.deepEqual(await readCommentActivity(e.db, TENANT, {}, async x => x), {ok: false, error: "unavailable", status: 503});
  assert.equal(COMMENT_ACTIVITY_MAX, 100);
});

test("worker source: comment wiring only behind FLOW_COMMENT_AUTOMATION_ENABLED; existing queries unchanged", () => {
  const w = readFileSync("supabase/functions/flow-outbox-worker/index.ts", "utf8");
  assert.ok(w.includes('.in("delivery_status",["pending","charge_pending"]).in("effect_kind",["message","question","message_image"])'));
  assert.ok(w.includes('.eq("delivery_status","retry_wait").lte("retry_at",new Date().toISOString())\n  .in("effect_kind",["message","question"])'));
  const gate = w.indexOf('const commentOn=env("FLOW_COMMENT_AUTOMATION_ENABLED")==="true";');
  const q = w.indexOf('.eq("effect_kind","reply_comment")');
  assert.ok(gate > 0 && q > gate && w.lastIndexOf("if(commentOn){", q) > gate);
  assert.match(w, /if\(commentRun&&!commentOn\)\{report\("blocked"\);continue;\}/);
  assert.match(w, /if\(cr\.reply_status!=="sent"\)\{report\("held_comment_reply"\);continue;\}/);
  assert.ok(w.includes('...(commentRecipientId!==undefined?{recipientCommentId:commentRecipientId}:{})'));
  const idx = readFileSync("supabase/functions/milan-api/index.ts", "utf8");
  assert.match(idx, /if \(commentAutomationEnabled\(\)\) \{\n\s+await ingestSignedComments\(sb, body\.object, entry, \{/);
  const sig = idx.indexOf("const sigOk = await verifyMetaSignature(");
  assert.ok(sig > 0 && idx.indexOf("await ingestSignedComments(") > sig, "comments only after signature verification");
});
