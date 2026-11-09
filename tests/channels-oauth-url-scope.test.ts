// Regression: the Facebook Login dialog URL built by channels /meta/oauth-url
// must request the Page permissions meta-auth's /facebook/callback needs
// (without them /me/accounts is empty -> "no_pages"). The Instagram URL is
// unchanged. channels/index.ts calls Deno.serve at load, so the branches are
// checked on source text (same approach as security-oauth-state.test.ts).
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {FB_REQUIRED_SCOPES} from "../supabase/functions/meta-auth/facebook.ts";

const ch = readFileSync("supabase/functions/channels/index.ts", "utf8");
const oauth = ch.slice(ch.indexOf('parts[1] === "oauth-url"'), ch.indexOf("// ─── GET /channels/accounts ───"));
const fb = oauth.slice(oauth.indexOf('if (channel === "facebook")'), oauth.indexOf("قناة غير مدعومة في OAuth"));
const ig = oauth.slice(oauth.indexOf('if (channel === "instagram")'), oauth.indexOf('if (channel === "facebook")'));

test("facebook oauth URL requests the Page scopes meta-auth requires", () => {
  assert.ok(fb.length > 0 && ig.length > 0, "branches located");
  const m = fb.match(/"&scope=" \+\s*encodeURIComponent\("([^"]+)"\)/);
  assert.ok(m, "facebook URL has a scope parameter");
  assert.deepEqual(m[1].split(","), [...FB_REQUIRED_SCOPES], "same list as meta-auth FB_REQUIRED_SCOPES");
  assert.doesNotMatch(m[1], /business_management/);
  // Comment automation (public reply to Page comments) needs these two.
  assert.ok(m[1].split(",").includes("pages_manage_engagement"));
  assert.ok(m[1].split(",").includes("pages_read_engagement"));
  // scope sits on the dialog URL, before the signed state; state signing intact
  assert.match(fb, /"https:\/\/www\.facebook\.com\/v21\.0\/dialog\/oauth" \+/);
  assert.ok(fb.indexOf('"&scope="') < fb.indexOf('"&state=" + encodeURIComponent(state)'));
  assert.match(fb, /createSignedState\(\{ platform: "facebook", userId \}\)/);
  assert.match(fb, /if \(!issued\.ok\) return oauthStartError\(issued\);/);

  // built URL as the browser would receive it
  const scope = encodeURIComponent(m[1]);
  const url = new URL(`https://www.facebook.com/v21.0/dialog/oauth?client_id=1&redirect_uri=x&scope=${scope}&state=s`);
  assert.equal(url.searchParams.get("scope"), FB_REQUIRED_SCOPES.join(","));
});

test("instagram oauth URL: Instagram Login scopes incl. comment management", () => {
  const expected =
    '        const oauthUrl =\n' +
    '          "https://www.instagram.com/oauth/authorize" +\n' +
    '          "?force_reauth=true" +\n' +
    '          `&client_id=${encodeURIComponent(appId)}` +\n' +
    '          `&redirect_uri=${encodeURIComponent(redirectUri)}` +\n' +
    '          "&response_type=code" +\n' +
    '          "&scope=" +\n' +
    '          encodeURIComponent("instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments") +\n' +
    '          `&state=${encodeURIComponent(state)}`;\n';
  assert.ok(ig.includes(expected), "instagram URL construction byte-identical except the added comment scope");
  assert.doesNotMatch(ig, /pages_/);
  // Instagram API with Instagram Login only accepts the instagram_business_*
  // names; the legacy Facebook-Login name would make the dialog fail.
  assert.doesNotMatch(ig, /"[^"]*\binstagram_manage_comments\b/);
  assert.match(ig, /createSignedState\(\{ platform: "instagram", userId \}\)/);
});
