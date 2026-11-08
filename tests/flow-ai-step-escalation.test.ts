// I4: a Flow AI step that ends without an answer (no knowledge, provider
// permanently unavailable, retries exhausted) is escalated to a human
// (unresolved question + 'ai_handoff') instead of being cancelled silently.
// Idempotent, tenant-scoped, never billed, nothing logged; OFF = unchanged.
// Run: node --experimental-strip-types --test tests/flow-ai-step-escalation.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolveKnowledgeEffect,aiEscalationReason,AI_MAX_ATTEMPTS,type AiClaim,type AiDecision,
 type AiEscalationReason} from "../supabase/functions/flow-outbox-worker/knowledgeRetry.ts";
import {escalateAiFailure,AI_ESCALATION_HANDOFF_MINUTES,type AiEscalationContext}
 from "../supabase/functions/flow-outbox-worker/aiEscalation.ts";
import type {KnowledgeOutcome} from "../supabase/functions/flow-outbox-worker/flowKnowledge.ts";

// ------------------------------------------------------------ policy
test("aiEscalationReason: only answer-less terminal outcomes escalate",()=>{
 assert.equal(aiEscalationReason({action:"finish",result:"no_knowledge"}),"no_knowledge");
 assert.equal(aiEscalationReason({action:"finish",result:"permanent",code:"ai_config_missing"}),"ai_unavailable");
 assert.equal(aiEscalationReason({action:"finish",result:"retry",code:"x",delaySeconds:60,exhausted:true}),
  "ai_retries_exhausted");
 assert.equal(aiEscalationReason({action:"finish",result:"retry",code:"x",delaySeconds:60,exhausted:false}),null);
 assert.equal(aiEscalationReason({action:"finish",result:"ineligible"}),null,"scope precondition, not an AI failure");
});

type Trace={calls:string[];finishes:Exclude<AiDecision,{action:"send"}>[]};
function deps(outcome:KnowledgeOutcome|(()=>never),opts:{attempt?:number;claim?:AiClaim;
 escalate?:(r:AiEscalationReason)=>Promise<boolean>;finish?:string|null}={}){
 const t:Trace={calls:[],finishes:[]};
 const d={
  claim:async():Promise<AiClaim>=>{t.calls.push("claim");
   return opts.claim??{outcome:"claimed",token:"tok",attempt:opts.attempt??1};},
  decrypt:async(e:string)=>e,
  generate:async()=>{t.calls.push("generate");
   if(typeof outcome==="function")return outcome();return outcome;},
  store:async()=>{t.calls.push("store");return true;},
  finish:async(_tok:string,dec:Exclude<AiDecision,{action:"send"}>)=>{t.calls.push("finish");
   t.finishes.push(dec);return opts.finish===undefined?(dec.result==="retry"&&!dec.exhausted?"retry_wait":
    dec.result==="no_knowledge"||dec.result==="ineligible"?"cancelled":"dead_letter"):opts.finish;},
  random:()=>0,
  ...(opts.escalate?{escalate:async(r:AiEscalationReason)=>{t.calls.push("escalate:"+r);return opts.escalate!(r);}}:{})
 };
 return {d,t};
}
const yes=async()=>true,no=async()=>false;

test("flag OFF (no escalate dep): every outcome and key exactly as before",async()=>{
 for(const [o,attempt,key] of [
  [{kind:"no_knowledge"},1,"cancelled_no_knowledge"],
  [{kind:"ineligible"},1,"cancelled_ineligible"],
  [{kind:"permanent",code:"ai_config_missing"},1,"dead_letter_ai_unavailable"],
  [{kind:"transient",code:"ai_timeout"},1,"ai_retry_scheduled"],
  [{kind:"transient",code:"ai_timeout"},AI_MAX_ATTEMPTS,"dead_letter_ai_retries_exhausted"],
 ] as [KnowledgeOutcome,number,string][]){
  const {d,t}=deps(o,{attempt});
  assert.deepEqual(await resolveKnowledgeEffect(d),{status:"report",key});
  assert.deepEqual(t.calls,["claim","generate","finish"]);
 }
 const {d}=deps({kind:"no_knowledge"},{claim:{outcome:"exhausted"}});
 assert.deepEqual(await resolveKnowledgeEffect(d),{status:"report",key:"dead_letter_ai_retries_exhausted"});
});

test("flag ON: no_knowledge / permanent / exhausted escalate BEFORE finish; same report keys",async()=>{
 for(const [o,attempt,reason,key] of [
  [{kind:"no_knowledge"},1,"no_knowledge","cancelled_no_knowledge"],
  [{kind:"permanent",code:"ai_config_missing"},2,"ai_unavailable","dead_letter_ai_unavailable"],
  [{kind:"transient",code:"ai_timeout"},AI_MAX_ATTEMPTS,"ai_retries_exhausted","dead_letter_ai_retries_exhausted"],
 ] as [KnowledgeOutcome,number,AiEscalationReason,string][]){
  const {d,t}=deps(o,{attempt,escalate:yes});
  assert.deepEqual(await resolveKnowledgeEffect(d),{status:"report",key});
  assert.deepEqual(t.calls,["claim","generate","escalate:"+reason,"finish"]);
 }
});

test("flag ON: ineligible, scheduled retry and answers never escalate",async()=>{
 for(const o of [{kind:"ineligible"},{kind:"transient",code:"ai_timeout"}] as KnowledgeOutcome[]){
  const {d,t}=deps(o,{escalate:yes});
  await resolveKnowledgeEffect(d);
  assert.ok(!t.calls.some(c=>c.startsWith("escalate")),JSON.stringify(o));
 }
 const {d,t}=deps({kind:"answer",text:"Price is 1000 IQD"},{escalate:yes});
 assert.deepEqual(await resolveKnowledgeEffect(d),{status:"send",text:"Price is 1000 IQD"});
 assert.deepEqual(t.calls,["claim","generate","store"]);
});

test("flag ON: failed / throwing escalation never finishes (no silent cancel); lease retry later",async()=>{
 for(const esc of [no,async()=>{throw new Error("db down");}] as ((r:AiEscalationReason)=>Promise<boolean>)[]){
  const {d,t}=deps({kind:"no_knowledge"},{escalate:esc});
  assert.deepEqual(await resolveKnowledgeEffect(d),{status:"report",key:"ai_escalation_failed"});
  assert.deepEqual(t.calls,["claim","generate","escalate:no_knowledge"]);
  assert.equal(t.finishes.length,0);
 }
 // A generate() crash is a transient retry, not an escalation (unless exhausted).
 const {d,t}=deps(()=>{throw new Error("boom");},{escalate:yes});
 assert.deepEqual(await resolveKnowledgeEffect(d),{status:"report",key:"ai_retry_scheduled"});
 assert.ok(!t.calls.some(c=>c.startsWith("escalate")));
});

test("flag ON: claim 'exhausted' (abandoned attempts) gets a last idempotent escalation",async()=>{
 let r=deps({kind:"no_knowledge"},{claim:{outcome:"exhausted"},escalate:yes});
 assert.deepEqual(await resolveKnowledgeEffect(r.d),{status:"report",key:"dead_letter_ai_retries_exhausted"});
 assert.deepEqual(r.t.calls,["claim","escalate:ai_retries_exhausted"]);
 r=deps({kind:"no_knowledge"},{claim:{outcome:"exhausted"},escalate:no});
 assert.deepEqual(await resolveKnowledgeEffect(r.d),{status:"report",key:"dead_letter_ai_escalation_failed"});
 // busy / not_due / cached never escalate.
 for(const claim of [{outcome:"busy"},{outcome:"not_due"},{outcome:"not_claimable"}] as AiClaim[]){
  r=deps({kind:"no_knowledge"},{claim,escalate:yes});
  await resolveKnowledgeEffect(r.d);
  assert.deepEqual(r.t.calls,["claim"]);
 }
});

// ------------------------------------------------------------ escalation writes
type R=Record<string,unknown>;
/** Tiny tenant-agnostic PostgREST fake: every filter is applied literally. */
class Db{
 tables:Record<string,R[]>={unresolved_questions:[],conversations:[]};
 log:{table:string;op:string;filters:string[]}[]=[];
 fail:Record<string,boolean>={};
 seq=0;
 from(table:string){
  const db=this;
  const filters:((r:R)=>boolean)[]=[],names:string[]=[];
  let op="select",payload:R|null=null,lim=Infinity;
  const run=()=>{
   db.log.push({table,op,filters:[...names]});
   if(db.fail[table+":"+op])return {data:null,error:{code:"57014"}};
   const rows=(db.tables[table]??=[]);
   if(op==="insert"){rows.push({id:"q"+(++db.seq),created_at:"2026-11-08T10:00:01.000Z",...payload});return {data:null,error:null};}
   const hit=rows.filter(r=>filters.every(f=>f(r)));
   if(op==="update"){for(const r of hit)Object.assign(r,payload);return {data:hit.map(r=>({id:r.id})),error:null};}
   return {data:hit.slice(0,lim).map(r=>({...r})),error:null};
  };
  const q:R={
   select:()=>q,
   insert:(p:R)=>{op="insert";payload=p;return q;},
   update:(p:R)=>{op="update";payload=p;return q;},
   eq:(k:string,v:unknown)=>{names.push(k);filters.push(r=>r[k]===v);return q;},
   is:(k:string,v:unknown)=>{names.push(k);filters.push(r=>(r[k]??null)===v);return q;},
   gte:(k:string,v:string)=>{names.push(k);filters.push(r=>String(r[k])>=v);return q;},
   limit:(n:number)=>{lim=n;return q;},
   maybeSingle:async()=>{const r=run();return {data:Array.isArray(r.data)?r.data[0]??null:null,error:r.error};},
   then:(ok:(v:unknown)=>unknown,ko:(e:unknown)=>unknown)=>Promise.resolve(run()).then(ok,ko)
  };
  return q;
 }
}
const A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222";
const CONV="c0000000-0000-4000-8000-000000000001",ACC="a0000000-0000-4000-8000-000000000001";
const SINCE="2026-11-08T10:00:00.000Z",NOW=Date.parse("2026-11-08T10:05:00.000Z");
const QUESTION="Do you ship to Basra tomorrow?";
const ctx=(o:Partial<AiEscalationContext>={}):AiEscalationContext=>
 ({tenantId:A,conversationId:CONV,accountId:ACC,since:SINCE,question:QUESTION,nowMs:NOW,...o});
const enc=async(p:string)=>"enc:v1:"+Buffer.from(p).toString("hex");
function seeded(){
 const db=new Db();
 db.tables.conversations.push({id:CONV,tenant_id:A,account_id:ACC,transferred:false,
  auto_paused_reason:null,human_agent_expires_at:null});
 return db;
}

test("escalateAiFailure: one encrypted open question + ai_handoff; re-runs never duplicate",async()=>{
 const db=seeded();
 assert.equal(await escalateAiFailure(db,ctx(),enc),true);
 assert.equal(db.tables.unresolved_questions.length,1);
 const q=db.tables.unresolved_questions[0];
 assert.equal(q.tenant_id,A);assert.equal(q.conversation_id,CONV);assert.equal(q.status,"open");
 assert.match(String(q.question_encrypted),/^enc:v1:/);
 assert.ok(!String(q.question_encrypted).includes(QUESTION),"never stored in plain text");
 const c=db.tables.conversations[0];
 assert.equal(c.transferred,true);assert.equal(c.auto_paused_reason,"ai_handoff");
 assert.equal(c.human_agent_expires_at,new Date(NOW+AI_ESCALATION_HANDOFF_MINUTES*60000).toISOString());
 // Retry / re-claim / second worker: nothing new.
 for(let i=0;i<3;i++)assert.equal(await escalateAiFailure(db,ctx({nowMs:NOW+i*1000}),enc),true);
 assert.equal(db.tables.unresolved_questions.length,1);
 assert.equal(c.human_agent_expires_at,new Date(NOW+AI_ESCALATION_HANDOFF_MINUTES*60000).toISOString(),
  "an existing takeover expiry is never extended/overwritten");
});

test("escalateAiFailure: every statement is tenant-scoped; another tenant is never touched",async()=>{
 const db=seeded();
 // Same conversation id under another tenant (defense in depth) + its open question.
 db.tables.conversations.push({id:CONV,tenant_id:B,account_id:ACC,transferred:false});
 db.tables.unresolved_questions.push({id:"qb",tenant_id:B,conversation_id:CONV,status:"open",
  created_at:"2026-11-08T10:00:02.000Z",question_encrypted:"enc:v1:00"});
 assert.equal(await escalateAiFailure(db,ctx(),enc),true);
 assert.equal(db.tables.unresolved_questions.filter(r=>r.tenant_id===A).length,1,
  "B's open question does not satisfy A's dedupe");
 assert.equal(db.tables.conversations.find(r=>r.tenant_id===B)!.transferred,false);
 for(const l of db.log)assert.ok(l.op==="insert"||l.filters.includes("tenant_id"),JSON.stringify(l));
 // Never billing / credits.
 assert.ok(db.log.every(l=>["unresolved_questions","conversations"].includes(l.table)));
});

test("escalateAiFailure: manual takeover kept; old resolved/earlier questions do not dedupe",async()=>{
 const db=seeded();
 Object.assign(db.tables.conversations[0],{transferred:true,auto_paused_reason:"manual_takeover",
  human_agent_expires_at:"2026-11-08T11:00:00.000Z"});
 db.tables.unresolved_questions.push(
  {id:"old",tenant_id:A,conversation_id:CONV,status:"open",created_at:"2026-11-07T09:00:00.000Z"},
  {id:"res",tenant_id:A,conversation_id:CONV,status:"resolved",created_at:"2026-11-08T10:00:03.000Z"});
 assert.equal(await escalateAiFailure(db,ctx(),enc),true);
 assert.equal(db.tables.unresolved_questions.length,3,"a new question for this AI step");
 assert.equal(db.tables.conversations[0].auto_paused_reason,"manual_takeover");
 assert.equal(db.tables.conversations[0].human_agent_expires_at,"2026-11-08T11:00:00.000Z");
});

test("escalateAiFailure: failures return false (caller retries), question never duplicated across retries",async()=>{
 for(const k of ["unresolved_questions:select","unresolved_questions:insert"]){
  const db=seeded();db.fail[k]=true;
  assert.equal(await escalateAiFailure(db,ctx(),enc),false,k);
  assert.equal(db.tables.conversations[0].transferred,false,"no handoff without the recorded question");
 }
 const db=seeded();db.fail["conversations:update"]=true;
 assert.equal(await escalateAiFailure(db,ctx(),enc),false);
 assert.equal(db.tables.unresolved_questions.length,1);
 delete db.fail["conversations:update"];
 assert.equal(await escalateAiFailure(db,ctx(),enc),true);
 assert.equal(db.tables.unresolved_questions.length,1,"retry reused the recorded question");
 assert.equal(db.tables.conversations[0].transferred,true);
 // Encryption failure / unusable cipher text / throwing client.
 assert.equal(await escalateAiFailure(seeded(),ctx(),async()=>{throw new Error("no key");}),false);
 assert.equal(await escalateAiFailure(seeded(),ctx(),async p=>p),false,"plain text is never stored");
 assert.equal(await escalateAiFailure({from:()=>{throw new Error("x");}},ctx(),enc),false);
 // Conversation of another account / missing: no handoff, false.
 const other=seeded();
 assert.equal(await escalateAiFailure(other,ctx({accountId:"a0000000-0000-4000-8000-000000000009"}),enc),false);
 assert.equal(other.tables.conversations[0].transferred,false);
});

test("escalateAiFailure: invalid context does no I/O",async()=>{
 for(const bad of [{tenantId:""},{conversationId:""},{accountId:""},{since:""},{question:"   "},{nowMs:NaN}]){
  const db=seeded();
  assert.equal(await escalateAiFailure(db,ctx(bad as Partial<AiEscalationContext>),enc),false,JSON.stringify(bad));
  assert.equal(db.log.length,0);
 }
});

test("end-to-end: escalation fails once, succeeds on the re-claim; one question, one handoff, no sends",async()=>{
 const db=seeded();let flaky=true,finished=0,sends=0;
 const run=()=>resolveKnowledgeEffect({
  claim:async()=>({outcome:"claimed",token:"t",attempt:1}),decrypt:async e=>e,
  generate:async()=>({kind:"no_knowledge"}),
  store:async()=>{sends++;return true;},
  finish:async()=>{finished++;return "cancelled";},
  escalate:async()=>{
   if(flaky){flaky=false;db.fail["conversations:update"]=true;}else delete db.fail["conversations:update"];
   return escalateAiFailure(db,ctx(),enc);
  }
 });
 assert.deepEqual(await run(),{status:"report",key:"ai_escalation_failed"});
 assert.equal(finished,0);
 assert.deepEqual(await run(),{status:"report",key:"cancelled_no_knowledge"});
 assert.equal(finished,1);assert.equal(sends,0);
 assert.equal(db.tables.unresolved_questions.length,1);
 assert.equal(db.tables.conversations[0].transferred,true);
});

// ------------------------------------------------------------ worker wiring (static)
test("worker wiring: escalate only behind FLOW_AI_STEP_ENABLED, tenant-scoped, no customer text logged, no billing",()=>{
 const code=readFileSync("supabase/functions/flow-outbox-worker/index.ts","utf8");
 assert.match(code,/\.\.\.\(aiStep\?\{escalate:async\(reason:AiEscalationReason\)=>\{/);
 assert.match(code,/escalateAiFailure\(sb,\{tenantId:String\(tenant\.id\),\s*conversationId:String\(conversation\.id\),accountId:String\(account\.id\),\s*since:String\(effect\.created_at\),question,nowMs:Date\.now\(\)\},\s*plain=>encryptMessageBody\(plain,fieldKey\)\);/);
 const claim=code.indexOf('sb.rpc("flow_claim_outbox_ai"');
 const esc=code.indexOf("escalateAiFailure(sb,");
 const reserve=code.indexOf('sb.rpc("flow_reserve_outbox_delivery"');
 assert(claim>0&&esc>claim&&reserve>esc,"order");
 assert.equal((code.match(/sb\.rpc\("consume_flow_reply"/g)??[]).length,1,"no new debit path");
 for(const line of code.split("\n").filter(l=>/console\.(log|info|warn|error)/.test(l)))
  assert.doesNotMatch(line,/question|messageText|plain|QUESTION|resolved\.text/,line);
 const mod=readFileSync("supabase/functions/flow-outbox-worker/aiEscalation.ts","utf8")
  .replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/.*$/gm,"");
 assert.doesNotMatch(mod,/console\.|credits|consume_|\.rpc\(|^import /m);
 const retry=readFileSync("supabase/functions/flow-outbox-worker/knowledgeRetry.ts","utf8");
 assert.doesNotMatch(retry,/console\./);
});
