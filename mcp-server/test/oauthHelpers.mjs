// Shared helpers for the OAuth tests: in-process app, fake Supabase password login, cookie jar,
// PKCE helpers and a scripted browser walk through /authorize -> login -> consent.
import { createHash, randomBytes } from "node:crypto";
import { createFakeSupabase } from "./fakeSupabase.mjs";
import { createFlowStore } from "../dist/store.js";
import { createHttpApp } from "../dist/httpApp.js";
import { supabaseTenantLookup } from "../dist/auth.js";
import { createMemoryOAuthStore } from "../dist/oauthStore.js";

export const SUPA_SECRET = "test-jwt-secret-0123456789-abcdefghijklmnop";
export const SIGNING = "oauth-signing-secret-0123456789-abcdefghijkl";
export const SESSION = "session-secret-0123456789-abcdefghijklmnopq";
export const T1 = "11111111-1111-4111-8111-111111111111";
export const T2 = "22222222-2222-4222-8222-222222222222";
export const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const U3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // no tenant
export const USERS = {
  "a@example.com": { password: "pw-a-correct", id: U1 },
  "b@example.com": { password: "pw-b-correct", id: U2 },
  "c@example.com": { password: "pw-c-correct", id: U3 },
};
export const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export async function startOAuth({ limits = {}, store = createMemoryOAuthStore(), allowStaticBearer = false, maxClientsPerHour = 100, clock = null } = {}) {
  const flows = createFakeSupabase();
  const tenants = createFakeSupabase({ table: "tenants" });
  tenants.rows.push({ id: T1, user_id: U1 }, { id: T2, user_id: U2 });
  const logins = [];
  const passwordLogin = async (email, password) => {
    logins.push(email);
    const u = USERS[email];
    return u && u.password === password ? { ok: true, userId: u.id } : { ok: false, reason: "invalid" };
  };
  const logs = [];
  const now = clock ? () => clock.t : undefined;
  // Listen first so the issuer can carry the real port.
  const holder = {};
  const http = await import("node:http");
  const server = http.createServer((req, res) => holder.app(req, res));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  holder.app = createHttpApp({
    store: createFlowStore(flows, "columns", flows.table), lookupTenant: supabaseTenantLookup(tenants),
    jwtSecret: SUPA_SECRET, allowSecretHeader: false, allowStaticBearer, log: m => logs.push(m),
    rateLimits: { mcp: 10_000, authorize: 10_000, token: 10_000, register: 10_000, login: 10_000, consent: 10_000, ...limits },
    oauth: {
      publicOrigin: origin, issuer: origin + "/", resource: origin + "/mcp", signingSecret: SIGNING, sessionSecret: SESSION,
      cookieSecure: false, maxClientsPerHour, store, passwordLogin, now,
    },
  });
  return {
    base: origin, origin, issuer: origin + "/", resource: origin + "/mcp", flows, tenants, logins, logs, store,
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  };
}

/** Minimal cookie jar (one cookie name is enough here). */
export class Jar {
  constructor() { this.c = new Map(); this.raw = []; }
  take(res) {
    for (const sc of res.headers.getSetCookie()) {
      this.raw.push(sc);
      const [kv] = sc.split(";");
      const i = kv.indexOf("=");
      this.c.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
}

export async function req(s, jar, path, { method = "GET", form, json, headers = {} } = {}) {
  const h = { ...headers };
  if (jar && jar.c.size) h.Cookie = jar.header();
  let body;
  if (form) { h["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
  if (json) { h["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  const res = await fetch(path.startsWith("http") ? path : s.base + path, { method, headers: h, body, redirect: "manual" });
  if (jar) jar.take(res);
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { res, text, json: parsed, location: res.headers.get("location") };
}

export async function register(s, extra = {}) {
  const r = await req(s, null, "/register", { method: "POST", json: {
    client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...extra,
  } });
  return r;
}

export function authorizeUrl(clientId, challenge, { redirect = REDIRECT, state = "st-123", scope = "mcp:tools", method = "S256", extra = {} } = {}) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, state, scope, ...extra });
  if (challenge !== null) q.set("code_challenge", challenge);
  if (method !== null) q.set("code_challenge_method", method);
  return "/authorize?" + q.toString();
}

export const csrfOf = html => (/name="csrf" value="([^"]*)"/.exec(html) ?? [])[1];
export const reqIdOf = loc => new URL(loc, "http://x").searchParams.get("req");

/** /authorize -> login -> consent; returns { code, location, jar, ... } or the failing step. */
export async function browserFlow(s, clientId, challenge, { email = "a@example.com", password, action = "allow", state = "st-123", redirect = REDIRECT } = {}) {
  const jar = new Jar();
  const a = await req(s, jar, authorizeUrl(clientId, challenge, { state, redirect }));
  if (a.res.status !== 302 || !a.location?.startsWith("/consent?")) return { step: "authorize", a, jar };
  const id = reqIdOf(a.location);
  const sidBefore = jar.c.get("milano_mcp_sid");
  const loginPage = await req(s, jar, a.location);
  const login = await req(s, jar, "/consent/login", { method: "POST", form: { csrf: csrfOf(loginPage.text), req: id, email, password: password ?? USERS[email]?.password ?? "x" } });
  if (login.res.status !== 303) return { step: "login", login, loginPage, jar };
  const sidAfter = jar.c.get("milano_mcp_sid");
  const consent = await req(s, jar, login.location);
  if (consent.res.status !== 200) return { step: "consent-page", consent, jar };
  const post = await req(s, jar, "/consent", { method: "POST", form: { csrf: csrfOf(consent.text), req: id, action } });
  const loc = post.location ? new URL(post.location) : null;
  return { step: "done", jar, id, loginPage, consent, post, loc, code: loc?.searchParams.get("code") ?? null, sidBefore, sidAfter };
}

export async function exchange(s, clientId, code, verifier, { redirect = REDIRECT, extra = {} } = {}) {
  return req(s, null, "/token", { method: "POST", form: { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, ...extra } });
}
export async function refresh(s, clientId, token, extra = {}) {
  return req(s, null, "/token", { method: "POST", form: { grant_type: "refresh_token", client_id: clientId, refresh_token: token, ...extra } });
}

const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
let rpcId = 0;
export async function rpc(s, method, params, headers = {}) {
  const res = await fetch(s.base + "/mcp", { method: "POST", headers: { ...H, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { res, body };
}
export const bearer = t => ({ Authorization: "Bearer " + t });
export const toolPayload = r => { const t = r.body.result.content[0].text; return JSON.parse(t.slice(t.indexOf("\n") + 1)); };

/** Full happy path: register, consent, exchange. */
export async function connect(s, email = "a@example.com", regExtra = {}) {
  const reg = await register(s, regExtra);
  const { verifier, challenge } = pkce();
  const f = await browserFlow(s, reg.json.client_id, challenge, { email });
  const t = await exchange(s, reg.json.client_id, f.code, verifier, regExtra.client_secret ? {} : {});
  return { clientId: reg.json.client_id, tokens: t.json, flow: f, tokenRes: t };
}
