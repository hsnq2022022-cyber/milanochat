import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {canWakeDurableRun,wakeEndReason,humanTakeoverActive,type WakeEligibility}
 from "../supabase/functions/flow-runtime-worker/eligibility.ts";

const now=Date.parse("2026-10-29T18:00:00Z");
const safe:WakeEligibility={
 runPlatform:"instagram",runStatus:"sleeping",runRevision:4,
 tenantActive:true,tenantSwitchEnabled:true,tenantTestOnly:false,
 tenantProductionApproved:true,globalEnabled:true,
 accountId:"same-account",canaryAccountId:"same-account",
 accountTenantMatches:true,accountActive:true,agentEnabled:true,
 autoReply:true,conversationTenantMatches:true,conversationAccountMatches:true,
 humanTransferred:false,humanAgentExpiresAt:null,humanPausedReason:null,
 activeRevision:4,revisionIsActive:true
};
test("wake permitted only for the still-active canary revision",()=>{
 assert.equal(canWakeDurableRun(safe,now),true);
 for(const [field,value] of [
  ["runRevision",2],["activeRevision",2],["revisionIsActive",false],
  ["runPlatform","facebook"],["runStatus","completed"],
  ["canaryAccountId","another-account"],["accountTenantMatches",false],
  ["conversationTenantMatches",false],["conversationAccountMatches",false],
  ["globalEnabled",false],["tenantActive",false],["tenantSwitchEnabled",false],
  ["accountActive",false],["agentEnabled",false],["autoReply",false],
  ["humanTransferred",true]
 ] as const){
  assert.equal(canWakeDurableRun({...safe,[field]:value},now),false,field);
 }
 assert.equal(canWakeDurableRun({...safe,tenantProductionApproved:false},now),false);
 assert.equal(canWakeDurableRun({...safe,tenantTestOnly:true,tenantProductionApproved:false},now),true);
});
// Canonical columns: transferred + human_agent_expires_at (+ auto_paused_reason),
// same rule as milan-api's lazy expiry and flow_conversation_human_takeover.
const takeover=(at:unknown,reason:unknown="manual_takeover")=>
 ({...safe,humanTransferred:true,humanAgentExpiresAt:at,humanPausedReason:reason});
test("human takeover follows milan-api expiry; corrupt values fail closed",()=>{
 assert.equal(canWakeDurableRun(takeover("2026-10-29T19:00:00Z"),now),false,"live takeover");
 assert.equal(canWakeDurableRun(takeover(null),now),false,"no expiry = active");
 assert.equal(canWakeDurableRun(takeover("not a date"),now),false,"corrupt date");
 assert.equal(canWakeDurableRun(takeover(42),now),false,"non-string date");
 assert.equal(canWakeDurableRun(takeover("2026-10-29T17:00:00Z"),now),true,"expired manual takeover");
 // milan-api only auto-releases manual_takeover; ai_handoff stays a takeover.
 assert.equal(canWakeDurableRun(takeover("2026-10-29T17:00:00Z","ai_handoff"),now),false);
 assert.equal(canWakeDurableRun(takeover("2026-10-29T17:00:00Z",null),now),false);
 // transferred=false is not a takeover even with a stale future timestamp.
 assert.equal(canWakeDurableRun({...safe,humanAgentExpiresAt:"2026-10-29T19:00:00Z"},now),true);
 assert.equal(canWakeDurableRun({...safe,humanTransferred:"yes"},now),false,"malformed transferred");
 assert.equal(canWakeDurableRun(safe,Number.NaN),false);
 assert.equal(humanTakeoverActive(true,"2026-10-29T17:00:00Z","manual_takeover",Number.NaN),true);
});
test("workers select only the canonical takeover columns",()=>{
 for(const f of ["supabase/functions/flow-runtime-worker/index.ts",
  "supabase/functions/flow-outbox-worker/index.ts"]){
  const src=readFileSync(f,"utf8");
  assert.doesNotMatch(src,/human_agent_until/,f);
  assert.match(src,/\.select\("[^"]*\btransferred,auto_paused_reason,human_agent_expires_at"\)/,f);
 }
});
test("worker performs eligibility check after lease but before planning or commit",()=>{
 const src=readFileSync("supabase/functions/flow-runtime-worker/index.ts","utf8");
 const claimed=src.indexOf('sb.rpc("flow_lease_due_runs"');
 const guard=src.indexOf("if(!canWakeDurableRun(wake,nowMs)){");
 const planner=src.indexOf("const plan=planUntilWait(");
 const commit=src.indexOf('sb.rpc("flow_commit_run_step"');
 assert(claimed>0&&guard>claimed&&planner>guard&&commit>planner);
 assert.match(src,/FLOW_DURABLE_CANARY_ACCOUNT_ID/);
 assert.match(src,/wake not eligible for current canary activation/);
});

const workerSrc=readFileSync("supabase/functions/flow-runtime-worker/index.ts","utf8");
test("permanent ineligibility ends the run with a lifecycle reason",()=>{
 assert.equal(wakeEndReason(safe,now),null);
 for(const [field,value,reason] of [
  ["revisionIsActive",false,"revision_inactive"],["activeRevision",null,"revision_inactive"],
  ["activeRevision",5,"revision_inactive"],
  ["humanTransferred",true,"human_takeover"],["humanTransferred","yes","human_takeover"],
  ["tenantFound",false,"ineligible"],["accountTenantMatches",false,"ineligible"],
  ["conversationTenantMatches",false,"ineligible"],["conversationAccountMatches",false,"ineligible"]
 ] as const){
  assert.equal(canWakeDurableRun({...safe,[field]:value},now),false,field);
  assert.equal(wakeEndReason({...safe,[field]:value},now),reason,field+"="+String(value));
 }
 for(const [at,reason] of [["2026-10-29T19:00:00Z","manual_takeover"],[null,"manual_takeover"],
  ["not a date","manual_takeover"],[42,"manual_takeover"],["2026-10-29T17:00:00Z","ai_handoff"]] as const)
  assert.equal(wakeEndReason(takeover(at,reason),now),"human_takeover",String(at)+"/"+reason);
 // Expired manual takeover: not a takeover, the run proceeds (not ended).
 assert.equal(wakeEndReason(takeover("2026-10-29T17:00:00Z"),now),null);
});
// Old behaviour (130000-era worker) ENDED these runs as 'ineligible'; a
// temporary pause must leave them sleeping so they resume when re-enabled.
test("temporary pauses never end a sleeping run",()=>{
 for(const [field,value] of [
  ["tenantActive",false],["tenantActive",undefined],["accountActive",false],
  ["agentEnabled",false],["agentEnabled",null],["autoReply",false],["autoReply",undefined]
 ] as const){
  assert.equal(canWakeDurableRun({...safe,[field]:value},now),false,field);
  assert.equal(wakeEndReason({...safe,[field]:value},now),null,field+"="+String(value));
 }
});
test("operator rollout gates never end a sleeping run",()=>{
 for(const [field,value] of [
  ["globalEnabled",false],["tenantSwitchEnabled",false],
  ["tenantProductionApproved",false],["canaryAccountId","another-account"],
  ["canaryAccountId",undefined],["runPlatform","facebook"],["runStatus","completed"]
 ] as const){
  assert.equal(canWakeDurableRun({...safe,[field]:value},now),false,field);
  assert.equal(wakeEndReason({...safe,[field]:value},now),null,field);
 }
});
test("ineligible wake is cancelled tenant-scoped before planning; expiry sweep is best-effort",()=>{
 const guard=workerSrc.indexOf("if(!canWakeDurableRun(wake,nowMs)){");
 const cancel=workerSrc.indexOf('sb.rpc("flow_cancel_run"');
 const planner=workerSrc.indexOf("const plan=planUntilWait(");
 assert(guard>0&&cancel>guard&&planner>cancel);
 assert.match(workerSrc,/p_tenant:tenantId,p_run:runId,p_reason:reason,p_expect_status:"sleeping"/);
 assert.match(workerSrc,/if\(!ee&&ended===true\)\{\s*cancelled\+\+;/);
 const gateOff=workerSrc.indexOf('return answer("flow global switch OFF",423)');
 const sweep=workerSrc.indexOf('sb.rpc("flow_expire_waiting_runs"');
 const lease=workerSrc.indexOf('sb.rpc("flow_lease_due_runs"');
 assert(gateOff>0&&sweep>gateOff&&lease>sweep);
 // A failed sweep logs only; it never returns early or blocks the lease.
 assert.match(workerSrc,/if\(xe\)console\.error\("\[flow-worker\] expiry sweep failed"/);
 assert.match(workerSrc,/sends:0/);
});

// ---- Wake path image guard (same rule as the ingress liveEffectKinds/safePlan).
import {wakeMediaSendEnabled,wakeEffectsMediaAllowed,endWakeForDisallowedMedia,
 WAKE_MEDIA_END_REASON,type WakeRpc} from "../supabase/functions/flow-runtime-worker/mediaGuard.ts";
import {planUntilWait,seedFromEventKey} from "../src/flow/runtimeChain.ts";

const WPROJECT="https://abcd1234.supabase.co";
const WIMG=WPROJECT+"/storage/v1/object/public/flow-media/u1/0f8c2b1e-1111-4222-8333-444455556666.webp";
const WT={id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}};
const WE=(source:string,target:string)=>({source,target,sourceHandle:"next"});
const wtxt=(nid:string,text:string)=>({id:nid,data:{kind:"message",text,image:"",options:[],contentBlocks:[]}});
// trigger -> delay -> (text+image | text-only) -> text
const delayDoc=(after:unknown)=>({version:3,name:"wake",nodes:[WT,
 {id:"sleep",data:{kind:"delay",delayValue:1,delayUnit:"minutes"}},after,wtxt("bye","شكراً")],
 edges:[WE("start","sleep"),WE("sleep","pic"),WE("pic","bye")]});
const imgNode=(url:unknown)=>({id:"pic",data:{kind:"message",text:"صورة المنتج",image:"",options:[],
 contentBlocks:[{id:"b1",type:"text",text:"هذا منتجنا"},{id:"b2",type:"image",url}]}});
const WAKE_AT=Date.parse("2026-10-29T17:00:00Z");
const TENANT="00000000-0000-4000-8000-0000000000aa",OTHER="00000000-0000-4000-8000-0000000000bb";

/**
 * Fake store + tick mirroring flow-runtime-worker/index.ts after eligibility:
 * lease (sleeping+due only, as flow_lease_due_runs), plan, image guard,
 * flow_cancel_run (tenant-scoped, expect 'sleeping', sets 'blocked') or commit.
 */
function wakeHarness(doc:any,env:Record<string,string|undefined>){
 const run={tenant_id:TENANT,id:"run-1",run_status:"sleeping",ended_reason:null as string|null,
  current_node_id:"sleep",step_count:2,variables:{},wake_at:WAKE_AT};
 const calls:{fn:string;args:any}[]=[];
 const rpc:WakeRpc=async(fn,args)=>{
  calls.push({fn,args});
  if(fn==="flow_cancel_run"){
   if(args.p_tenant!==run.tenant_id||args.p_run!==run.id||run.run_status!==args.p_expect_status)
    return {data:false,error:null};
   run.run_status="blocked";run.ended_reason=String(args.p_reason);
   return {data:true,error:null};
  }
  if(fn==="flow_commit_run_step"){run.run_status=String(args.p_next_status);return {data:true,error:null};}
  return {data:null,error:{code:"unexpected"}};
 };
 const tick=async()=>{
  const out={committed:0,cancelled:0,blocked:0};
  const leased=run.run_status==="sleeping"&&run.wake_at<=WAKE_AT+60_000?[run]:[];
  for(const r of leased){
   try{
    const plan=planUntilWait(doc,{flowId:"f",revision:4,nodeId:r.current_node_id,
     status:"sleeping",stepCount:r.step_count,variables:r.variables,wakeAt:r.wake_at},
     {eventKey:"scheduled:"+r.id,nowMs:WAKE_AT+60_000,seed:seedFromEventKey("scheduled:"+r.id)});
    if(plan.error||plan.state.status==="blocked")throw Error("blocked runtime plan");
    if(!wakeEffectsMediaAllowed(plan.effects,
      wakeMediaSendEnabled(()=>env.FLOW_MEDIA_SEND_ENABLED),env.SUPABASE_URL)){
     if(await endWakeForDisallowedMedia(rpc,r.tenant_id,r.id)){out.cancelled++;continue;}
     throw Error("image effect not allowed, run not ended");
    }
    await rpc("flow_commit_run_step",{p_tenant:r.tenant_id,p_run:r.id,p_next_status:plan.state.status,
     p_effects:plan.effects.map(e=>({kind:e.kind,idempotencyKey:e.idempotencyKey,payload:e}))});
    out.committed++;
   }catch{out.blocked++;}
  }
  return out;
 };
 return {run,calls,tick};
}
const commits=(calls:{fn:string}[])=>calls.filter(c=>c.fn==="flow_commit_run_step");
const ON={FLOW_MEDIA_SEND_ENABLED:"true",SUPABASE_URL:WPROJECT};

test("wake: delay -> image with FLOW_MEDIA_SEND_ENABLED OFF commits nothing and ends the run once",async()=>{
 for(const env of [{SUPABASE_URL:WPROJECT},{FLOW_MEDIA_SEND_ENABLED:"false",SUPABASE_URL:WPROJECT},
  {FLOW_MEDIA_SEND_ENABLED:"1",SUPABASE_URL:WPROJECT},{FLOW_MEDIA_SEND_ENABLED:"TRUE",SUPABASE_URL:WPROJECT}]){
  const h=wakeHarness(delayDoc(imgNode(WIMG)),env);
  assert.deepEqual(await h.tick(),{committed:0,cancelled:1,blocked:0},JSON.stringify(env));
  assert.equal(commits(h.calls).length,0,"nothing committed");
  assert.deepEqual(h.calls,[{fn:"flow_cancel_run",args:{p_tenant:TENANT,p_run:"run-1",
   p_reason:"ineligible",p_expect_status:"sleeping"}}]);
  assert.equal(h.run.run_status,"blocked");assert.equal(h.run.ended_reason,"ineligible");
  // Next tick: the blocked run is not leased again -> no repeat, no commit.
  assert.deepEqual(await h.tick(),{committed:0,cancelled:0,blocked:0});
  assert.equal(h.calls.length,1,"no repeat on the next tick");
 }
 assert.equal(WAKE_MEDIA_END_REASON,"ineligible");
 // A throwing flag reader is OFF.
 assert.equal(wakeMediaSendEnabled(()=>{throw Error("no Deno");}),false);
});
test("wake: delay -> image with the flag ON and a valid flow-media URL is committed in order",async()=>{
 const h=wakeHarness(delayDoc(imgNode(WIMG)),ON);
 assert.deepEqual(await h.tick(),{committed:1,cancelled:0,blocked:0});
 const c=commits(h.calls);
 assert.equal(c.length,1);
 assert.equal(h.calls.some(x=>x.fn==="flow_cancel_run"),false);
 assert.deepEqual(c[0].args.p_effects.map((e:any)=>[e.kind,e.payload.seq]),
  [["message",0],["message",1],["message_image",2],["message",3]]);
 assert.equal(c[0].args.p_effects[2].payload.url,WIMG);
 assert.equal(c[0].args.p_tenant,TENANT);
});
test("wake: flag ON with an invalid / data: / wrong-host image URL commits nothing and ends the run",async()=>{
 for(const [url,why] of [
  ["data:image/png;base64,AAAA","data: url"],
  [WIMG.replace("abcd1234.supabase.co","evil.example.com"),"wrong host"],
  [WIMG.replace("abcd1234.supabase.co","other9999.supabase.co"),"another project"],
  [WIMG.replace("https:","http:"),"http"],
  [WPROJECT+"/storage/v1/object/public/avatars/a.webp","other bucket"]] as const){
  const h=wakeHarness(delayDoc(imgNode(url)),ON);
  const r=await h.tick();
  assert.equal(commits(h.calls).length,0,why);
  if(h.calls.length){
   // Planner accepted the URL: the server-side guard ends the run.
   assert.deepEqual(r,{committed:0,cancelled:1,blocked:0},why);
   assert.equal(h.run.run_status,"blocked",why);assert.equal(h.run.ended_reason,"ineligible",why);
  }else assert.deepEqual(r,{committed:0,cancelled:0,blocked:1},why+" (refused by the planner)");
 }
 // The wrong-host case passes the pure planner and is caught only by the server guard.
 const wrong=wakeHarness(delayDoc(imgNode(WIMG.replace("abcd1234.supabase.co","evil.example.com"))),ON);
 assert.deepEqual(await wrong.tick(),{committed:0,cancelled:1,blocked:0});
 assert.deepEqual(await wrong.tick(),{committed:0,cancelled:0,blocked:0},"no repeat");
 // Direct guard checks (planner-independent).
 const img=(url:unknown,nodeId:unknown="pic")=>[{kind:"message"},{kind:"message_image",nodeId,url}];
 assert.equal(wakeEffectsMediaAllowed(img(WIMG),true,WPROJECT),true);
 assert.equal(wakeEffectsMediaAllowed(img("data:image/png;base64,AAAA"),true,WPROJECT),false);
 assert.equal(wakeEffectsMediaAllowed(img(WIMG,"<bad>"),true,WPROJECT),false,"unsafe node id");
 assert.equal(wakeEffectsMediaAllowed(img(undefined),true,WPROJECT),false);
 assert.equal(wakeEffectsMediaAllowed(img(WIMG),true,""),false,"no SUPABASE_URL: fail closed");
 assert.equal(wakeEffectsMediaAllowed(img(WIMG),false,WPROJECT),false);
});
test("wake: flag OFF, text-only after a delay is committed exactly as before",async()=>{
 for(const env of [{},{SUPABASE_URL:WPROJECT},ON]){
  const h=wakeHarness(delayDoc(wtxt("pic","مرحباً مجدداً")),env);
  assert.deepEqual(await h.tick(),{committed:1,cancelled:0,blocked:0});
  assert.deepEqual(h.calls.map(c=>c.fn),["flow_commit_run_step"]);
  assert.deepEqual(commits(h.calls)[0].args.p_effects.map((e:any)=>e.kind),["message","message"]);
 }
 assert.equal(wakeEffectsMediaAllowed([{kind:"message"},{kind:"delay"},{kind:"question"}],false,""),true);
});
test("ended media run is tenant-scoped: a cancel for another tenant ends nothing",async()=>{
 const calls:any[]=[];
 const rpc:WakeRpc=async(fn,args)=>{calls.push({fn,args});return {data:args.p_tenant===TENANT,error:null};};
 assert.equal(await endWakeForDisallowedMedia(rpc,OTHER,"run-1"),false);
 assert.equal(await endWakeForDisallowedMedia(async()=>({data:null,error:{code:"P0001"}}),TENANT,"run-1"),false);
 assert.equal(await endWakeForDisallowedMedia(rpc,TENANT,"run-1"),true);
 assert.deepEqual(calls[1].args,{p_tenant:TENANT,p_run:"run-1",p_reason:"ineligible",p_expect_status:"sleeping"});
});
test("worker source: image guard runs after planning, before any commit, and ends via flow_cancel_run",()=>{
 const planner=workerSrc.indexOf("const plan=planUntilWait(");
 const ai=workerSrc.indexOf('throw Error("knowledge AI requires trusted handler, no emission")');
 const guard=workerSrc.indexOf("if(!wakeEffectsMediaAllowed(plan.effects,");
 const end=workerSrc.indexOf("if(await endWakeForDisallowedMedia((fn,args)=>sb.rpc(fn,args),tenantId,runId)){");
 const commit=workerSrc.indexOf('sb.rpc("flow_commit_run_step"');
 assert(planner>0&&ai>planner&&guard>ai&&end>guard&&commit>end);
 assert.match(workerSrc,/wakeMediaSendEnabled\(\(\)=>Deno\.env\.get\("FLOW_MEDIA_SEND_ENABLED"\)\),base\)\)\{/);
 assert.match(workerSrc,/cancelled\+\+;\s*console\.warn\("\[flow-worker\] image wake ended",\{tenantId,runId,reason:WAKE_MEDIA_END_REASON\}\);\s*continue;\s*\}\s*throw Error\("image effect not allowed, run not ended"\);/);
 assert.equal((workerSrc.match(/Deno\.env\.get\("FLOW_MEDIA_SEND_ENABLED"\)/g)??[]).length,1);
 assert.equal((workerSrc.match(/sb\.rpc\("flow_commit_run_step"/g)??[]).length,1);
 const guardSrc=readFileSync("supabase/functions/flow-runtime-worker/mediaGuard.ts","utf8");
 assert.match(guardSrc,/import \{isAllowedFlowImageUrl\} from "\.\.\/flow-outbox-worker\/mediaPolicy\.ts";/);
 assert.match(guardSrc,/try\{return read\(\)==="true";\}catch\{return false;\}/);
 assert.match(workerSrc,/sends:0/);
});
