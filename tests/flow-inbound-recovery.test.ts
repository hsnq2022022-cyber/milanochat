// B-3/B-4 opt-in inbound recovery (supabase/functions/milan-api/inboundRecovery.ts).
// Mocks only: an in-memory fake PostgREST client, fake decrypt / re-drive.
// The SQL side (leases, SKIP LOCKED race, backoff, 48h cap, opt-in, tenant
// isolation, rollback) is covered on a scratch PostgreSQL cluster by
// tests/flow-inbound-recovery-sql.test.mjs.
// Run: node --experimental-strip-types --test tests/flow-inbound-recovery.test.ts
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInboundRecovery,inboundRecoveryEnabled,recoveryLeaseActive,RECOVERY_MAX_AGE_HOURS,
 RECOVERY_MAX_ATTEMPTS,type RedriveEvent} from "../supabase/functions/milan-api/inboundRecovery.ts";
import {processExclusiveEvent} from "../supabase/functions/milan-api/exclusiveMessageClaim.ts";

const T="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",T2="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC="11111111-1111-4111-8111-111111111111";
const CONV="44444444-4444-4444-8444-444444444444";
const MSG="77777777-7777-4777-8777-777777777771";
const TOKEN="99999999-9999-4999-8999-999999999991";
const NOW=Date.parse("2026-11-10T12:00:00Z");
const ago=(min:number)=>new Date(NOW-min*60000).toISOString();
const SECRET="customer-private-text-123";

type Row=Record<string,unknown>;
function world(over:Partial<Record<string,Row[]>>={}){
 return {
  automation_inbound_recovery_tenants:[{tenant_id:T,enabled:true}],
  tenants:[{id:T,is_active:true,credits_remaining:10}],
  messages:[{id:MSG,tenant_id:T,conversation_id:CONV,direction:"in",wa_message_id:"aWdfZAG1mid",
   body_encrypted:"enc:v1:aa:bb:cc",created_at:ago(10)}],
  automation_message_claims:[] as Row[],
  conversations:[{id:CONV,tenant_id:T,account_id:ACC,wa_chat_id:"instagram:555",transferred:false,
   auto_paused_reason:null,human_agent_expires_at:null}],
  channel_accounts:[{id:ACC,tenant_id:T,channel:"instagram",external_id:"178",status:"active",
   agent_enabled:true,auto_reply:true,access_token_encrypted:"enc:v1:x"}],
  automation_flow_runs:[] as Row[],
  automation_inbound_routing_retries:[] as Row[],
  automation_inbound_recovery:[] as Row[],
  ...over
 } as Record<string,Row[]>;
}
/** Fake client. leaky=true ignores filters (proves the module re-checks tenant/ids itself). */
function fakeDb(tables:Record<string,Row[]>,o:{leases?:Row[];leaky?:boolean;errors?:string[]}={}){
 const reads:Array<{table:string;filters:Record<string,unknown>}>=[];
 const finishes:Row[]=[];
 const db:any={
  from:(table:string)=>{
   const f:Record<string,unknown>={};let gt:[string,string]|null=null;
   const run=()=>{
    reads.push({table,filters:{...f}});
    if(o.errors?.includes(table))return {data:null,error:{code:"XX000"}};
    let rows=tables[table]??[];
    if(!o.leaky){
     rows=rows.filter(r=>Object.entries(f).every(([k,v])=>r[k]===v));
     if(gt)rows=rows.filter(r=>String(r[gt![0]])>gt![1]);
    }
    return {data:rows,error:null};
   };
   const q:any={select:()=>q,eq:(k:string,v:unknown)=>{f[k]=v;return q;},
    gt:(k:string,v:string)=>{gt=[k,v];return q;},
    limit:async()=>run(),
    maybeSingle:async()=>{const r=run();return r.error?r:{data:(r.data as Row[])[0]??null,error:null};}};
   return q;
  },
  rpc:async(name:string,args:Row)=>{
   if(name==="flow_inbound_recovery_lease")return {data:o.leases??[{tenant_id:T,inbound_message_id:MSG,
    conversation_id:CONV,lease_token:TOKEN,attempts:1}],error:null};
   if(name==="flow_inbound_recovery_finish"){
    finishes.push(args);
    return {data:args.p_result==="retry"?"waiting":args.p_result,error:null};
   }
   throw Error("unexpected rpc "+name);
  }
 };
 return {db,reads,finishes};
}
async function sweep(tables:Record<string,Row[]>,o:{leases?:Row[];leaky?:boolean;errors?:string[];
 decrypt?:(s:string)=>Promise<string>;redrive?:(e:RedriveEvent)=>Promise<"retry"|void>;tenantId?:string}={}){
 const {db,reads,finishes}=fakeDb(tables,o);
 const redrives:RedriveEvent[]=[];
 const logs:unknown[]=[];
 const old={warn:console.warn,error:console.error,log:console.log,info:console.info};
 for(const k of ["warn","error","log","info"] as const)(console as any)[k]=(...a:unknown[])=>logs.push(a);
 let out:Record<string,number>;
 try{
  out=await runInboundRecovery(db,{nowMs:()=>NOW,tenantId:o.tenantId,
   decrypt:o.decrypt??(async()=>SECRET),
   redrive:async(e)=>{redrives.push(e);
    if(o.redrive)return o.redrive(e);
    // the re-drive claims the event (what handleIncomingWebhookMessage does)
    tables.automation_message_claims.push({id:"c1",tenant_id:e.account.tenant_id,inbound_message_id:e.inboundId});
   }});
 }finally{Object.assign(console,old);}
 return {out:out!,redrives,reads,finishes,logs};
}
const reason=(f:Row[])=>f.map(x=>`${x.p_result}:${x.p_reason}`);

test("gate: default OFF; needs FLOW_INBOUND_RECOVERY_ENABLED=true AND the worker release; throwing reader OFF",()=>{
 const g=(e:Record<string,string>)=>inboundRecoveryEnabled(k=>e[k]);
 assert.equal(g({}),false);
 assert.equal(g({FLOW_INBOUND_RECOVERY_ENABLED:"true"}),false);
 assert.equal(g({FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved"}),false);
 assert.equal(g({FLOW_INBOUND_RECOVERY_ENABLED:"TRUE",FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved"}),false);
 assert.equal(g({FLOW_INBOUND_RECOVERY_ENABLED:"true",FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved"}),true);
 assert.equal(inboundRecoveryEnabled(()=>{throw Error("x");}),false);
 assert.equal(RECOVERY_MAX_AGE_HOURS,48);
 assert.ok(RECOVERY_MAX_ATTEMPTS>=1&&RECOVERY_MAX_ATTEMPTS<=10);
});

test("happy path: context rebuilt from stored rows only; ONE re-drive through the webhook function; resolved 'processed'",async()=>{
 const w=world();
 const r=await sweep(w);
 assert.equal(r.redrives.length,1);
 const e=r.redrives[0];
 assert.equal(e.account.id,ACC);assert.equal(e.channel,"instagram");assert.equal(e.chatId,"instagram:555");
 assert.equal(e.eventId,"aWdfZAG1mid");assert.equal(e.text,SECRET);
 assert.equal(e.conversationId,CONV);assert.equal(e.inboundId,MSG);assert.equal(e.phoneId,undefined);
 assert.deepEqual(reason(r.finishes),["resolved:processed"]);
 assert.equal(r.finishes[0].p_token,TOKEN);
 assert.deepEqual(r.out,{"resolved:processed":1});
});

test("no plaintext: decrypted text never in logs, finish args, counters or errors",async()=>{
 const w=world({messages:[{id:MSG,tenant_id:T,conversation_id:CONV,direction:"in",wa_message_id:"ig_syn_1",
  body_encrypted:"enc:v1:a",created_at:ago(10)}]});
 const runs=[await sweep(world()),await sweep(w),
  await sweep(world(),{redrive:async()=>{throw Error("boom "+SECRET);}}),
  await sweep(world(),{decrypt:async()=>{throw Error("bad "+SECRET);}})];
 for(const r of runs){
  const flat=JSON.stringify([r.logs,r.finishes,r.out]);
  assert.ok(!flat.includes(SECRET),flat);
  assert.ok(!flat.includes(MSG)&&!flat.includes(CONV),"no ids in logs/counters either");
 }
});

test("known terminal conditions resolve WITHOUT a re-drive (no reply)",async()=>{
 const cases:Array<[string,Partial<Record<string,Row[]>>]>=[
  ["tenant_inactive",{tenants:[{id:T,is_active:false,credits_remaining:10}]}],
  ["tenant_missing",{tenants:[]}],
  ["conversation_missing",{conversations:[]}],
  ["account_inactive",{channel_accounts:[{...world().channel_accounts[0],status:"disabled"}]}],
  ["human_takeover",{conversations:[{...world().conversations[0],transferred:true,auto_paused_reason:"staff"}]}],
  ["credits_paused",{conversations:[{...world().conversations[0],auto_paused_reason:"credits"}]}],
  ["auto_reply_off",{channel_accounts:[{...world().channel_accounts[0],auto_reply:false}]}],
  ["auto_reply_off",{channel_accounts:[{...world().channel_accounts[0],agent_enabled:false}]}],
  ["no_credits",{tenants:[{id:T,is_active:true,credits_remaining:0}]}],
  ["claimed",{automation_message_claims:[{id:"c",tenant_id:T,inbound_message_id:MSG}]}],
  ["superseded",{messages:[...world().messages,{id:"m2",tenant_id:T,conversation_id:CONV,direction:"out",created_at:ago(5)}]}],
 ];
 for(const [code,over] of cases){
  const r=await sweep(world(over));
  assert.equal(r.redrives.length,0,code);
  assert.deepEqual(reason(r.finishes),["resolved:"+code],code);
 }
 // an EXPIRED manual takeover is not a takeover (same rule as the webhook)
 const expired=await sweep(world({conversations:[{...world().conversations[0],transferred:true,
  auto_paused_reason:"manual_takeover",human_agent_expires_at:ago(1)}]}));
 assert.equal(expired.redrives.length,1);
});

test("unreconstructable context -> exhausted with a reason code, never a guess, never re-driven",async()=>{
 const m=world().messages[0],c=world().conversations[0],a=world().channel_accounts[0];
 const cases:Array<[string,Partial<Record<string,Row[]>>,object?]>=[
  ["synthetic_event_id",{messages:[{...m,wa_message_id:"ig_syn_abcdef"}]}],
  ["synthetic_event_id",{messages:[{...m,wa_message_id:"ig_1731240000000"}]}],
  ["body_undecryptable",{messages:[{...m,body_encrypted:"legacy plaintext"}]}],
  ["body_undecryptable",{},{decrypt:async()=>{throw Error("auth tag");}}],
  ["body_unusable",{},{decrypt:async()=>"   "}],
  ["account_unproven",{conversations:[{...c,account_id:null}]}],
  ["account_missing",{channel_accounts:[]}],
  ["chat_unproven",{conversations:[{...c,wa_chat_id:"whatsapp:555"}]}],
  ["flow_context_unrecoverable",{automation_flow_runs:[{id:"r",tenant_id:T,conversation_id:CONV,run_status:"awaiting_input",updated_at:ago(30)}]}],
  ["flow_context_unrecoverable",{automation_flow_runs:[{id:"r",tenant_id:T,conversation_id:CONV,run_status:"completed",updated_at:ago(60)}]}],
  ["event_id_unproven",{channel_accounts:[{...a,channel:"whatsapp",external_id:"1000001"}],
   conversations:[{...c,wa_chat_id:"whatsapp:9647"}]}],
  ["phone_id_unproven",{channel_accounts:[{...a,channel:"whatsapp",external_id:"not-digits"}],
   conversations:[{...c,wa_chat_id:"whatsapp:9647"}],messages:[{...m,wa_message_id:"wamid.X"}]}],
  ["expired",{messages:[{...m,created_at:ago(48*60+1)}]}],
  ["message_missing",{messages:[]}],
 ];
 for(const [code,over,opt] of cases){
  const r=await sweep(world(over),opt as any);
  assert.equal(r.redrives.length,0,code);
  assert.deepEqual(reason(r.finishes),["exhausted:"+code],code);
 }
 // an old, finished run (> 24h before the message) is not flow context
 const r=await sweep(world({automation_flow_runs:[{id:"r",tenant_id:T,conversation_id:CONV,run_status:"completed",updated_at:ago(26*60)}]}));
 assert.equal(r.redrives.length,1);
});

test("WhatsApp: phone id = the account's external_id; wamid required",async()=>{
 const w=world({channel_accounts:[{...world().channel_accounts[0],channel:"whatsapp",external_id:"1000001"}],
  conversations:[{...world().conversations[0],wa_chat_id:"whatsapp:9647000000001"}],
  messages:[{...world().messages[0],wa_message_id:"wamid.HBg"}]});
 const r=await sweep(w);
 assert.equal(r.redrives.length,1);
 assert.equal(r.redrives[0].phoneId,"1000001");assert.equal(r.redrives[0].channel,"whatsapp");
});

test("unknown state -> retry (bounded by SQL), never resolved: read errors, re-drive 'retry', re-drive throw, opt-in turned off",async()=>{
 for(const t of ["tenants","messages","conversations","channel_accounts","automation_flow_runs","automation_message_claims"]){
  const r=await sweep(world(),{errors:[t]});
  assert.equal(r.redrives.length,0,t);
  assert.deepEqual(reason(r.finishes),["retry:read_error"],t);
 }
 assert.deepEqual(reason((await sweep(world(),{redrive:async()=>"retry"})).finishes),["retry:routing_unknown"]);
 assert.deepEqual(reason((await sweep(world(),{redrive:async()=>{throw Error("x");}})).finishes),["retry:redrive_error"]);
 const off=await sweep(world({automation_inbound_recovery_tenants:[{tenant_id:T,enabled:false}]}));
 assert.equal(off.redrives.length,0);
 assert.deepEqual(reason(off.finishes),["retry:opt_in_off"]);
 const none=await sweep(world({automation_inbound_recovery_tenants:[]}));
 assert.equal(none.redrives.length,0,"no opt-in row: never processed");
 // re-drive returned without a claim and without a routing exhaustion: terminal no-reply
 assert.deepEqual(reason((await sweep(world(),{redrive:async()=>undefined})).finishes),["resolved:no_reply_terminal"]);
 const ex=world({automation_inbound_routing_retries:[{tenant_id:T,inbound_message_id:MSG,status:"exhausted"}]});
 assert.deepEqual(reason((await sweep(ex,{redrive:async()=>undefined})).finishes),["exhausted:routing_exhausted"]);
});

test("tenant isolation: every read is tenant-scoped; foreign rows from a leaky client are never used",async()=>{
 const r=await sweep(world());
 for(const x of r.reads){
  const t=x.table==="tenants"?x.filters.id:x.filters.tenant_id;
  assert.equal(t,T,x.table+" read without the lease tenant");
 }
 // A client that ignores filters returns tenant B's rows only: never used.
 const foreign=world({
  automation_inbound_recovery_tenants:[{tenant_id:T2,enabled:true}]});
 const leak=await sweep(foreign,{leaky:true});
 assert.equal(leak.redrives.length,0);
 assert.deepEqual(reason(leak.finishes),["retry:opt_in_off"]);
 const foreignConv=world({conversations:[{...world().conversations[0],tenant_id:T2}],
  channel_accounts:[{...world().channel_accounts[0],tenant_id:T2}]});
 const leak2=await sweep(foreignConv,{leaky:true});
 assert.equal(leak2.redrives.length,0,"another tenant's conversation/account is never used");
 // a tenant-restricted sweep refuses lease rows of another tenant
 const other=await sweep(world(),{tenantId:T,leases:[{tenant_id:T2,inbound_message_id:MSG,conversation_id:CONV,lease_token:TOKEN}]});
 assert.equal(other.redrives.length,0);
 assert.deepEqual(other.out,{invalid_lease:1});
 assert.deepEqual(other.finishes,[]);
});

test("lease state unavailable (migration missing / rpc error) -> nothing processed",async()=>{
 const {db}=fakeDb(world());
 db.rpc=async()=>({data:null,error:{code:"42883"}});
 let called=0;
 const old=console.error;console.error=()=>{};
 try{
  const out=await runInboundRecovery(db,{decrypt:async()=>"x",redrive:async()=>{called++;}});
  assert.deepEqual(out,{lease_unavailable:1});
 }finally{console.error=old;}
 assert.equal(called,0);
});

test("webhook-vs-sweeper race: both re-drive the same event concurrently -> exactly ONE claim, ONE reply",async()=>{
 const claims=new Set<string>();const sent:string[]=[];
 const process=()=>processExclusiveEvent({
  prepareFlow:async()=>null,
  claim:async()=>{
   await new Promise(r=>setTimeout(r,Math.random()*5));
   if(claims.has(MSG))return {acquired:false,route:"legacy_ai",outgoing_message_id:"o"};
   claims.add(MSG);return {acquired:true,route:"legacy_ai",outgoing_message_id:"o"};
  },
  legacyAnswer:async()=>"AI",send:async(t)=>{sent.push(t);return {providerMessageId:"mid"};},
  persistSent:async()=>true,debit:async()=>1
 });
 const w=world();
 const sweeper=sweep(w,{redrive:async()=>{await process();}});
 const webhook=process();
 const [r]=await Promise.all([sweeper,webhook]);
 assert.equal(sent.length,1,"one reply only");
 assert.equal(claims.size,1);
 assert.equal(r.redrives.length,1);
});

test("webhook side: recoveryLeaseActive is true only for an unexpired lease of the same tenant/message",async()=>{
 const lease=(over:Row={})=>fakeDb({automation_inbound_recovery:[{tenant_id:T,inbound_message_id:MSG,
  status:"leased",lease_expires_at:new Date(NOW+60000).toISOString(),...over}]}).db;
 assert.equal(await recoveryLeaseActive(lease(),{tenantId:T,inboundId:MSG},NOW),true);
 assert.equal(await recoveryLeaseActive(lease({lease_expires_at:new Date(NOW-1).toISOString()}),{tenantId:T,inboundId:MSG},NOW),false);
 assert.equal(await recoveryLeaseActive(lease({status:"waiting"}),{tenantId:T,inboundId:MSG},NOW),false);
 assert.equal(await recoveryLeaseActive(lease(),{tenantId:T2,inboundId:MSG},NOW),false);
 assert.equal(await recoveryLeaseActive(lease(),{tenantId:"nope",inboundId:MSG},NOW),false);
 const err=fakeDb({},{errors:["automation_inbound_recovery"]}).db;
 assert.equal(await recoveryLeaseActive(err,{tenantId:T,inboundId:MSG},NOW),false,"missing table: behaviour before 360000");
});

test("static: milan-api inbound_recovery_tick authenticates FIRST (flow worker bearer), then the default-OFF gate, then work",()=>{
 const s=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const c=s.slice(s.indexOf('case "inbound_recovery_tick": {'),s.indexOf("default:",s.indexOf('case "inbound_recovery_tick": {')));
 const auth=c.indexOf("acceptsFlowWorkerBearer(");
 const gate=c.indexOf("inboundRecoveryEnabled(");
 const work=c.indexOf("runInboundRecovery(");
 assert.ok(auth>0&&auth<gate&&gate<work);
 assert.match(c,/env\("SUPABASE_SERVICE_ROLE_KEY"\),\s*env\("flow_worker_service_role_key"\)/);
 assert.match(c,/return json\(\{ error: "Unauthorized" \}, 401\)/);
 assert.match(c,/return json\(\{ status: "disabled" \}, 423\)/);
 assert.match(c,/decrypt: decryptFieldStrict/);
 assert.match(c,/redrive: \(e\) => handleIncomingWebhookMessage\(/,"same routing/claim function as the webhook");
 assert.doesNotMatch(c.slice(0,auth),/sb\.|from\(|rpc\(/,"no DB access before authentication");
 // flowWorkerAuth.ts itself is unchanged by this work (behaviour pinned elsewhere)
 const strict=s.slice(s.indexOf("async function decryptFieldStrict("),s.indexOf("async function userOf("));
 assert.doesNotMatch(strict,/console\./,"strict decrypt logs nothing");
 assert.match(strict,/throw new Error\("not an encrypted field"\)/);
});
