// T5-D1: a claim token (tenants.claim_token) stops authorizing anything once
// its tenant is claimed (tenants.user_id set).
//  - claimToken.ts: well-formed 32-char lowercase hex only, constant-time
//    SHA-256 digest compare, tenant must be unclaimed (user_id === null);
//    claim = ONE conditional UPDATE (claim_token match AND user_id IS NULL)
//    that also rotates the token; 0 rows => "invalid or used".
//  - milan-api/index.ts: tenantByClaim delegates to tenantByClaimToken; every
//    claim-gated action goes through it and answers 403 "رمز الجلسة غير صالح"
//    for claimed AND unknown tenants alike; claim_account type-checks the
//    token and keeps 404 "رمز غير صالح أو مستخدم".
//  - src/lib/api.ts drops the stored "milano_claim" when a claim-gated call is
//    rejected for its token; Dashboard clears it after a successful claim.
// Behavioural parts run the REAL code: claimToken.ts is imported, index.ts /
// api.ts snippets are sliced out, type-stripped and run against fakes (same
// technique as tests/milan-db-error-leak.test.ts). No Deno, network or DB.
// Run: node --experimental-strip-types --test tests/milan-claim-token.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import {
  isClaimTokenFormat, claimTokenMatches, claimTokenAuthorizes, tenantByClaimToken,
  claimTenantByToken, newClaimToken, CLAIM_TOKEN_RE,
} from "../supabase/functions/milan-api/claimToken.ts";

const IDX = readFileSync(process.env.MILAN_IDX ?? "supabase/functions/milan-api/index.ts", "utf8");
const MOD = readFileSync("supabase/functions/milan-api/claimToken.ts", "utf8");
const API = readFileSync("src/lib/api.ts", "utf8");
const DASH = readFileSync("src/pages/Dashboard.tsx", "utf8");
const HERO = readFileSync("src/components/Hero.tsx", "utf8");
const strip = (s: string) => stripTypeScriptTypes(s, {mode: "strip"});

const INVALID_SESSION = "رمز الجلسة غير صالح";
const INVALID_OR_USED = "رمز غير صالح أو مستخدم";
const T1 = "0123456789abcdef0123456789abcdef";
const T2 = "fedcba9876543210fedcba9876543210";
const CLAIM_ACTIONS = ["bind_number", "wa_status", "qa_extract", "qa_save", "ingest_text", "qa_test", "comment_activity"];

// ------------------------------------------------------------ slicing
function between(src: string, a: string, b: string, from = 0) {
  const i = src.indexOf(a, from); const j = src.indexOf(b, i + a.length);
  assert.ok(i >= 0 && j > i, "located: " + a.slice(0, 50));
  return src.slice(i, j);
}
/** From the first "{" at/after `start` to its matching "}" (string-aware). */
function blockFrom(src: string, start: number) {
  let i = src.indexOf("{", start), depth = 0, q: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === "\\") { i++; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) { i++; break; }
  }
  return src.slice(start, i);
}
const once = (src: string, s: string) => {
  const i = src.indexOf(s); assert.ok(i >= 0, "located: " + s); assert.equal(src.indexOf(s, i + 1), -1, "unique: " + s); return i;
};

// index.ts helpers (json / err) and the claim path, run for real.
const JSON_ERR_SRC = between(IDX, "const json = (", "/* ═══");
const CLAIM_FN_SRC = between(IDX, "function claimOf(req: Request) {", "async function ownedTenant(");
const OWNED_SRC = between(IDX, "async function userOf(", "function claimOf(") + between(IDX, "async function ownedTenant(", "\n}\n") + "\n}\n";
const GATE_SRC = between(IDX, "    const claimActions = [", "      // S3/S4 (abuseGuards.ts)");
const CLAIM_CASE_SRC = blockFrom(IDX, once(IDX, 'case "claim_account": {') + 'case "claim_account": '.length);

function idxKit() {
  const src = strip("const CORS={};\n" + JSON_ERR_SRC + CLAIM_FN_SRC + OWNED_SRC) +
    "\nreturn {json,err,claimOf,tenantByClaim,ownedTenant,userOf};";
  return new Function("tenantByClaimToken", src)(tenantByClaimToken);
}
const K = idxKit();
const dbFail = (_e: unknown, _tag: string, m = "تعذر إتمام العملية — حاول مرة أخرى") => m;

/** The real claim-action gate: Response when rejected, else {tenant}. */
async function gate(sb: unknown, action: string, token: string | null, tenantId: unknown) {
  const run = new Function("action", "req", "body", "sb", "tenantByClaim", "err",
    strip("const __run = async () => {\n" + GATE_SRC + "\nreturn {tenant};\n}\n return null; };") + "\nreturn __run();");
  const h = new Headers(); if (token !== null) h.set("x-tenant-token", token);
  return run(action, new Request("https://x.test", {method: "POST", headers: h}), {tenantId}, sb, K.tenantByClaim, K.err);
}
/** The real claim_account case. */
async function claimAccount(sb: unknown, userId: string, body: Record<string, unknown>) {
  const run = new Function("body", "u", "sb", "err", "json", "dbFail", "isClaimTokenFormat", "claimTenantByToken",
    strip("const __run = async () => " + CLAIM_CASE_SRC + ";") + "\nreturn __run();");
  return run(body, {id: userId}, sb, K.err, K.json, dbFail, isClaimTokenFormat, claimTenantByToken) as Promise<Response>;
}
const read = async (r: Response) => ({status: r.status, ...(await r.json())});

// ------------------------------------------------------------ fake DB
type Row = {id: string; user_id: string | null; claim_token: string; business_name?: string};
/** PostgREST-ish builder over an in-memory tenants table. A conditional UPDATE
 *  evaluates its WHERE and applies the patch in ONE step (row lock + re-check,
 *  as Postgres does); every terminal call yields first so concurrent callers
 *  interleave. Models UNIQUE(tenants.user_id) and UNIQUE(claim_token). */
function fakeDb(rows: Row[], opts: {uniqueUser?: boolean} = {}) {
  const log: string[] = [];
  const users = new Map<string, string>();
  const sb: any = {
    auth: {getUser: async (t: string) => ({data: {user: users.has(t) ? {id: users.get(t)} : null}})},
    from(table: string) {
      assert.equal(table, "tenants");
      let mode = "select", patch: Record<string, unknown> | null = null;
      const filters: Array<(r: any) => boolean> = [];
      const b: any = {
        select() { return b; },
        update(p: Record<string, unknown>) { mode = "update"; patch = p; return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); log.push(`${mode}.eq.${c}`); return b; },
        is(c: string, v: unknown) { filters.push((r) => r[c] === v); log.push(`${mode}.is.${c}`); return b; },
        async maybeSingle() {
          await new Promise((r) => setImmediate(r));
          const hits = rows.filter((r) => filters.every((f) => f(r)));
          if (hits.length > 1) return {data: null, error: {code: "PGRST116"}};
          if (mode === "update") {
            log.push("update.exec");
            const p = patch!;
            if (hits.length === 1 && opts.uniqueUser !== false && p.user_id != null &&
                rows.some((o) => o !== hits[0] && o.user_id === p.user_id)) return {data: null, error: {code: "23505"}};
            if (hits.length === 1 && p.claim_token != null && rows.some((o) => o !== hits[0] && o.claim_token === p.claim_token))
              return {data: null, error: {code: "23505"}};
            if (hits[0]) Object.assign(hits[0], p);
            return {data: hits[0] ? {id: hits[0].id} : null, error: null};
          }
          log.push("select.exec");
          return {data: hits[0] ? {...hits[0]} : null, error: null};
        },
      };
      return b;
    },
  };
  return {sb, rows, log, users};
}
const tenant = (id: string, token: string, user: string | null = null): Row => ({id, user_id: user, claim_token: token, business_name: "b"});

// ========================================================= claimToken.ts
test("format: exactly 32 lowercase hex chars, string only", () => {
  assert.ok(isClaimTokenFormat(T1));
  assert.match(newClaimToken(), CLAIM_TOKEN_RE);
  assert.notEqual(newClaimToken(), newClaimToken());
  for (const bad of ["", " ", T1.toUpperCase(), T1 + "0", T1.slice(1), T1.slice(0, 31) + "g", ` ${T1}`, `${T1}\n`,
    null, undefined, 0, 123, true, {}, [T1], {toString: () => T1}, new String(T1)])
    assert.equal(isClaimTokenFormat(bad), false, JSON.stringify(String(bad)));
});

test("constant-time compare: equal tokens match, any other value does not (no === on tokens in code)", async () => {
  assert.equal(await claimTokenMatches(T1, T1), true);
  for (const p of [T2, "", null, undefined, 42, T1.toUpperCase(), T1 + " "]) assert.equal(await claimTokenMatches(T1, p), false);
  assert.equal(await claimTokenMatches("", ""), false, "empty stored + empty supplied never matches");
  assert.equal(await claimTokenMatches(null, null), false);
  assert.match(MOD, /digestsEqual\(a, b\)/);
  assert.match(MOD, /crypto\.subtle\.digest\("SHA-256"/);
  for (const src of [MOD, IDX]) {
    assert.doesNotMatch(src, /claim_token\s*[!=]==|[!=]==\s*\w*\.?claim_token\b/, "no direct token comparison");
    assert.doesNotMatch(src, /(?<!typeof )(?:supplied|claimOf\(req\))\s*[!=]==|[!=]==\s*(?:supplied|claimOf\(req\))/);
  }
});

test("claimTokenAuthorizes: only an UNCLAIMED tenant (user_id === null) with the right token", async () => {
  assert.equal(await claimTokenAuthorizes({user_id: null, claim_token: T1}, T1), true);
  assert.equal(await claimTokenAuthorizes({user_id: "u1", claim_token: T1}, T1), false);
  assert.equal(await claimTokenAuthorizes({claim_token: T1}, T1), false, "missing user_id fails closed");
  assert.equal(await claimTokenAuthorizes({user_id: null, claim_token: T1}, T2), false);
  assert.equal(await claimTokenAuthorizes(null, T1), false);
});

// ===================================================== claim-gated actions
test("every claim-gated action is in claimActions and goes through tenantByClaim (table-driven source check)", () => {
  const list = [...GATE_SRC.slice(0, GATE_SRC.indexOf("];")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(list, CLAIM_ACTIONS);
  assert.match(GATE_SRC, /await tenantByClaim\(\s*sb,\s*req,\s*body\.tenantId \?\? ""\s*\)/);
  assert.match(GATE_SRC, /if \(!tenant\) \{\s*return err\(\s*"رمز الجلسة غير صالح",\s*403\s*\);/);
  // The switch right after the gate holds ONLY claim actions.
  const sw = blockFrom(IDX, IDX.indexOf("switch (action) {", IDX.indexOf("    const claimActions = [")));
  const cases = [...sw.matchAll(/^\s*case "([a-z_]+)":/gm)].map((m) => m[1]).sort();
  assert.deepEqual(cases, [...CLAIM_ACTIONS].sort());
  // The claim token reaches nothing else: claimOf only in tenantByClaim, the
  // header only in claimOf, claim_token only in create_tenant's insert result.
  assert.equal(IDX.split("claimOf(req)").length - 1, 1);
  assert.equal(IDX.split('headers.get("x-tenant-token")').length - 1, 1, "read only in claimOf (the other hit is the CORS allow-list)");
  assert.equal(IDX.split("x-tenant-token").length - 1, 2);
  assert.equal(IDX.split("tenantByClaim(").length - 1, 2, "definition + the gate");
  const code = IDX.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  assert.equal(code.split("claim_token").length - 1, 2, 'create_tenant: .select("id, claim_token") + data.claim_token');
  assert.match(CLAIM_FN_SRC, /return await tenantByClaimToken\(sb, tenantId, claimOf\(req\)\);/);
});

test("pre-claim: the token authorizes every claim-gated action of its own tenant", async () => {
  const db = fakeDb([tenant("t1", T1), tenant("t2", T2)]);
  for (const a of CLAIM_ACTIONS) {
    const r = await gate(db.sb, a, T1, "t1");
    assert.ok(!(r instanceof Response), a);
    assert.equal(r.tenant.id, "t1", a);
    const other = await gate(db.sb, a, T1, "t2");
    assert.ok(other instanceof Response, a + ": token of t1 never opens t2");
  }
});

test("post-claim: token reuse is rejected for EVERY claim-gated action, same 403 as an unknown tenant / wrong token", async () => {
  const db = fakeDb([tenant("t1", T1), tenant("t9", T2, "someone")]);
  assert.deepEqual(await read(await claimAccount(db.sb, "owner", {claimToken: T1})), {status: 200, tenantId: "t1"});
  assert.equal(db.rows[0].user_id, "owner");
  for (const a of CLAIM_ACTIONS) {
    const variants: Array<[string | null, unknown]> = [
      [T1, "t1"],                 // old token, now-claimed tenant
      [db.rows[0].claim_token, "t1"], // even the rotated value: tenant is claimed
      [T2, "t9"],                 // claimed tenant with its own stored token
      [T1, "nope"],               // unknown tenant
      [T2, "t1"],                 // wrong token
      ["", "t1"], [null, "t1"], ["x".repeat(32), "t1"], [T1.toUpperCase(), "t1"], // malformed / missing
      [T1, 5], [T1, null],        // non-string tenantId
    ];
    for (const [tok, id] of variants) {
      const r = await gate(db.sb, a, tok, id);
      assert.ok(r instanceof Response, `${a} ${tok} ${id}`);
      assert.deepEqual(await read(r), {status: 403, error: INVALID_SESSION}, `${a} ${tok} ${id}`);
    }
  }
});

// ============================================================ claim_account
test("first-time claim succeeds: user_id set, token rotated (old token dead even if user_id were reset)", async () => {
  const db = fakeDb([tenant("t1", T1)]);
  assert.deepEqual(await read(await claimAccount(db.sb, "u1", {claimToken: T1})), {status: 200, tenantId: "t1"});
  assert.equal(db.rows[0].user_id, "u1");
  assert.match(db.rows[0].claim_token, CLAIM_TOKEN_RE);
  assert.notEqual(db.rows[0].claim_token, T1);
  // ON DELETE SET NULL on auth.users would reset user_id; the old token still never matches.
  db.rows[0].user_id = null;
  assert.ok((await gate(db.sb, "wa_status", T1, "t1")) instanceof Response);
  assert.deepEqual(await read(await claimAccount(db.sb, "u2", {claimToken: T1})), {status: 404, error: INVALID_OR_USED});
});

test("claim is ONE conditional UPDATE (claim_token AND user_id IS NULL), no prior SELECT", async () => {
  const db = fakeDb([tenant("t1", T1)]);
  await claimAccount(db.sb, "u1", {claimToken: T1});
  assert.deepEqual(db.log, ["update.eq.claim_token", "update.is.user_id", "update.exec"]);
});

test("reuse / already-associated tenant: 404 'invalid or used', user_id NEVER overwritten", async () => {
  const db = fakeDb([tenant("t1", T1, "owner")]);
  for (const u of ["attacker", "owner"]) {
    assert.deepEqual(await read(await claimAccount(db.sb, u, {claimToken: T1})), {status: 404, error: INVALID_OR_USED});
    assert.equal(db.rows[0].user_id, "owner");
    assert.equal(db.rows[0].claim_token, T1);
  }
  const db2 = fakeDb([tenant("t1", T1)]);
  await claimAccount(db2.sb, "first", {claimToken: T1});
  assert.deepEqual(await read(await claimAccount(db2.sb, "second", {claimToken: T1})), {status: 404, error: INVALID_OR_USED});
  assert.equal(db2.rows[0].user_id, "first");
});

test("concurrent claims (same or different users): exactly ONE success", async () => {
  for (const users of [["a", "b", "c", "d", "e"], ["a", "a", "a"]]) {
    const db = fakeDb([tenant("t1", T1)], {uniqueUser: false});
    const res = await Promise.all(users.map((u) => claimAccount(db.sb, u, {claimToken: T1}).then(read)));
    assert.equal(res.filter((r) => r.status === 200).length, 1, JSON.stringify(res));
    assert.equal(res.filter((r) => r.status === 404 && r.error === INVALID_OR_USED).length, users.length - 1);
    const winner = users[res.findIndex((r) => r.status === 200)];
    assert.equal(db.rows[0].user_id, winner);
  }
});

test("malformed / non-string / empty tokens: no DB call; missing keeps 400, malformed is 404 'invalid or used'", async () => {
  for (const [tok, st, msg] of [[undefined, 400, "رمز الضم ناقص"], ["", 400, "رمز الضم ناقص"], [null, 400, "رمز الضم ناقص"],
    [0, 400, "رمز الضم ناقص"], ["abc", 404, INVALID_OR_USED], [T1.toUpperCase(), 404, INVALID_OR_USED],
    [123, 404, INVALID_OR_USED], [{neq: "x"}, 404, INVALID_OR_USED], [[T1], 404, INVALID_OR_USED], [true, 404, INVALID_OR_USED],
    [`${T1},user_id.is.null`, 404, INVALID_OR_USED]] as Array<[unknown, number, string]>) {
    const db = fakeDb([tenant("t1", T1)]);
    assert.deepEqual(await read(await claimAccount(db.sb, "u1", {claimToken: tok})), {status: st, error: msg}, String(tok));
    assert.deepEqual(db.log, [], "no DB call: " + String(tok));
    assert.equal(db.rows[0].user_id, null);
  }
  assert.deepEqual(await claimTenantByToken(fakeDb([]).sb, "u", 5 as unknown as string), {data: null, error: null});
});

test("unknown vs claimed tenant: identical claim_account response (no oracle)", async () => {
  const db = fakeDb([tenant("t1", T1, "owner")]);
  const claimed = await read(await claimAccount(db.sb, "x", {claimToken: T1}));
  const unknown = await read(await claimAccount(db.sb, "x", {claimToken: T2}));
  assert.deepEqual(claimed, unknown);
  assert.deepEqual(claimed, {status: 404, error: INVALID_OR_USED});
});

test("DB error on claim keeps the generic 500 (dbFail), never a token in the body", async () => {
  const sb = {from: () => { const b: any = {update: () => b, eq: () => b, is: () => b, select: () => b,
    maybeSingle: async () => ({data: null, error: {code: "23505", message: `dup ${T1}`}})}; return b; }};
  const r = await read(await claimAccount(sb, "u1", {claimToken: T1}));
  assert.deepEqual(r, {status: 500, error: "تعذر إتمام العملية — حاول مرة أخرى"});
});

test("a user that already owns a tenant cannot claim a second one when UNIQUE(user_id) holds (500 generic, no change)", async () => {
  const db = fakeDb([tenant("t1", T1, "u1"), tenant("t2", T2)]);
  const r = await read(await claimAccount(db.sb, "u1", {claimToken: T2}));
  assert.equal(r.status, 500);
  assert.equal(db.rows[1].user_id, null);
  assert.equal(db.rows[1].claim_token, T2);
});

test("owner on the authenticated path still works after the claim (JWT -> ownedTenant by user_id)", async () => {
  const db = fakeDb([tenant("t1", T1)]);
  db.users.set("jwt-owner", "owner");
  await claimAccount(db.sb, "owner", {claimToken: T1});
  const req = (auth: string, claim?: string) => new Request("https://x.test", {method: "POST",
    headers: {authorization: auth, ...(claim ? {"x-tenant-token": claim} : {})}});
  const own = await K.ownedTenant(db.sb, req("Bearer jwt-owner", T1));
  assert.equal(own?.id, "t1");
  assert.equal(await K.ownedTenant(db.sb, req("Bearer nobody", T1)), null, "the claim token is no credential on the owner path");
  // Owner actions (summary, conversations, knowledge, ...) resolve the tenant via ownedTenant, never via the claim token.
  const ownerPart = IDX.slice(IDX.indexOf('case "claim_account": {'));
  assert.match(ownerPart, /const tenant =\s*await ownedTenant\(\s*sb,\s*req\s*\);/);
});

// ================================================================ frontend
const FN_SRC = between(API, "async function fn<T>(", "/** نداء دالة channels منفصلة في Supabase */");
function apiKit(status: number, payload: unknown) {
  const store = new Map<string, string>();
  const localStorage = {getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k)};
  const sent: Array<Record<string, string>> = [];
  const fetch = async (_u: string, init: any) => { sent.push(init.headers); return new Response(JSON.stringify(payload), {status}); };
  const fn = new Function("fetch", "localStorage", "SUPABASE_ANON", "FN_URL",
    strip(FN_SRC) + "\nreturn fn;")(fetch, localStorage, "anon", "https://x.test/milan-api");
  const storedClaim = () => localStorage.getItem("milano_claim");
  return {fn, store, sent, storedClaim};
}

test("frontend: a claim-gated 403 'invalid session token' drops the stale milano_claim; the dead token is not sent again", async () => {
  const k = apiKit(403, {error: INVALID_SESSION});
  k.store.set("milano_claim", T1);
  await assert.rejects(k.fn("wa_status", {body: {tenantId: "t1"}, claim: k.storedClaim()}), new RegExp(INVALID_SESSION));
  assert.equal(k.store.has("milano_claim"), false);
  await assert.rejects(k.fn("qa_test", {body: {tenantId: "t1"}, claim: k.storedClaim()}));
  assert.equal(k.sent[1]["x-tenant-token"], undefined, "no token header once dropped");
});

test("frontend: other failures (429, 500, other 403 text) and a different stored token keep milano_claim (pre-claim wizard keeps working)", async () => {
  for (const [st, payload, claim] of [[429, {error: "x"}, T1], [500, {error: INVALID_SESSION}, T1], [403, {error: "غير مصرح"}, T1],
    [403, {error: INVALID_SESSION}, T2]] as Array<[number, unknown, string]>) {
    const k = apiKit(st, payload);
    k.store.set("milano_claim", T1);
    await assert.rejects(k.fn("qa_save", {body: {}, claim}));
    assert.equal(k.store.get("milano_claim"), T1, `${st} ${JSON.stringify(payload)} ${claim}`);
  }
  const ok = apiKit(200, {chunks: 1});
  ok.store.set("milano_claim", T1);
  await ok.fn("ingest_text", {body: {}, claim: ok.storedClaim()});
  assert.equal(ok.sent[0]["x-tenant-token"], T1, "pre-claim: the stored token is sent");
  assert.equal(ok.store.get("milano_claim"), T1);
});

test("frontend: Dashboard clears the stored claim after a successful claim (auto and manual) and after a rejected one", () => {
  const auto = between(DASH, "const saved = getStoredClaim();", "// eslint-disable-next-line");
  assert.match(auto, /\.then\(\(\) => clearStoredClaim\(\)\)/);
  assert.match(auto, /\.catch\(\(\) => \{[^}]*clearStoredClaim\(\);/);
  const manual = between(DASH, 'await apiAuthFetch(token!, "/api/dashboard/claim"', "loadAll();");
  assert.match(manual, /clearStoredClaim\(\); setClaimVal\(""\);/);
  // The wizard still stores the token until the claim (Hero), and only these places remove it.
  assert.match(HERO, /localStorage\.setItem\("milano_claim", created\.claimToken\)/);
  assert.equal(DASH.split("clearStoredClaim()").length - 1, 3);
  assert.equal(API.split('localStorage.removeItem("milano_claim")').length - 1, 1);
  assert.doesNotMatch(HERO, /removeItem\("milano_claim"\)/);
});
