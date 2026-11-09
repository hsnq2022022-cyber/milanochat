#!/usr/bin/env node
/**
 * Per-function Supabase Edge Function deploy via the Management API.
 *
 * Usage:
 *   node scripts/deploy-functions.js --list
 *   node scripts/deploy-functions.js --only <slug> --dry-run
 *   node scripts/deploy-functions.js --only <slug>
 *
 * Env:
 *   SUPABASE_PROJECT_REF   (required for any network call)
 *   SUPABASE_ACCESS_TOKEN  (required for any network call; never printed)
 *   SUPABASE_API_BASE      (optional, default https://api.supabase.com; http only for localhost)
 *
 * Safety:
 *   - Exactly one --only <slug> per run. No bulk deploy.
 *   - verify_jwt comes from the hard-coded map below (verified against the LIVE project).
 *     Before a deploy the live function list is fetched and the run ABORTS if the live
 *     verify_jwt differs from the map, or if the function does not exist live.
 *   - --dry-run bundles locally; with credentials it additionally performs the read-only
 *     list check and calls the deploy endpoint with bundleOnly=1 (non-persisting).
 *   - The access token is redacted from every line of output.
 */
import {readFileSync, existsSync, statSync} from "node:fs";
import {dirname, resolve, relative, sep, posix} from "node:path";
import {fileURLToPath} from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTIONS_DIR = resolve(REPO_ROOT, "supabase/functions");
const DEFAULT_API_BASE = "https://api.supabase.com";
const REQUEST_TIMEOUT_MS = 120000;

// Verified verify_jwt settings of the LIVE project (17 functions). Do not edit without re-verifying live.
const VERIFY_JWT = Object.freeze({
  "agent-prompt": false,
  "api": false,
  "channels": false,
  "conversation-previews": false,
  "create-payment": false,
  "flow-delivery-review": true,
  "flow-internal-worker": false,
  "flow-outbox-worker": false,
  "flow-publication": true,
  "flow-runtime-worker": false,
  "generate-flow": true,
  "img-proxy": false,
  "meta-auth": false,
  "milan-api": false,
  "salla-test-products": true,
  "salla-webhook": false,
  "wayl-webhook": false,
});

const EXIT = {OK: 0, UNEXPECTED: 1, USAGE: 2, CREDS: 3, API: 4, MISMATCH: 5};
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const REF_RE = /^[a-z0-9]{8,40}$/;

const secrets = [];
function redact(text) {
  let s = String(text);
  for (const secret of secrets) if (secret) s = s.split(secret).join("[REDACTED]");
  return s.replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]");
}
const log = (msg) => process.stdout.write(redact(msg) + "\n");
const err = (msg) => process.stderr.write(redact(msg) + "\n");

class Fail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function usage() {
  return [
    "Usage:",
    "  node scripts/deploy-functions.js --list",
    "  node scripts/deploy-functions.js --only <slug> [--dry-run]",
    "Exactly one --only <slug> is required for deploy or dry-run. No bulk deploy.",
  ].join("\n");
}

function parseArgs(argv) {
  const opts = {only: [], dryRun: false, list: false, help: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Fail(EXIT.USAGE, "--only requires a slug");
      opts.only.push(v); i++;
    } else if (a.startsWith("--only=")) {
      opts.only.push(a.slice("--only=".length));
    } else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Fail(EXIT.USAGE, `Unknown argument: ${JSON.stringify(a)}`);
  }
  return opts;
}

function validateSlug(slug) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new Fail(EXIT.USAGE, `Invalid slug: ${JSON.stringify(slug)}`);
  }
  if (!Object.prototype.hasOwnProperty.call(VERIFY_JWT, slug)) {
    throw new Fail(EXIT.USAGE, `Unknown slug (not in verified verify_jwt map): ${slug}`);
  }
}

// ---- local bundle collection ----
const IMPORT_RES = [
  /^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function toPosixRel(abs) {
  return relative(REPO_ROOT, abs).split(sep).join(posix.sep);
}

function collectFiles(slug) {
  const entry = resolve(FUNCTIONS_DIR, slug, "index.ts");
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    throw new Fail(EXIT.USAGE, `No local source for ${slug}: supabase/functions/${slug}/index.ts not found`);
  }
  const seen = new Map();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const rel = toPosixRel(file);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      throw new Fail(EXIT.USAGE, `Import escapes repository root: ${rel}`);
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new Fail(EXIT.USAGE, `Missing local import: ${rel}`);
    }
    const content = readFileSync(file);
    seen.set(file, {path: rel, content});
    const text = content.toString("utf8");
    for (const re of IMPORT_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const spec = m[1];
        // Type-only imports/exports are erased at runtime and are not part of the deployed graph.
        if (/^\s*(?:import|export)\s+type\b/.test(m[0])) continue;
        if (spec.startsWith("./") || spec.startsWith("../")) queue.push(resolve(dirname(file), spec));
      }
    }
  }
  return {entrypointPath: toPosixRel(entry), files: [...seen.values()]};
}

// ---- API ----
function apiBase() {
  const raw = process.env.SUPABASE_API_BASE || DEFAULT_API_BASE;
  let url;
  try { url = new URL(raw); } catch { throw new Fail(EXIT.USAGE, "SUPABASE_API_BASE is not a valid URL"); }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Fail(EXIT.USAGE, "SUPABASE_API_BASE must be https (http allowed only for localhost)");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function credentials() {
  const ref = process.env.SUPABASE_PROJECT_REF || "";
  const token = process.env.SUPABASE_ACCESS_TOKEN || "";
  if (token) secrets.push(token);
  return {ref, token};
}

function requireCredentials({ref, token}) {
  const missing = [];
  if (!ref) missing.push("SUPABASE_PROJECT_REF");
  if (!token) missing.push("SUPABASE_ACCESS_TOKEN");
  if (missing.length) throw new Fail(EXIT.CREDS, `Missing required env: ${missing.join(", ")}`);
  if (!REF_RE.test(ref)) throw new Fail(EXIT.CREDS, "SUPABASE_PROJECT_REF has an invalid format");
}

async function api(method, path, {token, body, query} = {}) {
  const url = new URL(apiBase() + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {Authorization: `Bearer ${token}`, Accept: "application/json"},
      body,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Fail(EXIT.API, `${method} ${url.pathname} failed: ${e?.cause?.code || e?.name || "network error"}`);
  }
  const text = await res.text();
  if (res.status < 200 || res.status > 299) {
    throw new Fail(EXIT.API, `${method} ${url.pathname} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  try { return JSON.parse(text); } catch {
    throw new Fail(EXIT.API, `${method} ${url.pathname} returned malformed JSON`);
  }
}

async function liveFunction(ref, token, slug) {
  const list = await api("GET", `/v1/projects/${ref}/functions`, {token});
  if (!Array.isArray(list) || !list.every((f) => f && typeof f === "object" && typeof f.slug === "string")) {
    throw new Fail(EXIT.API, "Malformed function list response");
  }
  const fn = list.find((f) => f.slug === slug);
  if (!fn) return null;
  if (typeof fn.verify_jwt !== "boolean") throw new Fail(EXIT.API, `Live ${slug} has no boolean verify_jwt`);
  return fn;
}

async function checkLive(ref, token, slug) {
  const fn = await liveFunction(ref, token, slug);
  if (!fn) {
    throw new Fail(EXIT.MISMATCH, `${slug} not found in live project; refusing (check SUPABASE_PROJECT_REF)`);
  }
  if (fn.verify_jwt !== VERIFY_JWT[slug]) {
    throw new Fail(EXIT.MISMATCH,
      `ABORT: live verify_jwt for ${slug} is ${fn.verify_jwt}, expected ${VERIFY_JWT[slug]}. Nothing deployed.`);
  }
  log(`Live check OK: ${slug} verify_jwt=${fn.verify_jwt} (version ${fn.version ?? "?"})`);
}

async function deploy(ref, token, slug, bundle, bundleOnly) {
  const form = new FormData();
  form.append("metadata", JSON.stringify({
    name: slug,
    entrypoint_path: bundle.entrypointPath,
    verify_jwt: VERIFY_JWT[slug],
  }));
  for (const f of bundle.files) {
    form.append("file", new Blob([f.content], {type: "application/typescript"}), f.path);
  }
  const query = {slug};
  if (bundleOnly) query.bundleOnly = "1";
  const out = await api("POST", `/v1/projects/${ref}/functions/deploy`, {token, body: form, query});
  if (!out || typeof out !== "object" || Array.isArray(out) || (out.slug !== undefined && out.slug !== slug)) {
    throw new Fail(EXIT.API, `Malformed deploy response for ${slug}${bundleOnly ? "" : " (deploy state unknown; verify live)"}`);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { log(usage()); return EXIT.OK; }

  if (opts.list) {
    if (opts.only.length || opts.dryRun) throw new Fail(EXIT.USAGE, "--list cannot be combined with other flags");
    for (const [slug, v] of Object.entries(VERIFY_JWT)) {
      const local = existsSync(resolve(FUNCTIONS_DIR, slug, "index.ts")) ? "local" : "no-local-source";
      log(`${slug}\tverify_jwt=${v}\t${local}`);
    }
    return EXIT.OK;
  }

  if (opts.only.length !== 1) {
    throw new Fail(EXIT.USAGE, `Exactly one --only <slug> is required (got ${opts.only.length}). No bulk deploy.\n${usage()}`);
  }
  const slug = opts.only[0];
  validateSlug(slug);
  const bundle = collectFiles(slug);
  log(`Bundle ${slug}: entrypoint ${bundle.entrypointPath}, ${bundle.files.length} file(s), verify_jwt=${VERIFY_JWT[slug]}`);
  for (const f of bundle.files) log(`  ${f.path}`);

  const creds = credentials();
  if (opts.dryRun) {
    if (!creds.ref && !creds.token) {
      log("DRY RUN: local validation only (no credentials set; no network calls).");
      return EXIT.OK;
    }
    requireCredentials(creds);
    apiBase();
    await checkLive(creds.ref, creds.token, slug);
    await deploy(creds.ref, creds.token, slug, bundle, true);
    log(`DRY RUN OK: ${slug} bundled remotely with bundleOnly=1 (not persisted).`);
    return EXIT.OK;
  }

  requireCredentials(creds);
  apiBase();
  await checkLive(creds.ref, creds.token, slug);
  const out = await deploy(creds.ref, creds.token, slug, bundle, false);
  log(`Deployed ${slug} (version ${out.version ?? "?"}).`);
  const after = await liveFunction(creds.ref, creds.token, slug);
  if (!after || after.verify_jwt !== VERIFY_JWT[slug]) {
    throw new Fail(EXIT.MISMATCH, `POST-DEPLOY: live verify_jwt for ${slug} is ${after?.verify_jwt}, expected ${VERIFY_JWT[slug]}`);
  }
  log(`Post-deploy check OK: ${slug} verify_jwt=${after.verify_jwt}`);
  return EXIT.OK;
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => {
    if (e instanceof Fail) { err(`ERROR: ${e.message}`); process.exitCode = e.code; }
    else { err(`UNEXPECTED ERROR: ${e?.message || e}`); process.exitCode = EXIT.UNEXPECTED; }
  },
);
