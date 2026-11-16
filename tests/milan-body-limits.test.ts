// T5-S4: request body size limits and input boundaries for milan-api.
//  - bodyLimits.ts readBodyLimited(): per-class byte limit enforced on the
//    declared Content-Length (early reject, stream never read) AND on the bytes
//    actually received (streamed, cancelled as soon as the limit is exceeded);
//    returns exactly what req.text() returns (UTF-8 decode, BOM stripped).
//  - Classes: Meta webhooks 4 MiB, public / tiny-body endpoints 64 KiB, every
//    other action 1 MiB. Oversized body => 413; oversized / invalid field => 400.
//  - index.ts: the limited reader replaces `await req.text()` BEFORE JSON.parse
//    and BEFORE every signature check; field limits in create_tenant (after the
//    T5-S1 limiter), qa_save, ingest_text and knowledge_add.
// Behavioural parts run the REAL code: bodyLimits.ts / metaSignature.ts are
// imported; index.ts snippets are sliced out, type-stripped and run against
// fakes (same technique as tests/milan-claim-token.test.ts). No Deno / network / DB.
// Run: node --experimental-strip-types --test tests/milan-body-limits.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHmac} from "node:crypto";
import {stripTypeScriptTypes} from "node:module";
import {
  bodyClassFor, bodyLimitFor, readBodyLimited, META_WEBHOOK_BODY_MAX_BYTES, PUBLIC_BODY_MAX_BYTES,
  ACTION_BODY_MAX_BYTES, BODY_TOO_LARGE_MESSAGE, BODY_TOO_LARGE_LOG_TAG, INGEST_TEXT_MAX_CHARS,
  QA_SAVE_MAX_PAIRS, QA_QUESTION_MAX_CHARS, QA_ANSWER_MAX_CHARS, SOURCE_URL_MAX_CHARS,
  TEXT_TOO_LONG_MESSAGE, QA_PAIRS_LIMIT_MESSAGE, SOURCE_URL_INVALID_MESSAGE, textWithinLimit,
  qaPairsWithinLimits, optionalSourceUrlValid,
} from "../supabase/functions/milan-api/bodyLimits.ts";
import {verifyMetaWebhookSignature} from "../supabase/functions/milan-api/metaSignature.ts";

const IDX = readFileSync(process.env.MILAN_IDX ?? "supabase/functions/milan-api/index.ts", "utf8");
const strip = (s: string) => stripTypeScriptTypes(s, {mode: "strip"});
const enc = new TextEncoder();
const U = "https://milan.example/functions/v1/milan-api";

function between(src: string, a: string, b: string, from = 0) {
  const i = src.indexOf(a, from); const j = src.indexOf(b, i + a.length);
  assert.ok(i >= 0 && j > i, "located: " + a.slice(0, 60));
  return src.slice(i, j);
}
const once = (src: string, s: string) => {
  const i = src.indexOf(s); assert.ok(i >= 0, "located: " + s.slice(0, 60));
  assert.equal(src.indexOf(s, i + 1), -1, "unique: " + s.slice(0, 60)); return i;
};

/** Pull-driven body stream (highWaterMark 0: nothing is produced unless read). */
function trackedStream(chunks: Uint8Array[]) {
  const st = {pulls: 0, cancelled: 0, delivered: 0};
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      st.pulls++;
      if (i < chunks.length) { st.delivered += chunks[i].byteLength; c.enqueue(chunks[i++]); } else c.close();
    },
    cancel() { st.cancelled++; },
  }, {highWaterMark: 0});
  return {stream, st};
}
const split = (bytes: Uint8Array, size: number) => {
  const out: Uint8Array[] = [];
  for (let o = 0; o < bytes.byteLength; o += size) out.push(bytes.slice(o, o + size));
  return out;
};
const streamReq = (chunks: Uint8Array[], headers: Record<string, string> = {}, url = U) => {
  const t = trackedStream(chunks);
  return {req: new Request(url, {method: "POST", body: t.stream, headers, duplex: "half"} as RequestInit), st: t.st};
};
const bytesReq = (b: Uint8Array | string, headers: Record<string, string> = {}, url = U) =>
  new Request(url, {method: "POST", body: b, headers});

// ------------------------------------------------------------ index.ts handler prologue, run for real
const JSON_ERR_SRC = between(IDX, "const json = (", "/* ═══");
const HANDLER = IDX.slice(once(IDX, "Deno.serve(async (req) => {"));
const PROLOGUE_SRC = between(HANDLER, "  const url = new URL(req.url);", "  const sb = sbAdmin();");

async function prologue(req: Request) {
  const warns: string[] = [];
  const log = {warn: (...a: unknown[]) => warns.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" "))};
  const run = new Function("req", "console", "bodyClassFor", "bodyLimitFor", "readBodyLimited",
    "BODY_TOO_LARGE_MESSAGE", "BODY_TOO_LARGE_LOG_TAG",
    strip("const CORS={\"Access-Control-Allow-Origin\":\"*\"};\n" + JSON_ERR_SRC +
      "const __run = async () => {\n" + PROLOGUE_SRC + "\nreturn {raw, body, action};\n};") + "\nreturn __run();");
  const out = await run(req, log, bodyClassFor, bodyLimitFor, readBodyLimited, BODY_TOO_LARGE_MESSAGE, BODY_TOO_LARGE_LOG_TAG);
  return {out, warns};
}

// ------------------------------------------------------------ reader: identical to req.text()
test("under the limit: identical text to req.text() (empty, ASCII, Arabic, emoji, BOM, invalid UTF-8, split multibyte)", async () => {
  const samples: Uint8Array[] = [
    new Uint8Array(0),
    enc.encode('{"object":"page","entry":[]}'),
    enc.encode('{"text":"مرحبا بكم في المتجر — أهلًا"}'),
    enc.encode('{"m":"😀 emoji 𝄞"}'),
    new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('{"bom":true}')]),
    new Uint8Array([0x7b, 0xff, 0xc3, 0x28, 0xe2, 0x82, 0x7d]),
  ];
  for (const b of samples) {
    const expected = await bytesReq(b).text();
    for (const size of [1, 2, 3, 7, 1 << 16]) {
      const {req} = streamReq(split(b, size));
      const got = await readBodyLimited(req, 1024);
      assert.deepEqual(got, {ok: true, text: expected});
    }
    assert.deepEqual(await readBodyLimited(bytesReq(b), 1024), {ok: true, text: expected});
  }
  const get = new Request(U, {method: "GET"});
  assert.deepEqual(await readBodyLimited(get, 0), {ok: true, text: ""});
  assert.equal((await readBodyLimited(bytesReq(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 16) as {text: string}).text, "a");
  // Fetch "UTF-8 decode" strips exactly ONE leading BOM (Deno's req.text()
  // does the same; Node/undici strips twice, so this case is pinned to the spec).
  assert.equal((await readBodyLimited(bytesReq(new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x41])), 16) as {text: string}).text, "\uFEFFA");
});

test("over-limit declared Content-Length: rejected before reading, stream cancelled, never pulled", async () => {
  const {req, st} = streamReq([new Uint8Array(10)], {"content-length": "101"});
  assert.deepEqual(await readBodyLimited(req, 100), {ok: false, reason: "too_large"});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(st.pulls, 0);
  assert.equal(st.delivered, 0);
  assert.equal(st.cancelled, 1);
  // Huge declared values too.
  const big = streamReq([new Uint8Array(1)], {"content-length": "99999999999999999999999"});
  assert.equal((await readBodyLimited(big.req, 100)).ok, false);
  assert.equal(big.st.pulls, 0);
});

test("undeclared (chunked) body over the limit: rejected after at most limit + one chunk, then cancelled", async () => {
  const limit = 1000, chunk = 64;
  const {req, st} = streamReq(split(new Uint8Array(100_000), chunk));
  assert.deepEqual(await readBodyLimited(req, limit), {ok: false, reason: "too_large"});
  assert.ok(st.delivered <= limit + chunk, `delivered ${st.delivered}`);
  assert.equal(st.pulls, Math.floor(limit / chunk) + 1);
  assert.equal(st.cancelled, 1);
});

test("lying Content-Length (declares small, sends large): rejected on the actual bytes", async () => {
  const {req, st} = streamReq(split(new Uint8Array(5000), 100), {"content-length": "10"});
  assert.deepEqual(await readBodyLimited(req, 1000), {ok: false, reason: "too_large"});
  assert.equal(st.cancelled, 1);
  assert.ok(st.delivered <= 1100);
});

test("malformed / negative / non-numeric Content-Length: ignored, actual-bytes limit still applies", async () => {
  for (const cl of ["abc", "-1", "1e9", "", " ", "10, 10", "0x10", "+5", "12.5"]) {
    const small = streamReq([enc.encode('{"a":1}')], {"content-length": cl});
    assert.deepEqual(await readBodyLimited(small.req, 100), {ok: true, text: '{"a":1}'}, "cl=" + JSON.stringify(cl));
    const large = streamReq(split(new Uint8Array(500), 50), {"content-length": cl});
    assert.deepEqual(await readBodyLimited(large.req, 100), {ok: false, reason: "too_large"}, "cl=" + JSON.stringify(cl));
    assert.equal(large.st.cancelled, 1);
  }
});

test("boundary: exactly the limit passes, limit + 1 is rejected (declared and actual)", async () => {
  const limit = 256;
  const at = new Uint8Array(limit).fill(0x61);
  const over = new Uint8Array(limit + 1).fill(0x61);
  assert.deepEqual(await readBodyLimited(streamReq(split(at, 10)).req, limit), {ok: true, text: "a".repeat(limit)});
  assert.equal((await readBodyLimited(streamReq(split(over, 10)).req, limit)).ok, false);
  assert.equal((await readBodyLimited(streamReq([at], {"content-length": String(limit)}).req, limit)).ok, true);
  assert.equal((await readBodyLimited(streamReq([at], {"content-length": String(limit + 1)}).req, limit)).ok, false);
  assert.equal((await readBodyLimited(bytesReq(over), limit)).ok, false);
});

// ------------------------------------------------------------ classes
test("request classes: Meta webhooks, public / tiny-body endpoints and other actions have SEPARATE limits", () => {
  assert.equal(META_WEBHOOK_BODY_MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(ACTION_BODY_MAX_BYTES, 1024 * 1024);
  assert.equal(PUBLIC_BODY_MAX_BYTES, 64 * 1024);
  for (const a of ["whatsapp_webhook", "instagram_webhook"]) {
    assert.equal(bodyClassFor(a), "meta_webhook");
    assert.equal(bodyLimitFor(bodyClassFor(a)), META_WEBHOOK_BODY_MAX_BYTES);
  }
  for (const a of ["create_tenant", "widget_public", "widget_session", "widget_message", "widget.js", "pay_webhook", "inbound_recovery_tick"]) {
    assert.equal(bodyClassFor(a), "public", a);
    assert.equal(bodyLimitFor(bodyClassFor(a)), PUBLIC_BODY_MAX_BYTES);
  }
  for (const a of ["qa_save", "ingest_text", "knowledge_add", "qa_test", "reply", "widget_dashboard_update", "claim_account", "", "unknown_x"]) {
    assert.equal(bodyClassFor(a), "action", a);
    assert.equal(bodyLimitFor(bodyClassFor(a)), ACTION_BODY_MAX_BYTES);
  }
});

test("a 3 MB signed Meta batch passes the webhook class but not the action class; 100 KiB passes action, not public", async () => {
  const entry = {id: "123", time: 1, messaging: [{sender: {id: "1"}, recipient: {id: "2"}, message: {mid: "m", text: "سلام عليكم ".repeat(20)}}]};
  const entries: unknown[] = [];
  let raw = "";
  while (enc.encode(raw).byteLength < 3_000_000) { for (let i = 0; i < 500; i++) entries.push(entry); raw = JSON.stringify({object: "page", entry: entries}); }
  const bytes = enc.encode(raw);
  assert.ok(bytes.byteLength > ACTION_BODY_MAX_BYTES && bytes.byteLength < META_WEBHOOK_BODY_MAX_BYTES);
  const hook = await prologue(bytesReq(bytes, {}, U + "?action=instagram_webhook"));
  assert.equal(hook.out.raw, raw);
  const act = await prologue(bytesReq(bytes, {}, U + "?action=qa_save"));
  assert.ok(act.out instanceof Response);
  assert.equal(act.out.status, 413);
  const mid = enc.encode(JSON.stringify({pad: "x".repeat(100 * 1024)}));
  assert.ok(!((await prologue(bytesReq(mid, {}, U + "?action=ingest_text"))).out instanceof Response));
  assert.equal(((await prologue(bytesReq(mid, {}, U + "?action=create_tenant"))).out as Response).status, 413);
});

// ------------------------------------------------------------ handler prologue (real index.ts code)
test("index.ts prologue: within limits behaves exactly as before (raw text, JSON.parse, empty body, bad JSON 400)", async () => {
  const ok = await prologue(bytesReq('{"tenantId":"t","text":"نص"}', {}, U + "?action=ingest_text"));
  assert.deepEqual(ok.out, {raw: '{"tenantId":"t","text":"نص"}', body: {tenantId: "t", text: "نص"}, action: "ingest_text"});
  const empty = await prologue(new Request(U + "?action=whatsapp_webhook&hub.mode=subscribe", {method: "GET"}));
  assert.deepEqual(empty.out, {raw: "", body: {}, action: "whatsapp_webhook"});
  const bad = await prologue(bytesReq("{nope", {}, U + "?action=qa_save"));
  assert.equal((bad.out as Response).status, 400);
  assert.deepEqual(await (bad.out as Response).json(), {error: "JSON غير صالح"});
  assert.equal(ok.warns.length + empty.warns.length + bad.warns.length, 0);
});

test("index.ts prologue: oversized body => 413 {error} with CORS, fixed message, coarse log tag, no body content or sizes", async () => {
  const SECRET = "SECRET-CUSTOMER-TEXT-٩٩٩";
  const body = JSON.stringify({text: SECRET + "y".repeat(ACTION_BODY_MAX_BYTES)});
  for (const headers of [{}, {"content-length": String(enc.encode(body).byteLength)}, {"content-length": "12"}]) {
    const {out, warns} = await prologue(bytesReq(body, headers, U + "?action=ingest_text"));
    const res = out as Response;
    assert.equal(res.status, 413);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), {error: BODY_TOO_LARGE_MESSAGE});
    assert.doesNotMatch(text, /\d/);
    assert.equal(warns.length, 1);
    assert.equal(warns[0], BODY_TOO_LARGE_LOG_TAG + ' {"class":"action"}');
    assert.ok(!warns[0].includes(SECRET) && !/\d/.test(warns[0]));
  }
  const hook = await prologue(bytesReq(new Uint8Array(META_WEBHOOK_BODY_MAX_BYTES + 1), {}, U + "?action=whatsapp_webhook"));
  assert.equal((hook.out as Response).status, 413);
  assert.equal(hook.warns[0], BODY_TOO_LARGE_LOG_TAG + ' {"class":"meta_webhook"}');
});

// ------------------------------------------------------------ signature integrity
test("signature verification receives byte-identical raw content (real HMAC, multibyte split across chunks)", async () => {
  const secret = "meta-stage-secret";
  const raw = JSON.stringify({object: "whatsapp_business_account", entry: [{id: "w", changes: [{field: "messages",
    value: {messages: [{id: "wamid.1", type: "text", text: {body: "مرحبًا 😀 أهلًا"}}]}}]}]});
  const bytes = enc.encode(raw);
  const sig = "sha256=" + createHmac("sha256", secret).update(bytes).digest("hex");
  for (const size of [1, 3, 5, 1 << 16]) {
    const {req} = streamReq(split(bytes, size), {"x-hub-signature-256": sig}, U + "?action=whatsapp_webhook");
    const {out} = await prologue(req);
    assert.equal(out.raw, raw);
    assert.equal(out.raw, await bytesReq(bytes).text());
    assert.equal(await verifyMetaWebhookSignature(out.raw, sig, [secret]), true);
    assert.equal(await verifyMetaWebhookSignature(out.raw + " ", sig, [secret]), false);
  }
});

// ------------------------------------------------------------ field limits
test("field limits: ingest text, qa_save pairs / question / answer, sourceUrl boundaries", () => {
  assert.equal(INGEST_TEXT_MAX_CHARS, 50_000);
  assert.equal(textWithinLimit("ع".repeat(INGEST_TEXT_MAX_CHARS), INGEST_TEXT_MAX_CHARS), true);
  assert.equal(textWithinLimit("ع".repeat(INGEST_TEXT_MAX_CHARS + 1), INGEST_TEXT_MAX_CHARS), false);

  const pair = {question: "س", answer: "ج"};
  assert.equal(QA_SAVE_MAX_PAIRS, 50);
  assert.equal(qaPairsWithinLimits(Array(QA_SAVE_MAX_PAIRS).fill(pair)), true);
  assert.equal(qaPairsWithinLimits(Array(QA_SAVE_MAX_PAIRS + 1).fill(pair)), false);
  assert.equal(qaPairsWithinLimits([{question: "q".repeat(QA_QUESTION_MAX_CHARS), answer: "a".repeat(QA_ANSWER_MAX_CHARS)}]), true);
  assert.equal(qaPairsWithinLimits([{question: "q".repeat(QA_QUESTION_MAX_CHARS + 1), answer: "a"}]), false);
  assert.equal(qaPairsWithinLimits([{question: "q", answer: "a".repeat(QA_ANSWER_MAX_CHARS + 1)}]), false);
  assert.equal(qaPairsWithinLimits([{question: "  " + "q".repeat(QA_QUESTION_MAX_CHARS) + "  ", answer: "a"}]), true);
  for (const v of [undefined, null, "x", {}, [null, 1, "s", {question: 5}]]) assert.equal(qaPairsWithinLimits(v), true);

  assert.equal(SOURCE_URL_MAX_CHARS, 2048);
  const u = (n: number) => "https://x.example/" + "p".repeat(n - 18);
  assert.equal(optionalSourceUrlValid(u(2048)), true);
  assert.equal(optionalSourceUrlValid(u(2049)), false);
  for (const v of [undefined, null, ""]) assert.equal(optionalSourceUrlValid(v), true);
  for (const v of [1, {}, [], true]) assert.equal(optionalSourceUrlValid(v), false);
  for (const m of [TEXT_TOO_LONG_MESSAGE, QA_PAIRS_LIMIT_MESSAGE, SOURCE_URL_INVALID_MESSAGE, BODY_TOO_LARGE_MESSAGE]) {
    assert.match(m, /[؀-ۿ]/); assert.doesNotMatch(m, /\d/);
  }
});

/** Runs an index.ts guard snippet with the real validators; Response (400) or null. */
function runGuard(src: string, body: Record<string, unknown>, locals: Record<string, unknown> = {}) {
  const names = Object.keys(locals);
  const fn = new Function("body", "textWithinLimit", "qaPairsWithinLimits", "optionalSourceUrlValid",
    "INGEST_TEXT_MAX_CHARS", "TEXT_TOO_LONG_MESSAGE", "QA_PAIRS_LIMIT_MESSAGE", "SOURCE_URL_INVALID_MESSAGE", ...names,
    strip("const CORS={};\n" + JSON_ERR_SRC + "const __g = () => {\n" + src + "\nreturn null;\n};") + "\nreturn __g();");
  return fn(body, textWithinLimit, qaPairsWithinLimits, optionalSourceUrlValid, INGEST_TEXT_MAX_CHARS,
    TEXT_TOO_LONG_MESSAGE, QA_PAIRS_LIMIT_MESSAGE, SOURCE_URL_INVALID_MESSAGE, ...names.map((n) => locals[n])) as Response | null;
}
const QA_CASE = IDX.slice(once(IDX, '        case "qa_save": {'));
const QA_GUARD = between(QA_CASE, "          // T5-S4", "          const pairs =");
const CT_CASE = IDX.slice(once(IDX, '      case "create_tenant": {'));
const CT_GUARD = between(CT_CASE, "        // T5-S4", "        const {");
const ING_CASE = IDX.slice(once(IDX, '        case "ingest_text": {'));
const ING_GUARD = between(ING_CASE, "          // T5-S4", "          const chunks =");
const KB_CASE = IDX.slice(once(IDX, '      case "knowledge_add": {'));
const KB_GUARD = between(KB_CASE, "        // T5-S4", "        const chunks =");

test("index.ts guards (real code): at limit passes, limit + 1 => 400 {error} with the fixed message", async () => {
  const pair = {question: "س", answer: "ج"};
  assert.equal(runGuard(QA_GUARD, {pairs: Array(50).fill(pair), sourceUrl: "https://a.example"}), null);
  const r1 = runGuard(QA_GUARD, {pairs: Array(51).fill(pair)})!;
  assert.equal(r1.status, 400); assert.deepEqual(await r1.json(), {error: QA_PAIRS_LIMIT_MESSAGE});
  const r2 = runGuard(QA_GUARD, {pairs: [pair], sourceUrl: "u".repeat(2049)})!;
  assert.equal(r2.status, 400); assert.deepEqual(await r2.json(), {error: SOURCE_URL_INVALID_MESSAGE});

  assert.equal(runGuard(CT_GUARD, {sourceUrl: "u".repeat(2048)}), null);
  assert.equal(runGuard(CT_GUARD, {}), null);
  for (const bad of ["u".repeat(2049), 42, {href: "x"}]) {
    const r = runGuard(CT_GUARD, {sourceUrl: bad})!;
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), {error: SOURCE_URL_INVALID_MESSAGE});
  }

  assert.equal(runGuard(ING_GUARD, {}, {text: "ن".repeat(50_000)}), null);
  const r3 = runGuard(ING_GUARD, {}, {text: "ن".repeat(50_001)})!;
  assert.equal(r3.status, 400); assert.deepEqual(await r3.json(), {error: TEXT_TOO_LONG_MESSAGE});
  assert.equal(runGuard(KB_GUARD, {}, {t: "ن".repeat(50_000)}), null);
  assert.equal(runGuard(KB_GUARD, {}, {t: "ن".repeat(50_001)})!.status, 400);
});

// ------------------------------------------------------------ source-level ordering
test("source: the limited reader runs before JSON.parse and every signature check; no raw req.text()/req.json() left", () => {
  const iRead = once(HANDLER, "const limitedBody = await readBodyLimited(req, bodyLimitFor(bodyClass));");
  const iRaw = once(HANDLER, "const raw = limitedBody.text;");
  const i413 = once(HANDLER, "return err(BODY_TOO_LARGE_MESSAGE, 413);");
  const iParse = HANDLER.indexOf("JSON.parse(raw)");
  assert.ok(iRead < i413 && i413 < iRaw && iRaw < iParse, "limit -> 413 -> raw -> JSON.parse");
  assert.equal(HANDLER.indexOf("JSON.parse("), iParse, "no JSON.parse before the limited read");
  for (const sig of ["await verifyMetaWebhookSignature(\n          raw,", "await verifyMetaSignature(\n          raw,", "enc.encode(raw)"]) {
    const i = HANDLER.indexOf(sig); assert.ok(i > iRaw, "signature over the limited raw: " + sig.slice(0, 30));
  }
  assert.ok(HANDLER.indexOf('if (req.method === "OPTIONS")') < iRead, "OPTIONS still answered before any body read");
  const code = IDX.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /\breq\.(text|json|arrayBuffer|blob|formData)\(\)/);
  assert.doesNotMatch(code, /\breq\.body\b/);
  assert.equal((IDX.match(/readBodyLimited\(/g) ?? []).length, 1);
  // The webhook class is chosen from ?action= only (before the body exists).
  assert.ok(once(HANDLER, "const bodyClass = bodyClassFor(action);") < iRead);
});

test("source: field guards sit after the limiters and before the DB writes / embeddings", () => {
  const ct = CT_CASE.slice(0, CT_CASE.indexOf('case "pay_webhook"'));
  assert.ok(ct.indexOf("await rateGateStrict(") < ct.indexOf("optionalSourceUrlValid(body.sourceUrl)"), "T5-S1 limiter first");
  assert.ok(ct.indexOf("optionalSourceUrlValid(body.sourceUrl)") < ct.indexOf('.from("tenants")') ||
    ct.indexOf("optionalSourceUrlValid(body.sourceUrl)") < ct.indexOf(".insert("), "before the tenant insert");
  const qa = QA_CASE.slice(0, QA_CASE.indexOf('case "ingest_text"'));
  assert.ok(qa.indexOf("qaPairsWithinLimits(body.pairs)") < qa.indexOf('"knowledge_sources"'));
  assert.ok(qa.indexOf("qaPairsWithinLimits(body.pairs)") < qa.indexOf("await embed("));
  const ing = ING_CASE.slice(0, ING_CASE.indexOf('case "qa_test"'));
  assert.ok(ing.indexOf("textWithinLimit(text, INGEST_TEXT_MAX_CHARS)") < ing.indexOf("chunkText(text)"));
  assert.ok(ing.indexOf("textWithinLimit(text, INGEST_TEXT_MAX_CHARS)") < ing.indexOf("await embed("));
  const kb = KB_CASE.slice(0, KB_CASE.indexOf('case "knowledge_delete"'));
  assert.ok(kb.indexOf("await rateGate(") < kb.indexOf("textWithinLimit(t, INGEST_TEXT_MAX_CHARS)"));
  const kbText = kb.slice(kb.indexOf("textWithinLimit(t, INGEST_TEXT_MAX_CHARS)"));
  assert.ok(kbText.indexOf("chunkText(t)") > 0 && kbText.indexOf("await embed(") > 0);
});
