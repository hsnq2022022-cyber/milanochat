import {test} from "node:test";
import assert from "node:assert/strict";
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
