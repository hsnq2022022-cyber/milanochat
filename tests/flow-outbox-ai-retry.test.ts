// knowledge_ai outbox retry policy: outcome classification, bounded backoff,
// terminal states, duplicate prevention and queue recovery.
// Run: node --experimental-strip-types --test tests/flow-outbox-ai-retry.test.ts
// The SQL transitions themselves are exercised against a throwaway local
// PostgreSQL in tests/flow-outbox-ai-retry.test.mjs; the in-memory store
// below mirrors those functions so the worker orchestration can be tested.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {answerWithVerifiedKnowledge,answerWithVerifiedKnowledgeOutcome,
 classifyKnowledgeError,knowledgeHttpError,openAIKnowledgeDependencies,KnowledgeError,
 type KnowledgeOutcome} from "../supabase/functions/flow-outbox-worker/flowKnowledge.ts";
import {AI_MAX_ATTEMPTS,AI_CLAIM_LEASE_SECONDS,aiRetryDelaySeconds,decideKnowledgeOutcome,
 resolveKnowledgeEffect,safeAiErrorCode,recoverKnowledgeCharge,AI_ANSWER_MISSING_CODE,
 BILLING_BLOCKED_ANSWER_MISSING,type AiClaim,type AiDecision} from
 "../supabase/functions/flow-outbox-worker/knowledgeRetry.ts";
import {executeOnce} from "../supabase/functions/flow-outbox-worker/executeOnce.ts";
import {heldByEarlierEffect,statusAfterOutcome,type OrderRow}
 from "../supabase/functions/flow-outbox-worker/effectOrder.ts";

// ------------------------------------------------------------ knowledge outcomes
const rowId="77777777-7777-4777-8777-777777777771";
const content="Price is 1000 IQD for the item.";
function kb(opts:{rows?:unknown[];rpcError?:boolean}={}){
 return {
  rpc:async()=>opts.rpcError?{data:null,error:{code:"57014"}}:
   {data:opts.rows??[{id:rowId,content,similarity:0.9}],error:null},
  from:(table:string)=>{
   const q={select:()=>q,eq:()=>q,in:()=>q,
    limit:async()=>({data:table==="knowledge_chunks"?
     [{id:rowId,tenant_id:"A",content,source_id:"src"}]:
     [{id:"src",tenant_id:"A",status:"indexed"}],error:null})};
   return q;
  }
 } as never;
}
const scope={tenantId:"A",publishedTenantId:"A",conversationTenantId:"A",
 agentEnabled:true,humanTakeover:false,credits:5,businessName:"Test"};
const grounded={embed:async()=>[0.1,0.2],
 complete:async()=>({answer:"Price is 1000 IQD",grounded:true,supporting_quote:content})};

test("outcome: grounded answer, genuine no-knowledge and ineligible are distinct",async()=>{
 assert.deepEqual(await answerWithVerifiedKnowledgeOutcome(kb(),scope,"How much?",grounded),
  {kind:"answer",text:"Price is 1000 IQD"});
 let llmCalls=0;
 const counting={...grounded,complete:async()=>{llmCalls++;return grounded.complete();}};
 assert.deepEqual(await answerWithVerifiedKnowledgeOutcome(kb({rows:[]}),scope,"How much?",counting),
  {kind:"no_knowledge"});
 assert.equal(llmCalls,0,"no grounded evidence: the model is never called");
 assert.deepEqual(await answerWithVerifiedKnowledgeOutcome(kb(),scope,"How much?",
  {...grounded,complete:async()=>({answer:"x",grounded:false,supporting_quote:""})}),{kind:"no_knowledge"});
 assert.deepEqual(await answerWithVerifiedKnowledgeOutcome(kb(),scope,"How much?",
  {...grounded,complete:async()=>({answer:"invented",grounded:true,supporting_quote:"This quote is made up."})}),
  {kind:"no_knowledge"});
 assert.deepEqual(await answerWithVerifiedKnowledgeOutcome(kb(),{...scope,conversationTenantId:"B"},
  "How much?",grounded),{kind:"ineligible"});
 assert.deepEqual(await answerWithVerifiedKnowledgeOutcome(kb(),scope,"  ",grounded),{kind:"ineligible"});
});

test("outcome: transient vs permanent provider failures are classified, never thrown",async()=>{
 const fail=(e:unknown)=>({...grounded,embed:async()=>{throw e;}});
 const cases:[unknown,KnowledgeOutcome][]=[
  [knowledgeHttpError("Embedding",429),{kind:"transient",code:"ai_http_429"}],
  [knowledgeHttpError("Embedding",503),{kind:"transient",code:"ai_http_5xx"}],
  [knowledgeHttpError("LLM",408),{kind:"transient",code:"ai_http_408"}],
  [new DOMException("timed out","TimeoutError"),{kind:"transient",code:"ai_timeout"}],
  [new TypeError("fetch failed"),{kind:"transient",code:"ai_network"}],
  [Error("weird"),{kind:"transient",code:"ai_unknown"}],
  [knowledgeHttpError("LLM",401),{kind:"permanent",code:"ai_http_401"}],
  [knowledgeHttpError("LLM",400),{kind:"permanent",code:"ai_http_400"}],
  [new KnowledgeError("LLM key missing","ai_config_missing",false),{kind:"permanent",code:"ai_config_missing"}],
 ];
 for(const [err,want] of cases)
  assert.deepEqual(await answerWithVerifiedKnowledgeOutcome(kb(),scope,"q?",fail(err)),want,String(err));
 assert.deepEqual(await answerWithVerifiedKnowledgeOutcome(kb({rpcError:true}),scope,"q?",grounded),
  {kind:"transient",code:"rag_lookup_failed"});
 assert.deepEqual(await answerWithVerifiedKnowledgeOutcome(kb(),scope,"q?",{...grounded,embed:async()=>[]}),
  {kind:"transient",code:"ai_bad_embedding"});
 assert.deepEqual(classifyKnowledgeError(null),{kind:"transient",code:"ai_unknown"});
});

test("backward compatible API: string|null, provider errors still throw with old wording",async()=>{
 assert.equal(await answerWithVerifiedKnowledge(kb(),scope,"How much?",grounded),"Price is 1000 IQD");
 assert.equal(await answerWithVerifiedKnowledge(kb({rows:[]}),scope,"How much?",grounded),null);
 await assert.rejects(()=>answerWithVerifiedKnowledge(kb({rpcError:true}),scope,"q?",grounded),
  /RAG lookup failed: 57014/);
 await assert.rejects(()=>answerWithVerifiedKnowledge(kb(),scope,"q?",
  {...grounded,embed:async()=>{throw knowledgeHttpError("Embedding",500);}}),/Embedding HTTP 500/);
});

test("OpenAI dependencies raise typed errors (HTTP status, missing key) without leaking bodies",async()=>{
 const g=globalThis as unknown as {Deno?:unknown};
 const prev=g.Deno;
 const vars:Record<string,string>={LLM_API_KEY:"k"};
 g.Deno={env:{get:(n:string)=>vars[n]}};
 try{
  const status=(s:number)=>(async()=>new Response("secret body "+s,{status:s})) as unknown as typeof fetch;
  for(const [s,kind,code] of [[429,"transient","ai_http_429"],[500,"transient","ai_http_5xx"],
   [502,"transient","ai_http_5xx"],[401,"permanent","ai_http_401"],[403,"permanent","ai_http_403"]] as const){
   const out=await answerWithVerifiedKnowledgeOutcome(kb(),scope,"q?",openAIKnowledgeDependencies(status(s)));
   assert.deepEqual(out,{kind,code},String(s));
  }
  delete vars.LLM_API_KEY;
  const out=await answerWithVerifiedKnowledgeOutcome(kb(),scope,"q?",openAIKnowledgeDependencies(status(200)));
  assert.deepEqual(out,{kind:"permanent",code:"ai_config_missing"});
 }finally{g.Deno=prev;}
});

// ------------------------------------------------------------ policy
test("backoff: 1m/2m/4m/8m with at most +10% jitter, bounded attempts",()=>{
 assert.equal(AI_MAX_ATTEMPTS,5);
 assert.equal(AI_CLAIM_LEASE_SECONDS,120);
 assert.deepEqual([1,2,3,4].map(n=>aiRetryDelaySeconds(n,()=>0)),[60,120,240,480]);
 assert.deepEqual([1,2,3,4].map(n=>aiRetryDelaySeconds(n,()=>0.999999)),[66,132,264,528]);
 assert.equal(aiRetryDelaySeconds(9,()=>0),900,"capped");
 assert.equal(aiRetryDelaySeconds(Number.NaN,()=>Number.NaN),60);
 const r=(n:number)=>decideKnowledgeOutcome({kind:"transient",code:"ai_http_429"},n,()=>0);
 assert.deepEqual(r(1),{action:"finish",result:"retry",code:"ai_http_429",delaySeconds:60,exhausted:false});
 assert.equal((r(4) as {exhausted:boolean}).exhausted,false);
 assert.equal((r(5) as {exhausted:boolean}).exhausted,true);
 assert.deepEqual(decideKnowledgeOutcome({kind:"no_knowledge"},1),{action:"finish",result:"no_knowledge"});
 assert.deepEqual(decideKnowledgeOutcome({kind:"permanent",code:"ai_http_401"},1),
  {action:"finish",result:"permanent",code:"ai_http_401"});
 // An empty "answer" is a contract violation, retried, never sent or cancelled.
 assert.equal((decideKnowledgeOutcome({kind:"answer",text:"  "},1) as {result:string}).result,"retry");
});
test("error codes never carry free text",()=>{
 assert.equal(safeAiErrorCode("ai_http_429"),"ai_http_429");
 for(const bad of ["Bearer sk-123","customer said hi","A".repeat(10),"x".repeat(49),null,42])
  assert.equal(safeAiErrorCode(bad),"ai_unknown");
});

// ------------------------------------------------------------ in-memory mirror of the SQL
type Row={id:string;tenant:string;created:number;status:string;retryAt:number|null;
 aiAttempts:number;lastError:string|null;leaseToken:string|null;leaseUntil:number|null;
 answer:string|null;cancelReason:string|null;delivered:boolean};
class FakeDb{
 now=1_000_000;rows=new Map<string,Row>();sends=0;bills=0;modelCalls=0;tokens=0;
 add(id:string,created=this.now){this.rows.set(id,{id,tenant:"A",created,status:"pending",retryAt:null,
  aiAttempts:0,lastError:null,leaseToken:null,leaseUntil:null,answer:null,cancelReason:null,delivered:false});}
 /** Mirrors the worker list filter: pending/charge_pending, or retry_wait whose retry_at is due. */
 list(limit=50){return [...this.rows.values()].filter(r=>r.status==="pending"||r.status==="charge_pending"||
  (r.status==="retry_wait"&&r.retryAt!==null&&r.retryAt<=this.now))
  .sort((a,b)=>a.created-b.created).slice(0,limit);}
 claim(tenant:string,id:string,max=AI_MAX_ATTEMPTS):AiClaim{
  const r=this.rows.get(id);
  if(!r||r.tenant!==tenant||!["pending","retry_wait"].includes(r.status))return {outcome:"not_claimable"};
  if(r.retryAt!==null&&r.retryAt>this.now)return {outcome:"not_due"};
  if(r.leaseUntil!==null&&r.leaseUntil>this.now)return {outcome:"busy"};
  if(r.answer){Object.assign(r,{status:"pending",retryAt:null,leaseToken:null,leaseUntil:null});
   return {outcome:"cached",answerEncrypted:r.answer};}
  if(r.aiAttempts>=max){Object.assign(r,{status:"dead_letter",cancelReason:"ai_retries_exhausted",
   retryAt:null,leaseToken:null,leaseUntil:null});return {outcome:"exhausted"};}
  const token="t"+(++this.tokens);
  Object.assign(r,{status:"pending",retryAt:null,aiAttempts:r.aiAttempts+1,leaseToken:token,
   leaseUntil:this.now+AI_CLAIM_LEASE_SECONDS*1000});
  return {outcome:"claimed",token,attempt:r.aiAttempts};
 }
 store(id:string,token:string,enc:string){const r=this.rows.get(id)!;
  if(r.status!=="pending"||r.leaseToken!==token||r.answer)return false;
  Object.assign(r,{answer:enc,lastError:null,leaseToken:null,leaseUntil:null});return true;}
 finish(id:string,token:string,d:Exclude<AiDecision,{action:"send"}>,max=AI_MAX_ATTEMPTS){
  const r=this.rows.get(id)!;
  if(r.status!=="pending"||r.leaseToken!==token||r.answer)return null;
  const clear={leaseToken:null,leaseUntil:null,retryAt:null};
  if(d.result==="no_knowledge"||d.result==="ineligible"){
   Object.assign(r,clear,{status:"cancelled",cancelReason:d.result});return "cancelled";}
  if(d.result==="permanent"||r.aiAttempts>=max){
   Object.assign(r,clear,{status:"dead_letter",lastError:d.code,
    cancelReason:d.result==="permanent"?"ai_unavailable":"ai_retries_exhausted"});return "dead_letter";}
  Object.assign(r,clear,{status:"retry_wait",lastError:d.code,
   retryAt:this.now+Math.min(Math.max(d.delaySeconds,30),1800)*1000});return "retry_wait";
 }
 /** flow_reserve_outbox_delivery: one-shot, pending only. */
 reserve(id:string){const r=this.rows.get(id)!;
  if(r.status!=="pending"||r.delivered)return false;r.status="leased";r.delivered=true;return true;}
}
type Gen=()=>Promise<KnowledgeOutcome>;
/** One worker tick for one effect: AI resolution then one-shot send + bill. */
async function tick(db:FakeDb,id:string,gen:Gen,hooks:{crashAfterStore?:boolean;crashInGenerate?:boolean}={}){
 const res=await resolveKnowledgeEffect({
  claim:async()=>db.claim("A",id),
  decrypt:async enc=>enc.replace(/^enc:v1:/,""),
  generate:async()=>{db.modelCalls++;if(hooks.crashInGenerate)throw new Error("process killed");return gen();},
  store:async(token,text)=>db.store(id,token,"enc:v1:"+text),
  finish:async(token,d)=>db.finish(id,token,d),
  random:()=>0
 });
 if(hooks.crashAfterStore)throw new Error("worker restarted");
 if(res.status!=="send")return res.key;
 return executeOnce({reserve:async()=>db.reserve(id),
  send:async()=>{db.sends++;return "mid-"+id;},
  confirm:async()=>{db.rows.get(id)!.status="charge_pending";return true;},
  persistAndBill:async()=>{db.bills++;db.rows.get(id)!.status="settled";return true;}});
}
const transient:Gen=async()=>({kind:"transient",code:"ai_http_5xx"});
const answer:Gen=async()=>({kind:"answer",text:"Price is 1000 IQD"});

test("transient error schedules backoff, does not cancel, keeps the effect", async()=>{
 const db=new FakeDb();db.add("e1");
 assert.equal(await tick(db,"e1",transient),"ai_retry_scheduled");
 const r=db.rows.get("e1")!;
 assert.equal(r.status,"retry_wait");assert.equal(r.cancelReason,null);
 assert.equal(r.aiAttempts,1);assert.equal(r.lastError,"ai_http_5xx");
 assert.equal(r.retryAt,db.now+60_000);
 assert.equal(db.sends,0);
 // Not due yet: not listed, and a direct claim is refused without a model call.
 assert.deepEqual(db.list().map(x=>x.id),[]);
 assert.equal(await tick(db,"e1",answer),"ai_not_due");
 assert.equal(db.modelCalls,1);
 // After the backoff the same effect succeeds and is sent exactly once.
 db.now+=60_000;
 assert.deepEqual(db.list().map(x=>x.id),["e1"]);
 assert.equal(await tick(db,"e1",answer),"settled");
 assert.equal(db.sends,1);assert.equal(db.bills,1);assert.equal(r.aiAttempts,2);
});

test("retries are bounded: 5 model calls, then dead_letter/ai_retries_exhausted, never cancelled", async()=>{
 const db=new FakeDb();db.add("e1");
 const delays:number[]=[];
 for(let i=1;i<=AI_MAX_ATTEMPTS;i++){
  const before=db.now;
  const key=await tick(db,"e1",transient);
  const r=db.rows.get("e1")!;
  if(i<AI_MAX_ATTEMPTS){assert.equal(key,"ai_retry_scheduled");delays.push((r.retryAt!-before)/1000);
   db.now=r.retryAt!;}
  else assert.equal(key,"dead_letter_ai_retries_exhausted");
 }
 assert.deepEqual(delays,[60,120,240,480]);
 const r=db.rows.get("e1")!;
 assert.equal(r.status,"dead_letter");assert.equal(r.cancelReason,"ai_retries_exhausted");
 assert.equal(r.lastError,"ai_http_5xx");
 assert.equal(db.modelCalls,AI_MAX_ATTEMPTS);
 db.now+=3_600_000;
 assert.equal(await tick(db,"e1",answer),"ai_not_claimable");
 assert.equal(db.modelCalls,AI_MAX_ATTEMPTS);assert.equal(db.sends,0);assert.equal(db.bills,0);
 // Owner review surfaces dead_letter (not cancelled) with this reason.
 const review=readFileSync("supabase/functions/flow-delivery-review/review.ts","utf8");
 assert.match(review,/FAILED_OUTBOX_STATUSES = \["uncertain", "dead_letter", "billing_blocked"\]/);
 assert.match(review,/OUTBOX_LIFECYCLE_COLUMNS = OUTBOX_BASE_COLUMNS \+ ",cancel_reason,cancelled_at"/);
});

test("no-knowledge is terminal, distinct from transient, and never calls the model again", async()=>{
 const db=new FakeDb();db.add("e1");
 assert.equal(await tick(db,"e1",async()=>({kind:"no_knowledge"})),"cancelled_no_knowledge");
 const r=db.rows.get("e1")!;
 assert.equal(r.status,"cancelled");assert.equal(r.cancelReason,"no_knowledge");
 assert.equal(r.lastError,null);assert.equal(r.retryAt,null);
 db.now+=3_600_000;
 assert.equal(await tick(db,"e1",answer),"ai_not_claimable");
 assert.equal(db.modelCalls,1);assert.equal(db.sends,0);
});

test("permanent error is terminal immediately: dead_letter/ai_unavailable after one call", async()=>{
 const db=new FakeDb();db.add("e1");
 assert.equal(await tick(db,"e1",async()=>({kind:"permanent",code:"ai_http_401"})),"dead_letter_ai_unavailable");
 const r=db.rows.get("e1")!;
 assert.deepEqual([r.status,r.cancelReason,r.lastError,r.aiAttempts],["dead_letter","ai_unavailable","ai_http_401",1]);
 assert.equal(await tick(db,"e1",answer),"ai_not_claimable");
 assert.equal(db.modelCalls,1);assert.equal(db.sends,0);
});

test("duplicate prevention: concurrent workers and repeated ticks produce one model call, one send, one bill", async()=>{
 const db=new FakeDb();db.add("e1");
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const slow:Gen=async()=>{await gate;return answer();};
 const a=tick(db,"e1",slow),b=tick(db,"e1",slow);
 release();
 const results=(await Promise.all([a,b])).sort();
 assert.deepEqual(results,["ai_busy","settled"]);
 assert.equal(db.modelCalls,1);assert.equal(db.sends,1);assert.equal(db.bills,1);
 for(let i=0;i<3;i++){db.now+=600_000;await tick(db,"e1",answer);}
 assert.equal(db.modelCalls,1);assert.equal(db.sends,1);assert.equal(db.bills,1);
});

test("restart after the answer was stored reuses it: no regeneration, exactly one send", async()=>{
 const db=new FakeDb();db.add("e1");
 await assert.rejects(()=>tick(db,"e1",answer,{crashAfterStore:true}),/worker restarted/);
 assert.equal(db.rows.get("e1")!.answer,"enc:v1:Price is 1000 IQD");
 assert.equal(db.sends,0);
 assert.equal(await tick(db,"e1",async()=>({kind:"answer",text:"DIFFERENT"})),"settled");
 assert.equal(db.modelCalls,1,"cached answer, model not called again");
 assert.equal(db.sends,1);assert.equal(db.bills,1);
 // A lost claim (another worker re-claimed) cannot overwrite or send.
 db.add("e2");const c=db.claim("A","e2");assert.equal(c.outcome,"claimed");
 assert.equal(db.store("e2","stale-token","enc:v1:x"),false);
 assert.equal(db.claim("B","e2").outcome,"not_claimable","tenant-scoped");
});

test("restart mid-generation: lease blocks others until it expires, then resumes and counts the attempt", async()=>{
 const db=new FakeDb();db.add("e1");
 assert.equal(await tick(db,"e1",answer,{crashInGenerate:true}),"ai_retry_scheduled");
 // A worker killed outright (no finish) leaves the lease; simulate it directly.
 db.add("e2");assert.equal(db.claim("A","e2").outcome,"claimed");
 assert.equal(await tick(db,"e2",answer),"ai_busy");
 db.now+=AI_CLAIM_LEASE_SECONDS*1000;
 assert.equal(await tick(db,"e2",answer),"settled");
 assert.equal(db.rows.get("e2")!.aiAttempts,2);
 assert.equal(db.sends,1);
});

test("queue recovery: a backed-off item does not block newer items and is picked up when due", async()=>{
 const db=new FakeDb();
 db.add("old",db.now-5000);db.add("new1",db.now-1000);db.add("new2",db.now);
 assert.equal(await tick(db,"old",transient),"ai_retry_scheduled");
 assert.deepEqual(db.list().map(x=>x.id),["new1","new2"]);
 assert.deepEqual(db.list(1).map(x=>x.id),["new1"],"even with a scan limit of 1");
 for(const id of ["new1","new2"])assert.equal(await tick(db,id,answer),"settled");
 assert.deepEqual(db.list().map(x=>x.id),[]);
 db.now+=60_000;
 assert.deepEqual(db.list().map(x=>x.id),["old"]);
 assert.equal(await tick(db,"old",answer),"settled");
 assert.equal(db.sends,3);assert.equal(db.bills,3);
});

test("claim DB errors and unreadable cached answers fail closed (no model call, no send)", async()=>{
 let calls=0;
 const base={decrypt:async()=>{throw Error("bad key");},generate:async()=>{calls++;return {kind:"answer",text:"x"} as KnowledgeOutcome;},
  store:async()=>true,finish:async()=>"retry_wait"};
 assert.deepEqual(await resolveKnowledgeEffect({...base,claim:async()=>{throw Error("db");}}),{status:"report",key:"blocked"});
 assert.deepEqual(await resolveKnowledgeEffect({...base,claim:async()=>null}),{status:"report",key:"blocked"});
 assert.deepEqual(await resolveKnowledgeEffect({...base,claim:async()=>({outcome:"cached",answerEncrypted:"enc:v1:x"})}),
  {status:"report",key:"ai_cached_unreadable"});
 assert.deepEqual(await resolveKnowledgeEffect({...base,claim:async()=>({outcome:"claimed",token:"t",attempt:1}),
  store:async()=>false}),{status:"report",key:"ai_store_failed"});
 assert.deepEqual(await resolveKnowledgeEffect({...base,claim:async()=>({outcome:"claimed",token:"t",attempt:1}),
  generate:async()=>({kind:"transient",code:"ai_timeout"}),finish:async()=>null}),{status:"report",key:"ai_finish_failed"});
 assert.equal(calls,1);
});

// ------------------------------------------------------------ worker wiring (static)
test("worker: list reads retry_wait only when due; AI claim precedes the model; no empty-answer cancel", ()=>{
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 // The original pending/charge_pending scan is unchanged; due retry_wait rows
 // come from a separate bounded query filtered on retry_at <= now.
 // message_image (FLOW_MEDIA_SEND_ENABLED) is listed only in the pending scan,
 // never in the retry_wait query (images have no AI backoff).
 assert.match(code,/\.in\("delivery_status",\["pending","charge_pending"\]\)\.in\("effect_kind",\["message","question","message_image"\]\)\s*\.order\("created_at",\{ascending:true\}\)\.limit\(OUTBOX_SCAN_LIMIT\);/);
 assert.match(code,/\.eq\("delivery_status","retry_wait"\)\.lte\("retry_at",new Date\(\)\.toISOString\(\)\)\s*\.in\("effect_kind",\["message","question"\]\)\s*\.order\("retry_at",\{ascending:true\}\)\.limit\(OUTBOX_DISPATCH_LIMIT\);/);
 assert.doesNotMatch(code,/answerWithVerifiedKnowledge\(sb/,"legacy null-on-error path removed from the worker");
 assert.doesNotMatch(code,/\?\?"";\s*\}\s*if\(!messageText/);
 const gate=code.indexOf('if(env("FLOW_RAG_ENABLED")!=="true"){report("blocked");continue;}');
 const charge=code.indexOf('if(effect.delivery_status==="charge_pending"){',gate);
 const claim=code.indexOf('sb.rpc("flow_claim_outbox_ai"');
 const gen=code.indexOf("answerWithVerifiedKnowledgeOutcome(sb");
 const store=code.indexOf('sb.rpc("flow_store_outbox_ai_answer"');
 const reserve=code.indexOf('sb.rpc("flow_reserve_outbox_delivery"');
 assert(gate>0&&charge>gate&&claim>charge&&gen>claim&&store>gen&&reserve>store,"order");
 // Billing recovery reads the stored answer and never calls the model.
 const chargeBlock=code.slice(charge,claim);
 assert.match(chargeBlock,/select\("ai_answer_encrypted"\)\.eq\("tenant_id",effect\.tenant_id\)\.eq\("id",effect\.id\)/);
 assert.doesNotMatch(chargeBlock,/answerWithVerifiedKnowledge|openAIKnowledgeDependencies/);
 // All AI RPCs are tenant-scoped.
 for(const fn of ["flow_claim_outbox_ai","flow_store_outbox_ai_answer","flow_finish_outbox_ai"])
  assert.match(code,new RegExp(`sb\\.rpc\\("${fn}",\\{\\s*p_tenant:effect\\.tenant_id,p_outbox:effect\\.id`));
 // Non-AI retry_wait rows are never dispatched by this worker.
 assert.match(code,/if\(effect\.delivery_status==="retry_wait"&&payload\.source!=="knowledge_ai"\)\{\s*report\("blocked"\);continue;/);
 // Kill switches and gates are still checked before any AI work.
 for(const s of ['env("FLOW_WORKERS_OPERATOR_RELEASE")!=="production-canary-approved"',
  'env("FLOW_OUTBOX_SEND_ENABLED")!=="true"','sb.rpc("flow_skip_blocked_outbox"','!canDispatchOutbox({'])
  assert(code.indexOf(s)>0&&code.indexOf(s)<claim,s);
});

// ------------------------------------------------------------ charge_pending recovery (B5)
/** One billing-recovery tick for a charge_pending knowledge_ai row (mirrors index.ts). */
async function recoverTick(db:FakeDb,tenant:string,id:string,hooks:{readError?:boolean;markError?:boolean;
 storeBeforeMark?:string}={}){
 const billed:string[]=[];
 const res=await recoverKnowledgeCharge({
  readStored:async()=>{
   if(hooks.readError)return null;
   const r=db.rows.get(id);
   // .eq("tenant_id",tenant).eq("id",id): another tenant's row is not found.
   return r&&r.tenant===tenant?{found:true,answerEncrypted:r.answer}:{found:false,answerEncrypted:null};
  },
  decrypt:async enc=>{if(!enc.startsWith("enc:v1:"))throw Error("bad key");return enc.slice(7);},
  markAnswerMissing:async()=>{
   if(hooks.markError)return false;
   const r=db.rows.get(id);
   if(hooks.storeBeforeMark&&r)r.answer=hooks.storeBeforeMark;
   // tenant + id + delivery_status='charge_pending' + ai_answer_encrypted IS NULL
   if(!r||r.tenant!==tenant||r.status!=="charge_pending"||r.answer!==null)return false;
   Object.assign(r,{status:"billing_blocked",lastError:AI_ANSWER_MISSING_CODE});return true;
  }
 });
 if(res.status!=="bill")return {key:res.key,billed};
 db.bills++;billed.push(res.text);db.rows.get(id)!.status="settled";
 return {key:"settled",billed};
}
function chargePending(db:FakeDb,id:string,tenant:string,answer:string|null,created=db.now){
 db.rows.set(id,{id,tenant,created,status:"charge_pending",retryAt:null,aiAttempts:1,lastError:null,
  leaseToken:null,leaseUntil:null,answer,cancelReason:null,delivered:true});
}

test("legacy charge_pending without stored answer ends once as billing_blocked: no model, no send, no debit", async()=>{
 const db=new FakeDb();
 chargePending(db,"legacy","A",null,db.now-5000);
 db.add("next");
 assert.deepEqual(db.list().map(x=>x.id),["legacy","next"]);
 const first=await recoverTick(db,"A","legacy");
 assert.equal(first.key,BILLING_BLOCKED_ANSWER_MISSING);
 assert.equal(first.key,"billing_blocked_ai_answer_missing");
 const r=db.rows.get("legacy")!;
 assert.deepEqual([r.status,r.lastError,r.cancelReason,r.aiAttempts],
  ["billing_blocked","ai_answer_missing",null,1]);
 assert.match(r.lastError!,/^[a-z0-9_]{1,48}$/,"fits automation_flow_outbox_ai_state_chk");
 assert.equal(db.modelCalls,0);assert.equal(db.sends,0);assert.equal(db.bills,0);
 // Leaves the scan for good: no slot is taken any more, newer effects go first.
 assert.deepEqual(db.list().map(x=>x.id),["next"]);
 assert.deepEqual(db.list(1).map(x=>x.id),["next"]);
 // Idempotent: a re-run (e.g. a concurrent worker that listed it earlier)
 // changes nothing, bills nothing, calls nothing.
 for(let i=0;i<3;i++){
  const again=await recoverTick(db,"A","legacy");
  assert.equal(again.key,"billing_pending");assert.deepEqual(again.billed,[]);
 }
 assert.equal(r.status,"billing_blocked");
 assert.equal(db.modelCalls,0);assert.equal(db.sends,0);assert.equal(db.bills,0);
 // The run's later effects are no longer held by it.
 const order=(id:string,status:string,seq:number):OrderRow=>({id,tenant_id:"A",run_id:"run",
  delivery_status:status,effect_kind:"message",payload:{kind:"message",seq},created_at:"T0"});
 assert.equal(statusAfterOutcome(first.key),"billing_blocked");
 assert.equal(heldByEarlierEffect(order("s1","pending",1),[order("legacy","billing_blocked",0),order("s1","pending",1)]),false);
});

test("charge_pending WITH stored answer bills exactly the stored text once, never regenerates or resends", async()=>{
 const db=new FakeDb();
 chargePending(db,"stored","A","enc:v1:Price is 1000 IQD");
 const res=await recoverTick(db,"A","stored");
 assert.equal(res.key,"settled");assert.deepEqual(res.billed,["Price is 1000 IQD"]);
 assert.equal(db.rows.get("stored")!.status,"settled");
 assert.equal(db.modelCalls,0);assert.equal(db.sends,0);assert.equal(db.bills,1);
 assert.deepEqual(db.list().map(x=>x.id),[]);
});

test("charge_pending recovery is tenant-scoped and fails closed on errors, races and unreadable answers", async()=>{
 const db=new FakeDb();
 chargePending(db,"b-legacy","B",null);
 // Tenant A cannot read or terminalize tenant B's row.
 assert.equal((await recoverTick(db,"A","b-legacy")).key,"billing_pending");
 assert.equal(db.rows.get("b-legacy")!.status,"charge_pending");
 assert.equal((await recoverTick(db,"B","b-legacy")).key,BILLING_BLOCKED_ANSWER_MISSING);
 // Read error: unchanged, retried later, never terminal.
 chargePending(db,"e1","A",null);
 assert.equal((await recoverTick(db,"A","e1",{readError:true})).key,"billing_pending");
 assert.equal(db.rows.get("e1")!.status,"charge_pending");
 // Mark failure (DB error / lost transition): unchanged.
 assert.equal((await recoverTick(db,"A","e1",{markError:true})).key,"billing_pending");
 assert.equal(db.rows.get("e1")!.status,"charge_pending");
 // An answer stored concurrently wins over the terminal mark.
 assert.equal((await recoverTick(db,"A","e1",{storeBeforeMark:"enc:v1:late"})).key,"billing_pending");
 assert.equal(db.rows.get("e1")!.status,"charge_pending");
 // A stored but unreadable answer is never regenerated and never terminalized.
 chargePending(db,"bad","A","garbage");
 assert.equal((await recoverTick(db,"A","bad")).key,"billing_pending");
 assert.equal(db.rows.get("bad")!.status,"charge_pending");
 assert.equal(db.modelCalls,0);assert.equal(db.sends,0);assert.equal(db.bills,0);
 // Pure helper: throwing deps also fail closed.
 const boom=async()=>{throw Error("db");};
 assert.deepEqual(await recoverKnowledgeCharge({readStored:boom,decrypt:boom,markAnswerMissing:boom}),
  {status:"report",key:"billing_pending"});
 assert.deepEqual(await recoverKnowledgeCharge({readStored:async()=>({found:true,answerEncrypted:null}),
  decrypt:boom,markAnswerMissing:boom}),{status:"report",key:"billing_pending"});
});

test("worker: charge_pending recovery terminalizes only legacy rows, tenant-scoped, without send/debit/model", ()=>{
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 const charge=code.indexOf('if(effect.delivery_status==="charge_pending"){');
 const claim=code.indexOf('sb.rpc("flow_claim_outbox_ai"');
 assert(charge>0&&claim>charge);
 const block=code.slice(charge,claim);
 assert.match(block,/recoverKnowledgeCharge\(\{/);
 assert.match(block,/\.update\(\{delivery_status:"billing_blocked",ai_last_error_code:AI_ANSWER_MISSING_CODE\}\)\s*\.eq\("tenant_id",effect\.tenant_id\)\.eq\("id",effect\.id\)\s*\.eq\("delivery_status","charge_pending"\)\.is\("ai_answer_encrypted",null\)/);
 assert.match(block,/if\(recovered\.status!=="bill"\)\{[\s\S]*?report\(recovered\.key\);continue;\s*\}\s*messageText=recovered\.text;/);
 for(const banned of [/answerWithVerifiedKnowledge|openAIKnowledgeDependencies/,/sendProviderMessage/,
  /consume_flow_reply|persistAndBill|reply_ledger|credits_remaining/,/cancel_reason/,/flow_reserve_outbox_delivery/])
  assert.doesNotMatch(block,banned);
 // The terminal status is one already allowed by the installed outbox CHECK
 // and surfaced by delivery review; the code fits ai_state_chk.
 const fixture=readFileSync("tests/sql/fixtures/installed-flow-runtime.sql","utf8");
 assert.match(fixture,/'billing_blocked','dead_letter','cancelled'\)\)/);
 const review=readFileSync("supabase/functions/flow-delivery-review/review.ts","utf8");
 assert.match(review,/FAILED_OUTBOX_STATUSES = \["uncertain", "dead_letter", "billing_blocked"\]/);
 assert.match(AI_ANSWER_MISSING_CODE,/^[a-z0-9_]{1,48}$/);
});

// ------------------------------------------------------------ AI step (FLOW_AI_STEP_ENABLED)
import {aiStepEnabled,lastInboundQuestion,tenantSystemPrompt,generateAiStepAnswer,
 liveBotKnowledgeDependencies,MAX_SYSTEM_PROMPT_CHARS} from "../supabase/functions/flow-outbox-worker/aiStep.ts";
import {encryptMessageBody,decryptAccountToken,sendProviderMessage} from
 "../supabase/functions/flow-outbox-worker/deliveryCore.ts";
const FIELD_KEY="test-field-key";
const QUESTION="How much is the item?";
const OWNER_PROMPT="Speak in Iraqi dialect, be warm.";
type Read={table:string;filters:Record<string,unknown>;order?:unknown;limit?:number};
/** Tenant-scoped fake: knowledge for tenant A only, prompt per tenant, inbound messages. */
function aiDb(o:{prompt?:string|null;promptError?:boolean;messages?:unknown[];messagesError?:boolean;
 knowledgeTenant?:string}={}){
 const reads:Read[]=[],rpcs:Array<{fn:string;args:any}>=[];
 const kt=o.knowledgeTenant??"A";
 const db={
  rpc:async(fn:string,args:any)=>{rpcs.push({fn,args});
   return {data:args.p_tenant_id===kt?[{id:rowId,content,similarity:0.9}]:[],error:null};},
  from:(table:string)=>{
   const r:Read={table,filters:{}};reads.push(r);
   const q:any={select:()=>q,eq:(k:string,v:unknown)=>{r.filters[k]=v;return q;},
    in:(k:string,v:unknown)=>{r.filters[k]=v;return q;},
    lte:(k:string,v:unknown)=>{r.filters[k+"<="]=v;return q;},
    order:(k:string,v:unknown)=>{r.order=[k,v];return q;},
    maybeSingle:async()=>{
     if(table!=="tenants")throw Error("unexpected maybeSingle "+table);
     if(o.promptError)return {data:null,error:{code:"57014"}};
     return {data:{id:r.filters.id,agent_system_prompt:o.prompt??null},error:null};
    },
    limit:async(n:number)=>{r.limit=n;
     if(table==="messages")return o.messagesError?{data:null,error:{code:"57014"}}:
      {data:o.messages??[],error:null};
     if(table==="knowledge_chunks")return {data:r.filters.tenant_id===kt?
      [{id:rowId,tenant_id:kt,content,source_id:"src"}]:[],error:null};
     if(table==="knowledge_sources")return {data:r.filters.tenant_id===kt?
      [{id:"src",tenant_id:kt,status:"indexed"}]:[],error:null};
     throw Error("unexpected table "+table);
    }};
   return q;
  }
 };
 return {db:db as never,reads,rpcs};
}
const aiScope={...scope,businessName:"Shop"};
/** Mocked provider: records requests; `plan` decides each response. */
function fakeFetch(plan:(url:string,n:number)=>Response|Error){
 const calls:Array<{url:string;headers:Record<string,string>;body:any}>=[];
 const f=(async(url:string,init:any)=>{
  calls.push({url,headers:init.headers,body:JSON.parse(init.body)});
  const r=plan(url,calls.length);if(r instanceof Error)throw r;return r;
 }) as unknown as typeof fetch;
 return {f,calls};
}
const ok=(body:unknown)=>new Response(JSON.stringify(body),{status:200});
const providerOk=(answerText="Price is 1000 IQD")=>(url:string)=>url.includes("embed")?
 (url.includes("googleapis")?ok({embeddings:[{values:[0.1,0.2]}]}):ok({data:[{embedding:[0.1,0.2]}]})):
 ok({choices:[{message:{content:JSON.stringify({answer:answerText,grounded:true,supporting_quote:content})}}]});
const OPENAI_ENV:Record<string,string>={LLM_API_KEY:"sk-test-llm"};

test("AI step flag: both FLOW_AI_STEP_ENABLED and FLOW_RAG_ENABLED must be exactly true; errors are OFF",()=>{
 const env=(e:Record<string,string>)=>(k:string)=>e[k];
 assert.equal(aiStepEnabled(env({FLOW_AI_STEP_ENABLED:"true",FLOW_RAG_ENABLED:"true"})),true);
 for(const e of [{},{FLOW_AI_STEP_ENABLED:"true"},{FLOW_RAG_ENABLED:"true"},
  {FLOW_AI_STEP_ENABLED:"yes",FLOW_RAG_ENABLED:"true"},{FLOW_AI_STEP_ENABLED:"true",FLOW_RAG_ENABLED:"1"}])
  assert.equal(aiStepEnabled(env(e)),false,JSON.stringify(e));
 assert.equal(aiStepEnabled(()=>{throw Error("no runtime");}),false);
 const old=(globalThis as any).Deno;delete (globalThis as any).Deno;
 try{assert.equal(aiStepEnabled(),false);}finally{(globalThis as any).Deno=old;}
});

test("AI step question: the customer's last inbound message of THIS tenant conversation, decrypted in memory",async()=>{
 const enc=await encryptMessageBody("  "+QUESTION+"  ",FIELD_KEY);
 const row={tenant_id:"A",conversation_id:"c1",direction:"in",body_encrypted:enc,created_at:"t"};
 const dec=(e:string)=>decryptAccountToken(e,FIELD_KEY);
 const s={tenantId:"A",conversationId:"c1",before:"2026-11-07T10:00:00.000Z"};
 const h=aiDb({messages:[row]});
 assert.deepEqual(await lastInboundQuestion(h.db,s,dec),{kind:"ok",text:QUESTION});
 assert.deepEqual(h.reads[0],{table:"messages",filters:{tenant_id:"A",conversation_id:"c1",direction:"in",
  "created_at<=":s.before},order:["created_at",{ascending:false}],limit:1});
 // A row of another tenant/conversation or an outbound row is never used.
 for(const bad of [{...row,tenant_id:"B"},{...row,conversation_id:"c2"},{...row,direction:"out"},
  {...row,body_encrypted:null},{...row,body_encrypted:"plain text"}])
  assert.deepEqual(await lastInboundQuestion(aiDb({messages:[bad]}).db,s,dec),{kind:"none"});
 assert.deepEqual(await lastInboundQuestion(aiDb({messages:[]}).db,s,dec),{kind:"none"});
 assert.deepEqual(await lastInboundQuestion(aiDb({messages:[{...row,
  body_encrypted:await encryptMessageBody("   ",FIELD_KEY)}]}).db,s,dec),{kind:"none"});
 assert.deepEqual(await lastInboundQuestion(aiDb({messages:[{...row,
  body_encrypted:await encryptMessageBody("x".repeat(4001),FIELD_KEY)}]}).db,s,dec),{kind:"none"});
 // Read error: "error" (the worker holds the effect without any state change).
 assert.deepEqual(await lastInboundQuestion(aiDb({messagesError:true}).db,s,dec),{kind:"error"});
 // Missing scope: no query at all.
 const none=aiDb({messages:[row]});
 assert.deepEqual(await lastInboundQuestion(none.db,{...s,tenantId:""},dec),{kind:"none"});
 assert.equal(none.reads.length,0);
});

test("AI step generation: last customer message + the tenant's own system message, tenant-scoped",async()=>{
 const seen:Array<{system:string;user:string}>=[];
 const deps={embed:async()=>[0.1,0.2],complete:async(system:string,user:string)=>{
  seen.push({system,user});return {answer:"Price is 1000 IQD",grounded:true,supporting_quote:content};}};
 const h=aiDb({prompt:"  "+OWNER_PROMPT+"  "});
 assert.deepEqual(await generateAiStepAnswer(h.db,aiScope,QUESTION,deps),{kind:"answer",text:"Price is 1000 IQD"});
 assert.ok(seen[0].system.includes(OWNER_PROMPT));
 assert.ok(seen[0].system.includes("Answer ONLY with supplied verified knowledge"),"grounding rule kept");
 assert.ok(seen[0].user.endsWith("Customer:\n"+QUESTION));
 // Every read and the vector search are scoped to the effect's tenant.
 assert.deepEqual(h.reads.find(r=>r.table==="tenants")!.filters,{id:"A"});
 assert.equal(h.rpcs[0].args.p_tenant_id,"A");
 for(const r of h.reads.filter(x=>x.table.startsWith("knowledge_")))assert.equal(r.filters.tenant_id,"A");
 // Without a system message the prompt is byte-identical to the existing knowledge path.
 const base:string[]=[];
 const capture={...deps,complete:async(system:string,user:string)=>{base.push(system);return deps.complete(system,user);}};
 await answerWithVerifiedKnowledgeOutcome(kb(),aiScope,QUESTION,capture);
 await generateAiStepAnswer(aiDb({prompt:"   "}).db,aiScope,QUESTION,capture);
 await generateAiStepAnswer(aiDb({prompt:null}).db,aiScope,QUESTION,capture);
 assert.equal(base.length,3);assert.equal(base[1],base[0]);assert.equal(base[2],base[0]);
 // Bounded system message.
 const long=aiDb({prompt:"p".repeat(MAX_SYSTEM_PROMPT_CHARS+50)});
 assert.equal((await tenantSystemPrompt(long.db,"A"))!.length,MAX_SYSTEM_PROMPT_CHARS);
 // Another tenant's knowledge is never used: no evidence -> no_knowledge, no model call.
 const n=seen.length;
 assert.deepEqual(await generateAiStepAnswer(aiDb({knowledgeTenant:"B"}).db,aiScope,QUESTION,deps),{kind:"no_knowledge"});
 assert.equal(seen.length,n);
 // Prompt lookup error: transient (retry_wait), the model is not called.
 assert.deepEqual(await generateAiStepAnswer(aiDb({promptError:true}).db,aiScope,QUESTION,deps),
  {kind:"transient",code:"rag_lookup_failed"});
 assert.equal(seen.length,n);
 // Scope mismatch stays ineligible (no prompt can override it).
 assert.deepEqual(await generateAiStepAnswer(aiDb({prompt:OWNER_PROMPT}).db,{...aiScope,conversationTenantId:"B"},
  QUESTION,deps),{kind:"ineligible"});
});

test("AI step provider: the live bot's configuration (same secret names), typed failures, no leaks",async()=>{
 // OpenAI-compatible default (LLM_API_KEY only).
 const a=fakeFetch(providerOk());
 assert.deepEqual(await generateAiStepAnswer(aiDb().db,aiScope,QUESTION,liveBotKnowledgeDependencies(a.f,k=>OPENAI_ENV[k])),
  {kind:"answer",text:"Price is 1000 IQD"});
 assert.equal(a.calls[0].url,"https://api.openai.com/v1/embeddings");
 assert.equal(a.calls[0].headers.authorization,"Bearer sk-test-llm");
 assert.deepEqual(a.calls[0].body,{model:"text-embedding-3-small",input:[QUESTION]});
 assert.equal(a.calls[1].url,"https://api.openai.com/v1/chat/completions");
 assert.equal(a.calls[1].body.model,"gpt-4o-mini");
 assert.deepEqual(a.calls[1].body.response_format,{type:"json_object"});
 // Google key: Gemini text-embedding-004 (key in a header, never in the URL);
 // chat through LLM_BASE_URL / LLM_MODEL exactly like milan-api.
 const g=fakeFetch(providerOk());
 const genv:Record<string,string>={GEMINI_API_KEY:"AIzaTestKey",
  LLM_BASE_URL:"https://generativelanguage.googleapis.com/v1beta/openai",LLM_MODEL:"gemini-2.0-flash"};
 assert.equal((await generateAiStepAnswer(aiDb().db,aiScope,QUESTION,liveBotKnowledgeDependencies(g.f,k=>genv[k]))).kind,"answer");
 assert.equal(g.calls[0].url,"https://generativelanguage.googleapis.com/v1/models/text-embedding-004:batchEmbedContents");
 assert.equal(g.calls[0].headers["x-goog-api-key"],"AIzaTestKey");
 assert.ok(!g.calls.some(c=>c.url.includes("AIza")));
 assert.deepEqual(g.calls[0].body,{requests:[{model:"models/text-embedding-004",content:{parts:[{text:QUESTION}]}}]});
 assert.equal(g.calls[1].url,"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
 assert.equal(g.calls[1].headers.authorization,"Bearer AIzaTestKey");
 assert.equal(g.calls[1].body.model,"gemini-2.0-flash");
 // Classification: 5xx/429/timeout/network transient; other 4xx and config permanent.
 const outcome=async(plan:(url:string,n:number)=>Response|Error,env=OPENAI_ENV)=>{
  const p=fakeFetch(plan);
  return {o:await generateAiStepAnswer(aiDb().db,aiScope,QUESTION,liveBotKnowledgeDependencies(p.f,k=>env[k])),calls:p.calls.length};
 };
 assert.deepEqual((await outcome(()=>new Response("down",{status:503}))).o,{kind:"transient",code:"ai_http_5xx"});
 assert.deepEqual((await outcome(()=>new Response("",{status:429}))).o,{kind:"transient",code:"ai_http_429"});
 assert.deepEqual((await outcome((u)=>u.includes("chat")?new Response("",{status:500}):providerOk()(u))).o,
  {kind:"transient",code:"ai_http_5xx"});
 assert.deepEqual((await outcome(()=>new DOMException("timed out","TimeoutError"))).o,{kind:"transient",code:"ai_timeout"});
 assert.deepEqual((await outcome(()=>new DOMException("aborted","AbortError"))).o,{kind:"transient",code:"ai_timeout"});
 assert.deepEqual((await outcome(()=>new TypeError("fetch failed"))).o,{kind:"transient",code:"ai_network"});
 assert.deepEqual((await outcome(()=>new Response("secret body",{status:401}))).o,{kind:"permanent",code:"ai_http_401"});
 assert.deepEqual((await outcome(()=>new Response("",{status:400}))).o,{kind:"permanent",code:"ai_http_400"});
 const missing=await outcome(providerOk(),{});
 assert.deepEqual(missing,{o:{kind:"permanent",code:"ai_config_missing"},calls:0});
 const insecure=await outcome(providerOk(),{...OPENAI_ENV,EMBED_BASE_URL:"http://evil.example"});
 assert.deepEqual(insecure,{o:{kind:"permanent",code:"ai_config_invalid"},calls:0});
 // Not grounded / quote not in the tenant's knowledge: no_knowledge (existing fallback, no send).
 assert.deepEqual((await outcome(u=>u.includes("chat")?ok({choices:[{message:{content:JSON.stringify(
  {answer:"x",grounded:false,supporting_quote:""})}}]}):providerOk()(u))).o,{kind:"no_knowledge"});
 assert.deepEqual((await outcome(u=>u.includes("chat")?ok({choices:[{message:{content:JSON.stringify(
  {answer:"Invented",grounded:true,supporting_quote:"not in the knowledge base at all"})}}]}):providerOk()(u))).o,
  {kind:"no_knowledge"});
});

test("AI step end to end (in-memory SQL mirror): sends the scrubbed answer once, bills once, retry reuses the stored answer",async()=>{
 const logs:string[]=[];
 const orig={log:console.log,warn:console.warn,error:console.error,info:console.info};
 for(const k of ["log","warn","error","info"] as const)(console as any)[k]=(...a:unknown[])=>logs.push(JSON.stringify(a));
 try{
  const db=new FakeDb();db.add("e1");
  let n=0;
  const provider=fakeFetch((url)=>{n++;return n===1?new Response("",{status:503}):
   providerOk("Hello {{first_name}}, price is 1000 IQD {{order_id}}")(url);});
  const enc=await encryptMessageBody(QUESTION,FIELD_KEY);
  const h=aiDb({prompt:OWNER_PROMPT,messages:[{tenant_id:"A",conversation_id:"c1",direction:"in",body_encrypted:enc}]});
  const metaBodies:any[]=[];
  const aiTick=async()=>{
   const q=await lastInboundQuestion(h.db,{tenantId:"A",conversationId:"c1",before:"z"},e=>decryptAccountToken(e,FIELD_KEY));
   assert.equal(q.kind,"ok");
   const res=await resolveKnowledgeEffect({
    claim:async()=>db.claim("A","e1"),
    decrypt:e=>decryptAccountToken(e,FIELD_KEY),
    generate:async()=>{db.modelCalls++;return generateAiStepAnswer(h.db,aiScope,(q as {text:string}).text,
     liveBotKnowledgeDependencies(provider.f,k=>OPENAI_ENV[k]));},
    store:async(token,text)=>db.store("e1",token,await encryptMessageBody(text,FIELD_KEY)),
    finish:async(token,d)=>db.finish("e1",token,d),random:()=>0
   });
   if(res.status!=="send")return res.key;
   return executeOnce({reserve:async()=>db.reserve("e1"),
    send:async()=>{db.sends++;return sendProviderMessage({platform:"instagram",token:"IGtoken",externalId:"12345",
     recipient:"98765",text:res.text},(async(_u:string,init:any)=>{metaBodies.push(JSON.parse(init.body));
      return ok({message_id:"mid-1"});}) as never);},
    confirm:async()=>{db.rows.get("e1")!.status="charge_pending";return true;},
    persistAndBill:async()=>{db.bills++;db.rows.get("e1")!.status="settled";return true;}});
  };
  // Attempt 1: provider 503 -> retry_wait (60s), nothing sent or billed.
  assert.equal(await aiTick(),"ai_retry_scheduled");
  assert.equal(db.rows.get("e1")!.status,"retry_wait");assert.equal(db.sends,0);
  db.now+=60_000;
  assert.equal(await aiTick(),"settled");
  assert.equal(db.sends,1);assert.equal(db.bills,1);assert.equal(db.modelCalls,2);
  const providerCalls=provider.calls.length;
  // The stored answer is encrypted and is what any later attempt reuses.
  assert.match(db.rows.get("e1")!.answer!,/^enc:v1:/);
  // The customer never sees a placeholder.
  assert.equal(metaBodies.length,1);
  assert.doesNotMatch(metaBodies[0].message.text,/\{\{|\}\}/);
  assert.match(metaBodies[0].message.text,/price is 1000 IQD/);
  // Repeated ticks: no second model call, no second send, no second debit.
  for(let i=0;i<3;i++){db.now+=600_000;await aiTick();}
  assert.equal(provider.calls.length,providerCalls);assert.equal(db.modelCalls,2);
  assert.equal(db.sends,1);assert.equal(db.bills,1);
  // Crash after store: the restarted worker sends the stored answer without calling the model.
  const db2=new FakeDb();db2.add("e2");
  const tok=db2.claim("A","e2") as {token:string};
  db2.store("e2",tok.token,await encryptMessageBody("Stored answer",FIELD_KEY));
  const before=provider.calls.length;
  const res=await resolveKnowledgeEffect({claim:async()=>db2.claim("A","e2"),
   decrypt:e=>decryptAccountToken(e,FIELD_KEY),
   generate:async()=>{throw Error("must not be called");},
   store:async()=>false,finish:async()=>null});
  assert.deepEqual(res,{status:"send",text:"Stored answer"});
  assert.equal(provider.calls.length,before);
 }finally{Object.assign(console,orig);}
 // Nothing sensitive was logged: no question, system message, answer or key.
 for(const secret of [QUESTION,OWNER_PROMPT,"Price is 1000","price is 1000","sk-test-llm","Stored answer"])
  assert.ok(!logs.some(l=>l.includes(secret)),secret);
});

test("worker wiring: AI step only behind the flag, question before the claim, tenant-scoped, nothing logged",()=>{
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 const rag=code.indexOf('if(env("FLOW_RAG_ENABLED")!=="true"){report("blocked");continue;}');
 const flag=code.indexOf("const aiStep=aiStepEnabled();");
 const legacyQ=code.indexOf('let question=typeof run.variables?.message==="string"?run.variables.message:"";');
 const last=code.indexOf("const last=await lastInboundQuestion(sb,{tenantId:String(tenant.id),");
 const valid=code.indexOf('if(!knowledgeQuestionValid(question)){await skip("ineligible","invalid");continue;}');
 const claim=code.indexOf('sb.rpc("flow_claim_outbox_ai"');
 const gen=code.indexOf("generateAiStepAnswer(sb,knowledgeScope,question,liveBotKnowledgeDependencies())");
 const reserve=code.indexOf('sb.rpc("flow_reserve_outbox_delivery"');
 assert(rag>0&&flag>rag&&legacyQ>flag&&last>legacyQ&&valid>last&&claim>valid&&gen>claim&&reserve>gen,"order");
 assert.match(code,/conversationId:String\(conversation\.id\),before:String\(effect\.created_at\)\},\s*enc=>decryptAccountToken\(enc,fieldKey\)\);/);
 assert.match(code,/if\(last\.kind==="error"\)\{report\("blocked"\);continue;\}/);
 // Flag OFF: exactly the previous source and dependencies.
 assert.match(code,/return aiStep\?\s*generateAiStepAnswer\(sb,knowledgeScope,question,liveBotKnowledgeDependencies\(\)\):\s*answerWithVerifiedKnowledgeOutcome\(sb,knowledgeScope,question,openAIKnowledgeDependencies\(\)\);/);
 // One billing path: persistAndBill -> consume_flow_reply (no AI-specific debit).
 assert.equal((code.match(/sb\.rpc\("consume_flow_reply"/g)??[]).length,1);
 // No log line carries customer text, the system message or an answer.
 for(const line of code.split("\n").filter(l=>/console\.(log|info|warn|error)/.test(l)))
  assert.doesNotMatch(line,/question|messageText|last\.text|ownerInstructions|agent_system_prompt|resolved\.text|recovered\.text/,line);
 const ai=readFileSync("supabase/functions/flow-outbox-worker/aiStep.ts","utf8");
 assert.doesNotMatch(ai,/console\./);
 // Ingress and wake worker share the same fail-closed flag.
 const ingress=readFileSync("supabase/functions/milan-api/flowDurableIngress.ts","utf8");
 assert.match(ingress,/import \{aiStepEnabled\} from "\.\.\/flow-outbox-worker\/aiStep\.ts";/);
 const wake=readFileSync("supabase/functions/flow-runtime-worker/index.ts","utf8");
 assert.match(wake,/e\.source==="knowledge_ai"\)&&\s*!\(run\.platform==="instagram"&&aiStepEnabled\(\)\)\)\s*throw Error\("knowledge AI requires trusted handler, no emission"\);/);
});
