import {assertEquals} from "jsr:@std/assert@1";
import {handle} from "../supabase/functions/flow-delivery-review/index.ts";
Deno.test("delivery review blocks unapproved origin before checking credentials",async()=>{
 const res=await handle(new Request("https://example.supabase.co/functions/v1/flow-delivery-review",{
  method:"POST",headers:{origin:"https://evil.example"},
  body:JSON.stringify({tenantId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",mode:"queue"})
 }));
 assertEquals(res.status,403);
});
Deno.test("delivery review is OFF and never accesses DB without activation",async()=>{
 const previous=Deno.env.get("FLOW_DELIVERY_REVIEW_ENABLED");
 Deno.env.set("FLOW_DELIVERY_REVIEW_ENABLED","false");
 const res=await handle(new Request("https://example.supabase.co/functions/v1/flow-delivery-review",{
  method:"POST",headers:{origin:"https://hsnq2022022-cyber.github.io",
   authorization:"Bearer fake"},
  body:JSON.stringify({tenantId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",mode:"metrics"})
 }));
 assertEquals(res.status,423);
 if(previous===undefined)Deno.env.delete("FLOW_DELIVERY_REVIEW_ENABLED");
 else Deno.env.set("FLOW_DELIVERY_REVIEW_ENABLED",previous);
});


Deno.test("review safely rejects over-limit and malformed requests before hitting Auth",async()=>{
 const keys=["FLOW_DELIVERY_REVIEW_ENABLED","SUPABASE_SERVICE_ROLE_KEY","SUPABASE_URL"];
 const prev=Object.fromEntries(keys.map(k=>[k,Deno.env.get(k)]));
 try{
  Deno.env.delete("FLOW_DELIVERY_REVIEW_ENABLED");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY","test-only");
  Deno.env.set("SUPABASE_URL","https://example.supabase.co");
  const url="https://example.supabase.co/functions/v1/flow-delivery-review";
  const headers={origin:"https://hsnq2022022-cyber.github.io",authorization:"Bearer fake"};
  const oversized=await handle(new Request(url,{method:"POST",headers,body:"x".repeat(1025)}));
  assertEquals(oversized.status,413);
  const invalid=await handle(new Request(url,{method:"POST",headers,
   body:new Uint8Array([0xc3,0x28])}));
  assertEquals(invalid.status,400);
 }finally{
  for(const key of keys){
   const old=prev[key];
   if(old===undefined)Deno.env.delete(key);
   else Deno.env.set(key,old);
  }
 }
});
