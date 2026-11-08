// meta-auth platform "facebook": code -> long-lived -> Pages -> channel_accounts.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  linkFacebookPages, facebookDb, appSecretProof, FB_GRAPH_V, FB_PAGE_SUBSCRIBED_FIELDS,
  type FbDb, type FbPageRow, type FbLinkDeps,
} from "../supabase/functions/meta-auth/facebook.ts";

const TA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "app-secret-xyz";
const NOW = 1_800_000_000_000;
const SHORT = "SHORT_USER_TOKEN_s3cr3t", LONG = "LONG_USER_TOKEN_s3cr3t";
const P1TOK = "PAGE1_TOKEN_s3cr3t", P2TOK = "PAGE2_TOKEN_s3cr3t";
const res = (o: unknown) => new Response(JSON.stringify(o), {headers: {"Content-Type": "application/json"}});

type Call = {url: string; init?: RequestInit};
function graph(over: Partial<Record<"token" | "long" | "accounts" | "accounts2" | "sub", unknown>> = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({url, init});
    const u = new URL(url);
    assert.equal(u.origin, "https://graph.facebook.com", "only the fixed Graph host is ever called");
    if (u.pathname.endsWith("/oauth/access_token") && u.searchParams.get("grant_type") === "fb_exchange_token")
      return res(over.long ?? {access_token: LONG, expires_in: 5184000});
    if (u.pathname.endsWith("/oauth/access_token")) return res(over.token ?? {access_token: SHORT, expires_in: 3600});
    if (u.pathname.endsWith("/me/accounts") && u.searchParams.get("after") === "c2") return res(over.accounts2 ?? {data: []});
    if (u.pathname.endsWith("/me/accounts")) return res(over.accounts ?? {data: [
      {id: "111", name: "Page One", access_token: P1TOK, tasks: ["MANAGE", "MESSAGING"], picture: {data: {url: "https://cdn.example/p1.jpg"}}},
      {id: "222", name: "Page Two", access_token: P2TOK},
    ]});
    if (u.pathname.endsWith("/subscribed_apps")) return res(over.sub ?? {success: true});
    throw new Error("unexpected url " + u.pathname);
  };
  return {fetch, calls};
}
function memDb(owned: Record<string, boolean | "error"> = {}, failUpsert = false) {
  const rows = new Map<string, FbPageRow>();
  const db: FbDb = {
    pageOwnedElsewhere: async (id) => owned[id] ?? false,
    upsertPage: async (r) => { if (failUpsert) return false; rows.set(`${r.tenant_id}|${r.channel}|${r.external_id}`, r); return true; },
  };
  return {db, rows};
}
function deps(g: ReturnType<typeof graph>, db: FbDb): FbLinkDeps {
  return {fetch: g.fetch, appId: "APPID", appSecret: SECRET, redirectUri: "https://x.supabase.co/functions/v1/meta-auth/facebook/callback",
    tenantId: TA, encryptField: async (s) => `enc:v1:${Buffer.from(s).toString("hex")}`, db, nowMs: () => NOW};
}
function captureLogs() {
  const out: string[] = [];
  const orig = {log: console.log, warn: console.warn, error: console.error};
  for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { out.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
  return {out, restore: () => Object.assign(console, orig)};
}

test("happy path: pages saved tenant-scoped, encrypted page token, long-lived -> no expiry, webhooks subscribed", async () => {
  const g = graph(), m = memDb();
  const logs = captureLogs();
  let r;
  try { r = await linkFacebookPages("CODE1", deps(g, m.db)); } finally { logs.restore(); }
  assert.deepEqual(r, {ok: true, saved: 2, name: "Page One"});
  const p1 = m.rows.get(`${TA}|facebook|111`)!;
  assert.equal(p1.platform, "facebook");
  assert.equal(p1.status, "active");
  assert.equal(p1.is_active, true);
  assert.equal(p1.avatar_url, "https://cdn.example/p1.jpg");
  assert.equal(p1.token_expires_at, null, "page tokens from a long-lived user token do not expire");
  assert.equal(p1.access_token_encrypted, `enc:v1:${Buffer.from(P1TOK).toString("hex")}`, "PAGE token stored, encrypted");
  assert.equal(m.rows.get(`${TA}|facebook|222`)!.access_token_encrypted, `enc:v1:${Buffer.from(P2TOK).toString("hex")}`);
  // code exchange uses the configured redirect_uri
  const tok = new URL(g.calls[0].url);
  assert.equal(tok.searchParams.get("code"), "CODE1");
  assert.equal(tok.searchParams.get("redirect_uri"), "https://x.supabase.co/functions/v1/meta-auth/facebook/callback");
  // /me/accounts with the LONG token + appsecret_proof
  const acc = new URL(g.calls.find((c) => c.url.includes("/me/accounts"))!.url);
  assert.equal(acc.searchParams.get("access_token"), LONG);
  assert.equal(acc.searchParams.get("appsecret_proof"), await appSecretProof(SECRET, LONG));
  // subscription per page, with that page's token in the POST body (not the URL)
  const subs = g.calls.filter((c) => c.url.endsWith("/subscribed_apps"));
  assert.deepEqual(subs.map((s) => s.url), [`${FB_GRAPH_V}/111/subscribed_apps`, `${FB_GRAPH_V}/222/subscribed_apps`]);
  const b = new URLSearchParams(String(subs[0].init!.body));
  assert.equal(subs[0].init!.method, "POST");
  assert.equal(b.get("access_token"), P1TOK);
  assert.equal(b.get("subscribed_fields"), FB_PAGE_SUBSCRIBED_FIELDS);
  // no token or secret ever logged
  const all = logs.out.join("\n");
  for (const s of [SHORT, LONG, P1TOK, P2TOK, SECRET, "CODE1"]) assert.ok(!all.includes(s), `log leaks ${s}`);
});

test("idempotent: a second link of the same pages upserts the same keys (no duplicates)", async () => {
  const m = memDb();
  await linkFacebookPages("C1", deps(graph(), m.db));
  await linkFacebookPages("C2", deps(graph(), m.db));
  assert.equal(m.rows.size, 2);
});

test("long-lived exchange failure: short-lived expiry recorded, link still works", async () => {
  const m = memDb();
  const r = await linkFacebookPages("C", deps(graph({long: {error: {code: 190}}}), m.db));
  assert.equal(r.ok, true);
  assert.equal(m.rows.get(`${TA}|facebook|111`)!.token_expires_at, new Date(NOW + 3600_000).toISOString());
});

test("token exchange failure -> oauth_token_exchange, nothing saved, no further Graph call", async () => {
  const g = graph({token: {error: {code: 100, message: "bad code"}}}), m = memDb();
  assert.deepEqual(await linkFacebookPages("C", deps(g, m.db)), {ok: false, code: "oauth_token_exchange"});
  assert.equal(g.calls.length, 1);
  assert.equal(m.rows.size, 0);
});

test("no pages / /me/accounts error / page without MESSAGING task or token / bad id", async () => {
  assert.deepEqual(await linkFacebookPages("C", deps(graph({accounts: {data: []}}), memDb().db)), {ok: false, code: "no_pages"});
  assert.deepEqual(await linkFacebookPages("C", deps(graph({accounts: {error: {code: 200}}}), memDb().db)), {ok: false, code: "graph_error"});
  const m = memDb();
  const r = await linkFacebookPages("C", deps(graph({accounts: {data: [
    {id: "333", name: "No msg", access_token: "t", tasks: ["ANALYZE"]},
    {id: "444", name: "No token"},
    {id: "../evil", name: "Bad id", access_token: "t"},
    {id: "555", name: "Ok", access_token: "t5", picture: {data: {url: "http://insecure/x.jpg"}}},
  ]}}), m.db));
  assert.deepEqual(r, {ok: true, saved: 1, name: "Ok"});
  assert.deepEqual([...m.rows.keys()], [`${TA}|facebook|555`]);
  assert.equal(m.rows.get(`${TA}|facebook|555`)!.avatar_url, null, "only https avatars");
});

test("tenant isolation: a page active for another tenant is never linked (webhook would see it as ambiguous)", async () => {
  const m = memDb({"111": true});
  const r = await linkFacebookPages("C", deps(graph(), m.db));
  assert.deepEqual(r, {ok: true, saved: 1, name: "Page Two"});
  assert.ok(!m.rows.has(`${TA}|facebook|111`));
  const only = memDb({"111": true, "222": true});
  assert.deepEqual(await linkFacebookPages("C", deps(graph(), only.db)), {ok: false, code: "account_already_linked"});
  const err = memDb({"111": "error", "222": "error"});
  assert.deepEqual(await linkFacebookPages("C", deps(graph(), err.db)), {ok: false, code: "db_save_failed"}, "lookup error fails closed");
  assert.deepEqual(await linkFacebookPages("C", deps(graph(), memDb({}, true).db)), {ok: false, code: "db_save_failed"});
});

test("pagination follows only Graph-host next URLs (no SSRF), bounded", async () => {
  const g = graph({accounts: {data: [{id: "111", access_token: "a"}], paging: {next: "https://evil.example/v21.0/me/accounts?after=c2"}}});
  await linkFacebookPages("C", deps(g, memDb().db));
  assert.equal(g.calls.filter((c) => c.url.includes("/me/accounts")).length, 1);
  const g2 = graph({accounts: {data: [{id: "111", access_token: "a"}], paging: {next: `${FB_GRAPH_V}/me/accounts?after=c2`}},
    accounts2: {data: [{id: "222", access_token: "b"}]}});
  const m = memDb();
  assert.deepEqual(await linkFacebookPages("C", deps(g2, m.db)), {ok: true, saved: 2, name: ""});
});

test("facebookDb: ownership check excludes own tenant and only counts ACTIVE rows; upsert key and tenant guard", async () => {
  const ops: unknown[][] = [];
  const chain: any = new Proxy({}, {get: (_t, k) => k === "then" ? undefined : (...a: unknown[]) => {
    ops.push([k, ...a]);
    if (k === "limit") return Promise.resolve({data: [{tenant_id: "other"}], error: null});
    if (k === "upsert") return Promise.resolve({error: null});
    return chain;
  }});
  const db = facebookDb(chain, TA);
  assert.equal(await db.pageOwnedElsewhere("111"), true);
  assert.deepEqual(ops, [["from", "channel_accounts"], ["select", "tenant_id"], ["eq", "channel", "facebook"],
    ["eq", "external_id", "111"], ["neq", "tenant_id", TA], ["eq", "status", "active"], ["limit", 1]]);
  ops.length = 0;
  const row = {tenant_id: TA, external_id: "111"} as FbPageRow;
  assert.equal(await db.upsertPage(row), true);
  assert.deepEqual(ops[1], ["upsert", row, {onConflict: "tenant_id,channel,external_id"}]);
  ops.length = 0;
  assert.equal(await db.upsertPage({...row, tenant_id: "someone-else"}), false);
  assert.equal(ops.length, 0, "a row for another tenant is never written");
});

test("index.ts wiring: facebook route verifies state (platform facebook) before any Graph call; Instagram path intact", () => {
  const m = readFileSync("supabase/functions/meta-auth/index.ts", "utf8");
  assert.match(m, /import \{ facebookDb, linkFacebookPages \} from "\.\/facebook\.ts";/);
  assert.match(m, /url\.pathname\.endsWith\("\/facebook\/callback"\)\) \{\n\s+return await handleFacebookCallback\(url\);/);
  const fb = m.slice(m.indexOf("async function handleFacebookCallback"));
  assert.match(fb, /expectedPlatform: "facebook"/);
  for (const f of ['.eq("id", c.nonce)', '.eq("consumed", false)', '.eq("user_id", c.userId)', '.eq("tenant_id", c.tenantId)', '.eq("platform", c.platform)', '.gt("expires_at"'])
    assert.ok(fb.includes(f), f);
  assert.ok(fb.indexOf("consumeOAuthState({") < fb.indexOf("linkFacebookPages(code"));
  assert.match(fb, /const fbTenantId: string = st\.tenantId;/);
  assert.match(fb, /tenantId: fbTenantId,[\s\S]*db: facebookDb\(sb, fbTenantId\)/);
  assert.doesNotMatch(fb, /searchParams\.get\("tenant|access_token=|token: r\./);
  // the Instagram callback still expects platform instagram and its own path
  const ig = m.slice(m.indexOf("Deno.serve("), m.indexOf("async function handleFacebookCallback"));
  assert.match(ig, /expectedPlatform: "instagram"/);
  assert.match(ig, /!url\.pathname\.endsWith\("\/instagram\/callback"\)/);
});
