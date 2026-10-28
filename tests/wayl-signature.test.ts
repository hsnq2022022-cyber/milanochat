import {assertEquals} from "jsr:@std/assert@1";
import {verifyWaylSignature,handle} from "../supabase/functions/wayl-topup-webhook/index.ts";
const raw=JSON.stringify({referenceId:"11111111-1111-4111-8111-111111111111",
 total:35000,paymentStatus:"Complete"});
Deno.test("Wayl signed raw payload rejects tampering and malformed signature",async()=>{
 const secret="unit-test-merchant-webhook-secret-123456";
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),
  {name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const sig=[...new Uint8Array(await crypto.subtle.sign("HMAC",key,
  new TextEncoder().encode(raw)))].map(x=>x.toString(16).padStart(2,"0")).join("");
 assertEquals(await verifyWaylSignature(raw,sig,secret),true);
 assertEquals(await verifyWaylSignature(raw,"sha256="+sig,secret),true);
 assertEquals(await verifyWaylSignature(raw+" ",sig,secret),false);
 assertEquals(await verifyWaylSignature(raw,sig.slice(1),secret),false);
 assertEquals(await verifyWaylSignature(raw,sig,"short"),false);
});
Deno.test("Webhook disabled rejects even signed request before any database or credit access",async()=>{
 Deno.env.delete("PAYMENTS_ENABLED");
 Deno.env.delete("WAYL_TOPUP_WEBHOOK_ENABLED");
 const r=await handle(new Request("https://example.com/wayl-topup-webhook",{
  method:"POST",body:raw,headers:{"x-wayl-signature-256":"invalid"}
 }));
 assertEquals(r.status,503);
});
