// S4: SSRF guard for website ingestion (supabase/functions/milan-api/safeFetch.ts).
// Pure: fetch and DNS resolver are injected; no network is used.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  safeFetchText, validateUrl, isPublicAddress, parseIpv4, parseIpv6, SafeFetchError, SAFE_FETCH_DEFAULTS,
} from "../supabase/functions/milan-api/safeFetch.ts";

const PUBLIC_V4 = "93.184.216.34";
const html = (body: string, extra: Record<string, string> = {}) =>
  new Response(body, {status: 200, headers: {"content-type": "text/html; charset=utf-8", ...extra}});

type Call = {url: string; init: RequestInit};
function harness(routes: Record<string, () => Response>, dns: Record<string, string[]> = {}) {
  const calls: Call[] = [];
  const resolved: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({url, init});
    const r = routes[url];
    if (!r) throw new Error("unexpected fetch " + url);
    return r();
  };
  const resolve = async (h: string) => {
    resolved.push(h);
    return dns[h] ?? [PUBLIC_V4];
  };
  return {calls, resolved, fetch, resolve};
}
const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof SafeFetchError) return e.code; throw e; }
  return "no_error";
};

test("allows a normal public https page (manual redirect mode, no follow)", async () => {
  const h = harness({"https://example.com/about": () => html("<title>T</title><main>hello</main>")});
  const r = await safeFetchText("https://example.com/about", h);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.text.includes("hello"));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].init.redirect, "manual");
  assert.ok(h.calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(h.resolved, ["example.com", "example.com"], "resolved before and re-validated after");
});

test("blocks every private / loopback / metadata IPv4 literal form, without any fetch", async () => {
  const urls = [
    "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://0x7f.0.0.1/",
    "http://017700000001/", "http://0177.0.0.1/", "http://0/", "http://0.0.0.0/", "http://10.1.2.3/",
    "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/",
    "http://2852039166/", "http://0xa9fea9fe/", "http://100.64.0.1/", "http://192.0.0.8/", "http://198.18.0.1/",
    "http://224.0.0.1/", "http://239.255.255.250/", "http://240.0.0.1/", "http://255.255.255.255/",
    "http://192.0.2.1/", "http://203.0.113.9/", "http://127.0.0.1./",
  ];
  for (const u of urls) {
    const h = harness({});
    assert.equal(await code(safeFetchText(u, h)), "blocked_address", u);
    assert.equal(h.calls.length, 0, u);
  }
});

test("blocks private / loopback / mapped IPv6 literal forms", async () => {
  const urls = [
    "http://[::1]/", "http://[::]/", "http://[0:0:0:0:0:0:0:1]/", "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/", "http://[::ffff:169.254.169.254]/", "http://[::ffff:10.0.0.1]/",
    "http://[::127.0.0.1]/", "http://[fc00::1]/", "http://[fd12:3456::1]/", "http://[fe80::1]/",
    "http://[febf::1]/", "http://[ff02::1]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[2001:db8::1]/",
    "http://[2002:7f00:1::]/", "http://[2001:0:4136:e378::1]/", "http://[100::1]/", "http://[fec0::1]/",
  ];
  for (const u of urls) {
    const h = harness({});
    assert.equal(await code(safeFetchText(u, h)), "blocked_address", u);
    assert.equal(h.calls.length, 0, u);
  }
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
});

test("blocks localhost variants and internal names before DNS", async () => {
  for (const u of ["http://localhost/", "http://LOCALHOST./", "http://foo.localhost/", "http://printer.local/",
    "http://metadata.google.internal/computeMetadata/v1/", "http://db.internal/", "http://router.home.arpa/",
    "http://intranet/", "http://host.localdomain/"]) {
    const h = harness({});
    assert.equal(await code(safeFetchText(u, h)), "blocked_host", u);
    assert.equal(h.resolved.length + h.calls.length, 0, u);
  }
});

test("userinfo tricks, schemes and ports are refused", async () => {
  for (const [u, c] of [
    ["http://example.com@127.0.0.1/", "credentials"],
    ["http://user:pass@example.com/", "credentials"],
    ["http://127.0.0.1#@example.com/", "blocked_address"],
    ["file:///etc/passwd", "scheme"], ["ftp://example.com/", "scheme"], ["gopher://example.com/", "scheme"],
    ["javascript:alert(1)", "scheme"], ["http://example.com:8080/", "port"], ["https://example.com:22/", "port"],
    ["http://example.com:6379/", "port"], ["not a url", "invalid_url"],
  ] as const) {
    const h = harness({});
    assert.equal(await code(safeFetchText(u, h)), c, u);
    assert.equal(h.calls.length, 0, u);
  }
  // explicit 80/443 are fine
  assert.equal(validateUrl("https://example.com:443/").host, "example.com");
  assert.equal(validateUrl("https://example.com:80/").host, "example.com");
});

test("DNS answers are validated (A and AAAA): any private answer blocks, empty fails", async () => {
  for (const [ans, c] of [
    [["127.0.0.1"], "blocked_address"], [["93.184.216.34", "10.0.0.5"], "blocked_address"],
    [["::1"], "blocked_address"], [["::ffff:169.254.169.254"], "blocked_address"], [["fd00::1"], "blocked_address"],
    [[], "dns_failed"], [["garbage"], "blocked_address"],
  ] as const) {
    const h = harness({"https://rebind.example/": () => html("x")}, {"rebind.example": [...ans]});
    assert.equal(await code(safeFetchText("https://rebind.example/", h)), c, String(ans));
    assert.equal(h.calls.length, 0);
  }
});

test("redirects: re-validated per hop, private targets blocked, max 3 hops", async () => {
  const redir = (to: string) => () => new Response(null, {status: 302, headers: {location: to}});
  for (const to of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/",
    "http://localhost:80/", "http://inside.example/"]) {
    const h = harness({"https://example.com/": redir(to)}, {"inside.example": ["192.168.0.10"]});
    const c = await code(safeFetchText("https://example.com/", h));
    assert.ok(c === "blocked_address" || c === "blocked_host", `${to}: ${c}`);
    assert.equal(h.calls.length, 1, `${to}: the private hop is never fetched`);
  }
  // relative redirect, port change refused
  const hp = harness({"https://example.com/": redir("http://example.com:8080/x")});
  assert.equal(await code(safeFetchText("https://example.com/", hp)), "port");
  // 3 hops OK, 4 refused
  const chain = harness({
    "https://example.com/0": redir("/1"), "https://example.com/1": redir("/2"),
    "https://example.com/2": redir("/3"), "https://example.com/3": () => html("done"),
  });
  const ok3 = await safeFetchText("https://example.com/0", chain);
  assert.ok(ok3.ok && ok3.text === "done");
  const chain4 = harness({
    "https://example.com/0": redir("/1"), "https://example.com/1": redir("/2"),
    "https://example.com/2": redir("/3"), "https://example.com/3": redir("/4"), "https://example.com/4": () => html("x"),
  });
  assert.equal(await code(safeFetchText("https://example.com/0", chain4)), "too_many_redirects");
  assert.equal(chain4.calls.length, 4);
  const noLoc = harness({"https://example.com/": () => new Response(null, {status: 301})});
  assert.equal(await code(safeFetchText("https://example.com/", noLoc)), "bad_redirect");
});

test("content-type allowlist, streaming size cap and declared length", async () => {
  for (const ct of ["application/json", "image/png", "application/octet-stream", "text/javascript"]) {
    const h = harness({"https://example.com/": () => new Response("{}", {status: 200, headers: {"content-type": ct}})});
    assert.equal(await code(safeFetchText("https://example.com/", h)), "content_type", ct);
  }
  const noCt = harness({"https://example.com/": () => new Response(new Uint8Array([60, 104]), {status: 200})});
  assert.equal(await code(safeFetchText("https://example.com/", noCt)), "content_type", "missing content-type");
  for (const ct of ["text/plain", "application/xhtml+xml", "TEXT/HTML; charset=windows-1256"]) {
    const h = harness({"https://example.com/": () => new Response("hi", {status: 200, headers: {"content-type": ct}})});
    assert.equal(await code(safeFetchText("https://example.com/", h)), "no_error", ct);
  }
  // streamed body larger than the cap, no content-length
  const big = () => new Response(new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(256 * 1024)); },
  }), {status: 200, headers: {"content-type": "text/html"}});
  assert.equal(await code(safeFetchText("https://example.com/", harness({"https://example.com/": big}))), "too_large");
  const declared = harness({"https://example.com/": () => html("x", {"content-length": String(SAFE_FETCH_DEFAULTS.maxBytes + 1)})});
  assert.equal(await code(safeFetchText("https://example.com/", declared)), "too_large");
  assert.equal(SAFE_FETCH_DEFAULTS.maxBytes, 1_500_000);
});

test("overall timeout (hanging fetch, hanging DNS, slow body)", async () => {
  const hang = () => new Promise<Response>(() => {});
  assert.equal(await code(safeFetchText("https://example.com/", {fetch: hang, resolve: async () => [PUBLIC_V4], timeoutMs: 50})), "timeout");
  assert.equal(await code(safeFetchText("https://example.com/", {fetch: hang, resolve: () => new Promise(() => {}), timeoutMs: 50})), "timeout");
  const slow = async () => new Response(new ReadableStream({pull() { return new Promise(() => {}); }}),
    {status: 200, headers: {"content-type": "text/html"}});
  assert.equal(await code(safeFetchText("https://example.com/", {fetch: slow, resolve: async () => [PUBLIC_V4], timeoutMs: 50})), "timeout");
  assert.equal(SAFE_FETCH_DEFAULTS.timeoutMs, 8000);
});

test("non-2xx returns {ok:false,status} without reading the body; errors carry no host/IP", async () => {
  const h = harness({"https://example.com/": () => new Response("nope", {status: 404, headers: {"content-type": "text/html"}})});
  assert.deepEqual(await safeFetchText("https://example.com/", h), {ok: false, status: 404});
  try { await safeFetchText("http://169.254.169.254/", harness({})); } catch (e) {
    assert.ok(e instanceof SafeFetchError);
    assert.doesNotMatch((e as Error).message, /169\.254|metadata/);
  }
});

test("parsers", () => {
  assert.deepEqual(parseIpv4("2130706433"), [127, 0, 0, 1]);
  assert.deepEqual(parseIpv4("0x7f.1"), [127, 0, 0, 1]);
  assert.deepEqual(parseIpv4("10.0x10.1"), [10, 16, 0, 1]);
  assert.equal(parseIpv4("256.1.1.1"), null);
  assert.deepEqual(parseIpv6("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  assert.deepEqual(parseIpv6("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(parseIpv6("1:2:3:4:5:6:7:8:9"), null);
  assert.equal(parseIpv6("1::2::3"), null);
  assert.equal(parseIpv6("fe80::1%eth0"), null);
});

test("milan-api extractFromUrl uses the guard (no raw fetch with redirect:follow)", () => {
  const s = readFileSync("supabase/functions/milan-api/index.ts", "utf8");
  const a = s.indexOf("async function extractFromUrl(");
  const fn = s.slice(a, s.indexOf("\n}\n", a));
  assert.match(fn, /safeFetchText\(url, \{/);
  assert.match(fn, /resolve: denoResolver\(\)/);
  assert.doesNotMatch(fn, /redirect: "follow"/);
  assert.doesNotMatch(fn, /await fetch\(url/);
  assert.equal((s.match(/await\s+extractFromUrl\(/g) ?? []).length, 2, "qa_extract + knowledge_add only");
});
