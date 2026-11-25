// R1 — Instagram webhook ingress latency: bounded stage timings, a hard deadline on the
// Meta sender-profile request, and profile enrichment deferred AFTER the response.
//
// Behavioural where the code can be executed without Deno (the new pure modules, the REAL
// fetchSenderProfile and the REAL end-of-handler snippet sliced out of index.ts), plus source
// invariants for the ordering the design depends on. No network, no Supabase, no Meta.
// Run: node --experimental-strip-types --test tests/webhook-ingress-r1.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import {createStageTimer,NOOP_STAGE_TIMER,STAGES,MAX_STAGE_MS} from "../supabase/functions/milan-api/webhookTimings.ts";
import {runBackgroundJobs,failureCategory} from "../supabase/functions/milan-api/backgroundWork.ts";
import {webhookStatusFor,BATCH_EVENT_ERROR} from "../supabase/functions/milan-api/inboundRoutingRetry.ts";

const IDX=readFileSync("supabase/functions/milan-api/index.ts","utf8");
const tick=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const strip=(s:string)=>stripTypeScriptTypes(s,{mode:"strip"});

// ============================================================ stage timings
test("timer: only the closed stage set, whole non-negative ms, clamped, never throws",async()=>{
 let t=0;const clock=()=>t;
 const timer=createStageTimer(clock);
 const end=timer.start("verify");t=12.4;end();end();// idempotent
 t=100;const e2=timer.start("lookup");t=130.6;e2();
 const e3=timer.start("lookup");t=135.6;e3();// accumulates
 assert.deepEqual(timer.snapshot(),{verify:12,lookup:36});
 for(const k of Object.keys(timer.snapshot()))assert.ok((STAGES as readonly string[]).includes(k));
 // unknown stage names (never produced by the code, but hostile callers) are dropped
 const e4=timer.start("evil\nstage" as any);t=999;e4();
 assert.ok(!JSON.stringify(timer.snapshot()).includes("evil"));
 // clamp
 const big=createStageTimer(()=>t);t=0;const e5=big.start("total");t=1e12;e5();
 assert.equal(big.snapshot().total,MAX_STAGE_MS);
 // a broken clock records 0 and never throws
 const bad=createStageTimer(()=>{throw new Error("clock SECRET");});
 assert.doesNotThrow(()=>bad.start("verify")());
 assert.ok(!JSON.stringify(bad.snapshot()).includes("SECRET"));
});
test("timer.span records on success AND on rejection and rethrows the original error",async()=>{
 let t=0;const timer=createStageTimer(()=>t);
 assert.equal(await timer.span("persist",async()=>{t+=40;return "ok";}),"ok");
 await assert.rejects(timer.span("persist",async()=>{t+=10;throw new RangeError("boom");}),RangeError);
 assert.equal(timer.snapshot().persist,50);
 assert.deepEqual(NOOP_STAGE_TIMER.snapshot(),{});
 assert.equal(await NOOP_STAGE_TIMER.span("route",async()=>7),7);
});

// ============================================================ background execution
test("background: no jobs -> none; jobs never rejected into the caller",async()=>{
 assert.equal(await runBackgroundJobs([],null),"none");
});
test("background with waitUntil: returns BEFORE the slow job finishes, work is handed to waitUntil and settles",async()=>{
 let finished=false;let registered:Promise<unknown>|null=null;
 const mode=await runBackgroundJobs([async()=>{await tick(60);finished=true;}],(p)=>{registered=p;});
 assert.equal(mode,"background");
 assert.equal(finished,false,"the response path did not wait for the job");
 assert.ok(registered,"waitUntil received the work promise");
 await registered;assert.equal(finished,true);
});
test("background: a failing job is isolated, later jobs still run, only a fixed category is logged",async()=>{
 const warns:[string,unknown][]=[];const ran:string[]=[];
 let registered:Promise<unknown>|null=null;
 const SECRET="https://graph.instagram.com/v21.0/555?access_token=EAA-LEAKCANARY";
 const hostile:any={};Object.defineProperty(hostile,"name",{get(){throw new Error("hostile");}});
 await runBackgroundJobs([
  async()=>{ran.push("a");throw new TypeError(SECRET);},
  async()=>{ran.push("b");throw hostile;},
  async()=>{ran.push("c");},
 ],(p)=>{registered=p;},(m,f)=>warns.push([m,f]));
 await registered;
 assert.deepEqual(ran,["a","b","c"]);
 assert.deepEqual(warns,[["[instagram_webhook] background_task_failed",{category:"network"}],
  ["[instagram_webhook] background_task_failed",{category:"unknown"}]]);
 assert.ok(!JSON.stringify(warns).includes("LEAKCANARY")&&!JSON.stringify(warns).includes("graph."));
 assert.equal(failureCategory(Object.assign(new Error("x"),{name:"TimeoutError"})),"timeout");
});
test("background: without waitUntil (or if registering throws) the work is awaited inline, never dropped",async()=>{
 let done=0;const job=async()=>{await tick(10);done++;};
 assert.equal(await runBackgroundJobs([job],null),"inline");assert.equal(done,1);
 assert.equal(await runBackgroundJobs([job],undefined),"inline");assert.equal(done,2);
 assert.equal(await runBackgroundJobs([job],()=>{throw new Error("no runtime");}),"inline");
 assert.equal(done,3);
});

// ============================================================ REAL fetchSenderProfile deadline
const FSP_SRC=(()=>{
 const a="async function fetchSenderProfile(",b="async function handleIncomingWebhookMessage(";
 const i=IDX.indexOf(a),j=IDX.indexOf(b,i);assert.ok(i>=0&&j>i);return IDX.slice(i,j);
})();
function loadFsp(fetch:any,console:any){
 return new Function("fetch","console",strip(FSP_SRC)+"\nreturn fetchSenderProfile;")(fetch,console);
}
const cons=()=>{const logs:[string,unknown[]][]=[];const c:any={};
 for(const k of ["log","info","warn","error","debug"])c[k]=(...a:unknown[])=>logs.push([k,a]);return {logs,c};};
const TOKEN="IGQVJ-LEAKCANARY-r1-token";
// AbortSignal.timeout() uses an unref'ed timer in Node: keep the loop alive while a test waits for it.
const keepAlive=()=>{const h=setInterval(()=>{},10);return ()=>clearInterval(h);};
test("profile request: a stalled connection is aborted at the deadline -> {null,null}, fixed 'timeout' category only",async()=>{
 const stop=keepAlive();try{
 const {logs,c}=cons();let sawSignal=false;
 const fsp=loadFsp((url:string,init:any)=>new Promise((_,rej)=>{
  sawSignal=init.signal instanceof AbortSignal;
  init.signal.addEventListener("abort",()=>rej(init.signal.reason));
 }),c);
 const t0=Date.now();
 const r=await fsp({channel:"instagram",senderId:"555",token:TOKEN,timeoutMs:40});
 assert.deepEqual(r,{name:null,avatar:null});
 assert.ok(sawSignal);assert.ok(Date.now()-t0<2000,"returned promptly at the deadline");
 assert.deepEqual(logs,[["warn",["[fetchSenderProfile] failed",{category:"timeout"}]]]);
 assert.ok(!JSON.stringify(logs).includes("LEAKCANARY"));
 }finally{stop();}
});
test("profile request: a stalled RESPONSE BODY is covered by the same deadline",async()=>{
 const stop=keepAlive();try{
 const {logs,c}=cons();
 const fsp=loadFsp((url:string,init:any)=>Promise.resolve({ok:true,status:200,
  json:()=>new Promise((_,rej)=>init.signal.addEventListener("abort",()=>rej(init.signal.reason)))}),c);
 assert.deepEqual(await fsp({channel:"facebook",senderId:"555",token:TOKEN,timeoutMs:40}),{name:null,avatar:null});
 assert.deepEqual(logs,[["warn",["[fetchSenderProfile] failed",{category:"timeout"}]]]);
 }finally{stop();}
});
test("profile request: default deadline is set (3000 ms) and a fast success is unchanged",async()=>{
 const {c}=cons();let init:any;
 const r=await loadFsp(async(_u:string,i:any)=>{init=i;return {ok:true,status:200,json:async()=>({name:" Ann ",profile_pic:"https://x.test/a.jpg"})};},c)(
  {channel:"instagram",senderId:"555",token:TOKEN});
 assert.deepEqual(r,{name:"Ann",avatar:"https://x.test/a.jpg"});
 assert.ok(init.signal instanceof AbortSignal&&init.signal.aborted===false);
 assert.match(FSP_SRC,/: 3000;/,"default deadline literal");
});

// ============================================================ REAL end-of-handler snippet
const IG=(()=>{
 const a=IDX.indexOf('case "instagram_webhook": {');
 // the instagram_webhook case ends where the next case (recovery tick) begins
 const b=IDX.indexOf('case "inbound_recovery_tick": {',a);assert.ok(a>0&&b>a);return IDX.slice(a,b);
})();
const TAIL=(()=>{
 const a=IG.indexOf("const answerRetry = webhookStatusFor(igOutcomes) === 503;");
 const endMarker="return json({\n          received: true,\n        });";
 const b=IG.indexOf(endMarker,a);assert.ok(a>0&&b>a,"located the post-loop snippet");
 return IG.slice(a,b+endMarker.length);
})();
async function runTail(o:{outcomes:unknown[];jobs:Array<()=>Promise<unknown>>;waitUntil?:((p:Promise<unknown>)=>void)|null;timings?:Record<string,number>}){
 const logs:[string,unknown[]][]=[];
 const console_={log:(...a:unknown[])=>logs.push(["log",a]),warn:(...a:unknown[])=>logs.push(["warn",a]),error:(...a:unknown[])=>logs.push(["error",a])};
 const json=(body:unknown,status=200)=>({status,body});
 const timer={snapshot:()=>o.timings??{handle:42,total:57}};
 const run=new Function("webhookStatusFor","igOutcomes","runBackgroundJobs","profileJobs","timer","endTotal","json","console","globalThis",
  strip("async function __tail(){\n"+TAIL+"\n}")+"\nreturn __tail();");
 const g:any={EdgeRuntime:o.waitUntil===undefined?undefined:(o.waitUntil===null?{}:{waitUntil:o.waitUntil})};
 const res=await run(webhookStatusFor,o.outcomes,runBackgroundJobs,o.jobs,timer,()=>{},json,console_,g);
 return {res,logs};
}
test("tail: profile enrichment FAILURE never changes the 200 (inline fallback, no EdgeRuntime)",async()=>{
 const {res}=await runTail({outcomes:["saved",undefined],jobs:[async()=>{throw new Error("graph down");}]});
 assert.deepEqual(res,{status:200,body:{received:true}});
});
test("tail: 503 retry decision is unchanged and is NOT influenced by profile jobs",async()=>{
 for(const outcomes of [["retry"],[undefined,"retry"],[BATCH_EVENT_ERROR]]){
  const {res}=await runTail({outcomes,jobs:[async()=>{}],waitUntil:(p)=>void p});
  assert.deepEqual(res,{status:503,body:{error:"Flow routing temporarily unavailable"}},JSON.stringify(outcomes));
 }
 // terminal outcomes never produce a 503
 assert.equal((await runTail({outcomes:["handled","fallback",undefined],jobs:[]})).res.status,200);
});
test("tail: with waitUntil the response does NOT wait for a slow profile job, and the job still completes",async()=>{
 let done=false;let work:Promise<unknown>|null=null;
 const {res}=await runTail({outcomes:[undefined],jobs:[async()=>{await tick(80);done=true;}],waitUntil:(p)=>{work=p;}});
 assert.equal(res.status,200);assert.equal(done,false);
 await work;assert.equal(done,true);
});
test("tail: stage_timings log carries only the closed numeric stages + job count + mode",async()=>{
 const {logs}=await runTail({outcomes:[undefined],jobs:[async()=>{}],timings:{verify:3,lookup:5,handle:900,conversation:120,persist:80,route:600,durable:550,total:1000},waitUntil:(p)=>void p});
 const l=logs.filter(([,a])=>a[0]==="[instagram_webhook] stage_timings");
 assert.equal(l.length,1);
 const fields=l[0][1][1] as Record<string,unknown>;
 for(const [k,v] of Object.entries(fields)){
  if(k==="profile_mode")assert.ok(["none","background","inline"].includes(v as string));
  else{assert.ok([...STAGES,"profile_jobs"].includes(k as any),"closed field set: "+k);assert.equal(typeof v,"number");}
 }
 assert.equal(fields.profile_mode,"background");assert.equal(fields.profile_jobs,1);
 // quiet requests (no message handled, fast) are not logged
 const q=await runTail({outcomes:[],jobs:[],timings:{verify:1,total:4}});
 assert.equal(q.logs.filter(([,a])=>a[0]==="[instagram_webhook] stage_timings").length,0);
});

// ============================================================ source invariants (ordering)
test("invariant: durable ingress/routing is awaited BEFORE anything is deferred; signature precedes everything",()=>{
 const sig=IG.indexOf("const sigOk = await verifyMetaSignature(");
 const firstHandle=IG.indexOf("handleIncomingWebhookMessage(");
 const bg=IG.indexOf("await runBackgroundJobs(");
 const answer=IG.indexOf("const answerRetry = webhookStatusFor(igOutcomes) === 503;");
 const push=IG.indexOf("profileJobs.push(async () => {");
 assert.ok(sig>0&&sig<firstHandle&&firstHandle<push&&push<answer&&answer<bg,"verify < handle < job registration < 503 decision < background");
 assert.equal(IG.split("await runBackgroundJobs(").length-1,1,"exactly one scheduling point");
 assert.equal(IG.split("handleIncomingWebhookMessage(").length-1,2,"same two ingress call sites");
 // both ingress calls stay awaited inside runBatchEvent (errors still become 503 outcomes)
 assert.equal(IG.split("await runBatchEvent(() => handleIncomingWebhookMessage(").length-1,2);
 // a Meta redelivery duplicate still skips before ANY handling or profile job
 const dup=IG.indexOf("duplicate skipped:");
 assert.ok(dup>0&&dup<IG.indexOf("profileJobs.push("));
 assert.ok(!IG.slice(IG.lastIndexOf("if (dup && dup.length > 0) {"),dup+200).includes("profileJobs.push"));
 // the answer after the (possibly deferred) work is still the unchanged pair
 assert.match(IG,/if \(answerRetry\) \{\n\s+return json\(\{ error: "Flow routing temporarily unavailable" \}, 503\);\n\s+\}\n\n\s+return json\(\{\n\s+received: true,\n\s+\}\);/);
});
test("invariant: the Meta Graph call exists only inside the deferred job and the profile step never gates acceptance",()=>{
 const push=IG.indexOf("profileJobs.push(async () => {");
 const fetchAt=IG.indexOf("await fetchSenderProfile({");
 assert.ok(push>0&&fetchAt>push);
 assert.equal(IG.split("fetchSenderProfile(").length-1,1);
 // no await of the profile step outside runBackgroundJobs
 assert.ok(!IG.slice(0,push).includes("fetchSenderProfile("));
 // the profile job swallows its own errors (existing catch) and logs a fixed category only
 assert.match(IG,/sender profile step skipped",\n\s+\{ category: fetchErrorCategory\(e\) \}/);
 // waitUntil is read defensively and absence falls back to inline
 assert.match(IG,/typeof edgeRuntime\.waitUntil === "function"\n\s+\? \(p\) => edgeRuntime\.waitUntil!\(p\)\n\s+: null,/);
});
test("invariant: no sensitive field reaches the new log calls (stage_timings / profile_timing)",()=>{
 for(const marker of ['console.log("[instagram_webhook] stage_timings", {','console.log("[instagram_webhook] profile_timing", {']){
  const a=IG.indexOf(marker);assert.ok(a>0,marker);
  const call=IG.slice(a,IG.indexOf("});",a)+3);
  for(const bad of ["msg","chatId","senderId","account","token","text","raw","body","signature","name","avatar","tenant"])
   assert.ok(!new RegExp("\\b"+bad+"\\b").test(call.replace(/\[instagram_webhook\][^"]*/,"")),`${marker.slice(0,40)}… must not reference ${bad}`);
 }
});
