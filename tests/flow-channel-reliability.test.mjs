// Channel reliability (task E). Behavioural where possible: the REAL
// whatsapp_webhook / instagram_webhook batch loops and fetchSenderProfile are
// sliced out of supabase/functions/milan-api/index.ts, type-stripped and run
// against in-memory fakes. Mocks only: no Deno, no network, no database.
//  E1 WhatsApp binding -> channel_accounts row only when PROVEN.
//  E3 comment trigger normalizer removes invisible formatting characters.
//  E4 one failing/retryable event never stops the rest of a webhook batch.
//  E5 the customer's name is never logged by fetchSenderProfile.
// Run: node --experimental-strip-types --test tests/flow-channel-reliability.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import {bindingIsVerified,provenWhatsappAccount} from "../supabase/functions/milan-api/waBinding.ts";
import {runBatchEvent,webhookStatusFor,BATCH_EVENT_ERROR} from "../supabase/functions/milan-api/inboundRoutingRetry.ts";
import {normalizeCommentText,commentMatches,HIDDEN_FORMAT_CHARS as COMMENT_HIDDEN}
 from "../supabase/functions/milan-api/commentTrigger.ts";
import {HIDDEN_FORMAT_CHARS as DM_HIDDEN,normalizeTriggerText}
 from "../supabase/functions/milan-api/triggerKeywords.ts";

const IDX=readFileSync("supabase/functions/milan-api/index.ts","utf8");
const END_MARK="        return json({\n          received: true,\n        });\n";
function slice(caseLabel,startMark){
 const c=IDX.indexOf(caseLabel);
 const a=IDX.indexOf(startMark,c);
 const b=IDX.indexOf(END_MARK,a);
 assert.ok(c>0&&a>c&&b>a,caseLabel+" loop located");
 return IDX.slice(a,b+END_MARK.length);
}
const WA_PARAMS="body,sb,bindingIsVerified,handleIncomingWebhookMessage,multichannelEnabled,env,"+
 "normalizeMetaMessages,json,console,retryableEvent,webhookStatusFor,runBatchEvent,provenWhatsappAccount,recoveryLeaseActive";
const waLoop=new Function(stripTypeScriptTypes("async function __wa("+WA_PARAMS+"){\n"+
 slice('case "whatsapp_webhook": {',"        // Per-event outcomes: any \"retry\"")+"}\n",{mode:"strip"})+"\nreturn __wa;")();
// The profile-fetch token in the instagram_webhook loop is now decrypted with
// the STRICT decryptAccessTokenStrict (tests/milan-token-decrypt-strict.test.ts),
// no longer the lenient decryptField; same position, same fake.
const IG_PARAMS="body,sb,extractIgMessages,multichannelEnabled,normalizeMetaMessages,env,syntheticEventId,"+
 "retryableEvent,recoveryLeaseActive,runBatchEvent,handleIncomingWebhookMessage,decryptAccessTokenStrict,fetchSenderProfile,"+
 "commentAutomationEnabled,ingestSignedComments,encryptField,webhookStatusFor,json,console";
const igLoop=new Function(stripTypeScriptTypes("async function __ig("+IG_PARAMS+"){\n"+
 slice('case "instagram_webhook": {',"        // Per-event outcomes: any \"retry\"")+"}\n",{mode:"strip"})+"\nreturn __ig;")();

const T1="11111111-1111-4111-8111-111111111111";
const T2="22222222-2222-4222-8222-222222222222";
const ACC1="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ACC2="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const ACC_OTHER="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

/**
 * Fake client: filters applied literally (eq). `leaky` returns ALL rows of a
 * table regardless of filters, to prove the code re-checks tenant itself.
 */
function fakeDb({tables={},leaky=false,errorTables=[]}={}){
 const calls=[];
 return {calls,from(table){
  const f=[];
  const run=()=>{
   calls.push({table,filters:f.map(x=>x[0])});
   if(errorTables.includes(table))return {data:null,error:{code:"XX000"}};
   const rows=(tables[table]??[]).filter(r=>leaky||f.every(([k,v])=>r[k]===v));
   return {rows};
  };
  const q={
   select:()=>q,update:()=>q,in:()=>q,or:()=>q,
   eq:(k,v)=>{f.push([k,v]);return q;},
   maybeSingle:async()=>{const r=run();return r.error?r:{data:r.rows[0]??null,error:null};},
   limit:async(n)=>{const r=run();return r.error?r:{data:r.rows.slice(0,n),error:null};},
   then:(ok,ko)=>Promise.resolve({data:null,error:null}).then(ok,ko)
  };
  return q;
 }};
}
const cons=()=>{const logs=[];return {logs,c:{log:(...a)=>logs.push(["log",a]),info:(...a)=>logs.push(["info",a]),
 warn:(...a)=>logs.push(["warn",a]),error:(...a)=>logs.push(["error",a])}};};
const waChange=(phoneId,messages)=>({field:"messages",value:{metadata:{phone_number_id:phoneId},contacts:[],messages}});
const textMsg=(id,from,body)=>({id,from,type:"text",text:{body}});

async function runWa(body,db,handler){
 const handled=[];const {logs,c}=cons();
 const res=await waLoop(body,db,bindingIsVerified,
  async(_sb,account,chatId,text,msgId,channel,phoneId)=>{
   handled.push({account,chatId,msgId,channel,phoneId});
   return handler?handler(msgId):undefined;
  },
  ()=>false,()=>"",()=>[],(b,s=200)=>({json:b,status:s}),c,async()=>null,webhookStatusFor,
  runBatchEvent,provenWhatsappAccount,async()=>false);
 return {res,handled,logs};
}

// ================================================================ E1 unit
const acct=(over={})=>({id:ACC1,tenant_id:T1,channel:"whatsapp",external_id:"1000001",status:"active",
 agent_enabled:true,auto_reply:true,access_token_encrypted:null,...over});
test("E1 provenWhatsappAccount: exactly one active same-tenant row with the exact phone id",async()=>{
 const p=(rows,o={})=>provenWhatsappAccount(fakeDb({tables:{channel_accounts:rows},...o}),T1,"1000001");
 const one=await p([acct()]);
 assert.equal(one.status,"proven");assert.equal(one.account.id,ACC1);
 assert.equal((await p([])).status,"none");
 assert.equal((await p([acct({status:"inactive"})])).status,"none","inactive row is not proof");
 assert.equal((await p([acct(),acct({id:ACC2})])).status,"ambiguous","two active rows: never pick one");
 assert.equal((await p([acct()],{errorTables:["channel_accounts"]})).status,"error");
 // a client that ignores filters: another tenant's row / other phone id never qualifies
 assert.equal((await p([acct({tenant_id:T2,id:ACC_OTHER})],{leaky:true})).status,"none","cross-tenant never matched");
 assert.equal((await p([acct({external_id:"1000002"})],{leaky:true})).status,"none");
 assert.equal((await p([acct({channel:"instagram"})],{leaky:true})).status,"none");
 assert.equal((await p([acct({id:""})],{leaky:true})).status,"none");
 for(const phone of ["","abc","12",null,"1".repeat(31)])
  assert.equal((await provenWhatsappAccount(fakeDb({tables:{channel_accounts:[acct()]}}),T1,phone)).status,"none",String(phone));
 const thrower={from:()=>{throw Error("boom");}};
 assert.equal((await provenWhatsappAccount(thrower,T1,"1000001")).status,"error");
});

// ============================================================ E1 in webhook
test("E1 webhook: verified binding + exactly one proven account -> handler gets the account WITH its id",async()=>{
 const db=fakeDb({tables:{wa_bindings:[{phone_id:"1000001",tenant_id:T1,is_verified:true}],channel_accounts:[acct()]}});
 const {res,handled}=await runWa({entry:[{changes:[waChange("1000001",[textMsg("wamid.A","9647000000001","hi")])]}]},db);
 assert.equal(res.status,200);
 assert.equal(handled.length,1);
 assert.equal(handled[0].account.id,ACC1,"claim gets a real p_account_id");
 assert.equal(handled[0].account.tenant_id,T1);
});
test("E1 webhook: none / ambiguous / other-tenant account -> stored without an id (fail closed), code logged",async()=>{
 for(const [name,rows] of [["none",[]],["ambiguous",[acct(),acct({id:ACC2})]],
   ["cross-tenant",[acct({tenant_id:T2,id:ACC_OTHER})]]]){
  const db=fakeDb({tables:{wa_bindings:[{phone_id:"1000001",tenant_id:T1,is_verified:true}],channel_accounts:rows}});
  const {handled,logs}=await runWa({entry:[{changes:[waChange("1000001",[textMsg("wamid.B","9647000000002","secret text")])]}]},db);
  assert.equal(handled.length,1,name);
  assert.equal(handled[0].account.id,undefined,name+": no guessed account");
  assert.equal(handled[0].account.tenant_id,T1,name+": tenant stays the binding's");
  const w=logs.find(([l,a])=>l==="warn"&&a[0]==="[whatsapp_webhook] binding account unproven");
  assert.ok(w,name+" logged");
  assert.match(w[1][1].code,/^wa_account_(none|ambiguous)$/);
  assert.ok(!JSON.stringify(logs).includes("secret text"));
 }
});
test("E1 handler: a missing account id ends BEFORE the durable attempt and the claim (no 503 retry loop)",()=>{
 const h=IDX.slice(IDX.indexOf("async function handleIncomingWebhookMessage("),IDX.indexOf("Deno.serve("));
 // The proof of the account is a routing FACT (accountProven) checked by routeInbound BEFORE the durable stage and
 // the exclusive claim; index.ts only reports it as a terminal, resolved exit (no 503 retry loop).
 const routing=readFileSync("supabase/functions/milan-api/messageRouting.ts","utf8");
 const proven=routing.indexOf("if(!input.accountProven)");
 assert.ok(proven>0);
 assert.ok(proven<routing.indexOf("deps.attemptDurable()")&&proven<routing.indexOf("deps.exclusive()"));
 assert.match(h,/accountProven: typeof account\?\.id === "string" && account\.id\.length > 0,/);
 assert.match(h,/decision\.reason === "account_unproven"\)\s*\{[\s\S]*?code: "account_unproven"[\s\S]*?await resolvedAfterRedrive\(\);\n\s+return;/);
});

// ================================================================== E4
test("E4 runBatchEvent: a throw becomes a transient outcome, logs the error type only",async()=>{
 const old=console.error;const seen=[];console.error=(...a)=>seen.push(a);
 try{
  assert.equal(await runBatchEvent(async()=>{throw new TypeError("customer said: secret");}),BATCH_EVENT_ERROR);
  assert.equal(await runBatchEvent(async()=>"retry"),"retry");
  assert.equal(await runBatchEvent(async()=>undefined),undefined);
 }finally{console.error=old;}
 assert.ok(!JSON.stringify(seen).includes("secret"));
 assert.deepEqual(seen[0][1],{type:"TypeError"});
 assert.equal(webhookStatusFor([undefined,BATCH_EVENT_ERROR]),503);
 assert.equal(webhookStatusFor([undefined,"retry"]),503);
 assert.equal(webhookStatusFor([undefined,undefined]),200);
});
test("E4 WhatsApp mixed batch: a throwing and a retryable event never stop the others; 503 only at the end",async()=>{
 const db=fakeDb({tables:{channel_accounts:[acct()]}});
 const body={entry:[{changes:[waChange("1000001",[textMsg("wamid.1","9647000000001","a"),
  textMsg("wamid.2","9647000000002","b"),textMsg("wamid.3","9647000000003","c")])]},
  {changes:[waChange("1000001",[textMsg("wamid.4","9647000000004","d")])]}]};
 const {res,handled}=await runWa(body,db,(id)=>{
  if(id==="wamid.1")throw Error("boom");
  if(id==="wamid.3")return "retry";
 });
 assert.deepEqual(handled.map(h=>h.msgId),["wamid.1","wamid.2","wamid.3","wamid.4"],"every event processed");
 assert.equal(res.status,503,"redelivery requested AFTER the whole batch");
 const ok=await runWa(body,db,()=>undefined);
 assert.equal(ok.res.status,200);
});
test("E4 Instagram/Facebook mixed batch: throwing event and throwing comment ingest never stop the batch",async()=>{
 const handled=[];const comments=[];const {c}=cons();
 const msgs={E1:[{senderId:"s1",recipientId:"r",text:"x",mid:"m1"},{senderId:"s2",recipientId:"r",text:"y",mid:"m2"}],
  E2:[{senderId:"s3",recipientId:"r",text:"z",mid:"m3"}]};
 const db=fakeDb({tables:{channel_accounts:[{id:ACC1,tenant_id:T1,channel:"instagram",external_id:"E1",status:"active"},
  {id:ACC2,tenant_id:T1,channel:"instagram",external_id:"E2",status:"active"}]}});
 // messages duplicate pre-check: the fake returns no rows (q.limit on messages -> [])
 const res=await igLoop({object:"instagram",entry:[{id:"E1"},{id:"E2"}]},db,
  (entry)=>msgs[entry.id],()=>false,()=>[],()=>"",async()=>null,async()=>null,async()=>false,runBatchEvent,
  async(_sb,account,chatId,text,msgId)=>{handled.push(msgId);if(msgId==="m1")throw Error("boom");},
  async()=>"",async()=>({name:null,avatar:null}),()=>true,
  async(_sb,_o,entry)=>{comments.push(entry.id);if(entry.id==="E1")throw Error("comment boom");},
  async(x)=>x,webhookStatusFor,(b,s=200)=>({json:b,status:s}),c);
 assert.deepEqual(handled,["m1","m2","m3"],"all DMs processed");
 assert.deepEqual(comments,["E1","E2"],"comment ingest of every entry ran");
 assert.equal(res.status,503);
});
test("E4 Instagram: the recovery sweeper's lease on a retrying event -> no concurrent re-drive, 503",async()=>{
 const handled=[];const {c}=cons();
 // channel_accounts: SEC account resolution reads limit(2) rows (exactly one -> routed).
 const db={from(table){const q={select:()=>q,eq:()=>q,in:()=>q,or:()=>q,update:()=>q,
  limit:async()=>({data:table==="messages"?[{id:"in-1"}]:table==="channel_accounts"?[{id:ACC1,tenant_id:T1,channel:"instagram",external_id:"E1",status:"active"}]:[],error:null}),
  maybeSingle:async()=>({data:table==="channel_accounts"?{id:ACC1,tenant_id:T1,channel:"instagram",external_id:"E1",status:"active"}:null,error:null}),
  then:(ok,ko)=>Promise.resolve({data:null,error:null}).then(ok,ko)};return q;}};
 const res=await igLoop({object:"instagram",entry:[{id:"E1"}]},db,
  ()=>[{senderId:"s1",recipientId:"r",text:"x",mid:"m1"}],()=>false,()=>[],()=>"",async()=>null,
  async()=>({conversationId:"c",inboundId:"in-1"}),async()=>true,runBatchEvent,
  async(...a)=>{handled.push(a[4]);},async()=>"",async()=>({name:null,avatar:null}),()=>false,async()=>{},
  async(x)=>x,webhookStatusFor,(b,s=200)=>({json:b,status:s}),c);
 assert.deepEqual(handled,[],"leased event is not re-driven by the webhook");
 assert.equal(res.status,503);
});

// ================================================================== E5
test("E5 fetchSenderProfile logs name presence only, never the customer's name",async()=>{
 const a=IDX.indexOf("async function fetchSenderProfile(");
 const b=IDX.indexOf("async function handleIncomingWebhookMessage(",a);
 const fn=new Function("fetch","console",stripTypeScriptTypes(IDX.slice(a,b),{mode:"strip"})+"\nreturn fetchSenderProfile;");
 const {logs,c}=cons();
 const fakeFetch=async()=>({ok:true,json:async()=>({name:"Layla Customer",profile_pic:"https://x.test/p.jpg"})});
 const r=await fn(fakeFetch,c)({channel:"instagram",senderId:"123",token:"IGtoken"});
 assert.equal(r.name,"Layla Customer","the name is still returned for the conversation row");
 const flat=JSON.stringify(logs);
 assert.ok(!flat.includes("Layla"),"name never logged");
 assert.ok(!flat.includes("IGtoken"),"token never logged");
 assert.match(flat,/"name":"present"/);
});

// ================================================================== E3
const ZW=["­","؜","​","‌","‍","‎","‏","‪","‫","‬","‭","‮",
 "⁠","⁡","⁢","⁣","⁤","⁦","⁧","⁨","⁩","﻿"];
test("E3 comment normalizer: same hidden-character set as the DM matcher; every such char removed",()=>{
 assert.equal(COMMENT_HIDDEN.source,DM_HIDDEN.source);
 assert.equal(COMMENT_HIDDEN.flags,DM_HIDDEN.flags);
 for(const z of ZW){
  assert.equal(normalizeCommentText("pr"+z+"ice"),"price",JSON.stringify(z));
  assert.equal(normalizeCommentText("pr"+z+"ice"),normalizeTriggerText("pr"+z+"ice"));
 }
 assert.equal(normalizeCommentText("اشترا‌كات"),"اشتراكات");
});
test("E3 comment match semantics unchanged apart from hidden characters (containment, any, scope, no stemming)",()=>{
 const kw={target_scope:"all",match_type:"keyword",keywords:["price"],public_reply_text:"r"};
 assert.equal(commentMatches(kw,{postId:"1",text:"PR​ICE?"}),true,"ZWSP can no longer hide a keyword");
 assert.equal(commentMatches(kw,{postId:"1",text:"‮price"}),true,"bidi override removed");
 assert.equal(commentMatches(kw,{postId:"1",text:"prices please"}),true,"containment kept (as before)");
 assert.equal(commentMatches(kw,{postId:"1",text:"pr ice"}),false,"a real space still separates");
 assert.equal(commentMatches(kw,{postId:"1",text:"hello"}),false);
 const ar={...kw,keywords:["اشتراكات"]};
 assert.equal(commentMatches(ar,{postId:"1",text:"كم الاشتراكات"}),true,"containment, as before");
 assert.equal(commentMatches(ar,{postId:"1",text:"اشتراك"}),false,"no stemming");
 assert.equal(commentMatches({...kw,match_type:"any"},{postId:"1",text:"​"}),true,"any unchanged");
 assert.equal(commentMatches({...kw,target_scope:"specific",specific_post_id:"9"},{postId:"1",text:"price"}),false);
});
