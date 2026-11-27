// SEC account-resolution hardening (branch sec/channel-accounts-hardening).
// Webhooks resolve the receiving channel account across ALL tenants by the
// provider id, so every lookup must resolve to EXACTLY ONE row or nothing:
//  - whatsapp_webhook channel_accounts fallback: one ACTIVE row only; error /
//    0 / 2+ rows dropped; a wa_bindings row (verified or not) of ANOTHER
//    tenant blocks it; the same tenant's unverified row still falls back.
//  - sendToConversation: the wa_bindings phone id fallback must be VERIFIED;
//    wa_status / me keep the unfiltered read (pending badge).
//  - instagram_webhook: limit(2) per candidate; an error or 2 rows stop
//    resolution (the next candidate is never tried); Page lookup errors too.
//    Rows with status 'disconnected' are not candidates (they neither block
//    nor receive: they are outside the global unique index); needs_reauth
//    rows still match and are then dropped by the "not active" gate.
//  - meta-auth Instagram / Facebook pre-checks: every NON-disconnected row of
//    another tenant blocks (2+ rows or a lookup error refuse the link); a
//    23505 naming the global index channel_accounts_channel_external_id_global_uq
//    (message or details) maps to the existing "account_already_linked"
//    result; any other 23505 (per-tenant constraints) keeps db_save_failed.
//  - The verified-binding path (waBinding.ts provenWhatsappAccount, wip E1)
//    is unchanged: tenant-scoped proof only, never the global fallback.
//
// Behavioural: the REAL code is sliced out of the Edge Function sources,
// type-stripped (node:module stripTypeScriptTypes) and run against in-memory
// fakes (no Deno, no network, no database).
// Run: node --experimental-strip-types --test tests/security-account-resolution.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import {bindingIsVerified, provenWhatsappAccount} from "../supabase/functions/milan-api/waBinding.ts";
import {
  isAccountTakenViolation, facebookDb, linkFacebookPages, ACCOUNT_GLOBAL_UNIQUE_INDEX, type FbDb, type FbPageRow,
} from "../supabase/functions/meta-auth/facebook.ts";

const IDX = readFileSync("supabase/functions/milan-api/index.ts", "utf8");
const META = readFileSync("supabase/functions/meta-auth/index.ts", "utf8");
const TA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function compile(params: string, body: string, name: string): any {
  const js = stripTypeScriptTypes(`async function ${name}(${params}){\n${body}\n}\n`, {mode: "strip"});
  return new Function(js + `\nreturn ${name};`)();
}
function slice(src: string, from: string, to: string, startAt = 0, includeEnd = false): string {
  const a = src.indexOf(from, startAt);
  const b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `slice located: ${from.slice(0, 40)}`);
  return src.slice(a, includeEnd ? b + to.length : b);
}
function recorder() {
  const logs: Array<[string, unknown[]]> = [];
  const cons = {log: (...a: unknown[]) => logs.push(["log", a]), info: (...a: unknown[]) => logs.push(["info", a]),
    warn: (...a: unknown[]) => logs.push(["warn", a]), error: (...a: unknown[]) => logs.push(["error", a])};
  return {logs, cons};
}

/* ── generic query-builder fake: filters recorded, rows filtered literally ── */
type Res = {data: unknown; error: unknown};
function fakeDb(o: {
  rows?: Record<string, any[]>;
  errorOn?: (table: string, filters: Record<string, unknown>) => unknown;
} = {}) {
  const queries: Array<{table: string; filters: Record<string, unknown>; neq: Record<string, unknown>; or?: string; end: string; n?: number}> = [];
  // PostgREST or=(...) with the only form the code uses: col.is.null,col.neq.value
  const orMatch = (expr: string | undefined, r: any) => {
    if (expr === undefined) return true;
    const m = /^(\w+)\.is\.null,\1\.neq\.(\w+)$/.exec(expr);
    assert.ok(m, `supported or(): ${expr}`);
    return r[m[1]] === null || r[m[1]] === undefined || r[m[1]] !== m[2];
  };
  const from = (table: string) => {
    const filters: Record<string, unknown> = {}, neq: Record<string, unknown> = {};
    let orExpr: string | undefined;
    const run = (end: string, n?: number): Res => {
      queries.push({table, filters: {...filters}, neq: {...neq}, ...(orExpr === undefined ? {} : {or: orExpr}), end, n});
      const err = o.errorOn?.(table, filters);
      if (err) return {data: null, error: err};
      const rows = (o.rows?.[table] ?? []).filter((r) =>
        Object.entries(filters).every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v) &&
        Object.entries(neq).every(([k, v]) => r[k] !== v) && orMatch(orExpr, r));
      if (end === "maybeSingle") return rows.length > 1
        ? {data: null, error: {code: "PGRST116"}} : {data: rows[0] ?? null, error: null};
      return {data: rows.slice(0, n), error: null};
    };
    const q: any = {
      select: () => q,
      eq: (k: string, v: unknown) => { filters[k] = v; return q; },
      in: (k: string, v: unknown) => { filters[k] = v; return q; },
      neq: (k: string, v: unknown) => { neq[k] = v; return q; },
      or: (e: string) => { orExpr = e; return q; },
      maybeSingle: async () => run("maybeSingle"),
      limit: async (n: number) => run("limit", n),
      then: (ok: any, ko: any) => Promise.resolve({data: null, error: null}).then(ok, ko),
    };
    return q;
  };
  return {from, queries};
}

/* ═══════════════════════ WhatsApp inbound ═══════════════════════ */
const WA_CASE = IDX.indexOf('case "whatsapp_webhook": {');
const WA_END = "        return json({\n          received: true,\n        });\n";
const waLoop = compile(
  "body,sb,bindingIsVerified,provenWhatsappAccount,handleIncomingWebhookMessage,multichannelEnabled,env,normalizeMetaMessages,json,console," +
  "retryableEvent,recoveryLeaseActive,runBatchEvent,webhookStatusFor",
  slice(IDX, "        const waOutcomes: unknown[] = [];\n        for (const entry of body.entry ?? []) {", WA_END, WA_CASE, true), "__waBatch");

const waBody = (phoneId: string, id = "wamid.1") => ({object: "whatsapp_business_account", entry: [{changes: [{
  field: "messages", value: {metadata: {phone_number_id: phoneId}, contacts: [],
    messages: [{id, from: "9647000000001", type: "text", text: {body: "secret customer text"}}]}}]}]});
const waAcc = (tenant: string, over: Record<string, unknown> = {}) =>
  ({id: `acc-${tenant.slice(0, 4)}`, tenant_id: tenant, channel: "whatsapp", external_id: "5550001", status: "active", ...over});

async function runWa(db: ReturnType<typeof fakeDb>, phoneId = "5550001") {
  const handled: Array<{tenant: string; phoneId: string; accountId: unknown}> = [];
  const {logs, cons} = recorder();
  const res = await waLoop(waBody(phoneId), db, bindingIsVerified, provenWhatsappAccount,
    async (_sb: unknown, account: any, _c: string, _t: string, _m: string, _ch: string, p: string) => {
      handled.push({tenant: account.tenant_id, phoneId: p, accountId: account.id ?? null});
      return "replied";
    }, () => false, () => "", () => [], (b: unknown) => ({json: b}), cons,
    async () => null, async () => false, async (f: () => Promise<unknown>) => await f(), () => 200);
  assert.deepEqual(res, {json: {received: true}}, "webhook still acknowledged (HTTP unchanged)");
  // never a customer text, sender or tenant id in a NEW log line
  for (const [, a] of logs.filter(([, a]) => /fallback account ignored|binding account unproven|binding ignored/.test(String(a[0])))) {
    const flat = JSON.stringify(a);
    for (const s of ["secret customer text", "9647000000001", TA, TB, "5550001"]) assert.ok(!flat.includes(s), s);
  }
  return {handled, logs, codes: logs.filter(([l, a]) => l === "warn" && a[0] === "[whatsapp_webhook] fallback account ignored")
    .map(([, a]) => (a[1] as any).code)};
}

test("WA fallback: exactly one ACTIVE channel_accounts row routes (limit 2, status active)", async () => {
  const db = fakeDb({rows: {channel_accounts: [waAcc(TA)]}});
  const r = await runWa(db);
  assert.deepEqual(r.handled, [{tenant: TA, phoneId: "5550001", accountId: "acc-aaaa"}]);
  const q = db.queries.find((x) => x.table === "channel_accounts")!;
  assert.deepEqual(q.filters, {external_id: "5550001", channel: "whatsapp", status: "active"});
  assert.equal(q.end, "limit"); assert.equal(q.n, 2);
});

test("WA fallback: 0 rows (or only an inactive row) -> dropped", async () => {
  assert.deepEqual((await runWa(fakeDb())).handled, []);
  assert.deepEqual((await runWa(fakeDb({rows: {channel_accounts: [waAcc(TA, {status: "disconnected"})]}}))).handled, []);
});

test("WA fallback: 2 active rows (two tenants) -> dropped with a generic code", async () => {
  const r = await runWa(fakeDb({rows: {channel_accounts: [waAcc(TA), waAcc(TB)]}}));
  assert.deepEqual(r.handled, []);
  assert.deepEqual(r.codes, ["wa_account_lookup_failed_or_ambiguous"]);
});

test("WA fallback: lookup error -> dropped (fail closed)", async () => {
  const r = await runWa(fakeDb({rows: {channel_accounts: [waAcc(TA)]},
    errorOn: (t) => t === "channel_accounts" ? {code: "57014"} : null}));
  assert.deepEqual(r.handled, []);
  assert.deepEqual(r.codes, ["wa_account_lookup_failed_or_ambiguous"]);
});

test("WA fallback: an unverified binding of ANOTHER tenant blocks it; same tenant still falls back", async () => {
  const foreign = await runWa(fakeDb({rows: {wa_bindings: [{phone_id: "5550001", tenant_id: TB, is_verified: false}],
    channel_accounts: [waAcc(TA)]}}));
  assert.deepEqual(foreign.handled, []);
  assert.deepEqual(foreign.codes, ["wa_binding_tenant_mismatch"]);
  const same = await runWa(fakeDb({rows: {wa_bindings: [{phone_id: "5550001", tenant_id: TA, is_verified: false}],
    channel_accounts: [waAcc(TA)]}}));
  assert.deepEqual(same.handled, [{tenant: TA, phoneId: "5550001", accountId: "acc-aaaa"}]);
  assert.deepEqual(same.codes, []);
});

test("WA: a VERIFIED binding still wins; only a tenant-scoped proof (wip E1) reads channel_accounts, never the global fallback", async () => {
  const db = fakeDb({rows: {wa_bindings: [{phone_id: "5550001", tenant_id: TB, is_verified: true}],
    channel_accounts: [waAcc(TA)]}});
  const r = await runWa(db);
  // TA's active row is never borrowed: the binding's tenant (TB) has none -> unproven (no account id).
  assert.deepEqual(r.handled, [{tenant: TB, phoneId: "5550001", accountId: null}]);
  const ca = db.queries.filter((q) => q.table === "channel_accounts");
  assert.deepEqual(ca.map((q) => q.filters), [{tenant_id: TB, channel: "whatsapp", external_id: "5550001"}], "tenant-scoped proof only");
  assert.deepEqual(r.codes, [], "global fallback not consulted");
  // The binding tenant's own single ACTIVE row is proven (disconnected rows never are).
  const own = await runWa(fakeDb({rows: {wa_bindings: [{phone_id: "5550001", tenant_id: TB, is_verified: true}],
    channel_accounts: [waAcc(TA), waAcc(TB), waAcc(TB, {id: "acc-old", status: "disconnected"})]}}));
  assert.deepEqual(own.handled, [{tenant: TB, phoneId: "5550001", accountId: "acc-bbbb"}]);
});

test("WA fallback: a disconnected row of another tenant neither blocks nor receives (status active filter)", async () => {
  const r = await runWa(fakeDb({rows: {channel_accounts: [waAcc(TA, {id: "acc-old", status: "disconnected"}), waAcc(TB)]}}));
  assert.deepEqual(r.handled, [{tenant: TB, phoneId: "5550001", accountId: "acc-bbbb"}]);
  assert.deepEqual(r.codes, []);
  // needs_reauth is not active -> never routes through the fallback
  assert.deepEqual((await runWa(fakeDb({rows: {channel_accounts: [waAcc(TA, {status: "needs_reauth"})]}}))).handled, []);
});

/* ═══════════════════════ WhatsApp sends ═══════════════════════ */
const sendFns = compile(
  "fetchAccountWithToken,decryptField,sendMetaDirectMessage,sendWa",
  slice(IDX, "async function boundPhone(", "\n}\n", 0, true) +
  slice(IDX, "async function sendToConversation(", "\n}\n", 0, true) +
  "return {boundPhone, sendToConversation};", "__sendFns");

async function sendHarness(bindings: any[]) {
  const sent: Array<[string, string, string]> = [];
  const fns = await sendFns(async () => { throw Error("no account"); }, async (x: string) => x,
    async () => { throw Error("meta"); }, async (p: string, to: string, text: string) => { sent.push([p, to, text]); });
  return {sent, fns, db: fakeDb({rows: {wa_bindings: bindings}})};
}

test("boundPhone: verifiedOnly adds is_verified=true; default read stays unfiltered (wa_status / me)", async () => {
  const h = await sendHarness([{tenant_id: TA, phone_id: "5550001", is_verified: false}]);
  assert.equal(await h.fns.boundPhone(h.db, TA), "5550001", "pending binding still shown");
  assert.equal(await h.fns.boundPhone(h.db, TA, true), null, "pending binding never picks a sending phone");
  assert.deepEqual(h.db.queries.map((q) => q.filters), [{tenant_id: TA}, {tenant_id: TA, is_verified: true}]);
  const v = await sendHarness([{tenant_id: TA, phone_id: "5550001", is_verified: true}]);
  assert.equal(await v.fns.boundPhone(v.db, TA, true), "5550001");
  // call sites: sends filtered, display reads unfiltered
  assert.match(IDX, /phoneId = await boundPhone\(sb, tenantId, true\);/);
  const st = slice(IDX, 'case "wa_status": {', 'case "qa_extract": {');
  assert.match(st, /await boundPhone\(\s+sb,\s+tenant\.id\s+\);/);
  assert.equal((IDX.match(/boundPhone\(/g) ?? []).length, 4, "definition + send + wa_status + me only");
});

test("sendToConversation: unverified binding -> not bound error; verified -> sent via that phone id", async () => {
  const conv = {channel: "whatsapp", recipient: "whatsapp:9647000000009"};
  const u = await sendHarness([{tenant_id: TA, phone_id: "5550001", is_verified: false}]);
  await assert.rejects(u.fns.sendToConversation(u.db, TA, conv, "hi"), /واتساب غير مربوط/);
  assert.deepEqual(u.sent, []);
  const v = await sendHarness([{tenant_id: TA, phone_id: "5550001", is_verified: true}]);
  await v.fns.sendToConversation(v.db, TA, conv, "hi");
  assert.deepEqual(v.sent, [["5550001", "9647000000009", "hi"]]);
  // conv.phone_id keeps priority (unchanged), no binding read at all
  const p = await sendHarness([]);
  await p.fns.sendToConversation(p.db, TA, {...conv, phone_id: "5550002"}, "x");
  assert.deepEqual(p.sent, [["5550002", "9647000000009", "x"]]);
  assert.equal(p.db.queries.length, 0);
});

/* ═══════════════════════ Instagram / Page resolution ═══════════════════════ */
const IG_CASE = IDX.indexOf('case "instagram_webhook": {');
// R1 (PR #208) stage timer used by the sliced loop; same shape as webhookTimings.NOOP_STAGE_TIMER.
const NOOP_TIMER = {start: () => () => {}};
// The candidate loop + the drop checks, wrapped in a one-pass loop so their
// `continue` statements mean "event dropped".
const igResolve = compile("body,entryId,msg,sb,console,timer",
  "for (const __once of [0]) {\n" +
  slice(IDX, "            const candidates = [", "            if (!account) {", IG_CASE) +
  "  return {account};\n}\nreturn {dropped: true};", "__igResolve");

const igAcc = (id: string, tenant: string, over: Record<string, unknown> = {}) =>
  ({id: `acc-${id}-${tenant.slice(0, 4)}`, tenant_id: tenant, channel: "instagram", external_id: id, status: "active", ...over});
async function runIg(object: string, rows: any[], errorIds: string[] = [], entryId = "1700", recipientId = "1800") {
  const db = fakeDb({rows: {channel_accounts: rows},
    errorOn: (_t, f) => errorIds.includes(String(f.external_id)) ? {code: "57014"} : null});
  const {logs, cons} = recorder();
  const r = await igResolve({object}, entryId, {senderId: "9001", recipientId, text: "t", mid: "m"}, db, cons, NOOP_TIMER);
  const flat = JSON.stringify(logs);
  for (const s of ["1700", "1800", "9001", TA, TB]) assert.ok(!flat.includes(s), `log leaks ${s}`);
  return {r, tried: db.queries.map((q) => q.filters.external_id), queries: db.queries, logs};
}
const failedLog = "[instagram_webhook] account lookup failed or ambiguous — event ignored";

test("IG: exactly one row for entry.id routes (unaffected), limit(2) + instagram/facebook channels", async () => {
  const x = await runIg("instagram", [igAcc("1700", TA)]);
  assert.equal(x.r.account.tenant_id, TA);
  assert.deepEqual(x.tried, ["1700"]);
  assert.deepEqual(x.queries[0].filters.channel, ["instagram", "facebook"]);
  assert.equal(x.queries[0].or, "status.is.null,status.neq.disconnected", "disconnected rows excluded");
  assert.equal(x.queries[0].end, "limit"); assert.equal(x.queries[0].n, 2);
  // 0 rows for entry.id still falls through to the recipient id (unchanged)
  const y = await runIg("instagram", [igAcc("1800", TB)]);
  assert.equal(y.r.account.tenant_id, TB);
  assert.deepEqual(y.tried, ["1700", "1800"]);
  // a non-active, non-disconnected single row (needs_reauth) is still returned
  // here; the existing status gate drops it later
  const z = await runIg("instagram", [igAcc("1700", TA, {status: "needs_reauth"})]);
  assert.equal(z.r.account.status, "needs_reauth");
  assert.match(IDX.slice(IG_CASE), /if \(account\.status !== "active"\) \{/);
  // a disconnected row is not a candidate at all: falls through to the recipient id
  const d = await runIg("instagram", [igAcc("1700", TA, {status: "disconnected"})]);
  assert.equal(d.r.account, null);
  assert.deepEqual(d.tried, ["1700", "1800"]);
});

test("IG / Page: a disconnected row of tenant A never makes tenant B's live row ambiguous, never receives", async () => {
  const ig = await runIg("instagram", [igAcc("1700", TA, {status: "disconnected"}), igAcc("1700", TB)]);
  assert.equal(ig.r.account.tenant_id, TB);
  assert.deepEqual(ig.tried, ["1700"]);
  const fb = (id: string, t: string, over: Record<string, unknown> = {}) => igAcc(id, t, {channel: "facebook", ...over});
  const pg = await runIg("page", [fb("1700", TA, {status: "disconnected"}), fb("1700", TB)]);
  assert.equal(pg.r.account.tenant_id, TB);
  assert.equal(pg.queries[0].or, "status.is.null,status.neq.disconnected");
  // needs_reauth still counts: with B's active row it is ambiguous -> dropped
  const amb = await runIg("instagram", [igAcc("1700", TA, {status: "needs_reauth"}), igAcc("1700", TB)]);
  assert.deepEqual(amb.r, {dropped: true});
  const ambPg = await runIg("page", [fb("1700", TA, {status: "needs_reauth"}), fb("1700", TB)]);
  assert.deepEqual(ambPg.r, {dropped: true});
  // NULL status counts like the index (IS DISTINCT FROM)
  const nul = await runIg("instagram", [igAcc("1700", TA, {status: null}), igAcc("1700", TB)]);
  assert.deepEqual(nul.r, {dropped: true});
});

test("IG: 2 rows for entry.id -> dropped WITHOUT trying the recipient id", async () => {
  const x = await runIg("instagram", [igAcc("1700", TA), igAcc("1700", TB), igAcc("1800", TA)]);
  assert.deepEqual(x.r, {dropped: true});
  assert.deepEqual(x.tried, ["1700"]);
  assert.ok(x.logs.some(([l, a]) => l === "warn" && a[0] === failedLog));
});

test("IG: lookup error -> dropped without the next candidate (fail closed)", async () => {
  const x = await runIg("instagram", [igAcc("1800", TB)], ["1700"]);
  assert.deepEqual(x.r, {dropped: true});
  assert.deepEqual(x.tried, ["1700"]);
  // an ambiguous / failing recipient id (after 0 rows for entry.id) is dropped too
  const y = await runIg("instagram", [igAcc("1800", TA), igAcc("1800", TB)]);
  assert.deepEqual(y.r, {dropped: true});
  assert.deepEqual(y.tried, ["1700", "1800"]);
});

test("Page: one facebook row routes; 2 rows dropped; lookup error dropped without the next candidate", async () => {
  const fb = (id: string, t: string) => igAcc(id, t, {channel: "facebook"});
  const one = await runIg("page", [fb("1700", TA), igAcc("1700", TB)]);
  assert.equal(one.r.account.tenant_id, TA, "facebook channel only");
  assert.equal(one.queries[0].filters.channel, "facebook");
  const two = await runIg("page", [fb("1700", TA), fb("1700", TB), fb("1800", TA)]);
  assert.deepEqual(two.r, {dropped: true});
  assert.deepEqual(two.tried, ["1700"]);
  assert.ok(two.logs.some(([, a]) => a[0] === "[instagram_webhook] page id matches several accounts — event ignored"));
  const err = await runIg("page", [fb("1800", TA)], ["1700"]);
  assert.deepEqual(err.r, {dropped: true});
  assert.deepEqual(err.tried, ["1700"]);
  assert.ok(err.logs.some(([, a]) => a[0] === failedLog));
});

/* ═══════════════════════ meta-auth Instagram link ═══════════════════════ */
const igLink = compile("sb,tenantId,igId,prof,token,expiresIn,fail,encryptField,isAccountTakenViolation",
  slice(META, "    // الحساب غير مربوط بعميل آخر", "    // 5) اشتراك webhooks") + "\nreturn 'saved';", "__igLink");

function linkDb(o: {foreign?: any[]; lookupError?: unknown; upsertError?: unknown}) {
  const ops: any[] = [];
  const sb = {from: (t: string) => {
    const q: any = new Proxy({}, {get: (_x, k) => k === "then" ? undefined : (...a: unknown[]) => {
      ops.push([t, k, ...a]);
      // data [] WITH an error: the error alone must refuse (no reliance on data being null)
      if (k === "limit") return Promise.resolve(o.lookupError ? {data: [], error: o.lookupError} : {data: o.foreign ?? [], error: null});
      if (k === "upsert") return Promise.resolve({error: o.upsertError ?? null});
      return q;
    }});
    return q;
  }};
  return {sb, ops};
}
async function link(o: Parameters<typeof linkDb>[0]) {
  const d = linkDb(o);
  const {logs, cons} = recorder();
  const orig = {...console};
  Object.assign(console, cons);
  let r;
  try {
    r = await igLink(d.sb, TA, "1784", {username: "shop"}, "TOKEN_s3cr3t", 3600,
      (code: string) => ({failed: code}), async () => "enc:v1:x", isAccountTakenViolation);
  } finally { Object.assign(console, orig); }
  assert.ok(!JSON.stringify(logs).includes("1784"), "no id logged");
  return {r, ops: d.ops, upserted: d.ops.some((x) => x[1] === "upsert")};
}
const DUP = {code: "23505", message: 'duplicate key value violates unique constraint "channel_accounts_channel_external_id_global_uq"',
  details: "Key (channel, external_id)=(instagram, 1784) already exists."};
// The per-tenant constraint: its 23505 keeps the previous handling (db_save_failed).
const PER_TENANT = {code: "23505", message: 'duplicate key value violates unique constraint "channel_accounts_tenant_id_channel_external_id_key"',
  details: "Key (tenant_id, channel, external_id)=(t, instagram, 1784) already exists."};

test("meta-auth IG pre-check: limit(2), NON-disconnected rows of other tenants only", async () => {
  const x = await link({});
  assert.equal(x.r, "saved");
  assert.deepEqual(x.ops.slice(0, 7).map((o) => o.slice(1)), [["select", "tenant_id"], ["eq", "channel", "instagram"],
    ["eq", "external_id", "1784"], ["neq", "tenant_id", TA], ["or", "status.is.null,status.neq.disconnected"], ["limit", 2], ["upsert",
      x.ops[6][2], {onConflict: "tenant_id,channel,external_id"}]]);
});

test("meta-auth IG pre-check: 1 or 2 foreign rows -> account_already_linked; lookup error -> refused", async () => {
  for (const foreign of [[{tenant_id: TB}], [{tenant_id: TB}, {tenant_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}]]) {
    const x = await link({foreign});
    assert.deepEqual(x.r, {failed: "account_already_linked"});
    assert.equal(x.upserted, false);
  }
  const e = await link({lookupError: {code: "57014"}});
  assert.deepEqual(e.r, {failed: "db_save_failed"}, "fail closed, same code as facebook.ts");
  assert.equal(e.upserted, false);
});

test("meta-auth IG upsert: 23505 of the (channel, external_id) index -> existing already-linked result", async () => {
  assert.deepEqual((await link({upsertError: DUP})).r, {failed: "account_already_linked"});
  assert.deepEqual((await link({upsertError: PER_TENANT})).r, {failed: "db_save_failed"}, "per-tenant constraint: as before");
  assert.deepEqual((await link({upsertError: {code: "42501", message: "denied"}})).r, {failed: "db_save_failed"});
  assert.deepEqual((await link({upsertError: {code: "23505", message: "duplicate key value violates unique constraint \"x_pkey\"",
    details: "Key (id)=(1) already exists."}})).r, {failed: "db_save_failed"});
  assert.match(META, /import \{ isAccountTakenViolation \} from "\.\/facebook\.ts";/);
});

test("isAccountTakenViolation: only 23505 naming the global index (message or details)", () => {
  assert.equal(ACCOUNT_GLOBAL_UNIQUE_INDEX, "channel_accounts_channel_external_id_global_uq");
  assert.equal(isAccountTakenViolation(DUP), true);
  assert.equal(isAccountTakenViolation({code: "23505", message: "duplicate key", details: `index "${ACCOUNT_GLOBAL_UNIQUE_INDEX}"`}), true, "name in details");
  // the substring 'external_id' alone no longer matches (per-tenant constraint, other indexes)
  assert.equal(isAccountTakenViolation(PER_TENANT), false);
  assert.equal(isAccountTakenViolation({code: "23505", message: "violates \"channel_accounts_external_id_uidx\""}), false);
  assert.equal(isAccountTakenViolation({code: "23505", details: "Key (channel, external_id)=(instagram, 1) already exists."}), false);
  for (const e of [null, undefined, "23505", {code: "23503", details: "external_id"}, {code: "23505", message: "x_pkey"}, {code: 23505, details: "external_id"},
    {code: "23503", message: ACCOUNT_GLOBAL_UNIQUE_INDEX}, {code: "23505", message: {toString: () => ACCOUNT_GLOBAL_UNIQUE_INDEX}}])
    assert.equal(isAccountTakenViolation(e), false, JSON.stringify(e));
});

test("facebookDb.pageOwnedElsewhere: NON-disconnected rows of other tenants block; error fails closed", async () => {
  const fb = (t: string, status: unknown) => ({tenant_id: t, channel: "facebook", external_id: "111", status});
  const run = async (rows: any[], err = false) => {
    const db = fakeDb({rows: {channel_accounts: rows}, errorOn: () => err ? {code: "57014"} : null});
    const r = await facebookDb(db, TA).pageOwnedElsewhere("111");
    return {r, q: db.queries[0]};
  };
  const a = await run([fb(TB, "disconnected")]);
  assert.equal(a.r, false, "disconnected row of B does not block A");
  assert.equal(a.q.or, "status.is.null,status.neq.disconnected");
  assert.deepEqual(a.q.neq, {tenant_id: TA});
  assert.equal((await run([fb(TB, "needs_reauth")])).r, true, "needs_reauth blocks");
  assert.equal((await run([fb(TB, "active")])).r, true);
  assert.equal((await run([fb(TB, null)])).r, true, "NULL status blocks");
  assert.equal((await run([fb(TA, "active")])).r, false, "own row never blocks (same-tenant reconnect)");
  assert.equal((await run([], true)).r, "error");
});

/* ═══════════════════════ meta-auth Facebook link ═══════════════════════ */
test("facebookDb.upsertPage: 23505 of the global index -> 'owned' (not logged as a DB failure)", async () => {
  const mk = (error: unknown) => {
    const chain: any = new Proxy({}, {get: (_t, k) => k === "then" ? undefined : () => k === "upsert" ? Promise.resolve({error}) : chain});
    return facebookDb(chain, TA);
  };
  const row = {tenant_id: TA, external_id: "111"} as FbPageRow;
  const {logs, cons} = recorder();
  const orig = {...console};
  Object.assign(console, cons);
  try {
    assert.equal(await mk(DUP).upsertPage(row), "owned");
    assert.equal(await mk(PER_TENANT).upsertPage(row), false, "per-tenant 23505: logged DB failure as before");
    assert.equal(await mk({code: "42501"}).upsertPage(row), false);
    assert.equal(await mk(null).upsertPage(row), true);
  } finally { Object.assign(console, orig); }
  assert.equal(logs.length, 2, "only the non-global failures are logged (code only)");
  assert.ok(!JSON.stringify(logs).includes("1784") && !JSON.stringify(logs).includes("111"), "no id logged");
});

test("linkFacebookPages: an 'owned' upsert counts as already linked, never as db_save_failed", async () => {
  const res = (o: unknown) => new Response(JSON.stringify(o));
  const fetch = async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/oauth/access_token")) return res({access_token: "T", expires_in: 3600});
    if (u.pathname.endsWith("/me/accounts")) return res({data: [{id: "111", name: "One", access_token: "p1"}, {id: "222", name: "Two", access_token: "p2"}]});
    return res({success: true});
  };
  const run = (upsert: (r: FbPageRow) => Promise<boolean | "owned">) => {
    const db: FbDb = {pageOwnedElsewhere: async () => false, upsertPage: upsert};
    return linkFacebookPages("C", {fetch, appId: "A", appSecret: "S", redirectUri: "https://x/cb", tenantId: TA,
      encryptField: async (s) => s, db, nowMs: () => 0});
  };
  const {cons} = recorder();
  const orig = {...console};
  Object.assign(console, cons);
  try {
    assert.deepEqual(await run(async () => "owned"), {ok: false, code: "account_already_linked"});
    assert.deepEqual(await run(async (r) => r.external_id === "111" ? "owned" : true), {ok: true, saved: 1, name: "Two"});
    assert.deepEqual(await run(async () => false), {ok: false, code: "db_save_failed"});
  } finally { Object.assign(console, orig); }
});

test("meta-auth IG reconnect: a needs_reauth account is restored for exactly this tenant+account (status active, reason cleared, new encrypted token)", async () => {
  const x = await link({});
  assert.equal(x.r, "saved");
  const row = x.ops.find((o) => o[1] === "upsert")![2];
  assert.equal(row.tenant_id, TA);
  assert.equal(row.channel, "instagram");
  assert.equal(row.external_id, "1784");
  assert.equal(row.status, "active");
  assert.equal(row.error_message, null, "the previous needs_reauth reason is cleared");
  assert.equal(row.access_token_encrypted, "enc:v1:x", "stored encrypted, never the plain token");
  assert.ok(!JSON.stringify(row).includes("TOKEN_s3cr3t"));
  // One upsert keyed by (tenant, channel, external_id): no update/delete/other write can touch another account.
  assert.deepEqual(x.ops.filter((o) => o[1] === "upsert").map((o) => o[3]), [{onConflict: "tenant_id,channel,external_id"}]);
  assert.ok(!x.ops.some((o) => o[1] === "update" || o[1] === "delete" || o[1] === "insert"));
});
