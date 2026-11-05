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
test("provider 2xx lacking a stable message ID is uncertain without charging",async()=>{
 let calls=0;const events:string[]=[];
 const result=await executeOnce({
  reserve:async()=>{events.push("reserve");return true;},
  send:async()=>{calls++;events.push("send");return null;},
  confirm:async(status,id)=>{events.push(status+":"+id);return true;},
  persistAndBill:async()=>{events.push("UNEXPECTED_CHARGE");return true;}
 });
 assert.equal(result,"uncertain");
 assert.equal(calls,1);
 assert.deepEqual(events,["reserve","send","uncertain:null"]);
});
test("provider returning a blank message ID is not confirmed",async()=>{
 const actions:string[]=[];
 const result=await executeOnce({
  reserve:async()=>true,
  send:async()=>" ",
  confirm:async(status,id)=>{actions.push(status+":"+id);return true;},
  persistAndBill:async()=>{actions.push("UNEXPECTED_CHARGE");return true;}
 });
 assert.equal(result,"uncertain");
 assert.deepEqual(actions,["uncertain:null"]);
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
   assert(["knowledge_chunks","knowledge_sources"].includes(table));
   const q={
    select:()=>q,
    eq:(field:string,id:string)=>{
     if(field==="tenant_id")assert.equal(id,"A");
     if(field==="status")assert.equal(id,"indexed");
     return q;
    },
    in:()=>q,
    limit:async()=>({data:table==="knowledge_chunks"?
     [{id:rowId,tenant_id:tenant,content,source_id:"source-A"}]:
     [{id:"source-A",tenant_id:tenant,status:"indexed"}],error:null})
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

// ---------------------------------------------------------------- skip policy
import {readFileSync} from "node:fs";
import {permanentOutboxBlock,temporaryOutboxPause,humanTakeoverActive,OUTBOX_SCAN_LIMIT,
 OUTBOX_DISPATCH_LIMIT,OUTBOX_STALE_MINUTES,type OutboxSkipInput}
 from "../supabase/functions/flow-outbox-worker/skipPolicy.ts";
import {humanTakeoverActive as wakeTakeoverActive}
 from "../supabase/functions/flow-runtime-worker/eligibility.ts";
const skipNow=Date.parse("2026-10-29T18:00:00Z");
const sendable:OutboxSkipInput={
 tenantFound:true,tenantActive:true,runFound:true,accountFound:true,conversationFound:true,
 accountTenantMatches:true,conversationTenantMatches:true,accountPlatformMatchesRun:true,
 conversationAccountMatches:true,accountActive:true,agentEnabled:true,autoReply:true,
 allowedChannel:true,humanTransferred:false,humanAgentExpiresAt:null,humanPausedReason:null,
 revisionActive:true
};
// Canonical columns (transferred, human_agent_expires_at, auto_paused_reason);
// the old human_agent_until column does not exist on production shapes.
const TAKEOVER_CASES:[unknown,unknown,unknown,boolean][]=[
 [false,null,null,false],[null,null,null,false],[undefined,null,null,false],
 [false,"2026-10-29T19:00:00Z","manual_takeover",false],
 [true,null,"manual_takeover",true],[true,null,null,true],
 [true,"2026-10-29T19:00:00Z","manual_takeover",true],
 [true,"2026-10-29T17:00:00Z","manual_takeover",false],
 [true,"2026-10-29T17:00:00Z","ai_handoff",true],[true,"2026-10-29T17:00:00Z",null,true],
 [true,"garbage","manual_takeover",true],[true,123,"manual_takeover",true],
 ["true",null,null,true],[1,"2026-10-29T17:00:00Z","manual_takeover",true]
];
test("human takeover follows milan-api expiry and is fail-closed on corrupt values",()=>{
 for(const [tr,at,why,want] of TAKEOVER_CASES){
  assert.equal(humanTakeoverActive(tr,at,why,skipNow),want,JSON.stringify([tr,at,why]));
  // Runtime worker and outbox worker apply the identical rule.
  assert.equal(wakeTakeoverActive(tr,at,why,skipNow),want,"wake "+JSON.stringify([tr,at,why]));
 }
 assert.equal(humanTakeoverActive(true,"2026-10-29T17:00:00Z","manual_takeover",Number.NaN),true);
});
test("effects blocked by takeover, inactive revision or broken scope are skipped forever",()=>{
 assert.equal(permanentOutboxBlock(sendable,skipNow),null);
 for(const [field,value,reason] of [
  ["humanTransferred",true,"human_takeover"],
  ["revisionActive",undefined,"revision_inactive"],["revisionActive",false,"revision_inactive"],
  ["tenantFound",false,"ineligible"],["runFound",false,"ineligible"],
  ["accountFound",false,"ineligible"],["conversationFound",false,"ineligible"],
  ["accountTenantMatches",false,"ineligible"],["conversationTenantMatches",false,"ineligible"],
  ["accountPlatformMatchesRun",false,"ineligible"],["conversationAccountMatches",false,"ineligible"],
  ["allowedChannel",false,"ineligible"]
 ] as const){
  assert.equal(permanentOutboxBlock({...sendable,[field]:value},skipNow),reason,field);
 }
 assert.equal(permanentOutboxBlock({...sendable,humanTransferred:true,
  humanAgentExpiresAt:"2026-10-29T19:00:00Z",humanPausedReason:"manual_takeover"},skipNow),"human_takeover");
 // Expired manual takeover: sendable again (milan-api resumes auto replies too).
 assert.equal(permanentOutboxBlock({...sendable,humanTransferred:true,
  humanAgentExpiresAt:"2026-10-29T17:00:00Z",humanPausedReason:"manual_takeover"},skipNow),null);
 // A cross-tenant conversation never yields a takeover verdict for this tenant.
 assert.equal(permanentOutboxBlock({...sendable,conversationTenantMatches:false,
  humanTransferred:true},skipNow),"ineligible");
 // Takeover wins over other reasons so the audit reason is accurate.
 assert.equal(permanentOutboxBlock({...sendable,humanTransferred:true,revisionActive:false},
  skipNow),"human_takeover");
});
// Old behaviour cancelled these effects permanently as 'ineligible'. They are
// temporary: the effect stays pending (resumes when re-enabled) and only the
// 60-minute stale sweep (flow_skip_blocked_outbox) can cancel it.
test("temporarily disabled auto_reply/agent_enabled/tenant/account keeps effects pending",()=>{
 assert.equal(temporaryOutboxPause(sendable),null);
 for(const [field,value,pause] of [
  ["tenantActive",false,"tenant_inactive"],["tenantActive",undefined,"tenant_inactive"],
  ["accountActive",false,"account_inactive"],["agentEnabled",false,"agent_disabled"],
  ["agentEnabled",null,"agent_disabled"],["autoReply",false,"auto_reply_off"],
  ["autoReply",undefined,"auto_reply_off"]
 ] as const){
  assert.equal(permanentOutboxBlock({...sendable,[field]:value},skipNow),null,field+" not permanent");
  assert.equal(temporaryOutboxPause({...sendable,[field]:value}),pause,field);
 }
 // A permanent reason still wins over a pause.
 assert.equal(permanentOutboxBlock({...sendable,autoReply:false,revisionActive:false},skipNow),
  "revision_inactive");
 assert.equal(OUTBOX_STALE_MINUTES,60);
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.match(code,/if\(!tenant\|\|!run\)\{await skip\("ineligible"\);continue;\}/);
 assert.doesNotMatch(code,/tenant\.is_active!==true\|\|!run\)\{await skip/);
 const permanent=code.indexOf("if(permanent){await skip(permanent);continue;}");
 const pause=code.indexOf('if(pause){report("paused_"+pause);continue;}');
 const gate=code.indexOf("!canDispatchOutbox({");
 assert(permanent>0&&pause>permanent&&gate>pause);
 assert.doesNotMatch(code,/human_agent_until/);
 assert.match(code,/humanTakeover:takeover\b/);
});
test("worker sweeps stale/blocked effects before listing and fails closed without it",()=>{
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 const gateOff=code.indexOf("if(ge||g?.enabled!==true)return blocked();");
 const sweep=code.indexOf('sb.rpc("flow_skip_blocked_outbox"');
 const list=code.indexOf('sb.from("automation_flow_outbox")\n  .select(');
 assert(gateOff>0&&sweep>gateOff&&list>sweep);
 assert.match(code,/if\(sweepError\)\{[\s\S]{0,120}return json\(\{error:"Outbox lifecycle unavailable",sends:0\},503\);/);
 assert.match(code,/p_max_age_minutes:OUTBOX_STALE_MINUTES,p_limit:200/);
});
test("blocked effects are skipped tenant-scoped, never in-flight, and cannot starve newer ones",()=>{
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert(OUTBOX_SCAN_LIMIT>OUTBOX_DISPATCH_LIMIT);
 assert.match(code,/\.limit\(OUTBOX_SCAN_LIMIT\)/);
 assert.match(code,/if\(dispatched>=OUTBOX_DISPATCH_LIMIT\)break;/);
 // Only not-yet-sent rows (pending, or retry_wait during an AI backoff) are
 // ever skipped; leased/charge_pending/settled rows fall through to report().
 assert.match(code,/if\(effect\.delivery_status!=="pending"&&effect\.delivery_status!=="retry_wait"\)\{\s*report\(fallback\);return;\s*\}/);
 assert.doesNotMatch(code,/delivery_status!=="(charge_pending|leased|settled)"\)\{\s*report\(fallback/);
 assert.match(code,/sb\.rpc\("flow_skip_outbox_effect",\{\s*p_tenant:effect\.tenant_id,p_outbox:effect\.id,p_reason:reason/);
 const permanent=code.indexOf("const permanent=permanentOutboxBlock(");
 const skipped=code.indexOf("if(permanent){await skip(permanent);continue;}");
 const gate=code.indexOf("!canDispatchOutbox({");
 const reserve=code.indexOf('sb.rpc("flow_reserve_outbox_delivery"');
 assert(permanent>0&&skipped>permanent&&gate>skipped&&reserve>gate);
 // Lookup errors and paused tenants are transient: reported, not cancelled.
 assert.match(code,/if\(tenantError\|\|switchError\|\|runError\)\{report\("blocked"\);continue;\}/);
 assert.match(code,/if\(!sw\?\.enabled\)\{report\("blocked"\);continue;\}/);
 assert.match(code,/if\(accountResult\.error\|\|conversationResult\.error\|\|activationResult\.error\)\{\s*report\("blocked"\);continue;/);
});

// ---------------------------------------------------------- per-run seq order
import {compareOutbox,heldByEarlierEffect,effectSeq,statusAfterOutcome,type OrderRow}
 from "../supabase/functions/flow-outbox-worker/effectOrder.ts";
const T0="2026-11-05T10:00:00.123456+00:00",T1="2026-11-05T10:05:00.5+00:00";
const row=(id:string,seq:number|undefined,status="pending",over:Partial<OrderRow>={}):OrderRow=>({
 id,tenant_id:"A",run_id:"run-1",delivery_status:status,effect_kind:"message",
 payload:seq===undefined?{kind:"message"}:{kind:"message",seq},created_at:T0,...over});
test("candidates sort by (created_at, run, seq) even when one commit shares created_at",()=>{
 const rows=[row("z",2),row("y",0),row("x",1),row("w",0,"pending",{run_id:"run-0"}),row("v",0,"pending",{created_at:T1})];
 assert.deepEqual([...rows].sort(compareOutbox).map(r=>r.id),["w","y","x","z","v"]);
 assert.equal(effectSeq({seq:3}),3);assert.equal(effectSeq({}),0);
 assert.equal(effectSeq({seq:9}),0);assert.equal(effectSeq({seq:"1"}),0);assert.equal(effectSeq(null),0);
});
test("a later seq waits until every earlier effect of the same run is sent or terminally ended",()=>{
 const s0=row("s0",0),s1=row("s1",1),s2=row("s2",2);
 assert.equal(heldByEarlierEffect(s0,[s0,s1,s2]),false);
 assert.equal(heldByEarlierEffect(s1,[s0,s1,s2]),true);
 assert.equal(heldByEarlierEffect(s2,[s0,s1,s2]),true);
 for(const status of ["pending","leased","retry_wait","uncertain","weird_new_status"])
  assert.equal(heldByEarlierEffect(s1,[row("s0",0,status),s1]),true,"held by "+status);
 for(const status of ["settled","charge_pending","cancelled","dead_letter"])
  assert.equal(heldByEarlierEffect(s1,[row("s0",0,status),s1]),false,"released by "+status);
 // Blocked earlier effect holds ALL later ones, also when only seq 1 is done.
 assert.equal(heldByEarlierEffect(s2,[row("s0",0,"pending"),row("s1",1,"settled"),s2]),true);
 // Sends made during this tick release the next seq in the same tick.
 const local=new Map([["s0","settled"]]);
 assert.equal(heldByEarlierEffect(s1,[s0,s1,s2],local),false);
 assert.equal(heldByEarlierEffect(s2,[s0,s1,s2],local),true);
 assert.equal(statusAfterOutcome("settled"),"settled");
 assert.equal(statusAfterOutcome("billing_pending"),"charge_pending");
 assert.equal(statusAfterOutcome("uncertain"),"uncertain");
 assert.equal(statusAfterOutcome("skipped_stale"),"cancelled");
 assert.equal(statusAfterOutcome("blocked"),undefined);
 assert.equal(statusAfterOutcome("not_reserved"),undefined);
 // Non-provider rows (delay/tag) never hold a message.
 assert.equal(heldByEarlierEffect(s1,[row("d0",0,"pending",{effect_kind:"delay"}),s1]),false);
});
test("an older commit holds only while not yet attempted; legacy single effects are unaffected",()=>{
 const later=row("n0",0,"pending",{created_at:T1});
 assert.equal(heldByEarlierEffect(later,[row("o0",0,"pending"),later]),true);
 assert.equal(heldByEarlierEffect(later,[row("o0",0,"leased"),later]),true);
 assert.equal(heldByEarlierEffect(later,[row("o0",0,"settled"),later]),false);
 // A tapped question that ended uncertain must not block the tap's answer.
 assert.equal(heldByEarlierEffect(later,[row("o0",0,"uncertain",{effect_kind:"question"}),later]),false);
 assert.equal(heldByEarlierEffect(row("legacy",undefined),[row("legacy",undefined)]),false);
});
test("ordering is tenant- and run-isolated",()=>{
 const s1=row("s1",1);
 assert.equal(heldByEarlierEffect(s1,[row("b0",0,"pending",{tenant_id:"B"}),s1]),false,"other tenant, same run id");
 assert.equal(heldByEarlierEffect(s1,[row("r0",0,"pending",{run_id:"run-2"}),s1]),false,"other run");
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 // ONE tenant-scoped sibling query per tenant per tick, before any dispatch.
 assert.match(code,/for\(const tenantId of new Set\(items\.map\(e=>String\(e\.tenant_id\)\)\)\)\{/);
 assert.match(code,/\.eq\("tenant_id",tenantId\)\.in\("run_id",runIds\)\.in\("effect_kind",ORDERED_KINDS\)/);
 assert.match(code,/\(siblings as OrderRow\[\]\)\.filter\(r=>r\.tenant_id===tenantId\)/);
 assert.match(code,/\.sort\(compareOutbox\)/);
 const held=code.indexOf("if(heldByEarlierEffect(effect as OrderRow,siblings,localStatus))");
 const failClosed=code.indexOf('if(!siblings){report("blocked_order");continue;}');
 const tenant=code.indexOf('sb.from("tenants")');
 const reserve=code.indexOf('sb.rpc("flow_reserve_outbox_delivery"');
 assert(failClosed>0&&held>failClosed&&tenant>held&&reserve>tenant);
 // Billing path untouched: one consume per settled effect.
 assert.equal((code.match(/sb\.rpc\("consume_flow_reply"/g)??[]).length,1);
});

// ---- Typed-answer questions (text/email/phone): plain Instagram message.
import {plainInputQuestion} from "../supabase/functions/flow-outbox-worker/questionMode.ts";
import {ORDERED_KINDS} from "../supabase/functions/flow-outbox-worker/effectOrder.ts";
test("text/email/phone questions are plain Instagram messages; buttons and unknown modes keep the old rules",()=>{
 const q=(over:Record<string,unknown>={})=>({kind:"question",text:"ما بريدك؟",inputMode:"email",choices:[],choiceIds:[],seq:1,...over});
 for(const mode of ["text","email","phone"])assert.equal(plainInputQuestion(q({inputMode:mode}),"instagram"),true,mode);
 assert.equal(plainInputQuestion(q({choices:undefined,choiceIds:undefined}),"instagram"),true);
 for(const mode of ["number","buttons","date","",undefined,null])
  assert.equal(plainInputQuestion(q({inputMode:mode}),"instagram"),false,String(mode));
 for(const platform of ["facebook","whatsapp","",undefined])
  assert.equal(plainInputQuestion(q(),platform),false,"Instagram only: "+String(platform));
 assert.equal(plainInputQuestion(q({choices:["a"],choiceIds:["a"]}),"instagram"),false,"no hidden quick replies");
 assert.equal(plainInputQuestion(q({kind:"message"}),"instagram"),false);
 for(const bad of [null,"x",[],42])assert.equal(plainInputQuestion(bad,"instagram"),false);
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 // Only the plain question skips the buttons gate; any other question is blocked as before.
 assert.match(code,/const plainQuestion=effect\.effect_kind==="question"&&\n\s+plainInputQuestion\(payload,account\.platform\);/);
 assert.match(code,/if\(effect\.effect_kind==="question" && !plainQuestion &&\n\s+\(env\("FLOW_RICH_BUTTONS_ENABLED"\)!=="true" \|\|\n\s+!\["instagram","facebook"\]\.includes\(account\.platform\) \|\|\n\s+payload\.inputMode!=="buttons"\)\)\{\n\s+report\("blocked"\);continue;\n\s+\}/);
 assert.match(code,/const quickReplies=effect\.effect_kind==="question" && !plainQuestion &&/);
 assert.match(code,/if\(effect\.effect_kind==="question" && !plainQuestion && !quickReplies\)\{await skip\("ineligible","invalid"\);continue;\}/);
 // Decided after the production gate and payload checks, before any send.
 const gate=code.indexOf("!canDispatchOutbox({"),plain=code.indexOf("const plainQuestion="),
  reserve=code.indexOf('sb.rpc("flow_reserve_outbox_delivery"');
 assert(gate>0&&plain>gate&&reserve>plain);
 assert.equal((code.match(/sb\.rpc\("consume_flow_reply"/g)??[]).length,1,"billing untouched");
});
test("a plain question takes part in per-run seq ordering like any message",()=>{
 const a=row("q0",0,"pending",{effect_kind:"question"}),b=row("m1",1);
 assert.equal(heldByEarlierEffect(b,[a,b]),true,"the next effect waits for the question");
 assert.equal(heldByEarlierEffect(b,[{...a,delivery_status:"settled"},b]),false);
 assert.ok((ORDERED_KINDS as readonly string[]).includes("question"));
});
