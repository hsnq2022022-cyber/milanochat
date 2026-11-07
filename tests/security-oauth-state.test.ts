// S5: signed Meta OAuth state (supabase/functions/_shared/oauthState.ts) and
// its use by `channels` (issuer) and `meta-auth` (callback).
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  signOAuthState, verifyOAuthState, issueOAuthState, consumeOAuthState, oauthStateSecret,
  OAUTH_STATE_TTL_SEC, OAUTH_STATE_SECRET_ENV,
} from "../supabase/functions/_shared/oauthState.ts";

const SECRET = "s".repeat(40);
const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";
const TA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const N1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = 1_800_000_000;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tenants: Record<string, string> = {[U1]: TA, [U2]: TB};

/** In-memory meta_oauth_states with the atomic claim semantics of meta-auth. */
function nonceTable() {
  const rows = new Map<string, {user_id: string; tenant_id: string; platform: string; consumed: boolean; exp: number}>();
  return {
    rows,
    record: async (r: any) => { rows.set(r.id, {user_id: r.user_id, tenant_id: r.tenant_id, platform: r.platform, consumed: false, exp: Date.parse(r.expires_at) / 1000}); return true; },
    claim: (now: number) => async (c: any) => {
      const r = rows.get(c.nonce);
      if (!r || r.consumed || r.user_id !== c.userId || r.tenant_id !== c.tenantId || r.platform !== c.platform || r.exp <= now) return "not_found" as const;
      r.consumed = true;
      return "claimed" as const;
    },
  };
}
async function issue(userId: string, table = nonceTable(), secret: string | null = SECRET) {
  const r = await issueOAuthState({secret, userId, platform: "instagram", ownedTenantOf: async (u) => tenants[u] ? {id: tenants[u]} : null,
    recordNonce: table.record, nowSec: NOW, newNonce: () => crypto.randomUUID()});
  return {r, table};
}

test("valid state links ONLY the state's tenant/user, exactly once", async () => {
  const {r, table} = await issue(U1);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.payload.t, TA);
  assert.equal(r.payload.exp - r.payload.iat, OAUTH_STATE_TTL_SEC);
  const c1 = await consumeOAuthState({secret: SECRET, state: r.state, expectedPlatform: "instagram", nowSec: NOW + 5, claimNonce: table.claim(NOW + 5)});
  assert.deepEqual(c1, {ok: true, tenantId: TA, userId: U1, platform: "instagram"});
  const c2 = await consumeOAuthState({secret: SECRET, state: r.state, expectedPlatform: "instagram", nowSec: NOW + 6, claimNonce: table.claim(NOW + 6)});
  assert.deepEqual(c2, {ok: false, reason: "state_reused"}, "replay refused");
});

test("issuer has no tenant input: a query-string tenantId cannot be injected", async () => {
  // issueOAuthState derives the tenant from ownedTenantOf(userId) only.
  const {r} = await issue(U1);
  assert.ok(r.ok && r.payload.t === TA);
  const none = await issue("33333333-3333-4333-8333-333333333333");
  assert.deepEqual(none.r, {ok: false, status: 404, code: "no_tenant"});
  const ch = readFileSync("supabase/functions/channels/index.ts", "utf8");
  const oauth = ch.slice(ch.indexOf('parts[1] === "oauth-url"'), ch.indexOf("// ─── GET /channels/accounts ───"));
  assert.doesNotMatch(oauth, /tenantId/, "oauth-url branch never reads a tenantId");
  assert.equal((oauth.match(/createSignedState\(\{ platform: "(instagram|facebook)", userId \}\)/g) ?? []).length, 2);
  const fn = ch.slice(ch.indexOf("async function createSignedState("), ch.indexOf("function oauthStartError("));
  assert.match(fn, /ownedTenantOf: \(uid\) => ownedTenant\(uid\)/);
  assert.doesNotMatch(fn, /query|tenantId\s*:/);
  assert.doesNotMatch(ch, /INSTAGRAM_APP_SECRET/, "no longer signed with the Meta app secret");
});

test("forged / unsigned / tampered / wrong-secret / malformed states are rejected", async () => {
  const {r, table} = await issue(U1);
  assert.ok(r.ok);
  if (!r.ok) return;
  const [body, sig] = r.state.split(".");
  const claim = table.claim(NOW);
  const bad = async (state: string, secret: string | null = SECRET) =>
    (await consumeOAuthState({secret, state, expectedPlatform: "instagram", nowSec: NOW, claimNonce: claim}));
  // tamper tenant (cross-tenant replay of A's state for B)
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal((await bad(`${b64({...p, t: TB})}.${sig}`)).ok, false);
  assert.deepEqual(await bad(`${b64({...p, t: TB})}.${sig}`), {ok: false, reason: "state_signature"});
  assert.deepEqual(await bad(body), {ok: false, reason: "state_format"}, "unsigned");
  assert.deepEqual(await bad(`${body}.`), {ok: false, reason: "state_format"});
  assert.deepEqual(await bad(`${body}.${Buffer.alloc(32).toString("base64url")}`), {ok: false, reason: "state_signature"});
  assert.deepEqual(await bad(r.state, "t".repeat(40)), {ok: false, reason: "state_signature"}, "other secret");
  assert.deepEqual(await bad(r.state, null), {ok: false, reason: "config_missing"}, "missing secret fails closed");
  assert.deepEqual(await bad(`${r.state}.x`), {ok: false, reason: "state_format"});
  assert.deepEqual(await bad("x".repeat(5000)), {ok: false, reason: "state_format"});
  // legacy (old channels) format signed with the same secret but old shape
  const legacy = await signRaw({i: N1, p: "instagram", exp: NOW + 600});
  assert.deepEqual(await bad(legacy), {ok: false, reason: "state_payload"});
  // correctly signed but bad shapes
  for (const extra of [{t: "not-a-uuid"}, {u: "x"}, {p: "whatsapp"}, {v: 2}, {exp: NOW + 99999}, {admin: true}, {iat: NOW + 3600, exp: NOW + 4200}]) {
    const s = await signRaw({...p, ...extra});
    assert.deepEqual(await bad(s), {ok: false, reason: "state_payload"}, JSON.stringify(extra));
  }
  // nothing was consumed by any rejected attempt
  assert.equal([...table.rows.values()].every((x) => !x.consumed), true);
});

async function signRaw(payload: unknown) {
  const body = b64(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("base64url");
  return `${body}.${sig}`;
}

test("expired state is rejected before any DB access; platform mismatch rejected", async () => {
  const {r, table} = await issue(U1);
  assert.ok(r.ok);
  if (!r.ok) return;
  let dbCalls = 0;
  const claim = async (c: any) => { dbCalls++; return table.claim(NOW)(c); };
  assert.deepEqual(await consumeOAuthState({secret: SECRET, state: r.state, expectedPlatform: "instagram", nowSec: NOW + OAUTH_STATE_TTL_SEC, claimNonce: claim}),
    {ok: false, reason: "state_expired"});
  assert.deepEqual(await consumeOAuthState({secret: SECRET, state: r.state, expectedPlatform: "facebook", nowSec: NOW, claimNonce: claim}),
    {ok: false, reason: "state_platform_mismatch"});
  assert.equal(dbCalls, 0);
});

test("a valid state whose nonce row belongs to another tenant/user is not claimable", async () => {
  const t = nonceTable();
  const {r} = await issue(U1, t);
  assert.ok(r.ok);
  if (!r.ok) return;
  t.rows.get(r.payload.i)!.tenant_id = TB; // row tampered/mismatched
  assert.deepEqual(await consumeOAuthState({secret: SECRET, state: r.state, expectedPlatform: "instagram", nowSec: NOW, claimNonce: t.claim(NOW)}),
    {ok: false, reason: "state_reused"});
  assert.deepEqual(await consumeOAuthState({secret: SECRET, state: r.state, expectedPlatform: "instagram", nowSec: NOW, claimNonce: async () => "error"}),
    {ok: false, reason: "db_error"});
});

test("missing / short secret: issuer answers 503, nothing stored; nonce store failure fails closed", async () => {
  assert.equal(oauthStateSecret(() => undefined), null);
  assert.equal(oauthStateSecret(() => "short"), null);
  assert.equal(oauthStateSecret((k) => (k === OAUTH_STATE_SECRET_ENV ? ` ${SECRET} ` : "")), SECRET);
  const t = nonceTable();
  const {r} = await issue(U1, t, null);
  assert.deepEqual(r, {ok: false, status: 503, code: "config_missing"});
  assert.equal(t.rows.size, 0);
  const failing = await issueOAuthState({secret: SECRET, userId: U1, platform: "facebook", ownedTenantOf: async () => ({id: TA}),
    recordNonce: async () => false, nowSec: NOW, newNonce: () => N1});
  assert.deepEqual(failing, {ok: false, status: 503, code: "state_store_failed"});
  await assert.rejects(signOAuthState("", {userId: U1, tenantId: TA, platform: "instagram", nonce: N1, nowSec: NOW}));
});

test("meta-auth callback: verified state is the ONLY tenant source; claim matches user/tenant/platform", () => {
  const m = readFileSync("supabase/functions/meta-auth/index.ts", "utf8");
  assert.match(m, /import \{ consumeOAuthState, oauthStateSecret \} from "\.\.\/_shared\/oauthState\.ts";/);
  assert.match(m, /const tenantId: string = st\.tenantId;/);
  assert.doesNotMatch(m, /claimed\.tenant_id|searchParams\.get\("tenant/);
  const claim = m.slice(m.indexOf("claimNonce: async (c) => {"), m.indexOf("if (!st.ok) {"));
  for (const f of ['.eq("id", c.nonce)', '.eq("consumed", false)', '.eq("user_id", c.userId)', '.eq("tenant_id", c.tenantId)', '.eq("platform", c.platform)', '.gt("expires_at"'])
    assert.ok(claim.includes(f), f);
  // verification happens before the token exchange
  assert.ok(m.indexOf("consumeOAuthState({") < m.indexOf("IG_TOKEN_URL, {"));
  assert.doesNotMatch(m, /verifyState\(|safeEqual\(/);
});
