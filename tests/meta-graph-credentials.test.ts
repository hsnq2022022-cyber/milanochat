// T5-S5: Meta access tokens (and other credentials) never travel in a Graph
// API request URL from the active Edge Functions, except the documented OAuth
// token-exchange calls (Meta documents them only as GET with query params).
//  (a) helper: exact Bearer header; Meta-returned paging URLs lose their token
//  (b) every changed call path: URL without the token, Authorization header
//      with it, method / path / other params / body unchanged
//  (c)+(e) source guard over supabase/functions/** (salla* excluded): every
//      credential-in-query and credential-in-body site is exactly allow-listed
//  (d) fetch-error / exception paths never carry the token
//  (f) existing behaviour (results, classification, SSRF host check) unchanged
// Fake fetch only; no network, no Deno.
// Run: node --experimental-strip-types --test tests/meta-graph-credentials.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, readdirSync, statSync} from "node:fs";
import {join} from "node:path";
import {inspect} from "node:util";
import {stripTypeScriptTypes} from "node:module";
import {metaAuthHeaders, graphUrlWithoutToken, META_GRAPH_HOSTS} from "../supabase/functions/_shared/metaGraph.ts";
import {linkFacebookPages, appSecretProof, FB_GRAPH_V, type FbLinkDeps} from "../supabase/functions/meta-auth/facebook.ts";
import {findExistingReply, sendCommentReply, CommentReplyError} from "../supabase/functions/flow-outbox-worker/commentReply.ts";
import {subscribeInstagramWebhooks, IG_SUBSCRIBED_FIELDS, IG_DM_SUBSCRIBED_FIELDS}
  from "../supabase/functions/meta-auth/instagramSubscription.ts";

const IG_TOKEN = "IGQVJ-T5S5CANARY-ig-token-91c2";
const EAA_TOKEN = "EAA-T5S5CANARY-page-token-4d7e";
const LONG = "EAA-T5S5CANARY-long-user-token-0b1a";
const SHORT = "EAA-T5S5CANARY-short-user-token-77f0";
const SECRET = "T5S5CANARY-app-secret";
const CANARY = "T5S5CANARY";

type Call = {url: string; init?: RequestInit};
const res = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {status, headers: {"Content-Type": "application/json"}});
const hdr = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;

// ============================================================ (a) helper
test("(a) metaAuthHeaders builds exactly {authorization: 'Bearer <token>'}", () => {
  assert.deepEqual(metaAuthHeaders(EAA_TOKEN), {authorization: `Bearer ${EAA_TOKEN}`});
  assert.deepEqual(Object.keys(metaAuthHeaders("x")), ["authorization"]);
  assert.deepEqual([...META_GRAPH_HOSTS], ["graph.facebook.com", "graph.instagram.com"]);
});

test("(a) graphUrlWithoutToken: drops access_token, keeps every other param; only https Graph hosts", () => {
  const n = graphUrlWithoutToken(
    `https://graph.facebook.com/v21.0/me/accounts?fields=id%2Cname&limit=100&access_token=${LONG}&after=c2&appsecret_proof=abc`,
  )!;
  const u = new URL(n);
  assert.equal(u.searchParams.get("access_token"), null);
  assert.ok(!n.includes(CANARY));
  assert.equal(u.origin + u.pathname, "https://graph.facebook.com/v21.0/me/accounts");
  assert.deepEqual([...u.searchParams], [["fields", "id,name"], ["limit", "100"], ["after", "c2"], ["appsecret_proof", "abc"]]);
  assert.equal(new URL(graphUrlWithoutToken("https://graph.instagram.com/v21.0/x?access_token=t")!).search, "");
  for (const bad of [
    "https://evil.example/v21.0/me?access_token=t", "http://graph.facebook.com/v21.0/me",
    "https://graph.facebook.com.evil.example/me", "https://u:p@graph.facebook.com/me",
    "https://graph.facebook.com:8443/me", "not a url", "", null, undefined, 42, {},
  ]) assert.equal(graphUrlWithoutToken(bad), null, String(bad));
});

// ============================================================ (b) meta-auth/facebook.ts
function fbGraph(over: {accounts?: unknown; accounts2?: unknown; throwOn?: string} = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({url, init});
    const u = new URL(url);
    if (over.throwOn && u.pathname.endsWith(over.throwOn)) {
      const e = new TypeError(`error sending request for url (${url})`);
      (e as any).cause = new Error("connect " + url);
      throw e;
    }
    if (u.origin !== "https://graph.facebook.com") throw new Error("off-host call");
    if (u.pathname.endsWith("/oauth/access_token") && u.searchParams.get("grant_type") === "fb_exchange_token")
      return res({access_token: LONG, expires_in: 5184000});
    if (u.pathname.endsWith("/oauth/access_token")) return res({access_token: SHORT, expires_in: 3600});
    if (u.pathname.endsWith("/me/accounts") && u.searchParams.get("after") === "c2")
      return res(over.accounts2 ?? {data: [{id: "222", name: "Two", access_token: "PAGE2tok"}]});
    if (u.pathname.endsWith("/me/accounts"))
      return res(over.accounts ?? {data: [{id: "111", name: "One", access_token: EAA_TOKEN}]});
    if (u.pathname.endsWith("/subscribed_apps")) return res({success: true});
    throw new Error("unexpected " + u.pathname);
  };
  return {fetch, calls};
}
function fbDeps(fetch: FbLinkDeps["fetch"]): FbLinkDeps {
  return {
    fetch, appId: "APPID", appSecret: SECRET, redirectUri: "https://x.supabase.co/functions/v1/meta-auth/facebook/callback",
    tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", encryptField: async (s) => `enc:v1:${s.length}`,
    db: {pageOwnedElsewhere: async () => false, upsertPage: async () => true}, nowMs: () => 1_800_000_000_000,
  };
}

test("(b) facebook /me/accounts: URL has no token, header carries the long-lived token, appsecret_proof kept; paging.next token stripped", async () => {
  const g = fbGraph({accounts: {data: [{id: "111", name: "One", access_token: EAA_TOKEN}],
    paging: {next: `${FB_GRAPH_V}/me/accounts?fields=id&limit=100&access_token=${LONG}&after=c2`}}});
  const r = await linkFacebookPages("CODE1", fbDeps(g.fetch));
  assert.deepEqual(r, {ok: true, saved: 2, name: "One"});
  const acc = g.calls.filter((c) => new URL(c.url).pathname.endsWith("/me/accounts"));
  assert.equal(acc.length, 2, "first page + the followed paging.next");
  const proof = await appSecretProof(SECRET, LONG);
  for (const c of acc) {
    const u = new URL(c.url);
    assert.equal(u.searchParams.get("access_token"), null);
    assert.ok(!c.url.includes(LONG) && !c.url.includes(CANARY), "no token in the URL");
    assert.deepEqual(c.init?.headers, {authorization: `Bearer ${LONG}`});
    assert.equal(c.init?.method, undefined, "still a GET");
    assert.equal(c.init?.body, undefined);
    assert.equal(u.searchParams.get("appsecret_proof"), proof, "appsecret_proof on every page");
  }
  // unchanged first-page request apart from the credential
  const first = new URL(acc[0].url);
  assert.equal(first.origin + first.pathname, `${FB_GRAPH_V}/me/accounts`);
  assert.equal(first.searchParams.get("fields"), "id,name,access_token,tasks,picture{url}");
  assert.equal(first.searchParams.get("limit"), "100");
  assert.equal(new URL(acc[1].url).searchParams.get("after"), "c2");
});

test("(b)+(f) facebook: OAuth exchanges unchanged (documented query-param exception, no auth header); subscribed_apps body unchanged", async () => {
  const g = fbGraph();
  await linkFacebookPages("CODE1", fbDeps(g.fetch));
  const ex = g.calls.filter((c) => c.url.includes("/oauth/access_token"));
  assert.equal(ex.length, 2);
  const a = new URL(ex[0].url), b = new URL(ex[1].url);
  assert.deepEqual([...a.searchParams.keys()], ["client_id", "client_secret", "redirect_uri", "code"]);
  assert.deepEqual([...b.searchParams.keys()], ["grant_type", "client_id", "client_secret", "fb_exchange_token"]);
  assert.equal(ex[0].init, undefined);
  assert.equal(ex[1].init, undefined);
  const sub = g.calls.find((c) => c.url.endsWith("/subscribed_apps"))!;
  assert.equal(sub.url, `${FB_GRAPH_V}/111/subscribed_apps`);
  assert.equal(sub.init?.method, "POST");
  assert.deepEqual(sub.init?.headers, {"Content-Type": "application/x-www-form-urlencoded"});
  const body = new URLSearchParams(String(sub.init?.body));
  assert.equal(body.get("access_token"), EAA_TOKEN, "page token stays in the POST body (never the URL)");
  assert.ok(!sub.url.includes(CANARY));
});

test("(b) facebook: an off-host paging.next is never followed, so no header ever reaches a non-Graph host", async () => {
  for (const next of ["https://evil.example/v21.0/me/accounts?after=c2", "http://graph.facebook.com/v21.0/me/accounts?after=c2",
    "https://graph.facebook.com.evil.example/x?after=c2"]) {
    const g = fbGraph({accounts: {data: [{id: "111", access_token: "a"}], paging: {next}}});
    await linkFacebookPages("C", fbDeps(g.fetch));
    for (const c of g.calls) {
      if (hdr(c.init).authorization) assert.equal(new URL(c.url).origin, "https://graph.facebook.com");
    }
    assert.equal(g.calls.filter((c) => c.url.includes("/me/accounts")).length, 1);
  }
});

test("(d) facebook: a network error on /me/accounts (message embeds the URL) never carries the token", async () => {
  const g = fbGraph({throwOn: "/me/accounts"});
  const err = await linkFacebookPages("C", fbDeps(g.fetch)).then(() => null, (e) => e);
  assert.ok(err instanceof TypeError);
  const text = String(err.message) + inspect(err, {depth: null, showHidden: true});
  assert.ok(!text.includes(LONG) && !text.includes(CANARY), "no token in the thrown error");
});

// ============================================================ (b) flow-outbox-worker/commentReply.ts
const fakePerform = (responses: Response[]) => {
  const calls: Call[] = [];
  const perform = (async (url: string, init?: RequestInit) => {
    calls.push({url, init});
    const r = responses.shift();
    if (!r) throw new Error("unexpected call");
    return r;
  }) as unknown as typeof fetch;
  return {calls, perform};
};
const REQ_FB = {platform: "facebook" as const, token: EAA_TOKEN, externalId: "1122334455", commentId: "1122_9001", text: "hi"};
const REQ_IG = {platform: "instagram" as const, token: IG_TOKEN, externalId: "17841400000001", commentId: "1801", text: "hi"};
const REQ_IG_FB = {...REQ_IG, token: EAA_TOKEN};

test("(b) comment reconcile GET: token in the Authorization header on every host, never in the URL; fields/limit unchanged", async () => {
  const cases = [
    {r: REQ_FB, url: "https://graph.facebook.com/v21.0/1122_9001/comments?fields=id%2Cmessage%2Cfrom&limit=100"},
    {r: REQ_IG, url: "https://graph.instagram.com/v21.0/1801/replies?fields=id%2Ctext%2Cfrom&limit=100"},
    {r: REQ_IG_FB, url: "https://graph.facebook.com/v21.0/1801/replies?fields=id%2Ctext%2Cfrom&limit=100"},
  ];
  for (const {r, url} of cases) {
    const f = fakePerform([res({data: [{id: "9", message: "hi", text: "hi", from: {id: r.externalId}}]})]);
    assert.equal(await findExistingReply(r, f.perform), "9");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, url);
    assert.ok(!f.calls[0].url.includes("access_token") && !f.calls[0].url.includes(CANARY));
    assert.equal(f.calls[0].init?.method, "GET");
    assert.deepEqual(f.calls[0].init?.headers, {authorization: `Bearer ${r.token}`});
    assert.equal(f.calls[0].init?.body, undefined);
  }
});

test("(f) comment reconcile: failure classification unchanged (HTTP error / thrown fetch -> uncertain, no token in it)", async () => {
  const e1 = await findExistingReply(REQ_FB, fakePerform([res({}, 500)]).perform).catch((e) => e);
  assert.ok(e1 instanceof CommentReplyError);
  assert.equal(e1.failure, "uncertain");
  const thrower = (async (url: string) => { throw new TypeError(`error sending request for url (${url})`); }) as unknown as typeof fetch;
  const e2 = await findExistingReply(REQ_FB, thrower).catch((e) => e);
  assert.ok(e2 instanceof CommentReplyError);
  assert.equal(e2.failure, "uncertain");
  assert.ok(!inspect(e2, {depth: null, showHidden: true}).includes(CANARY));
});

test("(f) comment reply POST unchanged (URL token-free; FB token stays in the JSON body as before)", async () => {
  const f = fakePerform([res({id: "c1"}), res({id: "c2"})]);
  await sendCommentReply(REQ_FB, f.perform);
  await sendCommentReply(REQ_IG, f.perform);
  assert.equal(f.calls[0].url, "https://graph.facebook.com/v21.0/1122_9001/comments");
  assert.deepEqual(JSON.parse(String(f.calls[0].init?.body)), {message: "hi", access_token: EAA_TOKEN});
  assert.equal(f.calls[1].url, "https://graph.instagram.com/v21.0/1801/replies");
  assert.deepEqual(hdr(f.calls[1].init).authorization, `Bearer ${IG_TOKEN}`);
  for (const c of f.calls) assert.ok(!c.url.includes(CANARY));
});

// ============================================================ (b) milan-api fetchSenderProfile (sliced, as in milan-profile-fetch-log-safety)
const IDX = readFileSync("supabase/functions/milan-api/index.ts", "utf8");
const FSP_SRC = IDX.slice(IDX.indexOf("async function fetchSenderProfile("), IDX.indexOf("async function handleIncomingWebhookMessage("));
const loadFsp = (fetch: unknown, console: unknown) =>
  new Function("fetch", "console", stripTypeScriptTypes(FSP_SRC, {mode: "strip"}) + "\nreturn fetchSenderProfile;")(fetch, console);
const quiet = {log() {}, warn() {}, error() {}, info() {}, debug() {}};

test("(b) milan-api fetchSenderProfile: 3 paths, URL without token, Bearer header, GET, same fields", async () => {
  assert.ok(FSP_SRC.length > 100, "located fetchSenderProfile");
  const paths = [
    {channel: "instagram", token: IG_TOKEN, url: "https://graph.instagram.com/v21.0/555?fields=name,username,profile_pic"},
    {channel: "instagram", token: EAA_TOKEN, url: "https://graph.facebook.com/v21.0/555?fields=name,profile_picture"},
    {channel: "facebook", token: EAA_TOKEN, url: "https://graph.facebook.com/v21.0/555?fields=name,picture"},
  ];
  for (const p of paths) {
    const calls: Call[] = [];
    const r = await loadFsp(async (url: string, init?: RequestInit) => { calls.push({url, init}); return res({name: "N"}); }, quiet)(
      {channel: p.channel, senderId: "555", token: p.token});
    assert.deepEqual(r, {name: "N", avatar: null});
    assert.deepEqual(calls, [{url: p.url, init: {headers: {authorization: `Bearer ${p.token}`}}}]);
  }
});

test("(d) milan-api fetchSenderProfile: network error / HTTP error logs never carry the token", async () => {
  for (const mode of ["throw", "http"]) {
    const logs: unknown[] = [];
    const c = {log: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a)};
    const r = await loadFsp(async (url: string) => {
      if (mode === "throw") throw new TypeError(`error sending request for url (${url})`);
      return res({error: {message: `Malformed access token ${EAA_TOKEN}`, code: 190}}, 400);
    }, c)({channel: "facebook", senderId: "555", token: EAA_TOKEN});
    assert.deepEqual(r, {name: null, avatar: null});
    assert.ok(!inspect(logs, {depth: null, showHidden: true}).includes(CANARY));
  }
});

// ============================================================ meta-auth/index.ts (Deno.serve handler: source level)
const META = readFileSync("supabase/functions/meta-auth/index.ts", "utf8");
const metaCode = META.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("(b) meta-auth Instagram /me and subscribed_apps: no token in the URL, Bearer header via metaAuthHeaders", () => {
  assert.match(META, /import \{ metaAuthHeaders \} from "\.\.\/_shared\/metaGraph\.ts";/);
  const me = META.slice(META.indexOf("const pRes = await fetch("), META.indexOf("const prof: any"));
  assert.equal(me.trim(),
    "const pRes = await fetch(\n      `${IG_GRAPH_V}/me?fields=user_id,username,name,profile_picture_url,account_type`,\n" +
    "      { headers: metaAuthHeaders(token) },\n    );");
  // Task 1: the subscription moved to instagramSubscription.ts (exercised below).
  assert.match(META, /import \{ subscribeInstagramWebhooks \} from "\.\/instagramSubscription\.ts";/);
  assert.match(META, /\n    await subscribeInstagramWebhooks\(IG_GRAPH_V, token, \{ fetch, errCode: metaErrCode \}\);\n/);
  assert.ok(!META.includes("subscribed_fields="), "no inline subscription URL left in index.ts");
  const SUB = readFileSync("supabase/functions/meta-auth/instagramSubscription.ts", "utf8");
  assert.ok(SUB.includes(
    "const sRes = await deps.fetch(\n        `${graphBase}/me/subscribed_apps?subscribed_fields=${fields}`,\n" +
    "        { method: \"POST\", headers: metaAuthHeaders(token) },\n      );"));
});

test("(b) Instagram subscribed_apps: DM fields + comments, Bearer header, no token in URL; refusal -> DM-only fallback", async () => {
  const IG_V = "https://graph.instagram.com/v21.0";
  assert.equal(IG_SUBSCRIBED_FIELDS, "messages,messaging_postbacks,messaging_seen,comments");
  assert.equal(IG_DM_SUBSCRIBED_FIELDS, "messages,messaging_postbacks,messaging_seen", "DM fields unchanged");
  const run = async (replies: Array<unknown | Error>) => {
    const calls: Call[] = [];
    const logs: unknown[] = [];
    const orig = {error: console.error, warn: console.warn};
    console.error = (...a: unknown[]) => { logs.push(a); };
    console.warn = (...a: unknown[]) => { logs.push(a); };
    let r;
    try {
      r = await subscribeInstagramWebhooks(IG_V, IG_TOKEN, {
        fetch: (async (url: string, init?: RequestInit) => {
          calls.push({url, init});
          const next = replies.shift();
          if (next instanceof Error) throw next;
          return res(next);
        }) as typeof fetch,
        errCode: (j: any) => ({code: j?.error?.code ?? null}),
      });
    } finally { Object.assign(console, orig); }
    for (const c of calls) {
      assert.ok(!c.url.includes(IG_TOKEN) && !c.url.includes("access_token"), "no token in the URL");
      assert.equal(c.init?.method, "POST");
      assert.deepEqual(c.init?.headers, {authorization: `Bearer ${IG_TOKEN}`});
      assert.equal(c.init?.body, undefined);
    }
    assert.ok(!inspect(logs, {depth: null}).includes(CANARY), "no token logged");
    return {r, urls: calls.map((c) => c.url)};
  };
  const full = `${IG_V}/me/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_seen,comments`;
  const dm = `${IG_V}/me/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_seen`;
  assert.deepEqual(await run([{success: true}]), {r: "subscribed", urls: [full]});
  // Explicit Graph refusal of the list with comments: DM webhooks are kept.
  assert.deepEqual(await run([{error: {code: 100, message: `x ${IG_TOKEN}`}}, {success: true}]), {r: "dm_only", urls: [full, dm]});
  assert.deepEqual(await run([{error: {code: 100}}, {error: {code: 190}}]), {r: "failed", urls: [full, dm]});
  // Unknown outcome (network error / unexpected body): no DM-only call that could drop comments.
  assert.deepEqual(await run([new TypeError(`fetch failed ${IG_TOKEN}`)]), {r: "failed", urls: [full]});
  assert.deepEqual(await run([{success: false}]), {r: "failed", urls: [full]});
});

test("(d) meta-auth: error paths log/return no error text, URL or Meta free text (only e.name / codes)", () => {
  assert.doesNotMatch(metaCode, /\be\.message\b|e\?\.message/, "no exception message anywhere");
  assert.doesNotMatch(metaCode, /console\.\w+\([^;]*,\s*e\s*\)/, "no raw error object logged");
  assert.doesNotMatch(metaCode, /error_message|error\?\.message|JSON\.stringify\(sJson\)/, "no Meta free text logged");
  assert.match(META, /console\.error\("\[meta-auth\]", e instanceof Error \? e\.name : "unknown"\);\n    return fail\("unknown"\);/);
  // Facebook callback catch unchanged (already name-only).
  assert.match(META, /console\.error\("\[meta-auth\] facebook", e instanceof Error \? e\.name : "unknown"\);\n    return fail\("unknown"\);/);
});

test("(d) meta-auth metaErrCode keeps only numeric / short safe codes", () => {
  const src = META.slice(META.indexOf("const safeMetaValue"), META.indexOf("const fail ="));
  const fn = new Function(stripTypeScriptTypes(src, {mode: "strip"}) + "\nreturn metaErrCode;")();
  assert.deepEqual(fn({error: {code: 190, type: "OAuthException", message: `bad ${LONG}`}}), {code: 190, type: "OAuthException"});
  assert.deepEqual(fn({code: 400, error_type: "OAuthException", error_message: LONG}), {code: 400, type: "OAuthException"});
  assert.deepEqual(fn({error: {code: `x ${LONG}`, type: LONG + LONG}}), {code: null, type: null});
  assert.deepEqual(fn(null), {code: null, type: null});
});

// ============================================================ (c)+(e) source guard
const SKIP_DIR = /^salla/;
function edgeFiles(dir = "supabase/functions"): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (!SKIP_DIR.test(n)) out.push(...edgeFiles(p)); }
    else if (n.endsWith(".ts")) out.push(p);
  }
  return out;
}
const CRED = "(?:access_token|client_secret|fb_exchange_token)";
const QUERY_CRED = new RegExp(`[?&]${CRED}=|\\.(?:set|append)\\(\\s*["']${CRED}["']`);
const KEY_CRED = new RegExp(`(?<![.\\w])${CRED}\\s*:`);
function credentialSites() {
  const query: string[] = [], body: string[] = [];
  for (const f of edgeFiles()) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const t = line.trim();
      if (/^(\/\/|\*|\/\*)/.test(t)) continue;
      if (QUERY_CRED.test(line)) query.push(`${f} | ${t}`);
      if (KEY_CRED.test(line)) body.push(`${f} | ${t}`);
    }
  }
  return {query, body};
}

// Documented exceptions: Meta documents these token exchanges only as GET with
// query params (no header / POST-body form relied on without live evidence).
const QUERY_ALLOW = [
  "supabase/functions/meta-auth/facebook.ts | `&client_secret=${encodeURIComponent(deps.appSecret)}` +",
  "supabase/functions/meta-auth/facebook.ts | `&client_secret=${encodeURIComponent(deps.appSecret)}&fb_exchange_token=${encodeURIComponent(shortToken)}`,",
  "supabase/functions/meta-auth/index.ts | `&client_secret=${encodeURIComponent(igSecret)}&access_token=${encodeURIComponent(shortToken)}`,",
];
// Credentials in POST bodies (not URLs): pre-existing, unchanged by T5-S5.
const BODY_ALLOW = [
  "supabase/functions/flow-outbox-worker/commentReply.ts | body:JSON.stringify(igLogin?{message}:{message,access_token:r.token}),",
  "supabase/functions/flow-outbox-worker/deliveryCore.ts | payload={...envelope,access_token:input.token};",
  "supabase/functions/meta-auth/facebook.ts | access_token: pageToken,",
  "supabase/functions/meta-auth/index.ts | client_secret: igSecret,",
  "supabase/functions/milan-api/index.ts | body = { ...payload, access_token: token };",
  "supabase/functions/milan-api/index.ts | body = { ...payload, access_token: token };",
];

test("(c)+(e) guard: credential query params exist ONLY at the documented token-exchange call sites", () => {
  assert.deepEqual(credentialSites().query, QUERY_ALLOW);
  // and those sites are the OAuth exchange endpoints, nothing else
  const fb = readFileSync("supabase/functions/meta-auth/facebook.ts", "utf8");
  assert.equal(fb.match(/\$\{FB_GRAPH_V\}\/oauth\/access_token\?/g)?.length, 2);
  assert.match(META, /`\$\{IG_GRAPH_HOST\}\/access_token\?grant_type=ig_exchange_token` \+\n\s+`&client_secret=/);
});

test("(c)+(e) guard: credentials in request bodies are exactly the pre-existing documented set", () => {
  assert.deepEqual(credentialSites().body, BODY_ALLOW);
});

test("(c) guard self-check: the patterns catch a token put back into a URL", () => {
  for (const bad of ["url = `${G}/me?fields=a&access_token=${t}`;", "q.set(\"access_token\",r.token);",
    "`${G}/x?access_token=${encodeURIComponent(t)}`", "u.searchParams.append('client_secret', s)"])
    assert.ok(QUERY_CRED.test(bad), bad);
  for (const ok of ["fields=id,name,access_token,tasks", "typeof t?.access_token === \"string\" ? t.access_token : \"\"",
    "access_token_encrypted: x"]) {
    assert.ok(!QUERY_CRED.test(ok) && !KEY_CRED.test(ok), ok);
  }
});
