import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {verifyMetaWebhookSignature} from "../supabase/functions/milan-api/metaSignature.ts";

const raw='{"object":"page","entry":[{"id":"123","messaging":[]}]}';
const validMeta="sha256=9eb3f79d4d08f1a4dd3e3b7a8fc65d23ae7dc2e2256e4780761adeb53db0d2df";
const validIg="sha256=063af9fd70b85b01f15e5dbadc6bfa2c919ef86dff2779dff468d623db6cb577";

test("matches independent known HMAC-SHA256 vectors for either configured Meta app",async()=>{
 assert.equal(await verifyMetaWebhookSignature(raw,validMeta,["meta-stage-secret"]),true);
 assert.equal(await verifyMetaWebhookSignature(raw,validIg,
   ["meta-stage-secret","instagram-stage-secret"]),true);
 assert.equal(await verifyMetaWebhookSignature(raw,validMeta,
   ["instagram-stage-secret","meta-stage-secret"]),true);
});
test("no configured secret must NEVER bypass verification",async()=>{
 for(const secrets of [[],[""],[" ",""]]){
  assert.equal(await verifyMetaWebhookSignature(raw,validMeta,secrets),false);
 }
});
test("unsigned, malformed or legacy SHA1 signature cannot pass",async()=>{
 for(const signature of [
  "", "sha1=9eb3f79d4d08f1a4dd3e3b7a8fc65d23ae7dc2e",
  "sha256=",validMeta.slice(7),validMeta+"bad",
  "sha256="+"0".repeat(64),"sha256="+"z".repeat(64)
 ]){
  assert.equal(await verifyMetaWebhookSignature(raw,signature,["meta-stage-secret"]),false);
 }
});
test("HMAC checks raw body bytes exactly and rejects tampering or whitespace changes",async()=>{
 for(const modified of [
  raw+" ",raw.replace('"page"','"instagram"'),raw.replace('"123"','"999"'),
  raw.replace('"messaging":[]','"messaging":[{"sender":{"id":"spoof"}}]')
 ]){
  assert.equal(await verifyMetaWebhookSignature(modified,validMeta,
    ["meta-stage-secret"]),false);
 }
});
test("wrong app secret always fails; uppercase digest remains accepted",async()=>{
 assert.equal(await verifyMetaWebhookSignature(raw,validMeta,["wrong-secret"]),false);
 assert.equal(await verifyMetaWebhookSignature(raw,
  "sha256="+validMeta.slice(7).toUpperCase(),["meta-stage-secret"]),true);
});

test("milan-api fails closed with 503 on missing Meta signing configuration",()=>{
 const source=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 assert.match(source,/\[instagram_webhook\] missing signing secret/);
 assert.match(source,/Webhook signing secret unavailable" }, 503/);
 assert.match(source,/return verifyMetaWebhookSignature\(raw,sigHeader/);
 assert.doesNotMatch(source,/if \(secrets.length === 0\) return true/);
});

// Route order of milan-api instagram_webhook (object "instagram" and "page").
const route=()=>{
 const source=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const start=source.indexOf('case "instagram_webhook": {');
 return source.slice(start,source.indexOf("default:",start));
};
test("object=page: missing/bad signature -> 401 before receipts, parsing side effects or any DB access",()=>{
 const ig=route();
 const secret=ig.indexOf('return json({ error: "Webhook signing secret unavailable" }, 503);');
 const sig=ig.indexOf("const sigOk = await verifyMetaSignature(");
 const page401=ig.indexOf('return json({ error: "Invalid webhook signature" }, 401);');
 assert.ok(secret>0&&secret<sig&&sig<page401,"missing secret 503 first, then HMAC, then the page 401");
 assert.match(ig,/if \(!sigOk\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(body\.object === "page"\) \{\n\s*console\.error\("\[instagram_webhook\] invalid page signature"\);\n\s*return json\(\{ error: "Invalid webhook signature" \}, 401\);\n\s*\}/);
 for(const later of ["recordVerifiedMetaReceipts(","extractIgMessages(entry)","normalizeMetaMessages(",
  '.from("channel_accounts")',"handleIncomingWebhookMessage("])
  assert.ok(ig.indexOf(later)>page401,later);
});
test("object=instagram keeps its behaviour: a bad signature is still ignored with 200 (no DB access)",()=>{
 const ig=route();
 const page401=ig.indexOf('return json({ error: "Invalid webhook signature" }, 401);');
 const ignored=ig.indexOf('"[instagram_webhook] invalid signature — ignored"');
 assert.ok(ignored>page401);
 assert.match(ig.slice(ignored),/^"\[instagram_webhook\] invalid signature — ignored"\n\s+\);\n\n\s+return json\(\{\n\s+received: true,\n\s+\}\);\n\s+\}/);
 assert.ok(ignored<ig.indexOf('.from("channel_accounts")'));
 // The Instagram account lookup keeps its filters (instagram or facebook
 // channel). SEC (account resolution): .limit(2) instead of maybeSingle() —
 // a lookup error or 2+ rows stop resolution (no next candidate), exactly one
 // row is the account (tests/security-account-resolution.test.ts).
 assert.match(ig,/\.eq\("external_id", candidate\)\n\s+\.in\("channel", \[\n\s+"instagram",\n\s+"facebook",\n\s+\]\)\n(\s+\/\/[^\n]*\n)*\s+\.or\("status\.is\.null,status\.neq\.disconnected"\)\n\s+\.limit\(2\);\n\n\s+if \(igLookupError \|\| \(Array\.isArray\(igAccounts\) && igAccounts\.length > 1\)\) \{\n\s+lookupFailed = true;\n\s+break;\n\s+\}\n\n\s+if \(Array\.isArray\(igAccounts\) && igAccounts\.length === 1\) \{\n\s+account = igAccounts\[0\];\n\s+break;\n\s+\}/);
 assert.doesNotMatch(ig,/\.maybeSingle\(\);\n\n\s+if \(data\) \{\n\s+account = data;/,"no maybeSingle fall-through");
});
test("object=page account: facebook channel only; several accounts for one page id -> event ignored (never assigned)",()=>{
 const ig=route();
 const page=ig.slice(ig.indexOf('if (body.object === "page") {\n                const { data: pageAccounts, error: pageLookupError }'));
 // SEC (account resolution): the page lookup error is read and fails closed
 // (lookupFailed, no next candidate) before the 2-row / 1-row checks.
 assert.match(page,/^if \(body\.object === "page"\) \{\n\s+const \{ data: pageAccounts, error: pageLookupError \} = await sb\n\s+\.from\("channel_accounts"\)\n\s+\.select\(\n[^\n]*\n\s+\)\n\s+\.eq\("external_id", candidate\)\n\s+\.eq\("channel", "facebook"\)\n(\s+\/\/[^\n]*\n)*\s+\.or\("status\.is\.null,status\.neq\.disconnected"\)\n\s+\.limit\(2\);\n\n\s+if \(pageLookupError\) \{\n\s+lookupFailed = true;\n\s+break;\n\s+\}\n\n\s+if \(Array\.isArray\(pageAccounts\) && pageAccounts\.length > 1\)/);
 assert.match(page,/if \(Array\.isArray\(pageAccounts\) && pageAccounts\.length > 1\) \{\n\s+ambiguousPage = true;\n\s+break;\n\s+\}/);
 assert.match(page,/if \(Array\.isArray\(pageAccounts\) && pageAccounts\.length === 1\) \{\n\s+account = pageAccounts\[0\];\n\s+break;\n\s+\}\n\n\s+continue;/);
 // Ignored before the account is used; the warning names no id (non-PII).
 const amb=ig.indexOf("if (ambiguousPage) {");
 assert.ok(amb>0&&amb<ig.indexOf("if (!account) {")&&amb<ig.indexOf("handleIncomingWebhookMessage("));
 // SEC: lookup error / ambiguous Instagram id -> ignored before the account is used; no id logged.
 const failed=ig.indexOf("if (lookupFailed) {");
 assert.ok(failed>0&&failed<amb);
 assert.match(ig.slice(failed),/^if \(lookupFailed\) \{\n\s+console\.warn\(\n\s+"\[instagram_webhook\] account lookup failed or ambiguous — event ignored"\n\s+\);\n\s+continue;\n\s+\}/);
 assert.match(ig.slice(amb),/^if \(ambiguousPage\) \{\n\s+console\.warn\(\n\s+"\[instagram_webhook\] page id matches several accounts — event ignored"\n\s+\);\n\s+continue;\n\s+\}/);
 // The tenant comes from the single matched account; writes are keyed by it.
 assert.match(ig,/\.eq\("tenant_id", account\.tenant_id\)\n\s+\.eq\("wa_chat_id", chatId\);/);
});
