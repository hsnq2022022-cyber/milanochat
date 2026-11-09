import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {verifyMetaWebhookSignature} from "../supabase/functions/milan-api/metaSignature.ts";

const raw='{"object":"whatsapp_business_account","entry":[{"id":"waba1","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"123"},"messages":[{"id":"wamid.1","from":"96477","type":"text","text":{"body":"سلام"}}]}}]}]}';
const header="sha256=7dbb1121761ed4c6c5a9d74feaa59682fa0b98209abd556e3be65b1d67a0cecb";

test("WhatsApp signed raw UTF-8 payload matches independent HMAC vector",async()=>{
 assert.equal(await verifyMetaWebhookSignature(raw,header,["whatsapp-test-secret"]),true);
 assert.equal(await verifyMetaWebhookSignature(raw,header,["wrong-secret","whatsapp-test-secret"]),true);
});
test("missing secret, missing signature and message/body changes fail closed",async()=>{
 for(const secrets of [[],[""],[" "]]){
  assert.equal(await verifyMetaWebhookSignature(raw,header,secrets),false);
 }
 for(const data of [raw+" ",raw.replace("سلام","تحية"),raw.replace("wamid.1","wamid.2")]){
  assert.equal(await verifyMetaWebhookSignature(data,header,["whatsapp-test-secret"]),false);
 }
 assert.equal(await verifyMetaWebhookSignature(raw,"",["whatsapp-test-secret"]),false);
});
test("WhatsApp POST checks signature BEFORE enumerating message events",()=>{
 const source=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const start=source.indexOf('case "whatsapp_webhook": {');
 const finish=source.indexOf('case "instagram_webhook": {',start);
 assert.ok(start>=0&&finish>start);
 const route=source.slice(start,finish);
 const sig=route.indexOf("const whatsappSignatureValid = await verifyMetaWebhookSignature(");
 const processing=route.indexOf("for (const entry of body.entry");
 assert.ok(sig>=0&&processing>sig,"signature must precede customer processing");
 assert.match(route,/WhatsApp signing secret unavailable" }, 503/);
 assert.match(route,/Invalid WhatsApp signature" }, 401/);
 assert.match(route,/env\("WHATSAPP_APP_SECRET"\)/);
 assert.match(route,/env\("META_APP_SECRET"\)/);
});
test("WhatsApp: interactive replies reach the durable path only with FLOW_MULTICHANNEL_ENABLED and the canary account",()=>{
 const source=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const route=source.slice(source.indexOf('case "whatsapp_webhook": {'),source.indexOf('case "instagram_webhook": {'));
 const sig=route.indexOf("const whatsappSignatureValid = await verifyMetaWebhookSignature(");
 const parse=route.indexOf("normalizeMetaMessages(");
 assert.ok(sig>0&&parse>sig,"normalizer only after the signature");
 assert.ok(route.indexOf('.from("wa_bindings")')<parse,"and after the account is resolved");
 assert.match(route,/multichannelEnabled\(\) &&\n\s+typeof account\.id === "string" &&\n\s+account\.id === env\("FLOW_DURABLE_CANARY_ACCOUNT_ID"\)\n\s+\? new Map\(/);
 // Flag OFF: durableReplies is null, so text, arguments and skips are exactly as before.
 assert.match(route,/durableReply && !text \? durableReply\.text : text,/);
});
