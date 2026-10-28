import {test} from "node:test";
import assert from "node:assert/strict";
import {metaQuickReplies,messengerWebsiteButtons,metaSelectedQuickReply}
 from "../supabase/functions/flow-outbox-worker/flowRichActions.ts";
import {sendProviderMessage}
 from "../supabase/functions/flow-outbox-worker/deliveryCore.ts";
import {extractMetaDeliveryReceipts,recordVerifiedMetaReceipts}
 from "../supabase/functions/milan-api/metaDeliveryReceipts.ts";

test("quick replies: stable option ids, title limit and <=13 choices",()=>{
 const opts=[{id:"go_1",label:"الأسعار"},{id:"go_2",label:"موظف"}];
 assert.deepEqual(metaQuickReplies(opts,"instagram"),[
  {content_type:"text",title:"الأسعار",payload:"flow-choice:go_1"},
  {content_type:"text",title:"موظف",payload:"flow-choice:go_2"}
 ]);
 assert.throws(()=>metaQuickReplies(Array.from({length:14},(_,i)=>({
  id:"x"+i,label:"Hi"})),"instagram"),/1 to 13/);
 assert.throws(()=>metaQuickReplies([{id:"x",label:"x".repeat(21)}],"facebook"),/Invalid/);
 assert.throws(()=>metaQuickReplies([{id:"x",label:"a"},{id:"x",label:"b"}],"facebook"),/Invalid/);
 assert.throws(()=>metaQuickReplies(opts,"whatsapp"),/Unsupported/);
});
test("Messenger website buttons require HTTPS and reject credentials",()=>{
 assert.equal(messengerWebsiteButtons("Choose",[{label:"موقعنا",url:"https://example.com/p"}])
  .attachment.payload.elements[0].buttons[0].type,"web_url");
 assert.throws(()=>messengerWebsiteButtons("Choose",[{label:"site",url:"http://example.com"}]),/not allowed/);
 assert.throws(()=>messengerWebsiteButtons("Choose",[{label:"site",url:"https://user:pass@example.com"}]),/not allowed/);
 assert.throws(()=>messengerWebsiteButtons("a".repeat(81),[{label:"site",url:"https://example.com"}]),/Invalid/);
});
test("webhook selected quick reply is only candidate until HMAC and run validation",()=>{
 assert.equal(metaSelectedQuickReply({quick_reply:{payload:"flow-choice:go_1"}}),"go_1");
 assert.equal(metaSelectedQuickReply({quick_reply:{payload:"https://evil.test"}}),null);
 assert.equal(metaSelectedQuickReply({quick_reply:{payload:"flow-choice:<script>"}}),null);
 assert.equal(metaSelectedQuickReply(null),null);
});
test("provider sends valid Meta quick reply but never WhatsApp fake buttons",async()=>{
 let calls=0;
 const fake=(async(url:string,init:RequestInit)=>{
  calls++;
  const body=JSON.parse(String(init.body));
  assert.equal(url,"https://graph.instagram.com/v21.0/me/messages");
  assert.equal(body.message.quick_replies.length,2);
  assert.equal(body.message.quick_replies[0].payload,"flow-choice:go_1");
  return new Response(JSON.stringify({message_id:"mid_test"}),{status:200});
 }) as typeof fetch;
 assert.equal(await sendProviderMessage({platform:"instagram",token:"IGexample",
  externalId:"",recipient:"123456",text:"Pick one",
  quickReplies:[{id:"go_1",label:"yes"},{id:"go_2",label:"no"}]},fake),"mid_test");
 await assert.rejects(()=>sendProviderMessage({platform:"whatsapp",
  token:"example",externalId:"123456",recipient:"96477123456",text:"Hello",
  quickReplies:[{id:"go",label:"yes"}]},fake),/require separately approved/);
 assert.equal(calls,1);
});
test("signed Meta candidate parser ignores watermark, echo, malformed and duplicates",()=>{
 const entry={object:"page",entry:[{id:"my-page",messaging:[
  {sender:{id:"100"},delivery:{mids:["mid-1","mid-1"]}},
  {read:{watermark:1234}},
  {read:{mids:["mid-1"]}},
  {message:{mid:"incoming"}}]}]};
 assert.deepEqual(extractMetaDeliveryReceipts(entry),[
  {accountExternalId:"my-page",platform:"facebook",providerMessageId:"mid-1",status:"delivered"},
  {accountExternalId:"my-page",platform:"facebook",providerMessageId:"mid-1",status:"read"}
 ]);
 assert.deepEqual(extractMetaDeliveryReceipts({...entry,object:"unknown"}),[]);
});
test("verified receipt RPC resolves account only from server lookup; never body tenantId",async()=>{
 const calls:Array<{name:string;args:Record<string,unknown>}>=[];
 const db={
  from:(_table:string)=>{
   const q={
    select:()=>q,
    eq:()=>q,
    limit:async()=>({data:[{id:"account-A",tenant_id:"tenant-A",platform:"instagram"}],error:null})
   };return q;
  },
  rpc:async(name:string,args:Record<string,unknown>)=>{
   calls.push({name,args});return {data:true,error:null};
  }
 };
 const data={object:"instagram",tenant_id:"tenant-B",entry:[{id:"instaA",
  messaging:[{delivery:{mids:["mid-001"]}}]}]};
 assert.equal(await recordVerifiedMetaReceipts(db,data),1);
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0],{name:"flow_record_meta_delivery",args:{
  p_tenant:"tenant-A",p_account:"account-A",p_platform:"instagram",
  p_provider_message_id:"mid-001",p_status:"delivered"}});
});
test("ambiguous Meta account mapping refuses receipt",async()=>{
 let called=false;
 const db={
  from:()=>{const q={
   select:()=>q,eq:()=>q,
   limit:async()=>({data:[{id:"x"},{id:"y"}],error:null})
  };return q;},
  rpc:async()=>{called=true;return {data:true,error:null};}
 };
 assert.equal(await recordVerifiedMetaReceipts(db,{object:"page",entry:[{
  id:"page",messaging:[{delivery:{mids:["mid"]}}]}]}),0);
 assert.equal(called,false);
});
