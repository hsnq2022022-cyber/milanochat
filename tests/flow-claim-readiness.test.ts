// Flow-claim-then-silence rule (task B): a NEW durable run is started only when
// the workers that must produce its reply are ready; otherwise NOTHING is
// claimed and the event falls back to V2 / the legacy AI (one reply under its
// own exclusive claim). Plus the opt-in overdue-wake bound of
// flow-runtime-worker (overdueGuard.ts).
// Mocks only: in-memory fake PostgREST client, Deno.env shim, no network/DB.
// Run: node --experimental-strip-types --test tests/flow-claim-readiness.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {attemptDurableInstagram,durableWorkerGatesOpen,durableWorkersStalled,
 DURABLE_STALL_GRACE_MINUTES} from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {processExclusiveEvent} from "../supabase/functions/milan-api/exclusiveMessageClaim.ts";
import {wakeMaxOverdueMinutes,wakeOverdue,endOverdueWake,WAKE_OVERDUE_END_REASON}
 from "../supabase/functions/flow-runtime-worker/overdueGuard.ts";

type Env=Record<string,string|undefined>;
async function withEnv<T>(env:Env,fn:()=>Promise<T>|T):Promise<T>{
 const old=(globalThis as any).Deno;
 (globalThis as any).Deno={env:{get:(k:string)=>env[k]}};
 try{return await fn();}finally{(globalThis as any).Deno=old;}
}
const T={a:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",b:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
const A={a:"11111111-1111-4111-8111-111111111111",b:"22222222-2222-4222-8222-222222222222"};
const WORKERS_READY:Env={FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved",
 FLOW_OUTBOX_SEND_ENABLED:"true",FLOW_ATOMIC_CONSUME_READY:"true",FLOW_DURABLE_SCHEDULER_ENABLED:"true",
 FLOW_RICH_BUTTONS_ENABLED:"true",FLOW_INTERNAL_ACTIONS_ENABLED:"true",FIELD_ENCRYPTION_KEY:"test-only-field-key"};
const canary:Env={...WORKERS_READY,FLOW_DURABLE_INGRESS_ENABLED:"true",FLOW_DURABLE_CANARY_ACCOUNT_ID:A.a};

const trigger={kind:"trigger",platform:"instagram",triggerMode:"message",keywords:""};
/** The production shape: message trigger -> 1 minute delay -> message. */
const delayDoc={version:3,nodes:[{id:"start",data:trigger},
 {id:"sleep",data:{kind:"delay",delayValue:1,delayUnit:"minutes"}},
 {id:"yes",data:{kind:"message",text:"after a minute",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"sleep",sourceHandle:"next"},{source:"sleep",target:"yes",sourceHandle:"next"}]};
const buttonsDoc={version:3,nodes:[{id:"start",data:trigger},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"pick",image:"",contentBlocks:[],options:[
  {id:"p",label:"P"},{id:"s",label:"S"}]}},
 {id:"yes",data:{kind:"message",text:"P!",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"S!",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},
  {source:"choose",target:"yes",sourceHandle:"p"},{source:"choose",target:"no",sourceHandle:"s"}]};

const ev=(over:Record<string,unknown>={})=>({tenantId:T.a,accountId:A.a,
 conversationId:"44444444-4444-4444-8444-444444444444",inboundId:"77777777-7777-4777-8777-777777777771",
 eventId:"meta-1",platform:"instagram",providerEventIdGenuine:true,text:"hi",...over}) as any;

/**
 * Fake client. `sleeping` / `pending` are the rows the stall reads return
 * (filters are recorded; tenant scoping is asserted by the tests).
 */
function fakeDb(o:{doc:unknown;sleeping?:any[];pending?:any[];stallError?:boolean}){
 const reads:Array<{table:string;filters:Record<string,unknown>;lte?:[string,string]}>=[];
 const calls:Array<{name:string;args:any}>=[];
 const db:any={
  from:(table:string)=>{
   const filters:Record<string,unknown>={};let lte:[string,string]|undefined;
   const q:any={
    select:()=>q,eq:(k:string,v:unknown)=>{filters[k]=v;return q;},
    in:(k:string,v:unknown)=>{filters[k]=v;return q;},gt:()=>q,
    lte:(k:string,v:string)=>{lte=[k,v];return q;},order:()=>q,
    update:()=>{throw Error("unexpected write");},insert:()=>{throw Error("unexpected write");},
    maybeSingle:async()=>{reads.push({table,filters});
     if(table==="automation_flow_global_switch")return {data:{enabled:true},error:null};
     if(table==="automation_flow_tenant_switches")
      return {data:{enabled:true,test_only:false,production_approved:true},error:null};
     if(table==="automation_flow_publications")return {data:{document:o.doc},error:null};
     return {data:null,error:null};
    },
    limit:async()=>{reads.push({table,filters,lte});
     if(table==="automation_flow_activations")
      return {data:[{flow_key:"f",revision:1,is_active:true}],error:null};
     if(table==="automation_flow_runs"&&filters.run_status==="sleeping")
      return o.stallError?{data:null,error:{code:"XX000"}}:{data:o.sleeping??[],error:null};
     if(table==="automation_flow_outbox")
      return o.stallError?{data:null,error:{code:"XX000"}}:{data:o.pending??[],error:null};
     return {data:[],error:null};
    }
   };return q;
  },
  rpc:async(name:string,args:any)=>{
   calls.push({name,args});
   if(name==="flow_claim_begin_durable_run")
    return {data:[{acquired:true,run_id:"88888888-8888-4888-8888-888888888888"}],error:null};
   throw Error("Unexpected RPC "+name);
  }
 };
 return {db,reads,calls};
}
const minutesAgo=(m:number)=>new Date(Date.now()-m*60000).toISOString();

// ------------------------------------------------------------- gates (no IO)
test("gates: every worker gate the reply needs must be open; fail-closed on missing/garbage/throw",async()=>{
 const none={scheduler:false,buttons:false,internal:false};
 await withEnv(WORKERS_READY,()=>{
  assert.equal(durableWorkerGatesOpen(none),true);
  assert.equal(durableWorkerGatesOpen({scheduler:true,buttons:true,internal:true}),true);
 });
 for(const k of ["FLOW_WORKERS_OPERATOR_RELEASE","FLOW_OUTBOX_SEND_ENABLED","FLOW_ATOMIC_CONSUME_READY"])
  for(const v of [undefined,"","false","TRUE","yes"])
   await withEnv({...WORKERS_READY,[k]:v},()=>assert.equal(durableWorkerGatesOpen(none),false,k+"="+v));
 // the outbox worker needs a field key (presence check, like the worker)
 for(const v of [undefined,""])
  await withEnv({...WORKERS_READY,FIELD_ENCRYPTION_KEY:v},()=>assert.equal(durableWorkerGatesOpen(none),false,"key="+v));
 // need-specific gates only matter when the document needs them
 for(const [k,need] of [["FLOW_DURABLE_SCHEDULER_ENABLED","scheduler"],["FLOW_RICH_BUTTONS_ENABLED","buttons"],
   ["FLOW_INTERNAL_ACTIONS_ENABLED","internal"]] as const){
  await withEnv({...WORKERS_READY,[k]:"false"},()=>{
   assert.equal(durableWorkerGatesOpen(none),true,k+" irrelevant");
   assert.equal(durableWorkerGatesOpen({...none,[need]:true}),false,k+" required");
  });
 }
 const old=(globalThis as any).Deno;
 (globalThis as any).Deno={env:{get:()=>{throw Error("boom");}}};
 try{assert.equal(durableWorkerGatesOpen(none),false,"throwing env reader = not ready");}
 finally{(globalThis as any).Deno=old;}
});

// ------------------------------------------------------- ingress behaviour
test("ready workers: the production delay flow starts ONE run via the atomic claim (flow reply owned by the run)",async()=>{
 await withEnv(canary,async()=>{
  const {db,calls,reads}=fakeDb({doc:delayDoc});
  assert.equal(await attemptDurableInstagram(db,ev()),"handled");
  assert.deepEqual(calls.map(c=>c.name),["flow_claim_begin_durable_run"]);
  // both stall reads happened, tenant-scoped (runs also account-scoped)
  const runs=reads.find(r=>r.table==="automation_flow_runs"&&r.filters.run_status==="sleeping");
  // (pendingHandoff also reads the outbox; the stall read is the one with a time bound)
  const outbox=reads.find(r=>r.table==="automation_flow_outbox"&&r.lte);
  assert.ok(runs&&outbox);
  assert.equal(runs!.filters.tenant_id,T.a);assert.equal(runs!.filters.channel_account_id,A.a);
  assert.equal(outbox!.filters.tenant_id,T.a);
  assert.equal(outbox!.filters.delivery_status,"pending");
  assert.deepEqual(outbox!.filters.effect_kind,["message","question"]);
 });
});
test("gate closed (scheduler OFF for a delay flow): fallback BEFORE any claim, run or read of stall state",async()=>{
 await withEnv({...canary,FLOW_DURABLE_SCHEDULER_ENABLED:undefined},async()=>{
  const {db,calls,reads}=fakeDb({doc:delayDoc});
  assert.equal(await attemptDurableInstagram(db,ev()),"fallback");
  assert.deepEqual(calls,[],"nothing claimed or started");
  assert.ok(!reads.some(r=>r.lte),"no stall read: the gate decides first");
 });
 // outbox sender OFF: even a buttons flow (no delay) is not started
 await withEnv({...canary,FLOW_OUTBOX_SEND_ENABLED:"false"},async()=>{
  const {db,calls}=fakeDb({doc:buttonsDoc});
  assert.equal(await attemptDurableInstagram(db,ev()),"fallback");
  assert.deepEqual(calls,[]);
 });
});
test("stalled runtime worker (the production 401 case): an overdue sleeping run -> fallback, nothing claimed",async()=>{
 await withEnv(canary,async()=>{
  const sleeping=[{id:"r1",tenant_id:T.a,channel_account_id:A.a,run_status:"sleeping",
   wake_at:minutesAgo(DURABLE_STALL_GRACE_MINUTES+1)}];
  const {db,calls}=fakeDb({doc:delayDoc,sleeping});
  assert.equal(await attemptDurableInstagram(db,ev()),"fallback");
  assert.deepEqual(calls,[]);
 });
});
test("stalled outbox worker: a pending message effect older than the grace -> fallback",async()=>{
 await withEnv(canary,async()=>{
  const pending=[{id:"o1",tenant_id:T.a,delivery_status:"pending",effect_kind:"message",
   created_at:minutesAgo(DURABLE_STALL_GRACE_MINUTES+5)}];
  const {db,calls}=fakeDb({doc:buttonsDoc,pending});
  assert.equal(await attemptDurableInstagram(db,ev()),"fallback");
  assert.deepEqual(calls,[]);
 });
});
test("stall evidence is tenant/account-exact: rows of another tenant/account or too young are ignored",async()=>{
 const now=Date.now();
 const old=new Date(now-(DURABLE_STALL_GRACE_MINUTES+10)*60000).toISOString();
 const young=new Date(now-60000).toISOString();
 const db=(sleeping:any[],pending:any[])=>fakeDb({doc:delayDoc,sleeping,pending}).db;
 const e={tenantId:T.a,accountId:A.a};
 assert.equal(await durableWorkersStalled(db([],[]),e,now),"ok");
 assert.equal(await durableWorkersStalled(db([{tenant_id:T.b,channel_account_id:A.a,run_status:"sleeping",wake_at:old}],[]),e,now),"ok");
 assert.equal(await durableWorkersStalled(db([{tenant_id:T.a,channel_account_id:A.b,run_status:"sleeping",wake_at:old}],[]),e,now),"ok");
 assert.equal(await durableWorkersStalled(db([{tenant_id:T.a,channel_account_id:A.a,run_status:"sleeping",wake_at:young}],[]),e,now),"ok");
 assert.equal(await durableWorkersStalled(db([],[{tenant_id:T.b,delivery_status:"pending",effect_kind:"message",created_at:old}]),e,now),"ok");
 assert.equal(await durableWorkersStalled(db([],[{tenant_id:T.a,delivery_status:"pending",effect_kind:"delay",created_at:old}]),e,now),"ok",
  "delay markers are not deliveries");
 assert.equal(await durableWorkersStalled(db([],[{tenant_id:T.a,delivery_status:"pending",effect_kind:"question",created_at:old}]),e,now),"stalled");
 assert.equal(await durableWorkersStalled(db([{tenant_id:T.a,channel_account_id:A.a,run_status:"sleeping",wake_at:old}],[]),e,now),"stalled");
});
test("stall read error is UNKNOWN state: retry (no flow, no AI, nothing claimed)",async()=>{
 await withEnv(canary,async()=>{
  const {db,calls}=fakeDb({doc:delayDoc,stallError:true});
  assert.equal(await attemptDurableInstagram(db,ev()),"retry");
  assert.deepEqual(calls,[]);
 });
});

// ------------------------------------- fallback means exactly one AI reply
test("fallback -> the legacy AI answers ONCE under its own claim; a transient send failure never re-sends",async()=>{
 await withEnv({...canary,FLOW_DURABLE_SCHEDULER_ENABLED:"false"},async()=>{
  const {db,calls}=fakeDb({doc:delayDoc});
  assert.equal(await attemptDurableInstagram(db,ev()),"fallback");
  assert.deepEqual(calls,[]);
 });
 // The webhook then runs processExclusiveEvent (no V2 match -> legacy AI).
 const claims=new Set<string>();
 const sent:string[]=[];
 const run=(failSend:boolean)=>processExclusiveEvent({
  prepareFlow:async()=>null,
  claim:async(engineReady)=>{
   assert.equal(engineReady,false);
   if(claims.has("meta-1"))return {acquired:false,route:"legacy_ai",outgoing_message_id:"o-1"};
   claims.add("meta-1");return {acquired:true,route:"legacy_ai",outgoing_message_id:"o-1"};
  },
  legacyAnswer:async()=>"AI",
  send:async(t)=>{if(failSend)throw Error("provider 5xx");sent.push(t);return {providerMessageId:"mid"};},
  persistSent:async()=>true,debit:async()=>1
 });
 const first=await run(true);
 assert.equal(first,"send_failed","claim acquired, send failed: terminal, recorded as send_failed");
 const again=await run(false);
 assert.equal(again,"duplicate","a redelivery never sends a second reply");
 assert.deepEqual(sent,[]);
 const ok=new Set<string>();claims.clear();
 const r=await processExclusiveEvent({prepareFlow:async()=>null,
  claim:async()=>{if(ok.has("x"))return {acquired:false,route:"legacy_ai",outgoing_message_id:"o-2"};
   ok.add("x");return {acquired:true,route:"legacy_ai",outgoing_message_id:"o-2"};},
  legacyAnswer:async()=>"AI",send:async(t)=>{sent.push(t);return {providerMessageId:"mid"};},
  persistSent:async()=>true,debit:async()=>1});
 assert.equal(r,"sent_and_billed");
 assert.deepEqual(sent,["AI"],"exactly one AI reply");
});

// ---------------------------------------------- overdue wake bound (worker)
test("overdue bound: default OFF; only a valid 5..10080 integer turns it on",()=>{
 for(const v of [undefined,null,"","0","4","10081","abc","5.5"," 30","-30","30m","999999"])
  assert.equal(wakeMaxOverdueMinutes(()=>v as any),null,String(v));
 assert.equal(wakeMaxOverdueMinutes(()=>{throw Error("x");}),null);
 assert.equal(wakeMaxOverdueMinutes(()=>"5"),5);
 assert.equal(wakeMaxOverdueMinutes(()=>"10080"),10080);
});
test("overdue: only a parsable wake time beyond the bound; OFF never ends a run",()=>{
 const now=Date.parse("2026-11-10T12:00:00Z");
 assert.equal(wakeOverdue("2026-11-10T11:00:00Z",now,null),false,"OFF");
 assert.equal(wakeOverdue("2026-11-10T11:00:00Z",now,30),true);
 assert.equal(wakeOverdue("2026-11-10T11:31:00Z",now,30),false);
 assert.equal(wakeOverdue("2026-11-10T11:30:00Z",now,30),false,"exactly at the bound is not overdue");
 for(const w of [null,undefined,"","garbage",42])assert.equal(wakeOverdue(w,now,30),false,String(w));
});
test("overdue run is ENDED tenant-scoped with reason stale, expecting sleeping; failure is reported",async()=>{
 const calls:any[]=[];
 const ok=await endOverdueWake(async(fn,args)=>{calls.push([fn,args]);return {data:true,error:null};},T.a,"r1");
 assert.equal(ok,true);
 assert.deepEqual(calls,[["flow_cancel_run",{p_tenant:T.a,p_run:"r1",p_reason:"stale",p_expect_status:"sleeping"}]]);
 assert.equal(WAKE_OVERDUE_END_REASON,"stale");
 assert.equal(await endOverdueWake(async()=>({data:false,error:null}),T.a,"r1"),false);
 assert.equal(await endOverdueWake(async()=>({data:null,error:{code:"x"}}),T.a,"r1"),false);
});
test("static: the worker checks the overdue bound right after loading the sleeping run, before planning or committing",async()=>{
 const {readFileSync}=await import("node:fs");
 const s=readFileSync("supabase/functions/flow-runtime-worker/index.ts","utf8");
 const load=s.indexOf('throw Error("missing sleeping run")');
 const guard=s.indexOf("wakeOverdue(run.wake_at");
 const plan=s.indexOf("planUntilWait(doc,state");
 const commit=s.indexOf('sb.rpc("flow_commit_run_step"');
 assert.ok(load>0&&guard>load&&guard<plan&&guard<commit);
 assert.match(s.slice(guard,plan),/endOverdueWake\(/);
 assert.doesNotMatch(s.slice(guard,s.indexOf("continue;",guard)),/answerFromKnowledge|legacyAnswer|send/i,
  "an overdue run is ended, never answered late");
});
