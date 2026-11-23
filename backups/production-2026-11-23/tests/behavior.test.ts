// @ts-nocheck
// Differential behavior harness: ORIGINAL production snapshot vs HOTFIX working copy.
// Lives outside the repo. FAKE values only. fetch is stubbed: no network, no production calls.
import assert from "node:assert/strict";

const S = "/tmp/claude-0/-home-user-milanochat/b83f4a81-cf0b-5d1e-b57f-3a22ee1b536e/scratchpad";
const ORIG = {
  meta: `${S}/prod-snapshots/meta-auth.v63.index.ts`,
  chan: `${S}/prod-snapshots/channels.v112.index.ts`,
  api: `${S}/prod-snapshots/api.v108.index.ts`,
};
const FIX = {
  meta: `${S}/hotfix-work/meta-auth.v63.hotfix.index.ts`,
  chan: `${S}/hotfix-work/channels.v112.hotfix.index.ts`,
  api: `${S}/hotfix-work/api.v108.hotfix.index.ts`,
};

const BASE = "https://fakeproj.supabase.co";
const F = {
  IG_SECRET: "FAKE_IG_APP_SECRET_0123456789",
  IG_ID: "FAKE_IG_APP_ID_111",
  REDIR: "https://FAKE-redirect.example/FAKE-cb-secret-value",
  KEY: "FAKE_ENC_KEY_for_test_only",
  META_SECRET: "FAKE_META_APP_SECRET_abc",
  META_ID: "FAKE_META_APP_ID_222",
  SRV: "FAKE_SERVICE_ROLE_KEY_xyz",
  SHORT: "FAKE_SHORT_TOKEN_aaa",
  LONG: "FAKE_LONG_TOKEN_bbb",
  DBMSG: "FAKE_DB_DETAIL_SENSITIVE_42",
  THROW: "FAKE_THROW_SENSITIVE_77",
};
const ALL_FAKES = Object.values(F);

function setEnv(over = {}) {
  const e = {
    SUPABASE_URL: BASE,
    SUPABASE_SERVICE_ROLE_KEY: F.SRV,
    INSTAGRAM_APP_ID: F.IG_ID,
    INSTAGRAM_APP_SECRET: F.IG_SECRET,
    INSTAGRAM_REDIRECT_URI: F.REDIR,
    META_APP_ID: F.META_ID,
    META_APP_SECRET: F.META_SECRET,
    FIELD_ENCRYPTION_KEY: F.KEY,
    USE_INSTAGRAM_DIRECT_LOGIN: "true",
    FRONTEND_ORIGIN: "https://front.example",
    ...over,
  };
  for (const k of ["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","INSTAGRAM_APP_ID","INSTAGRAM_APP_SECRET","INSTAGRAM_REDIRECT_URI","META_APP_ID","META_APP_SECRET","FIELD_ENCRYPTION_KEY","USE_INSTAGRAM_DIRECT_LOGIN","FRONTEND_ORIGIN"]) {
    if (e[k] === undefined || e[k] === null) Deno.env.delete(k); else Deno.env.set(k, e[k]);
  }
}

let seq = 0;
async function load(path) {
  let captured = null;
  const orig = Deno.serve;
  Deno.serve = (h) => { captured = h; return {}; };
  try { await import(`file://${path}?t=${++seq}`); } finally { Deno.serve = orig; }
  assert.ok(captured, "handler captured");
  return captured;
}

function captureLogs() {
  const lines = [];
  const o = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const f = (...a) => lines.push(a.map((x) =>
    typeof x === "string" ? x
    : x instanceof Error ? `${x.name}: ${x.message}\n${x.stack ?? ""}`
    : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" "));
  console.log = console.warn = console.error = console.info = f;
  return { lines, restore() { Object.assign(console, o); } };
}

const json = (b, s = 200, h = {}) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...h } });

function makeFetch(o = {}) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = String(init.method ?? (typeof input === "object" && input && input.method ? input.method : "GET")).toUpperCase();
    let body = init.body;
    if (body instanceof URLSearchParams) body = body.toString();
    calls.push({ method, url, body: typeof body === "string" ? body : undefined });
    if (url.startsWith(`${BASE}/auth/v1/user`)) return json({ id: "user-1", aud: "authenticated", email: "t@example.com" });
    if (url.startsWith(`${BASE}/rest/v1/tenants`)) {
      if (o.tenantsEmpty && method === "GET") return json({ code: "PGRST116", message: "0 rows", details: "The result contains 0 rows" }, 406);
      if (o.tenantInsertThrows && method === "POST") throw new TypeError(`error sending request for url (${url}) ${FAKE_CRED_URL}`);
      if (o.tenantInsertHttpError && method === "POST") return json({ message: `insert failed for url (${FAKE_CRED_URL})`, details: "token=FAKE_FATAL_TOKEN_999 client_secret=FAKE_CLIENT_SECRET_zzz", hint: FAKE_CRED_URL, code: "23505" }, 409);
      return json({ id: "tenant-1", user_id: "user-1" });
    }
    if (url.startsWith(`${BASE}/rest/v1/meta_oauth_states`)) {
      if (method === "PATCH" && o.claimThrows) throw new TypeError(`error sending request for url (${url})`);
      if (method === "PATCH" && o.claimHttpError) return json({ message: `boom for ${url}`, code: "XX000" }, 500);
      return method === "POST" ? new Response(null, { status: 201 }) : json({ tenant_id: "tenant-1", platform: o.statePlatform ?? "instagram" });
    }
    if (url.startsWith(`${BASE}/rest/v1/channel_accounts`)) {
      if (method === "PATCH" && o.accountsPatchError) return json({ message: F.DBMSG, code: "XX000" }, 500);
      if (method === "GET" && o.accountsGetError) return json({ message: F.DBMSG, code: "XX001" }, 500);
      if (method === "GET" && o.accountsGetOk) return json([{ id: 1 }]);
      if (method === "GET") return json({ code: "PGRST116", message: "0 rows", details: "The result contains 0 rows" }, 406);
      if (method === "POST" && o.upsertThrows) throw new TypeError(`error sending request for url (${url})`);
      if (method === "POST" && o.upsertHttpError) return json({ message: `dup key for ${url}`, code: "23505" }, 409);
      if (method === "POST") return new Response(null, { status: 201 });
      return json({ id: "acc-1" });
    }
    if (url.startsWith(`${BASE}/rest/v1/conversations`)) return json([]);
    if (url.startsWith("https://api.instagram.com/oauth/access_token")) {
      if (o.igTokenBody) return json(o.igTokenBody, 400);
      return json({ data: [o.igTokenNoUser ? { access_token: F.SHORT } : { access_token: F.SHORT, user_id: "ig-123" }] });
    }
    if (url.startsWith("https://graph.instagram.com/access_token")) {
      if (o.longThrows) throw new TypeError(`error sending request for url (${url})`);
      if (o.longBody) return json(o.longBody, 400);
      return json({ access_token: F.LONG, expires_in: 5184000 });
    }
    if (url.includes("graph.instagram.com/v21.0/me?")) return o.meBody ? json(o.meBody, 400) : json({ user_id: "ig-123", username: "u", account_type: "BUSINESS" });
    if (url.includes("/me/subscribed_apps")) {
      if (o.subThrows) throw new TypeError(`error sending request for url (${url})`);
      return json(o.subBody ?? { success: true });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return { fn, calls };
}

async function run(handler, req, fetchOpts = {}) {
  const { fn, calls } = makeFetch(fetchOpts);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fn;
  const logs = captureLogs();
  let res;
  try { res = await handler(req); } finally { logs.restore(); globalThis.fetch = realFetch; }
  const text = await res.text();
  return { status: res.status, headers: [...res.headers.entries()].sort(), location: res.headers.get("location"), text, calls, logs: logs.lines.join("\n") };
}

const b64u = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function signState(secret, payload) {
  const body = b64u(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${b64u(String.fromCharCode(...sig))}`;
}
const cb = (path, q = {}) => new Request(`${BASE}/functions/v1/meta-auth/${path}?${new URLSearchParams(q)}`);
const noLeak = (s, what) => { for (const f of ALL_FAKES) assert.ok(!s.includes(f), `${what} leaks ${f}`); };

// ───────────────────────── meta-auth ─────────────────────────
Deno.test("meta-auth: /debug public endpoint removed (orig leaks, hotfix 404)", async () => {
  setEnv();
  const o = await run(await load(ORIG.meta), cb("debug"));
  assert.equal(o.status, 200);
  assert.ok(o.text.includes(F.REDIR) && o.text.includes(F.IG_ID), "baseline exposes config (documents the issue)");
  const h = await run(await load(FIX.meta), cb("debug"));
  assert.equal(h.status, 404);
  assert.equal(h.text, JSON.stringify({ error: "Not found" }));
  noLeak(h.text, "hotfix /debug");
  assert.equal(h.calls.length, 0, "no outbound calls");
});

Deno.test("meta-auth: other routes unchanged (facebook callback, unknown route, POST)", async () => {
  setEnv();
  const [o, h] = [await load(ORIG.meta), await load(FIX.meta)];
  for (const mk of [() => cb("facebook/callback"), () => cb("nope"), () => new Request(`${BASE}/functions/v1/meta-auth/instagram/callback`, { method: "POST" })]) {
    const a = await run(o, mk()); const b = await run(h, mk());
    assert.equal(b.status, a.status); assert.equal(b.location, a.location); assert.equal(b.text, a.text);
  }
});

const goodPayload = (over = {}) => ({ u: "user-1", t: "tenant-1", p: "instagram", i: "nonce-abc", exp: Math.floor(Date.now() / 1000) + 600, ...over });

Deno.test("meta-auth: full callback success flow identical (location + outbound call sequence + token-exchange contract)", async () => {
  setEnv();
  const state = await signState(F.IG_SECRET, goodPayload());
  const req = () => cb("instagram/callback", { code: "CODE123#_", state });
  const a = await run(await load(ORIG.meta), req());
  const b = await run(await load(FIX.meta), req());
  assert.equal(a.status, 302); assert.equal(b.status, 302);
  assert.equal(b.location, a.location);
  assert.ok(b.location.includes("channel_connected=instagram"));
  const sig = (c) => c.map((x) => `${x.method} ${x.url.split("?")[0]}`);
  assert.deepEqual(sig(b.calls), sig(a.calls), "same outbound request sequence");
  const tx = (r) => r.calls.find((c) => c.url.startsWith("https://api.instagram.com/oauth/access_token")).body;
  assert.equal(tx(b), tx(a), "token exchange body (client_id, grant_type, redirect_uri, code) identical");
  assert.ok(tx(b).includes(encodeURIComponent(`${BASE}/functions/v1/meta-auth/instagram/callback`)), "canonical redirect_uri still used");
  // Only intended log change: the token-exchange redirect_uri line is gone.
  assert.ok(a.logs.includes("token exchange redirect_uri"), "baseline logs it");
  assert.ok(!b.logs.includes("token exchange redirect_uri") && !b.logs.includes("/functions/v1/meta-auth/instagram/callback"), "hotfix does not log it");
  noLeak(b.logs, "hotfix success logs");
});

Deno.test("meta-auth: state validation contract unchanged (bad signature, expired, wrong platform, malformed)", async () => {
  setEnv();
  const [o, h] = [await load(ORIG.meta), await load(FIX.meta)];
  const cases = [
    await signState("WRONG_SECRET", goodPayload()),
    await signState(F.IG_SECRET, goodPayload({ exp: Math.floor(Date.now() / 1000) - 5 })),
    await signState(F.IG_SECRET, goodPayload({ p: "facebook" })),
    "no-dot-state",
  ];
  for (const st of cases) {
    const a = await run(o, cb("instagram/callback", { code: "c", state: st }));
    const b = await run(h, cb("instagram/callback", { code: "c", state: st }));
    assert.equal(b.location, a.location); assert.equal(b.status, a.status);
  }
});

Deno.test("meta-auth: fetch error containing the request URL (secret+token) is no longer logged", async () => {
  setEnv();
  const state = await signState(F.IG_SECRET, goodPayload());
  const req = () => cb("instagram/callback", { code: "c", state });
  const a = await run(await load(ORIG.meta), req(), { longThrows: true });
  const b = await run(await load(FIX.meta), req(), { longThrows: true });
  assert.ok(a.logs.includes(F.IG_SECRET) && a.logs.includes(F.SHORT), "baseline logs secret+token via error object (documents the issue)");
  noLeak(b.logs, "hotfix catch logs");
  assert.ok(b.logs.includes("unexpected error: TypeError"), "name-only log present");
  assert.equal(b.location, a.location, "user-visible redirect unchanged");
  assert.ok(b.location.includes("channel_error=unexpected_error"));
});

Deno.test("meta-auth: subscribed_apps fetch error no longer logs access token; redirect unchanged", async () => {
  setEnv();
  const state = await signState(F.IG_SECRET, goodPayload());
  const req = () => cb("instagram/callback", { code: "c", state });
  const a = await run(await load(ORIG.meta), req(), { subThrows: true });
  const b = await run(await load(FIX.meta), req(), { subThrows: true });
  assert.ok(a.logs.includes(F.LONG), "baseline logs token (documents the issue)");
  noLeak(b.logs, "hotfix subscribed_apps logs");
  assert.equal(b.location, a.location);
  assert.ok(b.location.includes("channel_connected=instagram"));
});

Deno.test("meta-auth: subscribed_apps non-success body is not dumped into logs", async () => {
  setEnv();
  const state = await signState(F.IG_SECRET, goodPayload());
  const body = { weird: F.LONG };
  const b = await run(await load(FIX.meta), cb("instagram/callback", { code: "c", state }), { subBody: body });
  noLeak(b.logs, "hotfix non-success body");
  assert.ok(b.logs.includes("no_success"));
});

// ───────────────────────── channels ─────────────────────────
const authReq = (path, init = {}) => new Request(`${BASE}/functions/v1/channels/${path}`, { ...init, headers: { authorization: "Bearer fake-jwt", ...(init.headers ?? {}) } });
const stripState = (u) => { const x = new URL(u); x.searchParams.delete("state"); return x.toString(); };

async function verifyOriginalContract(state, secret, platform) {
  // Same algorithm as meta-auth v63 verifyState (production contract).
  const [body, sig] = state.split(".");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const exp = b64u(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
  assert.equal(sig, exp, "HMAC-SHA256(secret, body) base64url");
  const p = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (body.length % 4)) % 4)));
  assert.deepEqual(Object.keys(p).sort(), ["exp", "i", "p", "t", "u"]);
  assert.equal(p.p, platform); assert.equal(p.u, "user-1"); assert.equal(p.t, "tenant-1");
  assert.ok(p.exp - Math.floor(Date.now() / 1000) > 800 && p.exp - Math.floor(Date.now() / 1000) <= 900, "15 minute TTL");
  return p;
}

Deno.test("channels: instagram direct login ?debug=1 -> debug fields + IG-DIAG logs removed, URL/state contract unchanged", async () => {
  setEnv();
  const a = await run(await load(ORIG.chan), authReq("meta/oauth-url?channel=instagram&debug=1"));
  const b = await run(await load(FIX.chan), authReq("meta/oauth-url?channel=instagram&debug=1"));
  const ja = JSON.parse(a.text), jb = JSON.parse(b.text);
  assert.ok(ja.debug && ja.debug.clientId === F.IG_ID, "baseline returns debug (documents the issue)");
  assert.ok(a.logs.includes("[IG-DIAG]") && a.logs.includes(F.REDIR), "baseline logs redirect secret (documents the issue)");
  assert.deepEqual(Object.keys(jb).sort(), ["provider", "state", "url"]);
  assert.equal(jb.provider, "instagram");
  assert.equal(stripState(jb.url), stripState(ja.url), "authorize URL identical apart from state");
  const u = new URL(jb.url);
  assert.equal(u.searchParams.get("scope"), "instagram_business_basic,instagram_business_manage_messages");
  assert.equal(u.searchParams.get("redirect_uri"), `${BASE}/functions/v1/meta-auth/instagram/callback`);
  assert.ok(!b.logs.includes("[IG-DIAG]"));
  noLeak(b.logs, "hotfix connect logs");
  assert.ok(b.logs.includes("[channels] INSTAGRAM_REDIRECT_URI secret differs from the canonical redirect"), "value-free warning kept");
  await verifyOriginalContract(jb.state, F.IG_SECRET, "instagram");
  const nonceRow = (r) => JSON.parse(r.calls.find((c) => c.method === "POST" && c.url.includes("/meta_oauth_states")).body);
  assert.deepEqual(Object.keys(nonceRow(b)).sort(), Object.keys(nonceRow(a)).sort(), "meta_oauth_states row shape identical");
});

Deno.test("channels: hotfix state is accepted by BOTH original and hotfix meta-auth (cross-version contract)", async () => {
  setEnv();
  const c = await run(await load(FIX.chan), authReq("meta/oauth-url?channel=instagram"));
  const state = JSON.parse(c.text).state;
  for (const path of [ORIG.meta, FIX.meta]) {
    const r = await run(await load(path), cb("instagram/callback", { code: "c", state }));
    assert.ok(r.location.includes("channel_connected=instagram"), `${path} rejected the state: ${r.location}`);
  }
});

Deno.test("channels: facebook login + instagram fallback unchanged (scopes, redirect, state secret); debug key gone", async () => {
  setEnv({ USE_INSTAGRAM_DIRECT_LOGIN: "false" });
  for (const ch of ["facebook", "instagram"]) {
    const a = await run(await load(ORIG.chan), authReq(`meta/oauth-url?channel=${ch}&debug=1`));
    const b = await run(await load(FIX.chan), authReq(`meta/oauth-url?channel=${ch}&debug=1`));
    const ja = JSON.parse(a.text), jb = JSON.parse(b.text);
    assert.deepEqual(Object.keys(jb).sort(), ["provider", "state", "url"]);
    assert.equal(jb.provider, "facebook");
    assert.equal(stripState(jb.url), stripState(ja.url));
    await verifyOriginalContract(jb.state, F.META_SECRET, ch);
    noLeak(b.logs, `hotfix fb logs (${ch})`);
    assert.ok(!b.logs.includes("[IG-DIAG]"));
  }
  const b = await run(await load(FIX.chan), authReq("meta/oauth-url?channel=instagram"));
  assert.ok(b.logs.includes("falling back to facebook login"), "value-free fallback note kept");
});

Deno.test("channels: /meta/status, OPTIONS, 400/404 responses unchanged", async () => {
  setEnv();
  const [o, h] = [await load(ORIG.chan), await load(FIX.chan)];
  for (const mk of [
    () => new Request(`${BASE}/functions/v1/channels/meta/status`),
    () => new Request(`${BASE}/functions/v1/channels/meta/oauth-url`, { method: "OPTIONS" }),
    () => authReq("meta/oauth-url?channel=bogus"),
    () => authReq("nope"),
  ]) {
    const a = await run(o, mk()); const b = await run(h, mk());
    assert.equal(b.status, a.status); assert.deepEqual(b.headers, a.headers); assert.equal(b.text, a.text);
  }
});

Deno.test("channels: DB errors no longer returned to the client or logged as full objects", async () => {
  setEnv();
  const patch = () => authReq("accounts/acc-1", { method: "PATCH", body: JSON.stringify({ auto_reply: true }), headers: { "content-type": "application/json" } });
  const del = () => authReq("accounts/acc-1", { method: "DELETE" });
  const [o, h] = [await load(ORIG.chan), await load(FIX.chan)];
  for (const mk of [patch, del]) {
    const a = await run(o, mk(), { accountsPatchError: true });
    const b = await run(h, mk(), { accountsPatchError: true });
    assert.equal(b.status, 500); assert.equal(a.status, 500);
    assert.ok(a.text.includes(F.DBMSG), "baseline returns raw DB message (documents the issue)");
    assert.equal(JSON.parse(b.text).error, "خطأ داخلي");
    noLeak(b.text, "hotfix error response"); noLeak(b.logs, "hotfix error logs");
    assert.ok(b.logs.includes("XX000"), "error code still logged");
  }
  const a = await run(o, authReq("accounts"), { accountsGetError: true });
  const b = await run(h, authReq("accounts"), { accountsGetError: true });
  assert.equal(b.text, a.text, "accounts list still [] on error");
  assert.ok(a.logs.includes(F.DBMSG), "baseline logs the full error object (documents the issue)");
  noLeak(b.logs, "hotfix accounts-select logs");
});

Deno.test("channels: fatal/config errors return a generic message", async () => {
  setEnv({ SUPABASE_SERVICE_ROLE_KEY: null });
  const a = await run(await load(ORIG.chan), authReq("accounts"));
  const b = await run(await load(FIX.chan), authReq("accounts"));
  assert.equal(a.status, 500); assert.equal(b.status, 500);
  assert.ok(a.text.includes("SUPABASE_SERVICE_ROLE_KEY"), "baseline returns internal config text (documents the issue)");
  assert.equal(JSON.parse(b.text).error, "خطأ داخلي");
  assert.ok(b.logs.includes("[channels] fatal: Error"));
});

Deno.test("channels: account PATCH/GET/DELETE success shapes unchanged", async () => {
  setEnv();
  const [o, h] = [await load(ORIG.chan), await load(FIX.chan)];
  const mk = () => authReq("accounts/acc-1", { method: "DELETE" });
  const a = await run(o, mk()); const b = await run(h, mk());
  assert.equal(b.status, a.status); assert.equal(b.text, a.text);
  const c = await run(o, authReq("summary")); const d = await run(h, authReq("summary"));
  assert.equal(d.text, c.text);
});

// ───────────────────────── api ─────────────────────────
Deno.test("api: /db-test removed (404), /health + unknown routes + OPTIONS unchanged", async () => {
  setEnv();
  const [o, h] = [await load(ORIG.api), await load(FIX.api)];
  const t = (path, m = "GET") => new Request(`${BASE}/functions/v1/api${path}`, { method: m });
  const a = await run(o, t("/db-test"), { accountsGetOk: true }); const b = await run(h, t("/db-test"), { accountsGetOk: true });
  assert.equal(a.status, 200, "baseline db-test answered (documents the issue)");
  assert.equal(b.status, 404);
  assert.equal(b.text, JSON.stringify({ error: "Not found" }));
  assert.equal(b.calls.length, 0, "hotfix makes no database call");
  for (const [p, m] of [["/health", "GET"], ["/nope", "GET"], ["/health", "OPTIONS"], ["/db-test", "OPTIONS"]]) {
    const x = await run(o, t(p, m)); const y = await run(h, t(p, m));
    assert.equal(y.status, x.status);
    assert.deepEqual(y.headers, x.headers);
    if (p === "/health" && m === "GET") {
      const jx = JSON.parse(x.text), jy = JSON.parse(y.text); delete jx.timestamp; delete jy.timestamp;
      assert.deepEqual(jy, jx);
    } else assert.equal(y.text, x.text);
  }
});


// ═════════════ hardening round 2 (reflected error param, DB error logging, fatal-handler credential URL) ═════════════
const FAKE_CRED_URL = "https://FAKE-host.example/path?client_secret=FAKE_CLIENT_SECRET_zzz&access_token=FAKE_FATAL_TOKEN_999";
const NEW_FAKES = ["FAKE_CLIENT_SECRET_zzz", "FAKE_FATAL_TOKEN_999", "FAKE-host.example", "randomUUID failed"];
const URL_PARTS = ["nonce-abc", "/rest/v1/", "fakeproj.supabase.co", "meta_oauth_states", "id=eq", "on_conflict", "channel_accounts?"];

Deno.test("channels fatal handler: an error carrying a fake credential-bearing URL is neither logged nor returned (kills 'log full error object')", async () => {
  setEnv();
  const realCrypto = globalThis.crypto;
  const boom = new TypeError(`randomUUID failed for url (${FAKE_CRED_URL})`);
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: new Proxy(realCrypto, {
    get(t, p) { if (p === "randomUUID") return () => { throw boom; }; const v = t[p]; return typeof v === "function" ? v.bind(t) : v; },
  }) });
  try {
    const a = await run(await load(ORIG.chan), authReq("meta/oauth-url?channel=instagram"));
    const b = await run(await load(FIX.chan), authReq("meta/oauth-url?channel=instagram"));
    assert.equal(a.status, 500); assert.equal(b.status, 500);
    assert.ok(a.text.includes("FAKE_FATAL_TOKEN_999"), "baseline returns the raw message (documents the issue)");
    assert.ok(a.logs.includes("FAKE_FATAL_TOKEN_999"), "baseline logs the full object (documents the issue)");
    assert.equal(JSON.parse(b.text).error, "خطأ داخلي");
    for (const f of NEW_FAKES) { assert.ok(!b.logs.includes(f), `hotfix logs leak ${f}`); assert.ok(!b.text.includes(f), `hotfix response leaks ${f}`); }
    assert.ok(!b.logs.includes("    at "), "no stack trace in logs");
    assert.ok(b.logs.includes("[channels] fatal: TypeError"), "error NAME is still logged");
  } finally { Object.defineProperty(globalThis, "crypto", { configurable: true, value: realCrypto }); }
});

Deno.test("meta-auth: attacker-controlled `error` parameter is not logged (newline/unicode/control chars); redirect contract unchanged", async () => {
  setEnv();
  const [o, h] = [await load(ORIG.meta), await load(FIX.meta)];
  const evil = "x\n[meta-auth] instagram linked: 999\r\n\u202E<script>alert(1)</script>\u0000 FAKE_REFLECT_MARKER";
  for (const v of [evil, "invalid_scope", "a".repeat(500), "ünï-çødé"]) {
    const a = await run(o, cb("instagram/callback", { error: v }));
    const b = await run(h, cb("instagram/callback", { error: v }));
    assert.equal(b.status, a.status, "status unchanged"); assert.equal(b.status, 302);
    assert.equal(b.location, a.location, "redirect (channel_error value) byte-identical to production");
    assert.ok(b.location.includes(new URLSearchParams({ channel_error: v }).toString()), "value still returned to the client unchanged");
    assert.ok(b.logs.includes("provider_error"), "fixed label logged");
    assert.deepEqual(b.logs.split("\n").filter(Boolean).length, 1, "exactly one log line (no injected lines)");
    assert.ok(!b.logs.includes(v), "raw value not logged");
  }
  const a0 = await run(o, cb("instagram/callback", { error: evil }));
  assert.ok(a0.logs.includes("FAKE_REFLECT_MARKER") && a0.logs.split("\n").some((l) => l.startsWith("[meta-auth] instagram linked: 999")), "baseline log injection works (documents the issue)");
  const b1 = await run(h, cb("instagram/callback", { error: evil }));
  assert.ok(!b1.logs.includes("FAKE_REFLECT_MARKER") && !b1.logs.includes("instagram linked: 999"));
  // access_denied keeps its existing mapping and log
  const a2 = await run(o, cb("instagram/callback", { error: "access_denied" }));
  const b2 = await run(h, cb("instagram/callback", { error: "access_denied" }));
  assert.equal(b2.location, a2.location); assert.ok(b2.location.includes("channel_error=user_cancelled")); assert.equal(b2.logs, a2.logs);
});

const dbCases = [
  ["claim: network failure (message embeds fake REST URL + nonce)", { claimThrows: true }, "state claim error:", "TypeError", "channel_error=db_error"],
  ["claim: HTTP error with code (message embeds fake URL)", { claimHttpError: true }, "state claim error:", "XX000", "channel_error=db_error"],
  ["upsert: network failure (message embeds fake URL + query params)", { upsertThrows: true }, "channel_accounts upsert failed:", "TypeError", "channel_error=db_save_failed"],
  ["upsert: HTTP error with code (message embeds fake URL)", { upsertHttpError: true }, "channel_accounts upsert failed:", "23505", "channel_error=db_save_failed"],
];
for (const [name, opts, label, tag, loc] of dbCases) {
  Deno.test(`meta-auth DB error logging: ${name}`, async () => {
    setEnv();
    const state = await signState(F.IG_SECRET, goodPayload());
    const req = () => cb("instagram/callback", { code: "c", state });
    const a = await run(await load(ORIG.meta), req(), opts);
    const b = await run(await load(FIX.meta), req(), opts);
    assert.ok(a.logs.includes("nonce-abc") || a.logs.includes("on_conflict") || a.logs.includes("/rest/v1/"), "baseline logs the URL (documents the issue)");
    for (const part of URL_PARTS) assert.ok(!b.logs.includes(part), `hotfix logs leak '${part}'`);
    assert.ok(b.logs.includes(`${label} ${tag}`), `safe diagnostic '${label} ${tag}' present: ${b.logs.slice(0, 200)}`);
    assert.equal(b.status, a.status); assert.equal(b.location, a.location, "user-facing redirect unchanged");
    assert.ok(b.location.includes(loc));
    const sig = (c) => c.map((x) => `${x.method} ${x.url.split("?")[0]}`);
    assert.deepEqual(sig(b.calls), sig(a.calls), "same outbound calls (no extra retry, no extra write)");
    assert.ok(!b.calls.some((c) => c.method === "POST" && c.url.includes("/channel_accounts")) || opts.upsertThrows || opts.upsertHttpError, "no account write on claim failure");
  });
}

Deno.test("meta-auth: nonce claim request unchanged (method, filters, body) vs production", async () => {
  setEnv();
  const state = await signState(F.IG_SECRET, goodPayload());
  const req = () => cb("instagram/callback", { code: "c", state });
  const a = await run(await load(ORIG.meta), req());
  const b = await run(await load(FIX.meta), req());
  const claim = (r) => { const c = r.calls.find((x) => x.method === "PATCH" && x.url.includes("/meta_oauth_states")); return { method: c.method, url: c.url.replace(/expires_at=gt\.[^&]+/, "expires_at=gt.<ts>"), body: c.body }; };
  assert.deepEqual(claim(b), claim(a));
  assert.ok(claim(b).url.includes("id=eq.nonce-abc") && claim(b).url.includes("consumed=eq.false"));
  assert.equal(claim(b).body, JSON.stringify({ consumed: true }));
});


// ═════════════ round 3: C17 (default-tenant creation failure) + Meta API error logs ═════════════
const tenantCases = [
  ["insert HTTP error (message/details/hint carry fake URL, token, secret)", { tenantsEmpty: true, tenantInsertHttpError: true }],
  ["insert network failure (message carries fake REST + credential URLs)", { tenantsEmpty: true, tenantInsertThrows: true }],
];
for (const [name, opts] of tenantCases) {
  Deno.test(`channels default-tenant creation failure (C17): ${name}`, async () => {
    setEnv();
    const req = () => authReq("meta/oauth-url?channel=instagram");
    const a = await run(await load(ORIG.chan), req(), opts);
    const b = await run(await load(FIX.chan), req(), opts);
    assert.ok(a.logs.includes("FAKE_FATAL_TOKEN_999"), "baseline logs the full error object (documents the issue)");
    for (const f of ["FAKE_CLIENT_SECRET_zzz", "FAKE_FATAL_TOKEN_999", "FAKE-host.example", "insert failed for url", "fakeproj.supabase.co", "/rest/v1/"]) {
      assert.ok(!b.logs.includes(f), `hotfix logs leak '${f}'`); assert.ok(!b.text.includes(f), `hotfix response leaks '${f}'`);
    }
    assert.ok(!b.logs.includes('"details"') && !b.logs.includes('"hint"') && !b.logs.includes('"message"'), "no serialized error object in logs");
    assert.ok(b.logs.includes("[channels] failed to create default tenant:"), "diagnostic label kept");
    assert.equal(b.status, a.status); assert.equal(b.status, 404);
    assert.equal(b.text, a.text, "response body unchanged");
    assert.equal(JSON.parse(b.text).error, "لا يوجد حساب مرتبط");
    const sig = (c) => c.map((x) => `${x.method} ${x.url.split("?")[0]}`);
    assert.deepEqual(sig(b.calls), sig(a.calls), "same control flow: lookup, one insert attempt, no state/nonce row created");
    assert.ok(!b.calls.some((c) => c.url.includes("/meta_oauth_states")), "no OAuth state is created without a tenant");
  });
}

const MEMSG = `Malformed access token ${F.LONG} url=${FAKE_CRED_URL} client_secret=${F.IG_SECRET}`;
const metaCases = [
  ["token exchange (Instagram OAuth error shape)", { igTokenBody: { error_type: "OAuthException", code: 400, error_message: MEMSG } }, "token exchange failed:", "400", "channel_error=oauth_token_exchange"],
  ["long-lived exchange (Graph error shape)", { longBody: { error: { message: MEMSG, type: "OAuthException", code: 190, fbtrace_id: "x" } } }, "long-lived exchange failed:", "190", "channel_connected=instagram"],
  ["long-lived exchange (message only, no code/type)", { longBody: { error: { message: MEMSG } } }, "long-lived exchange failed:", "unknown", "channel_connected=instagram"],
  ["/me profile request", { igTokenNoUser: true, meBody: { error: { message: MEMSG, type: "OAuthException", code: 190 } } }, "/me failed:", "190", "channel_error=no_eligible_instagram"],
  ["subscribed_apps", { subBody: { error: { message: MEMSG, type: "OAuthException", code: 190 } } }, "subscribed_apps failed:", "190", "channel_connected=instagram"],
];
for (const [name, opts, label, tag, loc] of metaCases) {
  Deno.test(`meta-auth Meta API error log never carries remote free text: ${name}`, async () => {
    setEnv();
    const state = await signState(F.IG_SECRET, goodPayload());
    const req = () => cb("instagram/callback", { code: "c", state });
    const a = await run(await load(ORIG.meta), req(), opts);
    const b = await run(await load(FIX.meta), req(), opts);
    assert.ok(a.logs.includes(F.LONG), "baseline logs the remote message (documents the mechanism)");
    for (const f of [F.LONG, F.IG_SECRET, "FAKE-host.example", "FAKE_CLIENT_SECRET_zzz", "Malformed access token"]) assert.ok(!b.logs.includes(f), `hotfix logs leak '${f}'`);
    assert.ok(b.logs.includes(`${label} ${tag}`), `safe diagnostic '${label} ${tag}' present: ${b.logs.slice(0, 160)}`);
    assert.equal(b.status, a.status); assert.equal(b.location, a.location, "redirect unchanged");
    assert.ok(b.location.includes(loc));
    const sig = (c) => c.map((x) => `${x.method} ${x.url.split("?")[0]}`);
    assert.deepEqual(sig(b.calls), sig(a.calls), "same outbound requests");
  });
}
