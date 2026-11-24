// Instagram OAuth redirect_uri: one normalization shared by connect (channels)
// and the callback token exchange (meta-auth). Offline; dummy URLs only.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {normalizeRedirectUri} from "../supabase/functions/_shared/redirectUri.ts";

const BASE = "https://proj.supabase.co";
const IG = `${BASE}/functions/v1/meta-auth/instagram/callback`;
const read = (p: string) => readFileSync(new URL(`../supabase/functions/${p}`, import.meta.url), "utf8");

test("exact production callback URL is unchanged", () => {
  assert.equal(normalizeRedirectUri(IG), IG);
});
test("one and several trailing slashes are removed", () => {
  assert.equal(normalizeRedirectUri(IG + "/"), IG);
  assert.equal(normalizeRedirectUri(IG + "///"), IG);
});
test("leading and trailing whitespace is trimmed (spaces, tabs, newlines)", () => {
  assert.equal(normalizeRedirectUri(`  ${IG}  `), IG);
  assert.equal(normalizeRedirectUri(`\t${IG}\n`), IG);
  assert.equal(normalizeRedirectUri(` ${IG}/ \n`), IG, "whitespace trimmed before slash removal");
});
test("missing, empty, whitespace-only and slash-only normalize to empty string", () => {
  assert.equal(normalizeRedirectUri(undefined), "");
  assert.equal(normalizeRedirectUri(null), "");
  assert.equal(normalizeRedirectUri(""), "");
  assert.equal(normalizeRedirectUri("   \n"), "");
  assert.equal(normalizeRedirectUri("///"), "");
});
test("interior characters and path are preserved (no other rewriting)", () => {
  assert.equal(normalizeRedirectUri(" https://a.example/x/y?z=1 "), "https://a.example/x/y?z=1");
});
test("idempotent", () => {
  const once = normalizeRedirectUri(` ${IG}// `);
  assert.equal(normalizeRedirectUri(once), once);
});

// Mirrors the two call sites exactly: connect = normalize(env) (missing => error),
// callback = normalize(env) || fallback.
const connect = (env?: string) => normalizeRedirectUri(env);
const callback = (env?: string) => normalizeRedirectUri(env) || IG;

test("connect and callback send the identical redirect_uri for every configured shape", () => {
  for (const v of [IG, IG + "/", IG + "//", `  ${IG}  `, ` ${IG}/\n`]) {
    assert.equal(connect(v), callback(v));
    assert.equal(connect(v), IG);
  }
});
test("missing/empty/whitespace secret: connect has no value (error path), callback uses the fallback", () => {
  for (const v of [undefined, "", "  "]) {
    assert.equal(connect(v), "");
    assert.equal(callback(v), IG);
  }
});

test("both Instagram call sites use the shared helper; no raw INSTAGRAM_REDIRECT_URI read remains", () => {
  const ch = read("channels/index.ts");
  const ma = read("meta-auth/index.ts");
  const call = 'normalizeRedirectUri(Deno.env.get("INSTAGRAM_REDIRECT_URI"))';
  assert.equal(ch.split(call).length - 1, 1, "channels connect");
  assert.equal(ma.split(call).length - 1, 1, "meta-auth callback");
  assert.ok(ch.includes('from "../_shared/redirectUri.ts"'));
  assert.ok(ma.includes('from "../_shared/redirectUri.ts"'));
  // every remaining INSTAGRAM_REDIRECT_URI reference is that call (or a comment / the diagnostics-only read)
  for (const [name, src] of [["channels", ch], ["meta-auth", ma]] as const) {
    const raw = src.split("\n").filter((l) => l.includes('Deno.env.get("INSTAGRAM_REDIRECT_URI")') && !l.includes(call));
    assert.deepEqual(raw, [], `${name} still reads the raw secret`);
  }
});
test("callback keeps the documented fallback and the token exchange uses the same variable", () => {
  const ma = read("meta-auth/index.ts");
  assert.ok(ma.includes("`${supaUrl}/functions/v1/meta-auth/instagram/callback`"));
  assert.ok(/redirect_uri:\s*redirectUri,/.test(ma), "token exchange passes redirectUri");
});
test("connect passes the same normalized value to the authorize URL", () => {
  const ch = read("channels/index.ts");
  assert.ok(ch.includes("`&redirect_uri=${encodeURIComponent(redirectUri)}`"));
});

test("Facebook OAuth redirect handling is unchanged", () => {
  const ch = read("channels/index.ts");
  const ma = read("meta-auth/index.ts");
  assert.ok(ch.includes('const redirectUri = (Deno.env.get("META_REDIRECT_URI") ?? "").replace(/\\/+$/, "");'));
  assert.ok(ma.includes('const redirectUri = (Deno.env.get("META_REDIRECT_URI") ?? "").trim().replace(/\\/+$/, "") ||'));
  assert.ok(ma.includes("`${supaUrl}/functions/v1/meta-auth/facebook/callback`"));
  assert.ok(!ch.includes("normalizeRedirectUri(Deno.env.get(\"META_REDIRECT_URI\"))"));
  assert.ok(!ma.includes("normalizeRedirectUri(Deno.env.get(\"META_REDIRECT_URI\"))"));
});
