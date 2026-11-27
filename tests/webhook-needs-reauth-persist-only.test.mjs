// Instagram / Facebook accounts in status needs_reauth: the customer's message is still STORED (it used to be dropped
// and acknowledged, so it was lost while the owner reconnected) but is NEVER answered.
//
// The REAL handleIncomingWebhookMessage and the REAL instagram_webhook batch loop are sliced out of
// supabase/functions/milan-api/index.ts. Every collaborator the handler could use to route or send (routeInbound,
// processExclusiveEvent, attemptDurableInstagram, sendMetaDirectMessage, AI / flow preparation, ...) is a TRIPWIRE: any
// call is recorded and throws, so "no outbound send" is proven by an empty tripwire list, not by absence of a mock.
// Run: node --experimental-strip-types --test tests/webhook-needs-reauth-persist-only.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import {persistInboundOnce} from "../supabase/functions/milan-api/persistInboundOnce.ts";
import {runBatchEvent,webhookStatusFor} from "../supabase/functions/milan-api/inboundRoutingRetry.ts";
import {createStageTimer} from "../supabase/functions/milan-api/webhookTimings.ts";
import {runBackgroundJobs} from "../supabase/functions/milan-api/backgroundWork.ts";

const IDX=readFileSync("supabase/functions/milan-api/index.ts","utf8");
const T1="11111111-1111-4111-8111-111111111111",T2="22222222-2222-4222-8222-222222222222";
const ACC_IG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",ACC_FB="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

/* ───────── the real handler with tripwires ───────── */
const fStart=IDX.indexOf("async function handleIncomingWebhookMessage(");
const fEnd=IDX.indexOf("\n}\n",fStart)+3;
assert.ok(fStart>0&&fEnd>fStart,"handler located");
const handlerSrc=stripTypeScriptTypes(IDX.slice(fStart,fEnd),{mode:"strip"});
const compileHandler=new Function("scope","with(scope){return ("+handlerSrc+");}");

function world(o={}){
 const tripwires=[],ops=[],routing=[];
 const trip=(name)=>(...a)=>{tripwires.push(name);throw new Error("TRIPWIRE:"+name);};
 const stubs={
  env:()=>"",encryptField:async(x)=>"enc:"+x,persistInboundOnce,multichannelEnabled:()=>false,
  readConversationStart:async()=>false,retryAttemptCap:()=>3,
  recordRoutingFailure:async()=>{routing.push("failure");return "retry";},
  markRoutingResolved:async()=>{routing.push("resolved");},markLiveNoReply:async()=>{routing.push("liveNoReply");},
  NOOP_STAGE_TIMER:{start:()=>()=>{},span:(_s,fn)=>fn(),snapshot:()=>({})},
 };
 const scope=new Proxy({},{has:(_t,k)=>typeof k==="string"&&!(k in globalThis),get:(_t,k)=>k in stubs?stubs[k]:trip(String(k))});
 const messages=[];
 const builder=(table)=>{
  let op="select",row=null;
  const q={
   select:()=>q,eq:()=>q,neq:()=>q,in:()=>q,or:()=>q,
   insert:(r)=>{op="insert";row=r;return q;},update:(r)=>{op="update";row=r;return q;},
   maybeSingle:async()=>{
    ops.push({table,op:"select"});
    if(table==="tenants")return {data:("tenant" in o)?o.tenant:{id:T1,is_active:true,credits_remaining:5},error:null};
    if(table==="conversations")return {data:o.conv===undefined?{id:"c1",transferred:false,account_id:o.accountId??null}:o.conv,error:null};
    return {data:null,error:null};
   },
   single:async()=>{
    ops.push({table,op,row});
    if(table==="conversations")return {data:{id:"c-new"},error:null};
    if(table==="messages"){
     if(o.insertThrows)throw new Error("network");
     if(o.insertError)return {data:null,error:o.insertError};
     messages.push(row);return {data:{id:"in-"+messages.length},error:null};
    }
    return {data:null,error:null};
   },
   then:(ok,ko)=>{ops.push({table,op,row});return Promise.resolve({data:null,error:null}).then(ok,ko);},
  };
  return q;
 };
 const sb={from:(t)=>builder(t)};
 const handler=compileHandler(scope);
 return {handler,sb,tripwires,ops,routing,messages};
}
const igAccount=(status)=>({id:ACC_IG,tenant_id:T1,channel:"instagram",external_id:"IG1",status,agent_enabled:true,auto_reply:true,access_token_encrypted:"enc:v1:x"});
const fbAccount=(status)=>({id:ACC_FB,tenant_id:T1,channel:"facebook",external_id:"PAGE1",status,agent_enabled:true,auto_reply:true,access_token_encrypted:"enc:v1:x"});

test("Instagram needs_reauth: the inbound message is persisted exactly once and nothing is routed or sent",async()=>{
 const w=world();
 const r=await w.handler(w.sb,igAccount("needs_reauth"),"instagram:42","hello","mid-1","instagram",undefined,null,true,undefined,undefined,true);
 assert.equal(r,undefined);
 assert.equal(w.messages.length,1,"exactly one inbound row");
 assert.equal(w.messages[0].direction,"in");assert.equal(w.messages[0].kind,"customer");
 assert.equal(w.messages[0].wa_message_id,"mid-1");assert.equal(w.messages[0].tenant_id,T1);
 assert.deepEqual(w.tripwires,[],"no routing, AI, flow, durable, claim or provider call");
 assert.ok(!w.ops.some(o=>o.table!=="tenants"&&o.table!=="conversations"&&o.table!=="messages"),"no other table is touched (no claim, run, outbox)");
});
test("Facebook needs_reauth: persisted exactly once, nothing routed or sent",async()=>{
 const w=world();
 const r=await w.handler(w.sb,fbAccount("needs_reauth"),"facebook:77","hi page","mid-f1","facebook",undefined,null,true,undefined,undefined,true);
 assert.equal(r,undefined);assert.equal(w.messages.length,1);
 assert.equal(w.messages[0].wa_message_id,"mid-f1");
 assert.deepEqual(w.tripwires,[]);
});
test("a first message creates the conversation (tenant + account scoped) and still sends nothing",async()=>{
 const w=world({conv:null});
 await w.handler(w.sb,igAccount("needs_reauth"),"instagram:99","first","mid-2","instagram",undefined,null,true,undefined,undefined,true);
 const insertConv=w.ops.find(o=>o.table==="conversations"&&o.op==="insert");
 assert.ok(insertConv,"conversation inserted");
 assert.equal(insertConv.row.tenant_id,T1);assert.equal(insertConv.row.account_id,ACC_IG);assert.equal(insertConv.row.channel,"instagram");
 assert.equal(w.messages.length,1);assert.deepEqual(w.tripwires,[]);
});
test("duplicate delivery (unique violation): not stored twice, no retry, nothing sent",async()=>{
 const w=world({insertError:{code:"23505"}});
 const r=await w.handler(w.sb,igAccount("needs_reauth"),"instagram:42","hello","mid-1","instagram",undefined,null,true,undefined,undefined,true);
 assert.equal(r,undefined);assert.equal(w.messages.length,0);assert.deepEqual(w.tripwires,[]);
});
test("persistence failure or an uncertain outcome keeps the retry (503) behaviour; nothing is sent",async()=>{
 for(const o of [{insertError:{code:"XX000"}},{insertThrows:true}]){
  const w=world(o);
  const r=await w.handler(w.sb,igAccount("needs_reauth"),"instagram:42","hello","mid-1","instagram",undefined,null,true,undefined,undefined,true);
  assert.equal(r,"retry",JSON.stringify(o));
  assert.deepEqual(w.tripwires,[]);
 }
});
test("tenant inactive / missing: nothing stored, nothing sent (unchanged)",async()=>{
 for(const tenant of [{id:T1,is_active:false},null]){
  const w=world({tenant});
  await w.handler(w.sb,igAccount("needs_reauth"),"instagram:42","hello","mid-1","instagram",undefined,null,true,undefined,undefined,true);
  assert.equal(w.messages.length,0);assert.deepEqual(w.tripwires,[]);
 }
});
test("re-drive of a retryable event for a needs_reauth account: resolved, never routed or sent, no second insert",async()=>{
 const w=world();
 const r=await w.handler(w.sb,igAccount("needs_reauth"),"instagram:42","hello","mid-1","instagram",undefined,null,true,{conversationId:"c1",inboundId:"in-9"},undefined,true);
 assert.equal(r,undefined);assert.equal(w.messages.length,0,"redrive never inserts again");
 assert.deepEqual(w.routing,["resolved"],"the retry row is closed: a known terminal outcome");
 assert.deepEqual(w.tripwires,[]);
});
test("ACTIVE account (persistOnly false/absent): the handler still reaches routing (first collaborator is a tripwire here)",async()=>{
 for(const flag of [false,undefined]){
  const w=world();
  await assert.rejects(()=>w.handler(w.sb,igAccount("active"),"instagram:42","hello","mid-1","instagram",undefined,null,true,undefined,undefined,flag),/TRIPWIRE/);
  assert.equal(w.messages.length,1,"persisted exactly as before");
  assert.ok(w.tripwires.length>0,"routing was entered");
 }
});

/* ───────── the real batch loop (webhook entry) ───────── */
const END_MARK="        return json({\n          received: true,\n        });\n";
const c=IDX.indexOf('case "instagram_webhook": {');
const a=IDX.indexOf("        // Per-event outcomes: any \"retry\"",c);
const b=IDX.indexOf(END_MARK,a);
const igLoopRaw=new Function(stripTypeScriptTypes("async function __ig(body,sb,extractIgMessages,multichannelEnabled,normalizeMetaMessages,env,syntheticEventId,"+
 "retryableEvent,recoveryLeaseActive,runBatchEvent,handleIncomingWebhookMessage,decryptAccessTokenStrict,fetchSenderProfile,"+
 "commentAutomationEnabled,ingestSignedComments,encryptField,webhookStatusFor,json,console,timer,endTotal,runBackgroundJobs){\n"+
 IDX.slice(a,b+END_MARK.length)+"}\n",{mode:"strip"})+"\nreturn __ig;")();
const igLoop=(...x)=>igLoopRaw(...x,createStageTimer(),()=>{},runBackgroundJobs);
const exStart=IDX.indexOf("function extractIgMessages(entry: any)");
const extractIgMessages=new Function("selectedFlowChoice",stripTypeScriptTypes(IDX.slice(exStart,IDX.indexOf("\n}\n",exStart)+3),{mode:"strip"})+"\nreturn extractIgMessages;")(()=>null);

function loopDb(accounts,existingMids=[]){
 const msgs=[...existingMids],calls=[];
 return {calls,from(table){
  const f=[];
  const rows=()=>table==="channel_accounts"?accounts.filter(r=>f.every(([k,v])=>Array.isArray(v)?v.includes(r[k]):r[k]===v)):
   table==="messages"?msgs.filter(r=>f.every(([k,v])=>r[k]===v)):[];
  const q={select:()=>q,update:()=>q,or:()=>q,neq:()=>q,in:(k,v)=>{f.push([k,v]);return q;},eq:(k,v)=>{f.push([k,v]);return q;},
   maybeSingle:async()=>({data:rows()[0]??null,error:null}),limit:async(n)=>({data:rows().slice(0,n),error:null}),
   then:(ok,ko)=>Promise.resolve({data:null,error:null}).then(ok,ko)};
  return q;
 }};
}
const cons={log(){},info(){},warn(){},error(){}};
const ev=(page,mid,text="hello")=>({sender:{id:"u"+mid},recipient:{id:page},timestamp:1,message:{mid,text}});
const json=(b,s=200)=>({json:b,status:s});
async function runLoop(body,db,handler){
 const calls=[];
 const res=await igLoop(body,db,extractIgMessages,()=>false,()=>[],()=>"",async()=>null,async()=>null,async()=>false,runBatchEvent,
  async(...args)=>{calls.push({account:args[1],msgId:args[4],persistOnly:args[11]});return handler?handler(args):undefined;},
  async()=>"tok",async()=>{throw new Error("profile fetch must not run for a needs_reauth account");},()=>false,async()=>{},async(x)=>x,webhookStatusFor,json,cons);
 return {res,calls};
}
const acct=(id,t,channel,ext,status)=>({id,tenant_id:t,channel,external_id:ext,status,agent_enabled:true,auto_reply:true,access_token_encrypted:"enc:v1:x"});

test("webhook loop: a needs_reauth Instagram and Facebook account are handled with persistOnly=true (previously skipped and acknowledged)",async()=>{
 const db=loopDb([acct(ACC_IG,T1,"instagram","IG1","needs_reauth"),acct(ACC_FB,T2,"facebook","PAGE1","needs_reauth")]);
 const ig=await runLoop({object:"instagram",entry:[{id:"IG1",messaging:[ev("IG1","i1")]}]},db);
 const fb=await runLoop({object:"page",entry:[{id:"PAGE1",messaging:[ev("PAGE1","f1")]}]},db);
 assert.equal(ig.res.status,200);assert.equal(fb.res.status,200);
 assert.deepEqual(ig.calls.map(x=>[x.msgId,x.persistOnly,x.account.tenant_id]),[["i1",true,T1]]);
 assert.deepEqual(fb.calls.map(x=>[x.msgId,x.persistOnly,x.account.tenant_id]),[["f1",true,T2]]);
});
test("webhook loop: ACTIVE accounts are handled exactly as before (persistOnly=false); other non-active statuses are still skipped",async()=>{
 const db=loopDb([acct(ACC_IG,T1,"instagram","IG1","active"),acct(ACC_FB,T2,"facebook","PAGE1","inactive")]);
 const ig=await runLoop({object:"instagram",entry:[{id:"IG1",messaging:[ev("IG1","i1")]}]},db);
 const fb=await runLoop({object:"page",entry:[{id:"PAGE1",messaging:[ev("PAGE1","f1")]}]},db);
 assert.deepEqual(ig.calls.map(x=>[x.msgId,x.persistOnly]),[["i1",false]]);
 assert.deepEqual(fb.calls,[],"inactive account: skipped, as before");
});
test("webhook loop: a duplicate delivery for a needs_reauth account is not handled again",async()=>{
 const db=loopDb([acct(ACC_IG,T1,"instagram","IG1","needs_reauth")],[{wa_message_id:"dup"}]);
 const r=await runLoop({object:"instagram",entry:[{id:"IG1",messaging:[ev("IG1","dup"),ev("IG1","new")]}]},db);
 assert.deepEqual(r.calls.map(x=>x.msgId),["new"]);
});
test("webhook loop: one invalid event does not stop valid events of the same batch; a retry outcome is a 503",async()=>{
 const db=loopDb([acct(ACC_IG,T1,"instagram","IG1","needs_reauth"),acct(ACC_FB,T2,"facebook","PAGE1","active")]);
 const body={object:"instagram",entry:[null,{id:"UNKNOWN",messaging:[ev("UNKNOWN","x")]},{id:"IG1",messaging:[null,ev("IG1","a"),ev("IG1","b")]}]};
 const ok=await runLoop(body,db);
 assert.deepEqual(ok.calls.map(x=>x.msgId),["a","b"]);assert.equal(ok.res.status,200);
 const retry=await runLoop(body,db,(args)=>args[4]==="a"?"retry":undefined);
 assert.equal(retry.res.status,503,"an unpersisted event is never acknowledged");
 assert.deepEqual(retry.calls.map(x=>x.msgId),["a","b"]);
});
test("END TO END: the real loop + real handler for needs_reauth Instagram and Facebook: each message persisted once, zero tripwires",async()=>{
 const run=async(object,entryId,acc,mid)=>{
  const w=world();
  const db=loopDb([acc]);
  const res=await igLoop({object,entry:[{id:entryId,messaging:[ev(entryId,mid),ev(entryId,mid)]}]},db,extractIgMessages,()=>false,()=>[],()=>"",async()=>null,async()=>null,async()=>false,runBatchEvent,
   (_sb,account,chat,text,msgId,channel,ph,choice,genuine,redrive,timer,persistOnly)=>w.handler(w.sb,account,chat,text,msgId,channel,ph,choice,genuine,redrive,timer,persistOnly),
   async()=>"tok",async()=>{throw new Error("no profile fetch");},()=>false,async()=>{},async(x)=>x,webhookStatusFor,json,cons);
  return {res,w};
 };
 const ig=await run("instagram","IG1",acct(ACC_IG,T1,"instagram","IG1","needs_reauth"),"m-ig");
 const fb=await run("page","PAGE1",acct(ACC_FB,T2,"facebook","PAGE1","needs_reauth"),"m-fb");
 for(const x of [ig,fb]){
  assert.equal(x.res.status,200);
  assert.deepEqual(x.w.tripwires,[],"no outbound / routing work");
  assert.equal(x.w.messages.length,2,"both deliveries reach persistence in this fake (the database unique index dedupes the repeat in production)");
 }
});

/* ───────── downstream workers: effects queued BEFORE the account needed reauth ───────── */
test("outbox worker: an effect queued earlier is PAUSED (kept pending, never sent) while the account is needs_reauth",()=>{
 const w=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.match(w,/accountActive:account\?\.status==="needs_reauth"\?false:account\?\.is_active,agentEnabled:account\?\.agent_enabled,/);
 assert.match(w,/account\.is_active!==true\|\|account\.status==="needs_reauth"\|\|/);
 // the pause happens before any dispatch / provider call in the same iteration
 const pause=w.indexOf('if(pause){report("paused_"+pause);continue;}');
 assert.ok(pause>0&&pause<w.indexOf("canDispatchOutbox({"),"pause precedes the dispatch gate");
});
test("comment ingestion and the recovery sweeper already refuse non-active accounts",()=>{
 const ci=readFileSync("supabase/functions/milan-api/commentIngress.ts","utf8");
 assert.match(ci,/if\(a\.status!==undefined&&a\.status!=="active"\)/);
 const rec=readFileSync("supabase/functions/milan-api/inboundRecovery.ts","utf8");
 assert.match(rec,/if\(account\.status!=="active"\)return resolved\("account_inactive"\);/);
});
