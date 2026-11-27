// Facebook / Instagram / WhatsApp webhook batches: a correctly SIGNED payload with an unexpected structure must never
// abort the batch (an uncaught TypeError became HTTP 500 and Meta redelivered the same batch forever, while every valid
// event after the bad element was never processed). The REAL batch loops are sliced out of
// supabase/functions/milan-api/index.ts and run against in-memory fakes (no Deno, network or database).
// Run: node --experimental-strip-types --test tests/webhook-malformed-batches.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import {bindingIsVerified,provenWhatsappAccount} from "../supabase/functions/milan-api/waBinding.ts";
import {runBatchEvent,webhookStatusFor} from "../supabase/functions/milan-api/inboundRoutingRetry.ts";
import {createStageTimer} from "../supabase/functions/milan-api/webhookTimings.ts";
import {runBackgroundJobs} from "../supabase/functions/milan-api/backgroundWork.ts";

const IDX=readFileSync("supabase/functions/milan-api/index.ts","utf8");
const END_MARK="        return json({\n          received: true,\n        });\n";
function slice(caseLabel){
 const c=IDX.indexOf(caseLabel);
 const a=IDX.indexOf("        // Per-event outcomes: any \"retry\"",c);
 const b=IDX.indexOf(END_MARK,a);
 assert.ok(c>0&&a>c&&b>a,caseLabel+" loop located");
 return IDX.slice(a,b+END_MARK.length);
}
const waLoop=new Function(stripTypeScriptTypes("async function __wa(body,sb,bindingIsVerified,handleIncomingWebhookMessage,multichannelEnabled,env,"+
 "normalizeMetaMessages,json,console,retryableEvent,webhookStatusFor,runBatchEvent,provenWhatsappAccount,recoveryLeaseActive){\n"+
 slice('case "whatsapp_webhook": {')+"}\n",{mode:"strip"})+"\nreturn __wa;")();
const igLoopRaw=new Function(stripTypeScriptTypes("async function __ig(body,sb,extractIgMessages,multichannelEnabled,normalizeMetaMessages,env,syntheticEventId,"+
 "retryableEvent,recoveryLeaseActive,runBatchEvent,handleIncomingWebhookMessage,decryptAccessTokenStrict,fetchSenderProfile,"+
 "commentAutomationEnabled,ingestSignedComments,encryptField,webhookStatusFor,json,console,timer,endTotal,runBackgroundJobs){\n"+
 slice('case "instagram_webhook": {')+"}\n",{mode:"strip"})+"\nreturn __ig;")();
const igLoop=(...a)=>igLoopRaw(...a,createStageTimer(),()=>{},runBackgroundJobs);
// The real extractIgMessages (needs selectedFlowChoice only for quick-reply payloads).
const exStart=IDX.indexOf("function extractIgMessages(entry: any)");
const exEnd=IDX.indexOf("\n}\n",exStart)+3;
const extractIgMessages=new Function("selectedFlowChoice",stripTypeScriptTypes(IDX.slice(exStart,exEnd),{mode:"strip"})+"\nreturn extractIgMessages;")(()=>null);

const T1="11111111-1111-4111-8111-111111111111",T2="22222222-2222-4222-8222-222222222222";
const ACC1="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",ACC2="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
function fakeDb(tables={}){
 const calls=[];
 return {calls,from(table){
  const f=[];
  const rows=()=>(tables[table]??[]).filter(r=>f.every(([k,v])=>r[k]===v));
  const q={select:()=>q,update:()=>q,in:()=>q,or:()=>q,neq:()=>q,eq:(k,v)=>{f.push([k,v]);return q;},
   maybeSingle:async()=>{calls.push(table);return {data:rows()[0]??null,error:null};},
   limit:async(n)=>{calls.push(table);return {data:rows().slice(0,n),error:null};},
   then:(ok,ko)=>Promise.resolve({data:null,error:null}).then(ok,ko)};
  return q;
 }};
}
const cons=()=>({log(){},info(){},warn(){},error(){}});
const json=(b,s=200)=>({json:b,status:s});

/* ───────── WhatsApp ───────── */
const waDb=(extra={})=>fakeDb({wa_bindings:[{phone_id:"1000001",tenant_id:T1,is_verified:true},{phone_id:"2000002",tenant_id:T2,is_verified:true}],
 channel_accounts:[{id:ACC1,tenant_id:T1,channel:"whatsapp",external_id:"1000001",status:"active"},{id:ACC2,tenant_id:T2,channel:"whatsapp",external_id:"2000002",status:"active"}],...extra});
const waChange=(phone,messages,extra={})=>({field:"messages",value:{metadata:{phone_number_id:phone},contacts:[],messages,...extra}});
const txt=(id,from,body)=>({id,from,type:"text",text:{body}});
async function runWa(body,db,handler){
 const handled=[];
 const res=await waLoop(body,db,bindingIsVerified,async(_sb,account,chatId,text,msgId)=>{handled.push({tenant:account.tenant_id,msgId});return handler?handler(msgId):undefined;},
  ()=>false,()=>"",()=>[],json,cons(),async()=>null,webhookStatusFor,runBatchEvent,provenWhatsappAccount,async()=>false);
 return {res,handled};
}
const GOOD_WA=waChange("1000001",[txt("wamid.OK","9647000000009","ok")]);
const WA_MALFORMED={
 "entry is an object":{object:"whatsapp_business_account",entry:{changes:[GOOD_WA]}},
 "entry is a string":{object:"whatsapp_business_account",entry:"abc"},
 "entry null / number then valid":{object:"whatsapp_business_account",entry:[null,5,{changes:[GOOD_WA]}]},
 "changes is an object":{object:"whatsapp_business_account",entry:[{changes:{a:1}},{changes:[GOOD_WA]}]},
 "change null / string then valid":{object:"whatsapp_business_account",entry:[{changes:[null,"x",GOOD_WA]}]},
 "messages is an object":{object:"whatsapp_business_account",entry:[{changes:[waChange("1000001",{a:1}),GOOD_WA]}]},
 "contacts is an object":{object:"whatsapp_business_account",entry:[{changes:[waChange("1000001",[txt("wamid.C1","9647000000001","x")],{contacts:{a:1}}),GOOD_WA]}]},
 "contacts has a null element":{object:"whatsapp_business_account",entry:[{changes:[waChange("1000001",[txt("wamid.C2","9647000000001","x")],{contacts:[null]}),GOOD_WA]}]},
 "null message then valid":{object:"whatsapp_business_account",entry:[{changes:[waChange("1000001",[null,txt("wamid.M","9647000000002","m")]),GOOD_WA]}]},
 "status-only (delivery / read / failed) change":{object:"whatsapp_business_account",entry:[{changes:[{field:"messages",value:{metadata:{phone_number_id:"1000001"},statuses:[{id:"x",status:"read"},{id:"y",status:"failed",errors:[{code:131047}]}]}},GOOD_WA]}]},
};
for(const [name,body] of Object.entries(WA_MALFORMED)){
 test("WhatsApp: "+name+" never aborts the batch; the valid event is still processed and acknowledged",async()=>{
  const {res,handled}=await runWa(body,waDb());
  assert.equal(res.status??200,200);
  assert.deepEqual(res.json,{received:true});
  if(!/entry is an object|entry is a string/.test(name))assert.ok(handled.some(h=>h.msgId==="wamid.OK"),"valid event processed");
 });
}
test("WhatsApp: structurally empty batches (entry missing / not an array) are acknowledged without work",async()=>{
 for(const entry of [undefined,null,{},"x",7,true]){
  const {res,handled}=await runWa({object:"whatsapp_business_account",entry},waDb());
  assert.deepEqual(res.json,{received:true});assert.equal(handled.length,0);
 }
});
test("WhatsApp: tenant isolation holds around malformed elements (each phone id routes only to its own tenant)",async()=>{
 const body={object:"whatsapp_business_account",entry:[null,{changes:[null,waChange("1000001",[txt("wamid.A","9647000000001","a")],{contacts:[null]}),
  waChange("2000002",[null,txt("wamid.B","9647000000002","b")]),waChange("3000003",[txt("wamid.X","9647000000003","unknown phone")])]}]};
 const {handled}=await runWa(body,waDb());
 assert.deepEqual(handled.map(h=>[h.msgId,h.tenant]),[["wamid.A",T1],["wamid.B",T2]],"unknown phone id is dropped, never guessed");
});
test("WhatsApp: a duplicate delivery is skipped even when its neighbours are malformed",async()=>{
 const db=waDb({messages:[{wa_message_id:"wamid.DUP"}]});
 const body={object:"whatsapp_business_account",entry:[{changes:[waChange("1000001",[null,txt("wamid.DUP","9647000000001","again"),txt("wamid.NEW","9647000000001","new")],{contacts:[null]})]}]};
 const {handled}=await runWa(body,db);
 assert.deepEqual(handled.map(h=>h.msgId),["wamid.NEW"]);
});
test("WhatsApp: one event that throws is isolated; the rest of a malformed batch is processed and the answer is a retry (503)",async()=>{
 const body={object:"whatsapp_business_account",entry:[{changes:[waChange("1000001",[txt("wamid.BOOM","9647000000001","boom"),txt("wamid.AFTER","9647000000001","after")],{contacts:{a:1}})]}]};
 const {res,handled}=await runWa(body,waDb(),(id)=>{if(id==="wamid.BOOM")throw new Error("db down");});
 assert.deepEqual(handled.map(h=>h.msgId),["wamid.BOOM","wamid.AFTER"]);
 assert.equal(res.status,503,"a transient failure is never silently acknowledged");
});
test("WhatsApp: a 'retry' outcome of a valid event still answers 503 (redelivery) with malformed neighbours",async()=>{
 const body={object:"whatsapp_business_account",entry:[null,{changes:[waChange("1000001",[txt("wamid.R","9647000000001","r")])]}]};
 const {res}=await runWa(body,waDb(),()=> "retry");
 assert.equal(res.status,503);
});

/* ───────── Facebook Page / Instagram ───────── */
const igDb=(extra={})=>fakeDb({channel_accounts:[{id:ACC1,tenant_id:T1,channel:"facebook",external_id:"PAGE1",status:"active"},{id:ACC2,tenant_id:T2,channel:"facebook",external_id:"PAGE2",status:"active"}],...extra});
const ev=(page,mid,text="hello")=>({sender:{id:"u"+mid},recipient:{id:page},timestamp:1,message:{mid,text}});
async function runIg(body,db,handler){
 const handled=[];
 const res=await igLoop(body,db,extractIgMessages,()=>false,()=>[],()=>"",async()=>null,async()=>null,async()=>false,runBatchEvent,
  async(_sb,account,_chat,_text,msgId)=>{handled.push({tenant:account.tenant_id,msgId});return handler?handler(msgId):undefined;},
  async()=>"",async()=>({name:null,avatar:null}),()=>false,async()=>{},async(x)=>x,webhookStatusFor,json,cons());
 return {res,handled};
}
const FB_MALFORMED={
 "entry is an object":[{object:"page",entry:{id:"PAGE1",messaging:[ev("PAGE1","a")]}},[]],
 "entry null / number / string then valid":[{object:"page",entry:[null,5,"x",{id:"PAGE1",messaging:[ev("PAGE1","b")]}]},["b"]],
 "messaging has null / string elements":[{object:"page",entry:[{id:"PAGE1",messaging:[null,"x",{sender:null,message:{text:"t",mid:"z"}},ev("PAGE1","c")]}]},["c"]],
 "message is a string / number":[{object:"page",entry:[{id:"PAGE1",messaging:[{sender:{id:"x"},message:"str"},{sender:{id:"x"},message:5},ev("PAGE1","d")]}]},["d"]],
 "delivery, read and echo events only around a valid one":[{object:"page",entry:[{id:"PAGE1",messaging:[{sender:{id:"s"},delivery:{mids:["m"]}},{sender:{id:"s"},read:{watermark:1}},
   {sender:{id:"PAGE1"},message:{is_echo:true,text:"mine",mid:"e"}},ev("PAGE1","f")]}]},["f"]],
 "changes / messaging not arrays":[{object:"page",entry:[{id:"PAGE1",changes:{a:1},messaging:{b:2}},{id:"PAGE1",messaging:[ev("PAGE1","g")]}]},["g"]],
};
for(const [name,[body,expected]] of Object.entries(FB_MALFORMED)){
 test("Facebook: "+name+" never aborts the batch; only valid customer messages are processed",async()=>{
  const {res,handled}=await runIg(body,igDb());
  assert.equal(res.status,200);
  assert.deepEqual(handled.map(h=>h.msgId),expected);
 });
}
test("Facebook: tenant isolation around malformed entries (page id routes only to its own tenant; echo and unknown pages dropped)",async()=>{
 const body={object:"page",entry:[null,{id:"PAGE1",messaging:[null,ev("PAGE1","a")]},{id:"PAGE2",messaging:[ev("PAGE2","b")]},{id:"PAGEX",messaging:[ev("PAGEX","x")]}]};
 const {handled}=await runIg(body,igDb());
 assert.deepEqual(handled.map(h=>[h.msgId,h.tenant]),[["a",T1],["b",T2]]);
});
test("Facebook: a duplicate delivery is skipped; the rest of a malformed batch is processed",async()=>{
 const db=igDb({messages:[{wa_message_id:"dup"}]});
 const {handled}=await runIg({object:"page",entry:[null,{id:"PAGE1",messaging:[ev("PAGE1","dup"),ev("PAGE1","new")]}]},db);
 assert.deepEqual(handled.map(h=>h.msgId),["new"]);
});
test("Facebook: a throwing event is isolated, later events still run, and the answer is a retry (503)",async()=>{
 const {res,handled}=await runIg({object:"page",entry:[null,{id:"PAGE1",messaging:[ev("PAGE1","boom"),ev("PAGE1","after")]}]},igDb(),(id)=>{if(id==="boom")throw new Error("db down");});
 assert.deepEqual(handled.map(h=>h.msgId),["boom","after"]);
 assert.equal(res.status,503);
});
test("Instagram: the same guards apply to object 'instagram' batches",async()=>{
 const db=fakeDb({channel_accounts:[{id:ACC1,tenant_id:T1,channel:"instagram",external_id:"IG1",status:"active"}]});
 const {res,handled}=await runIg({object:"instagram",entry:[null,{id:"IG1",messaging:[null,ev("IG1","m1")]}]},db);
 assert.equal(res.status,200);assert.deepEqual(handled.map(h=>h.msgId),["m1"]);
});

/* ───────── wiring: the guards are in the real source, before the loops ───────── */
test("source: both loops normalise a non-array entry and skip non-object entries before any property access",()=>{
 assert.equal((IDX.match(/if \(!Array\.isArray\(body\.entry\)\) body\.entry = \[\];/g)??[]).length,2);
 assert.match(IDX,/if \(!entry \|\| typeof entry !== "object"\) continue;\n\s+const entryId = String\(entry\.id \?\? ""\);/);
 assert.match(IDX,/for \(const change of Array\.isArray\(entry\?\.changes\) \? entry\.changes : \[\]\) \{/);
 assert.match(IDX,/\(Array\.isArray\(value\.contacts\) \? value\.contacts : \[\]\)\.find\(\n\s+\(x: any\) => x\?\.wa_id === waId/);
 assert.match(IDX,/for \(const message of Array\.isArray\(value\.messages\) \? value\.messages : \[\]\) \{/);
});
