import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {normalizeMetaMessages,flowChoiceFromPayload,MAX_NORMALIZED_MESSAGES}
 from "../supabase/functions/milan-api/normalizeMetaMessage.ts";

const wa=(value:unknown,field="messages")=>({object:"whatsapp_business_account",
 entry:[{id:"waba1",changes:[{field,value}]}]});
const meta={display_phone_number:"9647700000000",phone_number_id:"1234567890"};

test("WhatsApp text -> internal inbound shape (seconds timestamp, wamid, contact name)",()=>{
 const out=normalizeMetaMessages(wa({messaging_product:"whatsapp",metadata:meta,
  contacts:[{wa_id:"9647712345678",profile:{name:"Ali"}}],
  messages:[{from:"9647712345678",id:"wamid.A1",timestamp:"1730000000",type:"text",text:{body:"سلام"}}]}));
 assert.deepEqual(out,[{platform:"whatsapp",accountExternalId:"1234567890",senderId:"9647712345678",
  recipientId:"1234567890",text:"سلام",providerMessageId:"wamid.A1",timestampMs:1730000000000,
  choiceId:null,kind:"text",senderName:"Ali"}]);
});
test("WhatsApp interactive button_reply / list_reply / template button map flow-choice ids",()=>{
 const out=normalizeMetaMessages(wa({metadata:meta,messages:[
  {from:"111",id:"wamid.B",timestamp:"1",type:"interactive",
   interactive:{type:"button_reply",button_reply:{id:"flow-choice:prices",title:"الأسعار"}}},
  {from:"111",id:"wamid.L",timestamp:"2",type:"interactive",
   interactive:{type:"list_reply",list_reply:{id:"other-id",title:"Row",description:"d"}}},
  {from:"111",id:"wamid.T",timestamp:"3",type:"button",button:{text:"Yes",payload:"flow-choice:yes_1"}}
 ]}));
 assert.deepEqual(out.map(m=>[m.kind,m.text,m.choiceId,m.providerMessageId,m.timestampMs]),[
  ["button_reply","الأسعار","prices","wamid.B",1000],
  ["list_reply","Row",null,"wamid.L",2000],
  ["button_reply","Yes","yes_1","wamid.T",3000]
 ]);
});
test("WhatsApp statuses[] and errors[] are never customer messages",()=>{
 for(const status of ["sent","delivered","read","failed"])
  assert.deepEqual(normalizeMetaMessages(wa({metadata:meta,
   statuses:[{id:"wamid.X",status,timestamp:"1",recipient_id:"111"}]})),[]);
 assert.deepEqual(normalizeMetaMessages(wa({metadata:meta,errors:[{code:131047}]})),[]);
 // A non-"messages" field (e.g. account updates) is ignored.
 assert.deepEqual(normalizeMetaMessages(wa({metadata:meta,messages:[
  {from:"111",id:"w",timestamp:"1",type:"text",text:{body:"x"}}]},"account_update")),[]);
});
test("WhatsApp media/unsupported types are ignored, never crash",()=>{
 const types=[{type:"image",image:{id:"m"}},{type:"audio",audio:{id:"m"}},{type:"video"},
  {type:"document"},{type:"sticker"},{type:"location",location:{}},{type:"contacts"},
  {type:"reaction",reaction:{emoji:"x"}},{type:"unsupported",errors:[{code:131051}]},
  {type:"interactive",interactive:{type:"nfm_reply"}},{type:"text",text:{body:""}},
  {type:"text",text:{body:42}},{type:"text"}];
 const out=normalizeMetaMessages(wa({metadata:meta,messages:types.map((t,i)=>
  ({from:"111",id:"w"+i,timestamp:"1",...t}))}));
 assert.deepEqual(out,[]);
});
test("multiple entries, changes and messages in one POST keep order; missing ids stay null",()=>{
 const body={object:"whatsapp_business_account",entry:[
  {changes:[{field:"messages",value:{metadata:meta,messages:[
   {from:"1",id:"a",timestamp:"1",type:"text",text:{body:"one"}},
   {from:"2",timestamp:"bad",type:"text",text:{body:"two"}}]}},
   {field:"messages",value:{metadata:{phone_number_id:"99999"},messages:[
   {from:"3",id:"c",timestamp:"3",type:"text",text:{body:"three"}}]}}]},
  {changes:[{field:"messages",value:{metadata:meta,statuses:[{status:"read"}],messages:[
   {from:"4",id:"d",timestamp:"4",type:"text",text:{body:"four"}}]}}]}
 ]};
 const out=normalizeMetaMessages(body);
 assert.deepEqual(out.map(m=>[m.text,m.accountExternalId,m.providerMessageId,m.timestampMs]),[
  ["one","1234567890","a",1000],["two","1234567890",null,null],
  ["three","99999","c",3000],["four","1234567890","d",4000]]);
});
test("malformed bodies return [] and never throw",()=>{
 const hostile:unknown[]=[null,undefined,0,"x",[],{},{object:"instagram",entry:[]},
  {object:"whatsapp_business_account"},{object:"whatsapp_business_account",entry:"x"},
  {object:"whatsapp_business_account",entry:[null,1,{changes:{}},{changes:[null,{field:"messages"}]},
   {changes:[{field:"messages",value:{metadata:{phone_number_id:"abc"},messages:[{from:"1",type:"text",text:{body:"x"}}]}}]},
   {changes:[{field:"messages",value:{metadata:meta,messages:[null,"x",{from:"+1",type:"text",text:{body:"x"}},
    {from:{},type:"text",text:{body:"x"}}]}}]}]},
  {object:"page",entry:[null,{messaging:"x"},{id:{},messaging:[null,{sender:null},{message:{text:"x"}}]}]}];
 const getter={object:"page",get entry(){throw Error("boom");}};
 for(const body of [...hostile,getter])assert.deepEqual(normalizeMetaMessages(body),[]);
});
test("batch is bounded",()=>{
 const messages=Array.from({length:MAX_NORMALIZED_MESSAGES+20},(_,i)=>
  ({from:"1",id:"w"+i,timestamp:"1",type:"text",text:{body:"x"}}));
 assert.equal(normalizeMetaMessages(wa({metadata:meta,messages})).length,MAX_NORMALIZED_MESSAGES);
});

const page=(messaging:unknown[],extra:Record<string,unknown>={})=>({object:"page",
 entry:[{id:"555000",time:1730000000000,messaging,...extra}]});
const ev=(x:Record<string,unknown>)=>({sender:{id:"700001"},recipient:{id:"555000"},timestamp:1730000000123,...x});

test("Facebook text -> internal inbound shape with millisecond timestamp",()=>{
 assert.deepEqual(normalizeMetaMessages(page([ev({message:{mid:"m_1",text:"hello"}})])),[
  {platform:"facebook",accountExternalId:"555000",senderId:"700001",recipientId:"555000",text:"hello",
   providerMessageId:"m_1",timestampMs:1730000000123,choiceId:null,kind:"text",senderName:null}]);
});
test("Facebook quick_reply and postback carry the flow-choice id",()=>{
 const out=normalizeMetaMessages(page([
  ev({message:{mid:"m_q",text:"الأسعار",quick_reply:{payload:"flow-choice:prices"}}}),
  ev({message:{mid:"m_q2",text:"x",quick_reply:{payload:"OTHER"}}}),
  ev({postback:{mid:"m_p",title:"Start",payload:"flow-choice:start"}}),
  ev({postback:{payload:"flow-choice:start"}})
 ]));
 assert.deepEqual(out.map(m=>[m.kind,m.text,m.choiceId,m.providerMessageId]),[
  ["quick_reply","الأسعار","prices","m_q"],["quick_reply","x",null,"m_q2"],
  ["postback","Start","start","m_p"]]);
});
test("Facebook echo, delivery, read, reactions, handover, standby and attachments are ignored",()=>{
 const ignored=[
  ev({message:{mid:"e",text:"echo",is_echo:true}}),
  ev({delivery:{mids:["m"],watermark:1}}),ev({read:{watermark:1}}),
  ev({reaction:{mid:"m",action:"react",emoji:"x"}}),
  ev({pass_thread_control:{new_owner_app_id:"1"}}),ev({take_thread_control:{}}),
  ev({request_thread_control:{}}),ev({referral:{ref:"x"}}),ev({optin:{ref:"x"}}),
  ev({message:{mid:"a",attachments:[{type:"image"}]}}),
  {sender:{id:"555000"},recipient:{id:"555000"},message:{mid:"self",text:"self"}}
 ];
 assert.deepEqual(normalizeMetaMessages(page(ignored)),[]);
 assert.deepEqual(normalizeMetaMessages(page([],{standby:[ev({message:{mid:"s",text:"standby"}})]})),[]);
});
test("flowChoiceFromPayload matches the Instagram selectedFlowChoice rule",()=>{
 assert.equal(flowChoiceFromPayload("flow-choice:a_b-1"),"a_b-1");
 for(const bad of ["flow-choice:","flow-choice:a b","choice:a","flow-choice:"+"a".repeat(129),null,1])
  assert.equal(flowChoiceFromPayload(bad),null);
});
test("normalizer is pure: no env, Deno or network APIs",()=>{
 const src=readFileSync("supabase/functions/milan-api/normalizeMetaMessage.ts","utf8");
 assert.doesNotMatch(src,/Deno\.|fetch\(|process\.env|import /);
});
