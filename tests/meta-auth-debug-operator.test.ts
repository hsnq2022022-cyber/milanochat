// /meta-auth/debug: operator-only, boolean-only redirect diagnostics.
// Offline: dummy UUIDs and dummy URLs; no network, no real secrets.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {handleRedirectDiagnostics, diagnoseRedirect} from "../supabase/functions/meta-auth/redirectDiagnostics.ts";

const OP = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const BASE = "https://proj.supabase.co";
const IG = `${BASE}/functions/v1/meta-auth/instagram/callback`;
const FB = `${BASE}/functions/v1/meta-auth/facebook/callback`;
const APP_ID = "1234567890123456";

function deps(env: Record<string, string>, users: Record<string, string> = {"op-jwt": OP, "other-jwt": OTHER}) {
  return {
    env: (k: string) => env[k],
    getUserId: async (jwt: string) => users[jwt] ?? null,
  };
}
const baseEnv = () => ({
  FLOW_OPERATOR_USER_IDS: OP, SUPABASE_URL: BASE,
  INSTAGRAM_REDIRECT_URI: IG, META_REDIRECT_URI: FB, INSTAGRAM_APP_ID: APP_ID,
});
const get = (auth?: string) => new Request(`${BASE}/functions/v1/meta-auth/debug`, {headers: auth ? {authorization: auth} : {}});

test("operator with exact secrets: all-true match, booleans only", async () => {
  const r = await handleRedirectDiagnostics(get("Bearer op-jwt"), deps(baseEnv()));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body, {
    instagram_redirect: {present: true, exact_match: true, has_whitespace_or_quote: false, has_trailing_slash: false},
    facebook_redirect: {present: true, exact_match: true, has_whitespace_or_quote: false, has_trailing_slash: false},
  });
});

test("response never contains a secret value, URL, length, app id or SUPABASE_URL", async () => {
  const env = {...baseEnv(), INSTAGRAM_REDIRECT_URI: IG + "/ ", META_REDIRECT_URI: "https://evil.example/cb"};
  const r = await handleRedirectDiagnostics(get("Bearer op-jwt"), deps(env));
  const text = await r.text();
  for (const bad of [BASE, "supabase.co", "evil.example", APP_ID, "callback", "http"]) {
    assert.ok(!text.includes(bad), `leaked ${bad}`);
  }
  const parsed = JSON.parse(text);
  const walk = (o: unknown): void => {
    if (o && typeof o === "object") Object.values(o as object).forEach(walk);
    else assert.equal(typeof o, "boolean", "every leaf is a boolean");
  };
  walk(parsed);
  assert.deepEqual(Object.keys(parsed).sort(), ["facebook_redirect", "instagram_redirect"]);
  assert.deepEqual(Object.keys(parsed.instagram_redirect).sort(),
    ["exact_match", "has_trailing_slash", "has_whitespace_or_quote", "present"]);
});

test("mismatch, trailing slash, whitespace and quote are reported", () => {
  assert.deepEqual(diagnoseRedirect(IG + "/", IG), {present: true, exact_match: false, has_whitespace_or_quote: false, has_trailing_slash: true});
  assert.deepEqual(diagnoseRedirect(" " + IG, IG), {present: true, exact_match: false, has_whitespace_or_quote: true, has_trailing_slash: false});
  assert.deepEqual(diagnoseRedirect(`"${IG}"`, IG), {present: true, exact_match: false, has_whitespace_or_quote: true, has_trailing_slash: false});
  assert.deepEqual(diagnoseRedirect(IG.replace("instagram", "facebook"), IG), {present: true, exact_match: false, has_whitespace_or_quote: false, has_trailing_slash: false});
});

test("missing or empty secret: present=false, everything else false", async () => {
  const env: Record<string, string> = {...baseEnv(), INSTAGRAM_REDIRECT_URI: ""};
  delete env.META_REDIRECT_URI;
  const body = await (await handleRedirectDiagnostics(get("Bearer op-jwt"), deps(env))).json();
  const none = {present: false, exact_match: false, has_whitespace_or_quote: false, has_trailing_slash: false};
  assert.deepEqual(body, {instagram_redirect: none, facebook_redirect: none});
});

test("missing SUPABASE_URL: nothing can match", async () => {
  const env: Record<string, string> = baseEnv();
  delete env.SUPABASE_URL;
  const body = await (await handleRedirectDiagnostics(get("Bearer op-jwt"), deps(env))).json();
  assert.equal(body.instagram_redirect.exact_match, false);
  assert.equal(body.facebook_redirect.exact_match, false);
});

test("every unauthorized shape gets the identical generic 404", async () => {
  const notFoundBody = JSON.stringify({error: "Not found"});
  const cases: Array<[string, Request, Record<string, string>]> = [
    ["no authorization header", get(), baseEnv()],
    ["non-bearer scheme", get("Basic abc"), baseEnv()],
    ["empty bearer", get("Bearer "), baseEnv()],
    ["unknown jwt", get("Bearer nobody"), baseEnv()],
    ["valid user but not an operator", get("Bearer other-jwt"), baseEnv()],
    ["allowlist missing", get("Bearer op-jwt"), {...baseEnv(), FLOW_OPERATOR_USER_IDS: ""}],
    ["allowlist malformed", get("Bearer op-jwt"), {...baseEnv(), FLOW_OPERATOR_USER_IDS: OP + ",not-a-uuid"}],
    ["oversized header", get("Bearer " + "x".repeat(9000)), baseEnv()],
  ];
  for (const [name, req, env] of cases) {
    const r = await handleRedirectDiagnostics(req, deps(env));
    assert.equal(r.status, 404, name);
    assert.equal(await r.text(), notFoundBody, name);
  }
});

test("identity lookup throwing is a 404, not a 500 or a leak", async () => {
  const r = await handleRedirectDiagnostics(get("Bearer op-jwt"), {
    env: (k) => (baseEnv() as Record<string, string>)[k],
    getUserId: async () => { throw new Error("boom " + IG); },
  });
  assert.equal(r.status, 404);
  assert.ok(!(await r.text()).includes("boom"));
});

test("request body ids / headers cannot grant operator access", async () => {
  const req = new Request(`${BASE}/functions/v1/meta-auth/debug`, {
    headers: {authorization: "Bearer other-jwt", "x-user-id": OP, "x-operator": "true"},
  });
  assert.equal((await handleRedirectDiagnostics(req, deps(baseEnv()))).status, 404);
});

test("index.ts wires /debug only through the operator handler (no raw env echo)", () => {
  const src = readFileSync(new URL("../supabase/functions/meta-auth/index.ts", import.meta.url), "utf8");
  assert.ok(src.includes('import { handleRedirectDiagnostics } from "./redirectDiagnostics.ts";'));
  const i = src.indexOf('url.pathname.endsWith("/debug")');
  assert.ok(i > 0);
  const block = src.slice(i, i + 700);
  assert.ok(block.includes("handleRedirectDiagnostics("));
  for (const bad of ["INSTAGRAM_APP_ID", "INSTAGRAM_REDIRECT_URI", ".length", "USE_INSTAGRAM_DIRECT_LOGIN", "expected:"]) {
    assert.ok(!block.includes(bad), `debug block still references ${bad}`);
  }
});
