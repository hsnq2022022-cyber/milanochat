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

Deno.test("Signed Paid event remains unacknowledged pending verified Wayl status",async()=>{
 const secret="unit-test-merchant-webhook-secret-123456";
 const text=JSON.stringify({referenceId:"11111111-1111-4111-8111-111111111111",
  total:35000,paymentStatus:"Paid"});
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),
  {name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const signature=[...new Uint8Array(await crypto.subtle.sign("HMAC",key,
  new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,"0")).join("");
 const keys=["PAYMENTS_ENABLED","WAYL_TOPUP_WEBHOOK_ENABLED",
  "WAYL_WEBHOOK_SECRET","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY"] as const;
 const prior=Object.fromEntries(keys.map(k=>[k,Deno.env.get(k)]));
 try{
  Deno.env.set("PAYMENTS_ENABLED","true");
  Deno.env.set("WAYL_TOPUP_WEBHOOK_ENABLED","true");
  Deno.env.set("WAYL_WEBHOOK_SECRET",secret);
  Deno.env.set("SUPABASE_URL","https://example.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY","disposable-test-only");
  const response=await handle(new Request("https://example.com/wayl-topup-webhook",{
   method:"POST",body:text,headers:{"x-wayl-signature-256":signature}
  }));
  assertEquals(response.status,503);
  assertEquals(await response.text(),"signed paid status requires provider verification");
 }finally{
  for(const k of keys){
   const value=prior[k];if(value===undefined)Deno.env.delete(k);
   else Deno.env.set(k,value);
  }
 }
});
