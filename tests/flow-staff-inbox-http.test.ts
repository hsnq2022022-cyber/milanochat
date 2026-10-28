import {assertEquals,assert} from "jsr:@std/assert@1";
import {handleStaffInbox} from "../supabase/functions/flow-staff-inbox/index.ts";
import type {createClient} from "npm:@supabase/supabase-js@2";
const tenantA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ownerA="99999999-9999-4999-8999-999999999999";
const agentA="77777777-7777-4777-8777-777777777777";
const actorB="88888888-8888-4888-8888-888888888888";
const rows={
 tenants:[{id:tenantA,user_id:ownerA},{id:tenantB,user_id:actorB}],
 tenant_staff_memberships:[{tenant_id:tenantA,user_id:agentA,role:"agent",status:"active"}],
 flow_staff_notifications:[{tenant_id:tenantA,recipient_user_id:agentA,
  outbox_id:"outbox1",conversation_id:"convA",body:"متابعة الطلب",status:"queued",
  created_at:"2026-10-28T17:00:00Z"}]
};
function query(table:keyof typeof rows){
 const conditions=new Map<string,unknown>();
 const run=()=>rows[table].filter(row=>[...conditions].every(([k,v])=>
  (row as unknown as Record<string,unknown>)[k]===v));
 const q={
  select:()=>q,eq:(key:string,value:unknown)=>{conditions.set(key,value);return q;},
  order:()=>q,limit:async()=>({data:run(),error:null}),
  maybeSingle:async()=>({data:run()[0]??null,error:null})
 };
 return q;
}
const factory=((_url:string,_service:string,_opts:unknown)=>({
 auth:{getUser:async(token:string)=>{
  const id=token==="jwt-a"?agentA:token==="jwt-owner"?ownerA:
   token==="jwt-b"?actorB:null;
  return {data:{user:id?{id}:null},error:id?null:{message:"invalid"}};
 }},
 from:query
})) as unknown as typeof createClient;
function request(token:string|null,tenant:string,origin="https://hsnq2022022-cyber.github.io"){
 return new Request("http://localhost/functions/v1/flow-staff-inbox",{
  method:"POST",headers:{
   origin,"content-type":"application/json",
   ...(token?{authorization:"Bearer "+token}:{})
  },body:JSON.stringify({tenantId:tenant})});
}
Deno.test("staff inbox is OFF unless specifically gated",async()=>{
 Deno.env.set("SUPABASE_URL","https://example.supabase.co");
 Deno.env.set("SUPABASE_SERVICE_ROLE_KEY","test-not-production");
 Deno.env.delete("FLOW_STAFF_INBOX_ENABLED");
 assertEquals((await handleStaffInbox(request("jwt-a",tenantA),factory)).status,423);
});
Deno.test("origin, JWT, membership, suspension and tenant isolation",async()=>{
 Deno.env.set("FLOW_STAFF_INBOX_ENABLED","true");
 try{
  assertEquals((await handleStaffInbox(request("jwt-a",tenantA,"https://evil.test"),factory)).status,403);
  assertEquals((await handleStaffInbox(request(null,tenantA),factory)).status,401);
  assertEquals((await handleStaffInbox(request("expired",tenantA),factory)).status,401);
  assertEquals((await handleStaffInbox(request("jwt-a",tenantB),factory)).status,403);
  const accepted=await handleStaffInbox(request("jwt-a",tenantA),factory);
  assertEquals(accepted.status,200);
  const body=await accepted.json();
  assertEquals(body.items.length,1);
  assertEquals(body.items[0].body,"متابعة الطلب");
  assert(!JSON.stringify(body).includes("test-not-production"));
  rows.tenant_staff_memberships[0].status="suspended";
  assertEquals((await handleStaffInbox(request("jwt-a",tenantA),factory)).status,403);
  assertEquals((await handleStaffInbox(request("jwt-owner",tenantA),factory)).status,200);
 }finally{Deno.env.delete("FLOW_STAFF_INBOX_ENABLED");}
});
