// Tests for scripts/deploy-functions.js against a LOCAL mock HTTP server only.
// The child process env is built explicitly; real credentials are never inherited.
import {test, before, after, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts/deploy-functions.js");
const TOKEN = "FAKE_TOKEN_123";
const REF = "abcdefghijklmnopqrst";

const EXPECTED = {
  "agent-prompt": false, "api": false, "channel-token-lifecycle": false, "channels": false, "conversation-previews": false,
  "create-payment": false, "flow-delivery-review": true, "flow-internal-worker": false,
  "flow-outbox-worker": false, "flow-publication": true, "flow-runtime-worker": false,
  "generate-flow": true, "img-proxy": false, "meta-auth": false, "milan-api": false,
  "salla-test-products": true, "salla-webhook": false, "wayl-webhook": false,
};

const liveList = (overrides = {}) =>
  Object.entries({...EXPECTED, ...overrides})
    .filter(([, v]) => v !== undefined)
    .map(([slug, verify_jwt], i) => ({id: `id-${i}`, slug, name: slug, status: "ACTIVE", version: 7, verify_jwt}));

let server; let base; let requests; let routes;

function resetMock() {
  requests = [];
  routes = {
    list: () => ({status: 200, body: JSON.stringify(liveList())}),
    deploy: (url) => ({status: 201, body: JSON.stringify({id: "x", slug: url.searchParams.get("slug"), version: 8, verify_jwt: EXPECTED[url.searchParams.get("slug")]})}),
  };
}

before(async () => {
  resetMock();
  server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, contentType: req.headers["content-type"] || "", body});
      let out = {status: 404, body: "{}"};
      if (req.method === "GET" && url.pathname === `/v1/projects/${REF}/functions`) out = routes.list(url);
      else if (req.method === "POST" && url.pathname === `/v1/projects/${REF}/functions/deploy`) out = routes.deploy(url, body);
      res.writeHead(out.status, {"content-type": "application/json"});
      res.end(out.body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));
beforeEach(resetMock);

function run(args, env = {}) {
  const childEnv = {PATH: process.env.PATH, SUPABASE_API_BASE: base, ...env};
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], {cwd: ROOT, env: childEnv, timeout: 30000}, (error, stdout, stderr) => {
      done({code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout, stderr, all: stdout + stderr});
    });
  });
}
const creds = {SUPABASE_PROJECT_REF: REF, SUPABASE_ACCESS_TOKEN: TOKEN};
const noToken = (r) => assert.ok(!r.all.includes(TOKEN), "token leaked in output");
const posts = () => requests.filter((q) => q.method === "POST");

test("--list prints all 18 slugs with the verified verify_jwt map and makes no network call", async () => {
  const r = await run(["--list"], creds);
  assert.equal(r.code, 0, r.all);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 18);
  for (const [slug, v] of Object.entries(EXPECTED)) {
    assert.ok(lines.some((l) => l.startsWith(`${slug}\tverify_jwt=${v}\t`)), `missing ${slug}=${v}`);
  }
  assert.equal(requests.length, 0);
  noToken(r);
});

test("ambiguous targets are rejected without any API call", async () => {
  for (const args of [[], ["--dry-run"], ["--only", "milan-api", "--only", "api"], ["--only"], ["--only", "--dry-run"], ["--all"], ["milan-api"]]) {
    const r = await run(args, creds);
    assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.all}`);
    noToken(r);
  }
  assert.equal(requests.length, 0);
});

test("invalid and unknown slugs are rejected without any API call", async () => {
  for (const slug of ["../milan-api", "Milan-API", "milan api", "milan-api;rm", "", "not-a-function", "flow-staff-inbox", "_shared"]) {
    const r = await run(["--only", slug], creds);
    assert.equal(r.code, 2, `${slug}: ${r.all}`);
    noToken(r);
  }
  // In map but no local source: fails locally before network.
  const r = await run(["--only", "img-proxy"], creds);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /No local source/);
  assert.equal(requests.length, 0);
});

test("missing credentials fail safely with no API call", async () => {
  let r = await run(["--only", "milan-api"], {SUPABASE_PROJECT_REF: REF});
  assert.equal(r.code, 3);
  assert.match(r.stderr, /SUPABASE_ACCESS_TOKEN/);
  r = await run(["--only", "milan-api"], {SUPABASE_ACCESS_TOKEN: TOKEN});
  assert.equal(r.code, 3);
  noToken(r);
  r = await run(["--only", "milan-api", "--dry-run"], {SUPABASE_ACCESS_TOKEN: TOKEN});
  assert.equal(r.code, 3);
  noToken(r);
  r = await run(["--only", "milan-api"], {SUPABASE_PROJECT_REF: "BAD/REF", SUPABASE_ACCESS_TOKEN: TOKEN});
  assert.equal(r.code, 3);
  noToken(r);
  assert.equal(requests.length, 0);
});

test("real deploy targets exactly one function, sends bearer auth, only hits the mock", async () => {
  const r = await run(["--only", "milan-api"], creds);
  assert.equal(r.code, 0, r.all);
  noToken(r);
  assert.deepEqual(requests.map((q) => `${q.method} ${q.path}`), [
    `GET /v1/projects/${REF}/functions`,
    `POST /v1/projects/${REF}/functions/deploy`,
    `GET /v1/projects/${REF}/functions`,
  ]);
  for (const q of requests) assert.equal(q.auth, `Bearer ${TOKEN}`);
  const [post] = posts();
  assert.deepEqual(post.query, {slug: "milan-api"});
  assert.match(post.contentType, /^multipart\/form-data; boundary=/);
  const meta = JSON.parse(post.body.match(/name="metadata"\r\n\r\n([^\r]*)\r\n/)[1]);
  assert.deepEqual(meta, {name: "milan-api", entrypoint_path: "supabase/functions/milan-api/index.ts", verify_jwt: false});
  const files = [...post.body.matchAll(/name="file"; filename="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(files.includes("supabase/functions/milan-api/index.ts"));
  assert.ok(!files.some((f) => f.endsWith(".bak")));
  assert.equal(new Set(files).size, files.length, "duplicate files");
  for (const f of files) {
    assert.ok(f.startsWith("supabase/functions/") || f.startsWith("src/"), f);
    assert.ok(!f.includes(".."), f);
    // Cross-function helper imports are legitimate, but no other function's entrypoint may be bundled.
    if (/^supabase\/functions\/[^/]+\/index\.ts$/.test(f)) assert.equal(f, "supabase/functions/milan-api/index.ts");
  }
});

test("verify_jwt=true functions deploy with verify_jwt true in metadata", async () => {
  const r = await run(["--only", "flow-publication"], creds);
  assert.equal(r.code, 0, r.all);
  const meta = JSON.parse(posts()[0].body.match(/name="metadata"\r\n\r\n([^\r]*)\r\n/)[1]);
  assert.equal(meta.verify_jwt, true);
  assert.equal(meta.name, "flow-publication");
});

test("channel-token-lifecycle: single-function dry-run, verify_jwt=false metadata, no bulk deploy", async () => {
  const r = await run(["--only", "channel-token-lifecycle", "--dry-run"], creds);
  assert.equal(r.code, 0, r.all);
  noToken(r);
  const p = posts();
  assert.equal(p.length, 1);
  assert.equal(p[0].query.slug, "channel-token-lifecycle");
  assert.equal(p[0].query.bundleOnly, "1");
  const meta = JSON.parse(p[0].body.match(/name="metadata"\r\n\r\n([^\r]*)\r\n/)[1]);
  assert.equal(meta.verify_jwt, false);
  assert.equal(meta.name, "channel-token-lifecycle");
  // live verify_jwt=true would block JWT-less cron calls: the mismatch guard still aborts
  routes.list = () => ({status: 200, body: JSON.stringify(liveList({"channel-token-lifecycle": true}))});
  const m = await run(["--only", "channel-token-lifecycle"], creds);
  assert.equal(m.code, 5, m.all);
  assert.match(m.stderr, /ABORT: live verify_jwt for channel-token-lifecycle is true, expected false/);
  // not yet live: the existing "missing from live list" guard still aborts (nothing is created implicitly)
  routes.list = () => ({status: 200, body: JSON.stringify(liveList({"channel-token-lifecycle": undefined}))});
  const n = await run(["--only", "channel-token-lifecycle"], creds);
  assert.equal(n.code, 5, n.all);
  assert.ok(posts().filter((q) => q.query.bundleOnly !== "1").length === 0);
});

// ---- --first-deploy (scoped to channel-token-lifecycle; never a general missing-from-live bypass) ----
const CTL = "channel-token-lifecycle";
const absentThenLive = (jwtAfter = false) => {
  let deployed = false;
  routes.list = () => ({status: 200, body: JSON.stringify(deployed
    ? liveList({[CTL]: jwtAfter})
    : liveList({[CTL]: undefined}))});
  routes.deploy = (url) => {
    if (url.searchParams.get("bundleOnly") !== "1") deployed = true;
    return {status: 201, body: JSON.stringify({id: "x", slug: url.searchParams.get("slug"), version: 1, verify_jwt: false})};
  };
};

test("--first-deploy is refused for every slug except channel-token-lifecycle (no API call)", async () => {
  for (const slug of Object.keys(EXPECTED).filter((s) => s !== CTL).concat(["not-a-function", "tenant-admin"])) {
    const r = await run(["--only", slug, "--first-deploy"], creds);
    assert.equal(r.code, 2, `${slug}: ${r.all}`);
    noToken(r);
  }
  assert.equal(requests.length, 0);
});

test("--first-deploy needs exactly one --only target; no bulk or --list combination", async () => {
  for (const args of [["--first-deploy"], ["--first-deploy", "--dry-run"], ["--only", CTL, "--only", "milan-api", "--first-deploy"],
    ["--only", CTL, "--only", CTL, "--first-deploy"], ["--all", "--first-deploy"], ["--list", "--first-deploy"], ["--list", "--only", CTL, "--first-deploy"]]) {
    const r = await run(args, creds);
    assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.all}`);
  }
  assert.equal(requests.length, 0);
});

test("--first-deploy deploys only while absent live; sends verify_jwt=false and verifies it after", async () => {
  absentThenLive(false);
  const r = await run(["--only", CTL, "--first-deploy"], creds);
  assert.equal(r.code, 0, r.all);
  noToken(r);
  const p = posts();
  assert.equal(p.length, 1, "exactly one deploy call");
  assert.equal(p[0].query.slug, CTL);
  assert.equal(p[0].query.bundleOnly, undefined);
  const meta = JSON.parse(p[0].body.match(/name="metadata"\r\n\r\n([^\r]*)\r\n/)[1]);
  assert.equal(meta.verify_jwt, false);
  assert.equal(meta.name, CTL);
  assert.match(r.stdout, /First-deploy check OK/);
  assert.match(r.stdout, /Post-deploy check OK: channel-token-lifecycle verify_jwt=false/);
});

test("--first-deploy post-deploy verify_jwt mismatch still fails", async () => {
  absentThenLive(true);
  const r = await run(["--only", CTL, "--first-deploy"], creds);
  assert.equal(r.code, 5, r.all);
  assert.match(r.stderr, /POST-DEPLOY: live verify_jwt for channel-token-lifecycle is true, expected false/);
});

test("--first-deploy refuses an already-live function and points to the normal path (no deploy call)", async () => {
  for (const extra of [[], ["--dry-run"]]) {
    const r = await run(["--only", CTL, "--first-deploy", ...extra], creds);
    assert.equal(r.code, 5, r.all);
    assert.match(r.stderr, /already live .* Use the normal path: --only channel-token-lifecycle/);
  }
  assert.equal(posts().length, 0);
});

test("--first-deploy --dry-run is bundleOnly and never persists", async () => {
  absentThenLive(false);
  const r = await run(["--only", CTL, "--first-deploy", "--dry-run"], creds);
  assert.equal(r.code, 0, r.all);
  const p = posts();
  assert.equal(p.length, 1);
  assert.equal(p[0].query.bundleOnly, "1");
});

test("without --first-deploy the missing-from-live guard still blocks channel-token-lifecycle and every other function", async () => {
  for (const slug of [CTL, "milan-api", "flow-publication"]) {
    routes.list = () => ({status: 200, body: JSON.stringify(liveList({[slug]: undefined}))});
    for (const extra of [[], ["--dry-run"]]) {
      const r = await run(["--only", slug, ...extra], creds);
      assert.equal(r.code, 5, `${slug}: ${r.all}`);
      assert.match(r.stderr, /not found in live project; refusing/);
    }
  }
  assert.equal(posts().filter((q) => q.query.bundleOnly !== "1").length, 0);
});

test("dry-run with credentials only uses bundleOnly=1 and never persists", async () => {
  const r = await run(["--only", "generate-flow", "--dry-run"], creds);
  assert.equal(r.code, 0, r.all);
  noToken(r);
  const p = posts();
  assert.equal(p.length, 1);
  assert.equal(p[0].query.bundleOnly, "1");
  assert.equal(p[0].query.slug, "generate-flow");
  assert.ok(requests.every((q) => q.method === "GET" || q.query.bundleOnly === "1"));
});

test("dry-run without credentials is local-only (zero requests)", async () => {
  const r = await run(["--only", "milan-api", "--dry-run"]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /local validation only/);
  assert.equal(requests.length, 0);
});

test("live verify_jwt mismatch aborts before deploy (real and dry-run)", async () => {
  routes.list = () => ({status: 200, body: JSON.stringify(liveList({"flow-publication": false}))});
  for (const extra of [[], ["--dry-run"]]) {
    const r = await run(["--only", "flow-publication", ...extra], creds);
    assert.equal(r.code, 5, r.all);
    assert.match(r.stderr, /ABORT: live verify_jwt for flow-publication is false, expected true/);
    noToken(r);
  }
  routes.list = () => ({status: 200, body: JSON.stringify(liveList({"milan-api": true}))});
  const r = await run(["--only", "milan-api"], creds);
  assert.equal(r.code, 5);
  assert.equal(posts().length, 0);
});

test("function missing from live list aborts (likely wrong project)", async () => {
  routes.list = () => ({status: 200, body: JSON.stringify(liveList({"milan-api": undefined}))});
  const r = await run(["--only", "milan-api"], creds);
  assert.equal(r.code, 5, r.all);
  assert.equal(posts().length, 0);
});

test("API errors fail non-zero and redact the token even if echoed by the server", async () => {
  routes.list = () => ({status: 401, body: JSON.stringify({message: `invalid token ${TOKEN}`, header: `Bearer ${TOKEN}`})});
  let r = await run(["--only", "milan-api"], creds);
  assert.equal(r.code, 4, r.all);
  assert.match(r.stderr, /HTTP 401/);
  assert.match(r.stderr, /\[REDACTED\]/);
  noToken(r);
  assert.equal(posts().length, 0);

  resetMock();
  routes.deploy = () => ({status: 500, body: `boom ${TOKEN}`});
  r = await run(["--only", "milan-api"], creds);
  assert.equal(r.code, 4, r.all);
  assert.match(r.stderr, /HTTP 500/);
  noToken(r);
  assert.equal(requests.filter((q) => q.method === "GET").length, 1, "no post-deploy check after failed deploy");
});

test("malformed API responses fail safely", async () => {
  for (const body of ["not json", JSON.stringify({functions: []}), JSON.stringify([{nope: 1}]), JSON.stringify([{slug: "milan-api", verify_jwt: "false"}])]) {
    resetMock();
    routes.list = () => ({status: 200, body});
    const r = await run(["--only", "milan-api"], creds);
    assert.equal(r.code, 4, `${body}: ${r.all}`);
    assert.equal(posts().length, 0);
    noToken(r);
  }
  resetMock();
  routes.deploy = () => ({status: 200, body: JSON.stringify([1, 2])});
  const r = await run(["--only", "milan-api"], creds);
  assert.equal(r.code, 4, r.all);
  noToken(r);
});

test("non-local plain-http API base is refused without any request", async () => {
  const r = await run(["--only", "milan-api"], {...creds, SUPABASE_API_BASE: "http://example.invalid"});
  assert.equal(r.code, 2, r.all);
  assert.equal(requests.length, 0);
  noToken(r);
});
