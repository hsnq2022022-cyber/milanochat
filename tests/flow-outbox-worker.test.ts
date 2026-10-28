import {test} from "node:test";
import assert from "node:assert/strict";
import {executeOnce} from "../supabase/functions/flow-outbox-worker/executeOnce.ts";
import {sendProviderMessage,encryptMessageBody,decryptAccountToken} from
 "../supabase/functions/flow-outbox-worker/deliveryCore.ts";
import {answerWithVerifiedKnowledge} from
 "../supabase/functions/flow-outbox-worker/flowKnowledge.ts";

function deps(settings:{reserve?:boolean;throwSend?:boolean;confirm?:boolean;charge?:boolean}={}){
 let sent=0;const events:string[]=[];
 return {get:()=>({sent,events}),args:{
  reserve:async()=>{events.push("reserve");return settings.reserve!==false;},
  send:async()=>{sent++;events.push("send");if(settings.throwSend)throw Error("timeout");return "mid-123";},
  confirm:async(status:string,id:string|null)=>{events.push(status+":"+id);return settings.confirm!==false;},
  persistAndBill:async()=>{events.push("bill");return settings.charge!==false;}
 }};
}
test("duplicate reservation cannot call provider",async()=>{
 const d=deps({reserve:false});
 assert.equal(await executeOnce(d.args),"not_reserved");
 assert.deepEqual(d.get(),{sent:0,events:["reserve"]});
});
test("2xx confirmation followed by one bill and settlement",async()=>{
 const d=deps();
 assert.equal(await executeOnce(d.args),"settled");
 assert.deepEqual(d.get(),{sent:1,events:["reserve","send","confirmed:mid-123","bill"]});
});
test("timeout is uncertain, no retry, no debit",async()=>{
 const d=deps({throwSend:true});
 assert.equal(await executeOnce(d.args),"uncertain");
 assert.deepEqual(d.get(),{sent:1,events:["reserve","send","uncertain:null"]});
});
test("ambiguous DB confirmation and billing problems never re-send",async()=>{
 const d=deps({confirm:false});
 assert.equal(await executeOnce(d.args),"sent_unconfirmed");
 assert.equal(d.get().sent,1);assert(!d.get().events.includes("bill"));
 const b=deps({charge:false});
 assert.equal(await executeOnce(b.args),"billing_pending");
 assert.equal(b.get().sent,1);
});
test("provider routing validates 2xx and captures Meta message ID",async()=>{
 const calls:unknown[]=[];
 const fake=(async(url:string,init:RequestInit)=>{
  calls.push({url,headers:init.headers,body:JSON.parse(String(init.body))});
  return new Response(JSON.stringify({message_id:"mid-test"}),{status:200});
 }) as typeof fetch;
 const id=await sendProviderMessage({
  platform:"instagram",token:"IG-token",recipient:"123456",externalId:"",text:"اهلا"
 },fake);
 assert.equal(id,"mid-test");
 assert.equal((calls[0] as {url:string}).url,"https://graph.instagram.com/v21.0/me/messages");
 assert.equal(calls.length,1);
 await assert.rejects(()=>sendProviderMessage({
  platform:"facebook",token:"abc",recipient:"not-id",externalId:"",text:"hello"
 },fake),/Invalid provider/);
 assert.equal(calls.length,1);
});
test("WhatsApp provider uses its Cloud API endpoint and returns wamid",async()=>{
 const fake=(async(url:string,init:RequestInit)=>{
  assert.equal(url,"https://graph.facebook.com/v21.0/100001/messages");
  const body=JSON.parse(String(init.body));
  assert.equal(body.messaging_product,"whatsapp");
  assert.equal(body.to,"9647712345678");
  return new Response(JSON.stringify({messages:[{id:"wamid.test"}]}),{status:200});
 }) as typeof fetch;
 assert.equal(await sendProviderMessage({
  platform:"whatsapp",token:"wa",externalId:"100001",recipient:"9647712345678",text:"مرحبا"
 },fake),"wamid.test");
});
test("field encryption round-trip matches v101 enc:v1 representation",async()=>{
 const encrypted=await encryptMessageBody("مرحبا","test-secret");
 assert.match(encrypted,/^enc:v1:/);
 assert.equal(await decryptAccountToken(encrypted,"test-secret"),"مرحبا");
});
const rowId="77777777-7777-4777-8777-777777777771";
function knowledgeClient(tenant="A",content="Price is 1000 IQD for the item."){
 return {
  rpc:async(name:string,args:Record<string,unknown>)=>{
   assert.equal(name,"match_knowledge");
   assert.equal(args.p_tenant_id,"A");
   return {data:[{id:rowId,content,similarity:0.9}],error:null};
  },
  from:(table:string)=>{
   assert.equal(table,"knowledge_chunks");
   const q={
    select:()=>q,eq:(_field:string,id:string)=>{assert.equal(id,"A");return q;},
    in:()=>q,
    limit:async()=>({data:[{id:rowId,tenant_id:tenant,content}],error:null})
   };return q;
  }
 };
}
const scope={tenantId:"A",publishedTenantId:"A",conversationTenantId:"A",
 agentEnabled:true,humanTakeover:false,credits:5,businessName:"Test"};
const options={
 embed:async()=>[0.2,0.5],
 complete:async()=>({answer:"Price is 1000 IQD",grounded:true,
  supporting_quote:"Price is 1000 IQD for the item."})
};
test("RAG returns evidence-quoted answer ONLY for same tenant",async()=>{
 assert.equal(await answerWithVerifiedKnowledge(knowledgeClient() as never,
  scope,"How much?",options),"Price is 1000 IQD");
 assert.equal(await answerWithVerifiedKnowledge(knowledgeClient("B") as never,
  scope,"How much?",options),null);
 assert.equal(await answerWithVerifiedKnowledge(knowledgeClient() as never,
  {...scope,conversationTenantId:"B"},"How much?",options),null);
});
test("RAG rejects ungrounded text, fake quotes, no credit and manual takeover",async()=>{
 assert.equal(await answerWithVerifiedKnowledge(knowledgeClient() as never,
  scope,"How much?",{...options,complete:async()=>({
   answer:"invented",grounded:true,supporting_quote:"This quote is made up."
  })}),null);
 assert.equal(await answerWithVerifiedKnowledge(knowledgeClient() as never,
  {...scope,credits:0},"How much?",options),null);
 assert.equal(await answerWithVerifiedKnowledge(knowledgeClient() as never,
  {...scope,humanTakeover:true},"How much?",options),null);
});
