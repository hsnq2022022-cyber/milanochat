// I1 regression: an inbound WhatsApp event for an UNVERIFIED wa_bindings row
// (is_verified=false, S9 / 20261029290000) stays silent (logged code only,
// never answered) and must NOT block or abort the other events of the same
// signed webhook batch: the loop continues, no early return, no throw.
//
// Behavioural: the REAL whatsapp_webhook batch loop is sliced out of
// supabase/functions/milan-api/index.ts, type-stripped with node:module
// stripTypeScriptTypes and executed against in-memory fakes (no Deno, no
// network, no database).
// Run: node --experimental-strip-types --test tests/security-wa-unverified-batch.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import {bindingIsVerified} from "../supabase/functions/milan-api/waBinding.ts";

const IDX=readFileSync("supabase/functions/milan-api/index.ts","utf8");
const CASE=IDX.indexOf('case "whatsapp_webhook": {');
const START=IDX.indexOf("        for (const entry of body.entry ?? []) {",CASE);
const END_MARK="        return json({\n          received: true,\n        });\n";
const END=IDX.indexOf(END_MARK,START);

function loadLoop(){
 assert.ok(CASE>0&&START>CASE&&END>START,"whatsapp_webhook batch loop located");
 assert.ok(START<IDX.indexOf('case "instagram_webhook": {'),"slice stays inside whatsapp_webhook");
 const ts="async function __waBatch(body,sb,bindingIsVerified,handleIncomingWebhookMessage,"+
  "multichannelEnabled,env,normalizeMetaMessages,json,console){\n"+
  IDX.slice(START,END+END_MARK.length)+"}\n";
 const js=stripTypeScriptTypes(ts,{mode:"strip"});
 return new Function(js+"\nreturn __waBatch;")();
}
const loop=loadLoop();

const T_VERIFIED="11111111-1111-4111-8111-111111111111";
const T_SQUAT="22222222-2222-4222-8222-222222222222";
/** wa_bindings / channel_accounts / messages / conversations fake (filters applied literally). */
function fakeDb({bindings=[],channelAccounts=[],bindingError=false}={}){
 const calls=[];
 const tables={wa_bindings:bindings,channel_accounts:channelAccounts,messages:[],conversations:[]};
 return {calls,from(table){
  const f=[];let op="select";
  const q={
   select:()=>q,update:()=>{op="update";return q;},
   eq:(k,v)=>{f.push([k,v]);return q;},
   maybeSingle:async()=>{
    calls.push({table,op,filters:f.map(x=>x[0])});
    if(table==="wa_bindings"&&bindingError)return {data:null,error:{code:"42703"}};
    const rows=(tables[table]??[]).filter(r=>f.every(([k,v])=>r[k]===v));
    return {data:rows[0]??null,error:null};
   },
   then:(ok,ko)=>{calls.push({table,op,filters:f.map(x=>x[0])});
    return Promise.resolve({data:null,error:null}).then(ok,ko);}
  };
  return q;
 }};
}
const waChange=(phoneId,messages)=>({field:"messages",value:{
 metadata:{phone_number_id:phoneId},contacts:[],messages}});
const textMsg=(id,from,body)=>({id,from,type:"text",text:{body}});

async function runBatch(body,db){
 const handled=[],logs=[];
 const cons={log:(...a)=>logs.push(["log",a]),info:(...a)=>logs.push(["info",a]),
  warn:(...a)=>logs.push(["warn",a]),error:(...a)=>logs.push(["error",a])};
 const res=await loop(body,db,bindingIsVerified,
  async(_sb,account,chatId,text,msgId,channel,phoneId)=>{
   handled.push({tenant:account.tenant_id,chatId,text,msgId,channel,phoneId});
  },
  ()=>false,()=>"",()=>[],(b)=>({json:b}),cons);
 return {res,handled,logs};
}

test("unverified binding first in the batch: silent + logged, later verified events still processed",async()=>{
 const db=fakeDb({bindings:[
  {phone_id:"2000002",tenant_id:T_SQUAT,is_verified:false},
  {phone_id:"1000001",tenant_id:T_VERIFIED,is_verified:true}]});
 const body={object:"whatsapp_business_account",entry:[
  {changes:[waChange("2000002",[textMsg("wamid.U1","9647000000001","hello squatter")])]},
  {changes:[
   waChange("2000002",[textMsg("wamid.U2","9647000000002","second unverified")]),
   waChange("1000001",[textMsg("wamid.V1","9647000000003","hi"),textMsg("wamid.V2","9647000000004","price?")])]}]};
 const {res,handled,logs}=await runBatch(body,db);
 assert.deepEqual(res,{json:{received:true}},"batch acknowledged (no early return/throw)");
 assert.deepEqual(handled.map(h=>h.msgId),["wamid.V1","wamid.V2"],"every verified event processed, in order");
 assert.ok(handled.every(h=>h.tenant===T_VERIFIED&&h.channel==="whatsapp"&&h.phoneId==="1000001"));
 assert.ok(!handled.some(h=>h.tenant===T_SQUAT),"unverified binding never answered");
 const ignored=logs.filter(([lvl,a])=>lvl==="warn"&&a[0]==="[whatsapp_webhook] binding ignored");
 assert.equal(ignored.length,2,"each unverified change is logged");
 for(const [,a] of ignored)assert.deepEqual(a[1],{code:"wa_binding_unverified"});
 // No customer text, sender or tenant id in any log line.
 const flat=JSON.stringify(logs);
 for(const s of ["hello squatter","second unverified","9647000000001",T_SQUAT])assert.ok(!flat.includes(s),s);
});

test("unverified binding LAST / interleaved in one change list: earlier events unaffected",async()=>{
 const db=fakeDb({bindings:[
  {phone_id:"1000001",tenant_id:T_VERIFIED,is_verified:true},
  {phone_id:"2000002",tenant_id:T_SQUAT,is_verified:false}]});
 const body={object:"whatsapp_business_account",entry:[{changes:[
  waChange("1000001",[textMsg("wamid.A","9647000000005","a")]),
  waChange("2000002",[textMsg("wamid.X","9647000000006","x")]),
  waChange("1000001",[textMsg("wamid.B","9647000000007","b")])]}]};
 const {res,handled}=await runBatch(body,db);
 assert.deepEqual(res,{json:{received:true}});
 assert.deepEqual(handled.map(h=>h.msgId),["wamid.A","wamid.B"]);
});

test("unverified binding still falls back to the real owner's channel_accounts row (S9 kept)",async()=>{
 const db=fakeDb({bindings:[{phone_id:"2000002",tenant_id:T_SQUAT,is_verified:false}],
  channelAccounts:[{id:"acc-1",tenant_id:T_VERIFIED,channel:"whatsapp",external_id:"2000002"}]});
 const {handled}=await runBatch({object:"whatsapp_business_account",entry:[{changes:[
  waChange("2000002",[textMsg("wamid.O","9647000000008","owner")])]}]},db);
 assert.deepEqual(handled.map(h=>[h.msgId,h.tenant]),[["wamid.O",T_VERIFIED]]);
});

test("binding lookup error (e.g. column missing) is treated as unverified, batch continues",async()=>{
 const db=fakeDb({bindingError:true,
  channelAccounts:[{id:"acc-2",tenant_id:T_VERIFIED,channel:"whatsapp",external_id:"1000001"}]});
 const {res,handled}=await runBatch({object:"whatsapp_business_account",entry:[{changes:[
  waChange("3000003",[textMsg("wamid.N","9647000000009","nobody")]),
  waChange("1000001",[textMsg("wamid.C","9647000000010","c")])]}]},db);
 assert.deepEqual(res,{json:{received:true}});
 assert.deepEqual(handled.map(h=>h.msgId),["wamid.C"]);
});

test("static: the unverified branch only logs; nothing between lookup and account check returns or throws",()=>{
 const seg=IDX.slice(IDX.indexOf('.select("tenant_id, phone_id, is_verified")',START),
  IDX.indexOf("no account for phone_number_id",START));
 assert.ok(seg.length>0);
 assert.doesNotMatch(seg,/\breturn\b|\bthrow\b|\bbreak\b/,"no early exit for unverified bindings");
 assert.match(seg,/if \(bindingRow && !binding\) \{\s*console\.warn\("\[whatsapp_webhook\] binding ignored", \{ code: "wa_binding_unverified" \}\);\s*\}/);
 const after=IDX.slice(IDX.indexOf("no account for phone_number_id",START));
 assert.match(after,/^no account for phone_number_id=\$\{phoneId\}`\s*\);\s*continue;/,"no account -> continue");
});
