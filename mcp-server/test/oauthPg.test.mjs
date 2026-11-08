// 20261029320000_oauth_tables: static checks (always) + a THROWAWAY local PostgreSQL cluster
// (temporary data dir, unix socket only, listen_addresses='', removed afterwards) that applies the
// migration and rollback and runs the same store contract against the Postgres store and the
// in-memory store, plus the full HTTP OAuth flow on the Postgres store. Never connects to a remote host.
// Skips the live part (with a message) when PostgreSQL server binaries are unavailable.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, chownSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPgOAuthStore, createMemoryOAuthStore, sha256Hex } from "../dist/oauthStore.js";
import { startOAuth, connect, refresh, rpc, bearer, U1, U2, U3 } from "./oauthHelpers.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIG = join(ROOT, "supabase/migrations/20261029320000_oauth_tables.sql");
const RB = join(ROOT, "supabase/rollbacks/20261029320000_oauth_tables.rollback.sql");
const MARK = "CREATED_BY_20261029320000_OAUTH_TABLES";
const TABLES = ["mcp_oauth_clients", "mcp_oauth_grant_families", "mcp_oauth_codes", "mcp_oauth_refresh_tokens", "mcp_oauth_revoked_access_tokens"];
const src = f => readFileSync(f, "utf8");
const noComments = s => s.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");

test("static: one bounded transaction, RLS + no policies, service_role-only, markers, rollback data guard", () => {
  for (const f of [MIG, RB]) {
    const s = src(f), code = noComments(s);
    assert.match(s, /^BEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='60s';\n/m, f);
    assert.equal((code.match(/^BEGIN;$/gm) ?? []).length, 1, f);
    assert.equal((code.match(/^COMMIT;$/gm) ?? []).length, 1, f);
    assert.doesNotMatch(code, /GRANT[^;]*\bTO\s+(anon|authenticated|PUBLIC)\b/i, f);
    assert.doesNotMatch(code, /CREATE POLICY|TRUNCATE|CONCURRENTLY/i, f);
  }
  const code = noComments(src(MIG));
  for (const t of TABLES) {
    assert.ok(code.includes(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`), t);
    assert.ok(code.includes(`REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated;`), t);
    assert.ok(code.includes(`COMMENT ON TABLE public.${t} IS '${MARK}';`), t);
  }
  assert.match(code, /SECURITY DEFINER\nSET search_path = ''/);
  assert.match(code, /REVOKE ALL ON FUNCTION public\.mcp_oauth_cleanup\(timestamptz\) FROM PUBLIC, anon, authenticated;/);
  assert.doesNotMatch(code, /\b(client_secret|code|token|refresh_token|password)\s+text\b/i, "no plaintext secret columns");
  const rb = noComments(src(RB));
  assert.match(rb, /milan\.rollback_320000/);
  assert.match(rb, /discard-mcp-oauth-grants/);
  const order = ["mcp_oauth_revoked_access_tokens", "mcp_oauth_refresh_tokens", "mcp_oauth_codes", "mcp_oauth_grant_families", "mcp_oauth_clients"]
    .map(t => rb.indexOf(`DROP TABLE IF EXISTS public.${t};`));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), "drop order children -> parents");
});

// ---------------------------------------------------------------- live PG
function findPgBin() {
  const c = [];
  if (process.env.PG_BIN) c.push(process.env.PG_BIN);
  try { for (const v of readdirSync("/usr/lib/postgresql").sort().reverse()) c.push(`/usr/lib/postgresql/${v}/bin`); } catch {}
  return c.find(d => ["initdb", "pg_ctl", "postgres", "psql"].every(b => existsSync(join(d, b)))) ?? null;
}
const BIN = findPgBin();
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const canRunAsPostgres = !isRoot || spawnSync("id", ["-u", "postgres"]).status === 0;
const live = Boolean(BIN && canRunAsPostgres);
const skip = live ? false : "PostgreSQL server binaries unavailable (/usr/lib/postgresql/*/bin); live migration + Postgres store tests skipped";
if (!live) process.stderr.write("[oauthPg] SKIP: " + skip + "\n");
let dir, port, started = false;
const asServer = (cmd, args) => isRoot
  ? spawnSync("runuser", ["-u", "postgres", "--", join(BIN, cmd), ...args], { encoding: "utf8" })
  : spawnSync(join(BIN, cmd), args, { encoding: "utf8" });
function clientEnv(extra = {}) { const e = {}; for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("PG")) e[k] = v; return { ...e, ...extra }; }
function psql(db, { file, sql, env } = {}) {
  const a = ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-h", dir, "-p", String(port), "-U", "postgres", "-d", db];
  if (file) a.push("-f", file);
  return spawnSync(join(BIN, "psql"), a, { encoding: "utf8", input: sql, env: clientEnv(env) });
}
function ok(db, s, label) { const r = psql(db, s); assert.equal(r.status, 0, `${label}\n${r.stderr}`); return r.stdout.trim(); }
const val = (db, q) => ok(db, { sql: `SELECT (${q});` }, q);
let dbn = 0;
const fresh = (template = "g320") => { const d = `o${++dbn}`; ok("postgres", { sql: `CREATE DATABASE ${d} TEMPLATE ${template};` }, d); return d; };
const FIXTURE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Supabase default privileges for future objects (so the migration's REVOKEs are really exercised).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
INSERT INTO auth.users VALUES ('${U1}'),('${U2}'),('${U3}');
`;
const pools = [];
const poolFor = db => { const p = new pg.Pool({ host: dir, port, user: "postgres", database: db, max: 4 }); pools.push(p); return p; };

before(() => {
  if (!live) return;
  dir = mkdtempSync(join(tmpdir(), "mcp-oauth-pg-"));
  if (isRoot) chownSync(dir, Number(spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }).stdout.trim()),
    Number(spawnSync("id", ["-g", "postgres"], { encoding: "utf8" }).stdout.trim()));
  port = 20000 + ((process.pid + 320) % 20000);
  const init = asServer("initdb", ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"]);
  assert.equal(init.status, 0, init.stderr);
  const st = asServer("pg_ctl", ["-D", join(dir, "data"), "-l", join(dir, "server.log"), "-w", "-o",
    `-c listen_addresses='' -k ${dir} -p ${port} -c fsync=off -c autovacuum=off`, "start"]);
  assert.equal(st.status, 0, st.stderr + st.stdout);
  started = true;
  ok("postgres", { sql: "CREATE DATABASE base;" }, "base");
  const fx = join(dir, "fixture.sql"); writeFileSync(fx, FIXTURE);
  ok("base", { file: fx }, "fixture");
  ok("postgres", { sql: "CREATE DATABASE g320 TEMPLATE base;" }, "g320");
  ok("g320", { file: MIG }, "apply 320000");
});
after(async () => {
  for (const p of pools) await p.end().catch(() => {});
  if (started) asServer("pg_ctl", ["-D", join(dir, "data"), "-m", "fast", "-w", "stop"]);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("live: re-apply is a no-op; RLS, no policies, anon/authenticated denied, service_role allowed", { skip }, () => {
  const db = fresh();
  const snap = `SELECT string_agg(c.relname||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity, ',' ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace`;
  const pre = val(db, snap);
  ok(db, { file: MIG }, "re-apply");
  assert.equal(val(db, snap), pre);
  for (const t of TABLES) {
    assert.equal(val(db, `obj_description('public.${t}'::regclass,'pg_class')`), MARK, t);
    assert.equal(val(db, `SELECT relrowsecurity FROM pg_class WHERE oid='public.${t}'::regclass`), "t", t);
    assert.equal(val(db, `SELECT count(*) FROM pg_policies WHERE tablename='${t}'`), "0", t);
    for (const role of ["anon", "authenticated"]) for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"])
      assert.equal(val(db, `has_table_privilege('${role}','public.${t}','${p}')`), "f", `${t} ${role} ${p}`);
    assert.equal(val(db, `has_table_privilege('service_role','public.${t}','SELECT')`), "t", t);
  }
  for (const role of ["anon", "authenticated", "public"])
    assert.equal(val(db, `has_function_privilege('${role}','public.mcp_oauth_cleanup(timestamptz)','EXECUTE')`), "f", role);
  assert.equal(val(db, `SELECT prosecdef::text||'|'||array_to_string(proconfig,',') FROM pg_proc WHERE oid='public.mcp_oauth_cleanup(timestamptz)'::regprocedure`), 'true|search_path=""');
  const r = psql(db, { sql: "BEGIN; SET LOCAL ROLE authenticated; SELECT * FROM public.mcp_oauth_clients; COMMIT;" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /permission denied/);
  // constraints: plaintext-looking secrets / long TTLs refused
  const bad = psql(db, { sql: `INSERT INTO public.mcp_oauth_clients (client_id, client_secret_hash, redirect_uris, token_endpoint_auth_method, grant_types, response_types, scope)
    VALUES ('${"a".repeat(32)}', 'plaintext-secret', ARRAY['https://x/cb'], 'client_secret_post', ARRAY['authorization_code'], ARRAY['code'], 'mcp:tools');` });
  assert.notEqual(bad.status, 0);
});

test("live: migration refuses to take over an unmarked table", { skip }, () => {
  const db = fresh("base");
  ok(db, { sql: "CREATE TABLE public.mcp_oauth_codes(x int);" }, "squat");
  const r = psql(db, { file: MIG });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /without marker/);
});

/** Same contract for both stores. */
async function storeContract(store) {
  const now = Date.parse("2026-11-01T00:00:00Z");
  const H = n => sha256Hex("t" + n + Math.random());
  const client = (id, extra = {}) => ({ clientId: id, clientSecretHash: null, clientSecretExpiresAt: null, clientName: "C", redirectUris: ["https://claude.ai/cb"],
    tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"], scope: "mcp:tools", createdAt: Math.floor(now / 1000), ...extra });
  const A = "A".repeat(32), B = "B".repeat(32), Cx = "C".repeat(32);
  assert.equal(await store.registerClient(client(A), 2, now), "ok");
  assert.equal(await store.registerClient(client(B, { tokenEndpointAuthMethod: "client_secret_post", clientSecretHash: sha256Hex("s") }), 2, now), "ok");
  assert.equal(await store.registerClient(client(Cx), 2, now), "cap");
  assert.equal(await store.getClient(Cx), null);
  const got = await store.getClient(B);
  assert.equal(got.clientSecretHash, sha256Hex("s"));
  assert.deepEqual(got.redirectUris, ["https://claude.ai/cb"]);
  assert.equal(got.createdAt, Math.floor(now / 1000));
  // codes
  const code = { codeHash: H(1), clientId: A, userId: U1, redirectUri: "https://claude.ai/cb", codeChallenge: "c".repeat(43), scope: "mcp:tools", resource: "https://x/mcp", expiresAt: now + 300_000 };
  await store.saveCode(code, now);
  assert.equal((await store.consumeCode(code.codeHash, B, now)).status, "invalid", "other client");
  const c1 = await store.consumeCode(code.codeHash, A, now + 1000);
  assert.equal(c1.status, "ok");
  assert.equal(c1.code.userId, U1);
  assert.equal(c1.code.codeChallenge, "c".repeat(43));
  const fam = crypto.randomUUID(), r0 = H(2);
  await store.createGrant({ familyId: fam, codeHash: code.codeHash, clientId: A, userId: U1, scope: "mcp:tools", refreshHash: r0, refreshExpiresAt: now + 30 * 86400_000 }, now);
  const jti = crypto.randomUUID();
  assert.equal(await store.isAccessTokenRevoked(jti, fam, now), false);
  // rotation
  const r1 = H(3);
  const rot = await store.rotateRefreshToken(r0, A, r1, now + 30 * 86400_000, now + 2000);
  assert.deepEqual({ ...rot }, { status: "ok", familyId: fam, userId: U1, scope: "mcp:tools" });
  assert.equal((await store.rotateRefreshToken(r1, B, H(4), now + 86400_000, now)).status, "invalid", "other client");
  assert.equal(await store.isAccessTokenRevoked(jti, fam, now), false, "foreign attempt does not revoke");
  // code replay -> family revoked
  assert.equal((await store.consumeCode(code.codeHash, A, now + 3000)).status, "reused");
  assert.equal(await store.isAccessTokenRevoked(jti, fam, now), true);
  assert.equal((await store.rotateRefreshToken(r1, A, H(5), now + 86400_000, now + 4000)).status, "invalid");
  // refresh reuse on a second family
  const code2 = { ...code, codeHash: H(6) };
  await store.saveCode(code2, now);
  assert.equal((await store.consumeCode(code2.codeHash, A, now)).status, "ok");
  const fam2 = crypto.randomUUID(), s0 = H(7), s1 = H(8);
  await store.createGrant({ familyId: fam2, codeHash: code2.codeHash, clientId: A, userId: U2, scope: "mcp:tools", refreshHash: s0, refreshExpiresAt: now + 86400_000 }, now);
  assert.equal((await store.rotateRefreshToken(s0, A, s1, now + 86400_000, now)).status, "ok");
  assert.equal((await store.rotateRefreshToken(s0, A, H(9), now + 86400_000, now)).status, "reused");
  assert.equal((await store.rotateRefreshToken(s1, A, H(10), now + 86400_000, now)).status, "invalid", "family dead");
  // expired code / refresh
  const code3 = { ...code, codeHash: H(11), expiresAt: now + 1000 };
  await store.saveCode(code3, now);
  assert.equal((await store.consumeCode(code3.codeHash, A, now + 1000)).status, "invalid");
  // revoke refresh (owner client only), revoke access jti
  const code4 = { ...code, codeHash: H(12) };
  await store.saveCode(code4, now);
  await store.consumeCode(code4.codeHash, A, now);
  const fam4 = crypto.randomUUID(), t0 = H(13);
  await store.createGrant({ familyId: fam4, codeHash: code4.codeHash, clientId: A, userId: U1, scope: "mcp:tools", refreshHash: t0, refreshExpiresAt: now + 86400_000 }, now);
  await store.revokeRefreshToken(t0, B, now);
  assert.equal(await store.isAccessTokenRevoked(jti, fam4, now), false);
  const jti2 = crypto.randomUUID();
  await store.revokeAccessToken(jti2, now + 3600_000);
  assert.equal(await store.isAccessTokenRevoked(jti2, fam4, now), true);
  await store.revokeRefreshToken(t0, A, now);
  assert.equal(await store.isAccessTokenRevoked(jti, fam4, now), true);
  // cleanup: far future removes everything dead, including never-used client B
  const n = await store.cleanup(now + 200 * 86400_000);
  assert.ok(n >= 5, "cleanup removed rows: " + n);
  assert.equal(await store.getClient(B), null);
  assert.equal(await store.isAccessTokenRevoked(crypto.randomUUID(), fam4, now), true, "unknown family counts as revoked");
}

test("store contract: in-memory store", async () => { await storeContract(createMemoryOAuthStore()); });

test("live: store contract on the Postgres store", { skip }, async () => {
  const db = fresh();
  const store = createPgOAuthStore(poolFor(db));
  await storeContract(store);
  // only hashes in the database
  assert.equal(val(db, "SELECT count(*) FROM public.mcp_oauth_refresh_tokens WHERE token_hash !~ '^[0-9a-f]{64}$'"), "0");
});

test("live: full HTTP OAuth flow + refresh rotation/reuse on the Postgres store", { skip }, async () => {
  const db = fresh();
  const s = await startOAuth({ store: createPgOAuthStore(poolFor(db)) });
  try {
    const { clientId, tokens, flow } = await connect(s);
    assert.equal(flow.step, "done");
    assert.equal((await rpc(s, "tools/list", {}, bearer(tokens.access_token))).res.status, 200);
    const r1 = await refresh(s, clientId, tokens.refresh_token);
    assert.equal(r1.res.status, 200, r1.text);
    assert.equal((await refresh(s, clientId, tokens.refresh_token)).json.error, "invalid_grant");
    assert.equal((await rpc(s, "tools/list", {}, bearer(r1.json.access_token))).res.status, 401, "reuse revoked the family");
    assert.equal(val(db, "SELECT revoked_reason FROM public.mcp_oauth_grant_families"), "refresh_reuse");
    const dump = val(db, "SELECT string_agg(t::text, '|') FROM (SELECT row_to_json(x)::text AS t FROM public.mcp_oauth_refresh_tokens x UNION ALL SELECT row_to_json(y)::text FROM public.mcp_oauth_codes y) z");
    for (const secret of [tokens.refresh_token, r1.json.refresh_token, flow.code]) assert.equal(dump.includes(secret), false, "no plaintext secret stored");
  } finally { await s.close(); }
});

test("live: rollback refuses with data unless discarded explicitly; empty rollback; not-installed refusal", { skip }, () => {
  const db = fresh();
  ok(db, { sql: `INSERT INTO public.mcp_oauth_clients (client_id, redirect_uris, token_endpoint_auth_method, grant_types, response_types, scope)
    VALUES ('${"a".repeat(32)}', ARRAY['https://x/cb'], 'none', ARRAY['authorization_code'], ARRAY['code'], 'mcp:tools');` }, "row");
  const refused = psql(db, { file: RB });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /hold rows/);
  assert.equal(val(db, "to_regclass('public.mcp_oauth_clients') IS NOT NULL"), "t", "nothing dropped");
  ok(db, { file: RB, env: { PGOPTIONS: "-c milan.rollback_320000=discard-mcp-oauth-grants" } }, "discard rollback");
  for (const t of TABLES) assert.equal(val(db, `to_regclass('public.${t}') IS NULL`), "t", t);
  assert.equal(val(db, "to_regprocedure('public.mcp_oauth_cleanup(timestamptz)') IS NULL"), "t");
  const again = psql(db, { file: RB });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /not installed/);
  const empty = fresh();
  ok(empty, { file: RB }, "empty rollback");
  ok(empty, { file: MIG }, "re-apply after rollback");
});
