// OAuth 2.1 (authorization code + PKCE S256, refresh rotation, DCR) for the remote HTTP server.
// In-process app, in-memory OAuth store, fake Supabase (tenants + password login). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadHttpConfig, ConfigError } from "../dist/config.js";
import { escapeHtml, supabasePasswordLogin } from "../dist/oauthPages.js";
import {
  startOAuth, register, pkce, authorizeUrl, browserFlow, exchange, refresh, req, Jar, csrfOf, reqIdOf, rpc, bearer,
  toolPayload, connect, REDIRECT, SIGNING, SUPA_SECRET, SESSION, T1, T2, U1, U2, U3,
} from "./oauthHelpers.mjs";

const entry = fileURLToPath(new URL("../dist/http-server.js", import.meta.url));
const enc = s => new TextEncoder().encode(s);

async function mint(s, { sub = U1, aud = s.resource, iss = s.issuer, scope = "mcp:tools", exp = "1h", secret = SIGNING, typ = "at+jwt", fam, jti } = {}) {
  let b = new SignJWT({ client_id: "x".repeat(32), scope, fam: fam ?? crypto.randomUUID() })
    .setProtectedHeader({ alg: "HS256", typ }).setSubject(sub).setIssuedAt().setExpirationTime(exp).setJti(jti ?? crypto.randomUUID());
  if (aud) b = b.setAudience(aud);
  if (iss) b = b.setIssuer(iss);
  return b.sign(enc(secret));
}

test("discovery: AS metadata, protected resource metadata (root + /mcp), 401 challenge with resource_metadata", async () => {
  const s = await startOAuth();
  try {
    const as = await req(s, null, "/.well-known/oauth-authorization-server");
    assert.equal(as.res.status, 200);
    assert.equal(as.json.issuer, s.issuer);
    assert.equal(as.json.authorization_endpoint, s.origin + "/authorize");
    assert.equal(as.json.token_endpoint, s.origin + "/token");
    assert.equal(as.json.registration_endpoint, s.origin + "/register");
    assert.equal(as.json.revocation_endpoint, s.origin + "/revoke");
    assert.deepEqual(as.json.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(as.json.response_types_supported, ["code"]);
    assert.deepEqual(as.json.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.deepEqual(as.json.scopes_supported, ["mcp:tools"]);
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const pr = await req(s, null, path);
      assert.equal(pr.res.status, 200, path);
      assert.equal(pr.json.resource, s.resource, path);
      assert.deepEqual(pr.json.authorization_servers, [s.issuer], path);
      assert.deepEqual(pr.json.scopes_supported, ["mcp:tools"], path);
    }
    const { res } = await rpc(s, "tools/list", {});
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), `Bearer resource_metadata="${s.origin}/.well-known/oauth-protected-resource", scope="mcp:tools"`);
    const bad = await rpc(s, "tools/list", {}, bearer("aaa.bbb.ccc"));
    assert.equal(bad.res.status, 401);
    assert.match(bad.res.headers.get("www-authenticate"), /^Bearer error="invalid_token", resource_metadata="/);
  } finally { await s.close(); }
});

test("DCR: redirect URI / metadata validation, public + confidential clients, per-hour cap", async () => {
  const s = await startOAuth({ maxClientsPerHour: 3 });
  try {
    const bad = [
      { redirect_uris: ["http://evil.example/cb"] }, { redirect_uris: ["javascript:alert(1)"] },
      { redirect_uris: ["cursor://anysphere/cb"] }, { redirect_uris: ["https://a.example/cb#frag"] },
      { redirect_uris: [] }, { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`) },
      { redirect_uris: ["https://user:pw@a.example/cb"] }, { redirect_uris: ["http://localhost.evil.example/cb"] },
      { token_endpoint_auth_method: "client_secret_basic" }, { grant_types: ["client_credentials"] },
      { response_types: ["token"] }, { scope: "admin" }, { client_name: "x".repeat(1001) },
    ];
    for (const b of bad) {
      const r = await register(s, b);
      assert.equal(r.res.status, 400, JSON.stringify(b).slice(0, 80));
      assert.equal(r.json.error, "invalid_client_metadata", JSON.stringify(b).slice(0, 80));
    }
    const pub = await register(s, { redirect_uris: [REDIRECT, "http://localhost:6274/oauth/callback", "http://127.0.0.1:33418/cb"] });
    assert.equal(pub.res.status, 201);
    assert.match(pub.json.client_id, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(pub.json.client_secret, undefined);
    assert.equal(pub.json.token_endpoint_auth_method, "none");
    const conf = await register(s, { token_endpoint_auth_method: "client_secret_post", client_name: "  My‮App\u0007  " });
    assert.equal(conf.res.status, 201);
    assert.match(conf.json.client_secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(conf.json.client_name, "MyApp", "control / bidi characters stripped");
    // stored as hash only
    const stored = await s.store.getClient(conf.json.client_id);
    assert.notEqual(stored.clientSecretHash, conf.json.client_secret);
    assert.match(stored.clientSecretHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(stored).includes(conf.json.client_secret), false);
    const longName = await register(s, { client_name: "ن".repeat(300) });
    assert.equal(longName.res.status, 201);
    assert.equal([...longName.json.client_name].length, 100, "client_name capped");
    const capped = await register(s);
    assert.equal(capped.res.status, 400);
    assert.equal(capped.json.error, "too_many_requests");
    const huge = await req(s, null, "/register", { method: "POST", json: { redirect_uris: [REDIRECT], pad: "x".repeat(20_000) } });
    assert.equal(huge.res.status, 413);
  } finally { await s.close(); }
});

test("authorize: missing / plain PKCE, unknown client, redirect mismatch (exact match), bad scope / resource", async () => {
  const s = await startOAuth();
  try {
    const c = (await register(s, { redirect_uris: [REDIRECT, "http://127.0.0.1:33418/cb"] })).json.client_id;
    const { challenge } = pkce();
    for (const [name, url] of [["missing", authorizeUrl(c, null, { method: null })], ["plain", authorizeUrl(c, challenge, { method: "plain" })],
      ["no-method", authorizeUrl(c, challenge, { method: null })], ["short", authorizeUrl(c, "abc")]]) {
      const r = await req(s, new Jar(), url);
      assert.equal(r.res.status, 302, name);
      const loc = new URL(r.location);
      assert.equal(loc.origin + loc.pathname, REDIRECT, name);
      assert.equal(loc.searchParams.get("error"), "invalid_request", name);
      assert.equal(loc.searchParams.get("state"), "st-123", name);
      assert.equal(loc.searchParams.get("code"), null, name);
    }
    const unknown = await req(s, new Jar(), authorizeUrl("Z".repeat(32), challenge));
    assert.equal(unknown.res.status, 400);
    assert.equal(unknown.location, null);
    for (const redirect of ["https://claude.ai/api/mcp/other", "https://evil.example/cb", "http://127.0.0.1:9999/cb", REDIRECT + "?x=1"]) {
      const r = await req(s, new Jar(), authorizeUrl(c, challenge, { redirect }));
      assert.equal(r.res.status, 400, redirect);
      assert.equal(r.location, null, "never redirects to an unregistered URI: " + redirect);
      assert.equal(r.json.error, "invalid_request");
    }
    const scope = await req(s, new Jar(), authorizeUrl(c, challenge, { scope: "mcp:tools admin" }));
    assert.equal(new URL(scope.location).searchParams.get("error"), "invalid_scope");
    const resource = await req(s, new Jar(), authorizeUrl(c, challenge, { extra: { resource: "https://other.example/mcp" } }));
    assert.equal(new URL(resource.location).searchParams.get("error"), "invalid_target");
    const ok = await req(s, new Jar(), authorizeUrl(c, challenge, { extra: { resource: s.resource } }));
    assert.equal(ok.res.status, 302);
    assert.match(ok.location, /^\/consent\?req=/);
    const noScope = await req(s, new Jar(), authorizeUrl(c, challenge, { scope: "" }));
    assert.match(noScope.location, /^\/consent\?req=/, "empty scope defaults to mcp:tools");
  } finally { await s.close(); }
});

test("full flow: DCR -> authorize -> login -> consent -> token -> /mcp tools/list (official MCP client)", async () => {
  const s = await startOAuth();
  try {
    const reg = await register(s);
    const { verifier, challenge } = pkce();
    const f = await browserFlow(s, reg.json.client_id, challenge, { state: "xyz-state" });
    assert.equal(f.step, "done");
    // Login page / consent page hardening.
    for (const page of [f.loginPage, f.consent]) {
      assert.equal(page.res.headers.get("x-frame-options"), "DENY");
      assert.equal(page.res.headers.get("cache-control"), "no-store");
      const csp = page.res.headers.get("content-security-policy");
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /style-src 'nonce-[A-Za-z0-9+/=]+'/);
      assert.match(page.text, /<html lang="ar" dir="rtl">/);
    }
    assert.match(f.loginPage.text, /تسجيل الدخول/);
    assert.match(f.consent.text, /سماح/);
    assert.match(f.consent.text, /رفض/);
    assert.match(f.consent.text, /إنشاء وتعديل تدفقات الأتمتة/);
    assert.match(f.consent.text, /<span class="host">claude\.ai<\/span>/);
    assert.match(f.consent.res.headers.get("content-security-policy"), /form-action 'self' https:\/\/claude\.ai/);
    // Session cookie: custom name, HttpOnly, SameSite=Lax, short-lived, rotated on login.
    const sc = f.jar.raw.find(c => c.startsWith("milano_mcp_sid="));
    assert.ok(sc, "custom cookie name");
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Lax/i);
    assert.match(sc, /Max-Age=900|Expires=/i);
    assert.ok(f.sidBefore && f.sidAfter && f.sidBefore !== f.sidAfter, "session id regenerated on login");
    assert.ok(!f.jar.raw.some(c => /connect\.sid/.test(c)));
    // Redirect back with code + state + iss.
    assert.equal(f.post.res.status, 303);
    assert.equal(f.loc.origin + f.loc.pathname, REDIRECT);
    assert.equal(f.loc.searchParams.get("state"), "xyz-state");
    assert.equal(f.loc.searchParams.get("iss"), s.issuer);
    assert.match(f.code, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!s.logs.some(l => l.includes("pw-a-correct")), "password never logged");

    const t = await exchange(s, reg.json.client_id, f.code, verifier);
    assert.equal(t.res.status, 200, t.text);
    assert.equal(t.res.headers.get("cache-control"), "no-store");
    assert.equal(t.json.token_type, "Bearer");
    assert.equal(t.json.expires_in, 3600);
    assert.equal(t.json.scope, "mcp:tools");
    assert.match(t.json.refresh_token, /^[A-Za-z0-9_-]{43}$/);
    const [h, p] = t.json.access_token.split(".").slice(0, 2).map(x => JSON.parse(Buffer.from(x, "base64url")));
    assert.equal(h.alg, "HS256");
    assert.equal(h.typ, "at+jwt");
    assert.equal(p.iss, s.issuer);
    assert.equal(p.aud, s.resource);
    assert.equal(p.sub, U1);
    assert.equal(p.client_id, reg.json.client_id);
    assert.equal(p.scope, "mcp:tools");
    assert.equal(p.exp - p.iat, 3600);
    assert.match(p.jti, /^[0-9a-f-]{36}$/);
    assert.equal(p.tenant_id, undefined);

    const transport = new StreamableHTTPClientTransport(new URL(s.resource), { requestInit: { headers: bearer(t.json.access_token) } });
    const client = new Client({ name: "oauth-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(x => x.name).sort(), ["add_node", "connect_nodes", "create_flow", "list_flows"]);
      assert.doesNotMatch(JSON.stringify(tools.map(x => x.inputSchema)), /tenant_id/);
      const r = await client.callTool({ name: "create_flow", arguments: { name: "عبر OAuth" } });
      assert.equal(r.isError, undefined);
      assert.equal(s.flows.rows[0].tenant_id, T1);
      const rej = await client.callTool({ name: "list_flows", arguments: { tenant_id: T2 } });
      assert.equal(rej.isError, true, "client-supplied tenant_id rejected");
    } finally { await client.close(); }
    // Only hashes in the store.
    assert.equal(JSON.stringify(await s.store.getClient(reg.json.client_id)).includes(f.code), false);
  } finally { await s.close(); }
});

test("code: wrong verifier fails and burns the code; reuse fails and revokes the grant; expired fails; redirect/client binding", async () => {
  const clock = { t: Date.now() };
  const s = await startOAuth({ clock });
  try {
    const c = (await register(s)).json.client_id;
    const other = (await register(s)).json.client_id;
    // wrong verifier
    let k = pkce(); let f = await browserFlow(s, c, k.challenge);
    let r = await exchange(s, c, f.code, pkce().verifier);
    assert.equal(r.res.status, 400);
    assert.equal(r.json.error, "invalid_grant");
    r = await exchange(s, c, f.code, k.verifier);
    assert.equal(r.json.error, "invalid_grant", "code burned by the failed attempt");
    // malformed verifier
    k = pkce(); f = await browserFlow(s, c, k.challenge);
    assert.equal((await exchange(s, c, f.code, "short")).json.error, "invalid_grant");
    // other client / wrong redirect_uri
    k = pkce(); f = await browserFlow(s, c, k.challenge);
    assert.equal((await exchange(s, other, f.code, k.verifier)).json.error, "invalid_grant");
    k = pkce(); f = await browserFlow(s, c, k.challenge);
    assert.equal((await exchange(s, c, f.code, k.verifier, { redirect: "https://claude.ai/api/mcp/x" })).json.error, "invalid_grant");
    // reuse
    k = pkce(); f = await browserFlow(s, c, k.challenge);
    const first = await exchange(s, c, f.code, k.verifier);
    assert.equal(first.res.status, 200);
    assert.equal((await rpc(s, "tools/list", {}, bearer(first.json.access_token))).res.status, 200);
    const again = await exchange(s, c, f.code, k.verifier);
    assert.equal(again.json.error, "invalid_grant");
    assert.equal((await rpc(s, "tools/list", {}, bearer(first.json.access_token))).res.status, 401, "code reuse revokes the issued access token");
    assert.equal((await refresh(s, c, first.json.refresh_token)).json.error, "invalid_grant", "and its refresh token");
    // expired (5 minutes)
    k = pkce(); f = await browserFlow(s, c, k.challenge);
    clock.t += 5 * 60 * 1000 + 1000;
    assert.equal((await exchange(s, c, f.code, k.verifier)).json.error, "invalid_grant");
    // unknown grant / missing params
    assert.equal((await req(s, null, "/token", { method: "POST", form: { grant_type: "password", client_id: c } })).json.error, "unsupported_grant_type");
    assert.equal((await req(s, null, "/token", { method: "POST", form: { grant_type: "authorization_code", client_id: c, code: "x" } })).json.error, "invalid_request");
    assert.equal((await req(s, null, "/token", { method: "POST", form: { grant_type: "authorization_code", client_id: "nope", code: "x", code_verifier: k.verifier } })).res.status, 401);
  } finally { await s.close(); }
});

test("refresh: rotation returns new tokens; reuse of an old refresh token revokes the whole family", async () => {
  const s = await startOAuth();
  try {
    const { clientId, tokens } = await connect(s);
    const r1 = await refresh(s, clientId, tokens.refresh_token);
    assert.equal(r1.res.status, 200, r1.text);
    assert.notEqual(r1.json.access_token, tokens.access_token);
    assert.notEqual(r1.json.refresh_token, tokens.refresh_token);
    assert.equal(r1.json.expires_in, 3600);
    assert.equal((await rpc(s, "tools/list", {}, bearer(r1.json.access_token))).res.status, 200);
    const r2 = await refresh(s, clientId, r1.json.refresh_token);
    assert.equal(r2.res.status, 200);
    // scope escalation refused
    const esc = await refresh(s, clientId, r2.json.refresh_token, { scope: "mcp:tools admin" });
    assert.equal(esc.json.error, "invalid_scope");
    // reuse of r1's (rotated) token
    const reuse = await refresh(s, clientId, r1.json.refresh_token);
    assert.equal(reuse.res.status, 400);
    assert.equal(reuse.json.error, "invalid_grant");
    assert.equal((await refresh(s, clientId, r2.json.refresh_token)).json.error, "invalid_grant", "family revoked: latest refresh dead");
    for (const at of [tokens.access_token, r1.json.access_token, r2.json.access_token])
      assert.equal((await rpc(s, "tools/list", {}, bearer(at))).res.status, 401, "family revoked: access tokens dead");
    // another client cannot use someone else's refresh token
    const b = await connect(s, "b@example.com");
    const other = (await register(s)).json.client_id;
    assert.equal((await refresh(s, other, b.tokens.refresh_token)).json.error, "invalid_grant");
    assert.equal((await refresh(s, b.clientId, b.tokens.refresh_token)).res.status, 200, "not revoked by the foreign attempt");
    assert.equal((await refresh(s, clientId, "garbage")).json.error, "invalid_grant");
  } finally { await s.close(); }
});

test("access token validation: wrong aud / iss / signature / typ / expired / revoked / no scope; static Supabase JWT off", async () => {
  const clock = { t: Date.now() };
  const s = await startOAuth({ clock });
  try {
    const { clientId, tokens } = await connect(s);
    assert.equal((await rpc(s, "tools/list", {}, bearer(tokens.access_token))).res.status, 200);
    const fam = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url")).fam;
    const cases = {
      wrongAud: await mint(s, { aud: "https://other.example/mcp", fam }),
      noAud: await mint(s, { aud: null, fam }),
      supabaseAud: await mint(s, { aud: "authenticated", fam }),
      wrongIss: await mint(s, { iss: "https://evil.example/", fam }),
      wrongSig: await mint(s, { secret: SUPA_SECRET, fam }),
      wrongTyp: await mint(s, { typ: "JWT", fam }),
      expired: await mint(s, { exp: Math.floor(Date.now() / 1000) - 60, fam }),
      unknownFamily: await mint(s, {}),
      supabaseUserJwt: await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "HS256" }).setSubject(U1)
        .setAudience("authenticated").setIssuedAt().setExpirationTime("1h").sign(enc(SUPA_SECRET)),
    };
    for (const [name, tok] of Object.entries(cases)) {
      const r = await rpc(s, "tools/list", {}, bearer(tok));
      assert.equal(r.res.status, 401, name);
      assert.match(r.res.headers.get("www-authenticate"), /resource_metadata=/, name);
    }
    const noScope = await rpc(s, "tools/list", {}, bearer(await mint(s, { scope: "other", fam })));
    assert.equal(noScope.res.status, 403);
    assert.match(noScope.res.headers.get("www-authenticate"), /insufficient_scope/);
    assert.equal((await rpc(s, "tools/list", {}, bearer(await mint(s, { fam })))).res.status, 200, "control: same family, valid claims");
    // revoke the access token
    const rv = await req(s, null, "/revoke", { method: "POST", form: { client_id: clientId, token: tokens.access_token } });
    assert.equal(rv.res.status, 200);
    assert.equal((await rpc(s, "tools/list", {}, bearer(tokens.access_token))).res.status, 401, "revoked jti");
    // expiry after 1 h (clock)
    const r = await refresh(s, clientId, tokens.refresh_token);
    assert.equal((await rpc(s, "tools/list", {}, bearer(r.json.access_token))).res.status, 200);
    clock.t += 3600 * 1000 + 10_000;
    assert.equal((await rpc(s, "tools/list", {}, bearer(r.json.access_token))).res.status, 401, "expired after 1h");
    // revoke the refresh token -> family dead
    const r2 = await refresh(s, clientId, r.json.refresh_token);
    assert.equal(r2.res.status, 200);
    await req(s, null, "/revoke", { method: "POST", form: { client_id: clientId, token: r2.json.refresh_token } });
    assert.equal((await rpc(s, "tools/list", {}, bearer(r2.json.access_token))).res.status, 401);
    assert.equal((await refresh(s, clientId, r2.json.refresh_token)).json.error, "invalid_grant");
  } finally { await s.close(); }
});

test("cross-user isolation: user A's token cannot read or modify user B's flows; user without tenant gets no code", async () => {
  const s = await startOAuth();
  try {
    const a = await connect(s, "a@example.com");
    const b = await connect(s, "b@example.com");
    const A = bearer(a.tokens.access_token), B = bearer(b.tokens.access_token);
    const created = toolPayload(await rpc(s, "tools/call", { name: "create_flow", arguments: { name: "A-flow" } }, A));
    assert.equal(created.tenant_id, T1);
    const listB = toolPayload(await rpc(s, "tools/call", { name: "list_flows", arguments: {} }, B));
    assert.equal(listB.tenant_id, T2);
    assert.equal(listB.flows.length, 0);
    const before = JSON.stringify(s.flows.rows);
    const addB = await rpc(s, "tools/call", { name: "add_node", arguments: { flow_id: created.flow_id, node_type: "end", position_x: 1, position_y: 1 } }, B);
    assert.equal(addB.body.result.isError, true);
    const spoof = await rpc(s, "tools/call", { name: "list_flows", arguments: { tenant_id: T1 } }, B);
    assert.equal(spoof.body.result.isError, true);
    const hdr = await rpc(s, "tools/call", { name: "list_flows", arguments: {} }, { ...B, "X-Milano-Tenant": T1 });
    assert.equal(toolPayload(hdr).tenant_id, T2, "X-Milano-Tenant ignored");
    assert.equal(JSON.stringify(s.flows.rows), before);
    // user C: no workspace -> consent refused (no code issued); a forged-but-valid token for C -> 403
    const reg = await register(s);
    const f = await browserFlow(s, reg.json.client_id, pkce().challenge, { email: "c@example.com" });
    assert.equal(f.post.res.status, 403);
    assert.match(f.post.text, /لا توجد مساحة عمل/);
    assert.equal(f.code, null);
    // same family as A (valid) but sub = C
    const fam = JSON.parse(Buffer.from(a.tokens.access_token.split(".")[1], "base64url")).fam;
    const c = await rpc(s, "tools/list", {}, bearer(await mint(s, { sub: U3, fam })));
    assert.equal(c.res.status, 403);
  } finally { await s.close(); }
});

test("consent page escapes attacker-controlled client_name; shows the redirect host", async () => {
  const s = await startOAuth();
  try {
    const evil = `<script>alert(1)</script><img src=x onerror="alert('x')">&amp;\`x\``;
    const reg = await register(s, { client_name: evil, redirect_uris: ["https://phish.example.net/cb"] });
    const f = await browserFlow(s, reg.json.client_id, pkce().challenge, { redirect: "https://phish.example.net/cb" });
    assert.equal(f.consent.res.status, 200);
    assert.ok(!f.consent.text.includes("<script>alert"), "no raw script tag");
    assert.ok(!f.consent.text.includes("<img"), "no raw img tag");
    assert.ok(f.consent.text.includes(escapeHtml(evil)));
    assert.match(f.consent.text, /<span class="host">phish\.example\.net<\/span>/);
    assert.equal(escapeHtml(`<>&"'\``), "&lt;&gt;&amp;&quot;&#39;&#96;");
  } finally { await s.close(); }
});

test("CSRF: missing / wrong token -> 403 on login and consent POST; foreign Origin -> 403; no session -> 400", async () => {
  const s = await startOAuth();
  try {
    const c = (await register(s)).json.client_id;
    const jar = new Jar();
    const a = await req(s, jar, authorizeUrl(c, pkce().challenge));
    const id = reqIdOf(a.location);
    const page = await req(s, jar, a.location);
    const csrf = csrfOf(page.text);
    assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
    for (const form of [{ req: id, email: "a@example.com", password: "pw-a-correct" }, { csrf: "x".repeat(43), req: id, email: "a@example.com", password: "pw-a-correct" }]) {
      const r = await req(s, jar, "/consent/login", { method: "POST", form });
      assert.equal(r.res.status, 403);
    }
    const foreign = await req(s, jar, "/consent/login", { method: "POST", headers: { Origin: "https://evil.example" }, form: { csrf, req: id, email: "a@example.com", password: "pw-a-correct" } });
    assert.equal(foreign.res.status, 403);
    assert.equal(s.logins.length, 0, "no login attempted without a valid CSRF token");
    const wrongPw = await req(s, jar, "/consent/login", { method: "POST", form: { csrf, req: id, email: "a@example.com", password: "wrong" } });
    assert.equal(wrongPw.res.status, 401);
    assert.match(wrongPw.text, /غير صحيحة/);
    assert.ok(!wrongPw.text.includes("wrong"), "password not echoed");
    const ok = await req(s, jar, "/consent/login", { method: "POST", form: { csrf, req: id, email: "a@example.com", password: "pw-a-correct" } });
    assert.equal(ok.res.status, 303);
    const consent = await req(s, jar, ok.location);
    const csrf2 = csrfOf(consent.text);
    assert.notEqual(csrf2, csrf, "csrf rotated on login");
    assert.equal((await req(s, jar, "/consent", { method: "POST", form: { req: id, action: "allow" } })).res.status, 403);
    assert.equal((await req(s, jar, "/consent", { method: "POST", form: { csrf, req: id, action: "allow" } })).res.status, 403, "pre-login token invalid");
    // fresh browser without session
    assert.equal((await req(s, new Jar(), a.location)).res.status, 400);
    assert.equal((await req(s, new Jar(), "/consent", { method: "POST", form: { csrf: csrf2, req: id, action: "allow" } })).res.status, 403);
    const done = await req(s, jar, "/consent", { method: "POST", form: { csrf: csrf2, req: id, action: "allow" } });
    assert.equal(done.res.status, 303);
  } finally { await s.close(); }
});

test("deny -> redirect with error=access_denied + state; the request is single use", async () => {
  const s = await startOAuth();
  try {
    const c = (await register(s)).json.client_id;
    const f = await browserFlow(s, c, pkce().challenge, { action: "deny", state: "keep-me" });
    assert.equal(f.post.res.status, 303);
    assert.equal(f.loc.origin + f.loc.pathname, REDIRECT);
    assert.equal(f.loc.searchParams.get("error"), "access_denied");
    assert.equal(f.loc.searchParams.get("state"), "keep-me");
    assert.equal(f.code, null);
    const again = await req(s, f.jar, "/consent", { method: "POST", form: { csrf: csrfOf(f.consent.text), req: f.id, action: "allow" } });
    assert.equal(again.res.status, 400);
  } finally { await s.close(); }
});

test("confidential client: client_secret_post required at /token; wrong / missing secret -> 401 invalid_client", async () => {
  const s = await startOAuth();
  try {
    const reg = await register(s, { token_endpoint_auth_method: "client_secret_post" });
    const id = reg.json.client_id, secret = reg.json.client_secret;
    const k = pkce();
    const f = await browserFlow(s, id, k.challenge);
    assert.equal((await exchange(s, id, f.code, k.verifier)).res.status, 401);
    assert.equal((await exchange(s, id, f.code, k.verifier, { extra: { client_secret: "wrong" } })).json.error, "invalid_client");
    const basic = await req(s, null, "/token", { method: "POST", headers: { Authorization: "Basic " + Buffer.from(id + ":" + secret).toString("base64") },
      form: { grant_type: "authorization_code", client_id: id, code: f.code, code_verifier: k.verifier, redirect_uri: REDIRECT } });
    assert.equal(basic.res.status, 401);
    const ok = await exchange(s, id, f.code, k.verifier, { extra: { client_secret: secret } });
    assert.equal(ok.res.status, 200, ok.text);
    assert.equal((await refresh(s, id, ok.json.refresh_token)).res.status, 401);
    assert.equal((await refresh(s, id, ok.json.refresh_token, { client_secret: secret })).res.status, 200);
    // a public client must not send a secret
    const pub = (await register(s)).json.client_id;
    assert.equal((await req(s, null, "/token", { method: "POST", form: { grant_type: "refresh_token", client_id: pub, client_secret: "x", refresh_token: "y" } })).res.status, 401);
  } finally { await s.close(); }
});

test("rate limits: /authorize, /token, /register, login POST", async () => {
  const s = await startOAuth({ limits: { authorize: 2, token: 2, register: 1, login: 1 } });
  try {
    const c = (await register(s)).json.client_id;
    assert.equal((await register(s)).res.status, 429);
    const k = pkce();
    const jar = new Jar();
    const a1 = await req(s, jar, authorizeUrl(c, k.challenge));
    assert.equal(a1.res.status, 302);
    assert.equal((await req(s, new Jar(), authorizeUrl(c, k.challenge))).res.status, 302);
    const a3 = await req(s, new Jar(), authorizeUrl(c, k.challenge));
    assert.equal(a3.res.status, 429);
    assert.equal(a3.json.error, "too_many_requests");
    for (let i = 0; i < 2; i++) await req(s, null, "/token", { method: "POST", form: { grant_type: "refresh_token", client_id: c, refresh_token: "x" } });
    assert.equal((await req(s, null, "/token", { method: "POST", form: { grant_type: "refresh_token", client_id: c, refresh_token: "x" } })).res.status, 429);
    const page = await req(s, jar, a1.location);
    const form = { csrf: csrfOf(page.text), req: reqIdOf(a1.location), email: "a@example.com", password: "wrong" };
    assert.equal((await req(s, jar, "/consent/login", { method: "POST", form })).res.status, 401);
    assert.equal((await req(s, jar, "/consent/login", { method: "POST", form })).res.status, 429);
  } finally { await s.close(); }
});

test("static Supabase bearer fallback works alongside OAuth when MCP_ALLOW_STATIC_BEARER is on", async () => {
  const s = await startOAuth({ allowStaticBearer: true });
  try {
    const supa = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "HS256" }).setSubject(U2)
      .setAudience("authenticated").setIssuedAt().setExpirationTime("1h").sign(enc(SUPA_SECRET));
    assert.equal(toolPayload(await rpc(s, "tools/call", { name: "list_flows", arguments: {} }, bearer(supa))).tenant_id, T2);
    const { tokens } = await connect(s);
    assert.equal(toolPayload(await rpc(s, "tools/call", { name: "list_flows", arguments: {} }, bearer(tokens.access_token))).tenant_id, T1);
    // an OAuth-typed token signed with the Supabase secret is NOT accepted by either path
    const forged = await mint(s, { secret: SUPA_SECRET });
    assert.equal((await rpc(s, "tools/list", {}, bearer(forged))).res.status, 401);
  } finally { await s.close(); }
});

test("supabasePasswordLogin: keeps only user.id, maps errors, sends the anon key", async () => {
  const calls = [];
  const mk = (status, body) => async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); };
  let login = supabasePasswordLogin("https://x.supabase.co", "anon-key", mk(200, { access_token: "t", user: { id: U1.toUpperCase() } }));
  assert.deepEqual(await login("a@example.com", "pw"), { ok: true, userId: U1 });
  assert.equal(calls[0].url, "https://x.supabase.co/auth/v1/token?grant_type=password");
  assert.equal(calls[0].init.headers.apikey, "anon-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: "a@example.com", password: "pw" });
  login = supabasePasswordLogin("https://x.supabase.co", "k", mk(400, { error: "invalid_grant" }));
  assert.deepEqual(await login("a@example.com", "pw"), { ok: false, reason: "invalid" });
  login = supabasePasswordLogin("https://x.supabase.co", "k", mk(500, {}));
  assert.deepEqual(await login("a@example.com", "pw"), { ok: false, reason: "unavailable" });
  login = supabasePasswordLogin("https://x.supabase.co", "k", async () => { throw new Error("net"); });
  assert.deepEqual(await login("a@example.com", "pw"), { ok: false, reason: "unavailable" });
  login = supabasePasswordLogin("https://x.supabase.co", "k", mk(200, { user: { id: "not-a-uuid" } }));
  assert.deepEqual(await login("a@example.com", "pw"), { ok: false, reason: "unavailable" });
});

test("env validation: OAuth names listed (no values), production refusals, https issuer", () => {
  const base = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc-key-do-not-leak", SUPABASE_JWT_SECRET: SUPA_SECRET };
  const oauth = { ...base, MCP_OAUTH_ENABLED: "true", MCP_PUBLIC_URL: "https://abc.ngrok.app", MCP_OAUTH_SIGNING_SECRET: SIGNING, SESSION_SECRET: SESSION, SUPABASE_ANON_KEY: "anon" };
  assert.throws(() => loadHttpConfig({ ...base, MCP_OAUTH_ENABLED: "true" }),
    e => e instanceof ConfigError && /MCP_PUBLIC_URL, MCP_OAUTH_SIGNING_SECRET, SESSION_SECRET, SUPABASE_ANON_KEY\./.test(e.message));
  assert.throws(() => loadHttpConfig({ ...oauth, NODE_ENV: "production" }), e => /Missing required environment variable\(s\): DATABASE_URL/.test(e.message) && !e.message.includes("svc-key"));
  assert.throws(() => loadHttpConfig({ ...oauth, NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db.example:5432/postgres", MCP_INSECURE_COOKIES: "true" }), /Refusing to start: MCP_INSECURE_COOKIES/);
  assert.throws(() => loadHttpConfig({ ...base, NODE_ENV: "production" }), /no authentication method/);
  assert.throws(() => loadHttpConfig({ ...oauth, MCP_PUBLIC_URL: "http://abc.ngrok.app" }), /https/);
  assert.throws(() => loadHttpConfig({ ...oauth, MCP_PUBLIC_URL: "https://abc.ngrok.app/base" }), /bare origin/);
  assert.throws(() => loadHttpConfig({ ...oauth, MCP_OAUTH_SIGNING_SECRET: "short" }), /MCP_OAUTH_SIGNING_SECRET is too short/);
  assert.throws(() => loadHttpConfig({ ...oauth, SESSION_SECRET: "short" }), /SESSION_SECRET is too short/);
  assert.throws(() => loadHttpConfig({ ...oauth, MCP_OAUTH_SIGNING_SECRET: SUPA_SECRET }), /must differ from SUPABASE_JWT_SECRET/);
  assert.throws(() => loadHttpConfig({ ...oauth, MCP_OAUTH_ENABLED: "yes" }), /MCP_OAUTH_ENABLED must be/);
  assert.throws(() => loadHttpConfig({ ...oauth, DATABASE_URL: "mysql://x" }), /postgres/);
  assert.throws(() => loadHttpConfig({ ...oauth, DATABASE_URL: "postgres://u:p@db.example/x", DATABASE_SSL: "disable" }), /local database host/);
  const c = loadHttpConfig({ ...oauth, DATABASE_URL: "postgresql://u:p@db.example:6543/postgres?sslmode=disable&application_name=x" });
  assert.equal(c.oauth.issuer, "https://abc.ngrok.app/");
  assert.equal(c.oauth.resource, "https://abc.ngrok.app/mcp");
  assert.equal(c.oauth.cookieSecure, true);
  assert.equal(c.oauth.databaseSsl, "verify");
  assert.doesNotMatch(c.oauth.databaseUrl, /sslmode/, "libpq ssl overrides stripped");
  assert.equal(c.allowStaticBearer, true, "static bearer default on outside production");
  const local = loadHttpConfig({ ...oauth, MCP_PUBLIC_URL: "http://localhost:8080", MCP_INSECURE_COOKIES: "true" });
  assert.equal(local.oauth.cookieSecure, false);
  assert.equal(local.oauth.databaseUrl, null);
  // production: static bearer off by default, SUPABASE_JWT_SECRET then not required
  const { SUPABASE_JWT_SECRET: _drop, ...noSupa } = oauth;
  const prod = loadHttpConfig({ ...noSupa, NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db.example:5432/postgres" });
  assert.equal(prod.allowStaticBearer, false);
  assert.equal(prod.jwtSecret, "");
  assert.equal(loadHttpConfig({ ...oauth, NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db.example/x", MCP_ALLOW_STATIC_BEARER: "true" }).allowStaticBearer, true);
});

test("built entry: production refuses OAuth without DATABASE_URL and with insecure cookies; secrets never echoed", () => {
  const env = { PATH: process.env.PATH ?? "", NODE_ENV: "production", PORT: "0", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "svc-key-do-not-leak",
    MCP_OAUTH_ENABLED: "true", MCP_PUBLIC_URL: "https://abc.ngrok.app", MCP_OAUTH_SIGNING_SECRET: SIGNING, SESSION_SECRET: SESSION, SUPABASE_ANON_KEY: "anon-do-not-leak" };
  const r = spawnSync(process.execPath, [entry], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DATABASE_URL/);
  assert.doesNotMatch(r.stderr, /svc-key-do-not-leak|anon-do-not-leak|oauth-signing-secret|session-secret/);
  const r2 = spawnSync(process.execPath, [entry], { env: { ...env, DATABASE_URL: "postgres://u:p@127.0.0.1:9/x", MCP_INSECURE_COOKIES: "true" }, encoding: "utf8", timeout: 10000 });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /Refusing to start: MCP_INSECURE_COOKIES/);
});
