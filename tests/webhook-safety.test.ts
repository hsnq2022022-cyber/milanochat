import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import {
  classifyInboundInsert, verifyWebhookHmac,
} from "../supabase/functions/_shared/webhook-safety.ts";

async function sign(secret: string, raw: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await webcrypto.subtle.importKey(
    "raw", encoder.encode(secret), {name:"HMAC", hash:"SHA-256"}, false, ["sign"],
  );
  const bytes = new Uint8Array(
    await webcrypto.subtle.sign("HMAC", key, encoder.encode(raw)),
  );
  return "sha256=" + Array.from(bytes, byte => byte.toString(16).padStart(2,"0")).join("");
}

test("Meta SHA256 signature validation accepts signed exact raw body only", async () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';
  const secret = "test-secret-only";
  const signature = await sign(secret,body);
  assert.equal(await verifyWebhookHmac(body,signature,[secret]),true);
  assert.equal(await verifyWebhookHmac(body+" ",signature,[secret]),false);
  assert.equal(await verifyWebhookHmac(body,signature,["wrong-secret"]),false);
  assert.equal(await verifyWebhookHmac(body,signature,[]),false);
  assert.equal(await verifyWebhookHmac(body,"", [secret]),false);
  assert.equal(await verifyWebhookHmac(body,"sha256="+"z".repeat(64),[secret]),false);
  assert.equal(await verifyWebhookHmac(body,signature.toUpperCase().replace("SHA256=","sha256="),[secret]),true);
});

test("Supabase result.error controls whether automatic replies can start", () => {
  const id="mid-test-123";
  assert.equal(classifyInboundInsert(id,{error:null}),"accepted");
  assert.equal(classifyInboundInsert(id,{error:{code:"23505"}}),"duplicate");
  assert.equal(classifyInboundInsert(id,{error:{code:"42501"}}),"rejected");
  assert.equal(classifyInboundInsert(id,{error:{code:"PGRST205"}}),"rejected");
  assert.equal(classifyInboundInsert(null,{error:null}),"missing_event_id");
  assert.equal(classifyInboundInsert(" ",{error:null}),"missing_event_id");
  assert.equal(classifyInboundInsert("x".repeat(257),{error:null}),"missing_event_id");
});

test("both live Meta webhook handlers are wired to signature checks, and fallback IDs are forbidden", () => {
  const source = readFileSync("supabase/functions/milan-api/index.ts","utf8");
  const waCase = source.split('case "whatsapp_webhook":')[1]?.split('case "instagram_webhook":')[0] ?? "";
  const igCase = source.split('case "instagram_webhook":')[1] ?? "";
  assert.match(waCase,/verifyMetaSignature\([\s\S]*?"whatsapp"/);
  assert.match(igCase,/verifyMetaSignature\([\s\S]*?"instagram"/);
  assert.match(waCase,/invalid\/missing signature/);
  assert.match(igCase,/invalid signature/);
  assert.doesNotMatch(igCase,/ig_\$\{Date\.now\(\)\}/);
  const incoming = source.split("async function handleIncomingWebhookMessage(")[1]?.split("/* ═")[0] ?? "";
  assert.match(incoming,/classifyInboundInsert\(externalMsgId, insertion\)/);
  assert.match(incoming,/if \(decision !== "accepted"\)/);
});
