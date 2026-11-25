/**
 * Publication <-> runtime agreement for the durable rollout.
 * The runtime serves an account only when it is in the FLOW_DURABLE_CANARY_ACCOUNT_ID
 * allowlist AND registered in automation_flow_canary_accounts (PK tenant_id,platform:
 * ONE durable account per tenant and platform). Publication must report "live"
 * under exactly the same condition, never otherwise.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {T,A,KEY,pub,act,v2Doc,server,PROD_ENV,buttonsDoc,type Env} from "./flowPublicationDouble.ts";
import {RUNTIME_MESSAGES} from "../supabase/functions/flow-publication/activeRuntimeStatus.ts";
import {catalogRuntimeNote,catalogActiveFlows} from "../src/flow/activationAccount.ts";
import {makeNode,edgeFor} from "../src/flow/model.ts";
import {durableRegistryStatus,durableRuntimeAccepts,REGISTRY_MESSAGES} from "../supabase/functions/flow-publication/registryGate.ts";
import {notLiveReason,NOT_LIVE_MESSAGES} from "../supabase/functions/flow-publication/publishLive.ts";
import {classifyPublishLive,isSafeArabicMessage} from "../src/flow/publishLiveResult.ts";

const reg=(tenant:string,account:string)=>({tenant_id:tenant,channel_account_id:account,platform:"instagram"});
const env=(allow:string):Env=>({...PROD_ENV,FLOW_DURABLE_CANARY_ACCOUNT_ID:allow});
const pubs=()=>[pub(T.a,A.a,KEY,1,buttonsDoc),pub(T.a,A.a2,KEY,1,buttonsDoc),pub(T.b,A.b,KEY,1,buttonsDoc)];
const activate=(accountId:string)=>({action:"activate",accountId,flowKey:KEY,revision:1});
const token=(accountId:string)=>accountId===A.b?"jwt-b":"jwt-a";

test("allowlisted account WITH a matching registry row goes live",async()=>{
 const s=server({pubs:pubs(),registry:[reg(T.a,A.a)]});
 const r=await s.call(activate(A.a),"jwt-a",env(A.a));
 assert.equal(r.status,200);assert.equal(s.mutations().length,1);
});

test("allowlisted account WITHOUT a registry row is refused in Arabic and nothing is activated",async()=>{
 const s=server({pubs:pubs(),registry:[]});
 const r=await s.call(activate(A.a),"jwt-a",env(A.a));
 assert.equal(r.status,409);assert.equal(r.body.code,"FLOW_DURABLE_REGISTRY_MISSING");
 assert.equal(r.body.error,REGISTRY_MESSAGES.missing);assert.match(r.body.error,/[؀-ۿ]/);
 assert.doesNotMatch(r.body.error,/FLOW_|automation_|[0-9a-f]{8}-/);
 assert.equal(s.mutations().length,0);
});

test("registry row without allowlist membership never goes live as a durable flow",async()=>{
 const s=server({pubs:pubs(),registry:[reg(T.a,A.a)]});
 const r=await s.call(activate(A.a),"jwt-a",env(A.a2)); // allowlist names another account
 // Not allowlisted -> not durable -> the V2 shape check refuses a buttons graph: exact status and message.
 assert.equal(r.status,422);assert.equal(r.body.error,"This flow uses unsupported runtime features");
 assert.equal(r.body.code,undefined,"not a registry refusal");assert.equal(s.mutations().length,0);
 const c=await s.call({action:"capabilities",accountId:A.a,flowKey:KEY},"jwt-a",env(A.a2));
 assert.equal(c.body.canPublish.advanced,false);
});

test("several accounts under one tenant+platform: only the registered one works, the rest say so",async()=>{
 const s=server({pubs:pubs(),registry:[reg(T.a,A.a)]}); // PK(tenant,platform): a2 can never have a row
 const both=env(A.a+","+A.a2);
 assert.equal((await s.call(activate(A.a),"jwt-a",both)).status,200);
 const second=await s.call(activate(A.a2),"jwt-a",both);
 assert.equal(second.status,409);assert.equal(second.body.code,"FLOW_DURABLE_REGISTRY_OTHER_ACCOUNT");
 assert.equal(second.body.error,REGISTRY_MESSAGES.another_account);
 assert.equal(s.mutations().length,1);
});

test("tenant isolation: another tenant's registry row (even naming this account) grants nothing",async()=>{
 // Poisoned row: tenant B's registry slot names tenant A's account. It must not admit A's account for A.
 const poisoned=server({pubs:pubs(),registry:[{tenant_id:T.b,channel_account_id:A.a,platform:"instagram"}]});
 const r=await poisoned.call(activate(A.a),"jwt-a",env(A.a+","+A.b));
 assert.equal(r.status,409);assert.equal(poisoned.mutations().length,0);
 // Tenant B's own registered account is served; B cannot reach A's account.
 const s=server({pubs:pubs(),registry:[reg(T.b,A.b)]});
 assert.equal((await s.call(activate(A.b),"jwt-b",env(A.a+","+A.b))).status,200);
 const crossTenant=await s.call(activate(A.a),"jwt-b",env(A.a+","+A.b));
 assert.equal(crossTenant.status,403,"tenant B cannot act on tenant A's account");
 assert.equal((await s.call(activate(A.a),"jwt-a",env(A.a+","+A.b))).status,409);
});

test("registry read failure fails closed (503), nothing activated",async()=>{
 const s=server({pubs:pubs(),failTables:["automation_flow_canary_accounts"]});
 const r=await s.call(activate(A.a),"jwt-a",env(A.a));
 assert.equal(r.status,503);assert.equal(s.mutations().length,0);
});

test("publication == runtime: activate, readiness canary check and capabilities agree for every allowlist x registry state",async()=>{
 for(const allow of [true,false])for(const registered of [true,false]){
  const s=server({pubs:pubs(),registry:registered?[reg(T.a,A.a)]:[]});
  const e=env(allow?A.a:A.a2);
  const runtimeAccepts=allow&&registered; // flow_claim_inbound_durable + durableAccountAllowed
  const a=await s.call(activate(A.a),"jwt-a",e);
  const rd=await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:1},"jwt-a",e);
  const c=await s.call({action:"capabilities",accountId:A.a,flowKey:KEY},"jwt-a",e);
  const label=`allow=${allow} registered=${registered}`;
  assert.equal(a.status===200,runtimeAccepts,"activate "+label);
  assert.equal(rd.body.readiness.checks.canary,runtimeAccepts,"readiness "+label);
  assert.equal(c.body.canPublish.advanced,runtimeAccepts,"capabilities "+label);
 }
});

test("readiness explains a missing registration in Arabic only for allowlisted accounts",async()=>{
 const s=server({pubs:pubs(),registry:[]});
 const rd=await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:1},"jwt-a",env(A.a));
 assert.deepEqual(rd.body.readiness.registry,{status:"missing",message:REGISTRY_MESSAGES.missing});
 const other=await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:1},"jwt-a",env(A.a2));
 assert.equal(other.body.readiness.registry,undefined);
});

test("durableRegistryStatus: exact tenant+account+platform, fail closed",async()=>{
 const db=(rows:any[],error:unknown=null)=>({from:()=>{const f:any={};const q:any={select:()=>q,
  eq:(k:string,v:unknown)=>{f[k]=v;return q;},
  maybeSingle:async()=>({data:error?null:rows.find(r=>Object.entries(f).every(([k,v])=>r[k]===v))??null,error})};return q;}});
 const sc={tenantId:T.a,accountId:A.a,platform:"instagram"};
 assert.equal(await durableRegistryStatus(db([reg(T.a,A.a)]),sc),"registered");
 assert.equal(await durableRegistryStatus(db([reg(T.a,A.a2)]),sc),"another_account");
 assert.equal(await durableRegistryStatus(db([reg(T.b,A.a)]),sc),"missing");
 assert.equal(await durableRegistryStatus(db([],{code:"x"}),sc),"unavailable");
 assert.equal(durableRuntimeAccepts(true,"registered"),true);
 for(const st of ["missing","another_account","unavailable"] as const)assert.equal(durableRuntimeAccepts(true,st),false);
 assert.equal(durableRuntimeAccepts(false,"registered"),false);
});

// ------------------------------------------------------------ publish_live propagation
/** Editor-built durable graph (trigger -> one-minute delay -> text), as publish_live validates it. */
function durableDoc(){
 const t=makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:"message",keywords:""});
 const d=makeNode("delay",{x:0,y:100},{delayValue:1,delayUnit:"minutes"});
 const m=makeNode("message",{x:0,y:200},{text:"after"});
 return {version:3,name:"d",nodes:[t,d,m],edges:[edgeFor({source:t.id,target:d.id,sourceHandle:"next",targetHandle:"in"} as any),
  edgeFor({source:d.id,target:m.id,sourceHandle:"next",targetHandle:"in"} as any)]};
}
const live=(accountId:string)=>({action:"publish_live",accountId,flowKey:KEY,document:durableDoc()});
const CODES={missing:"FLOW_DURABLE_REGISTRY_MISSING",another_account:"FLOW_DURABLE_REGISTRY_OTHER_ACCOUNT",unavailable:"FLOW_DURABLE_REGISTRY_UNAVAILABLE"};
const REASONS={missing:"registry_missing",another_account:"registry_other_account",unavailable:"registry_unavailable"};

for(const [state,mk] of [
 ["missing",()=>server({registry:[]})],
 ["another_account",()=>server({registry:[reg(T.a,A.a2)]})],
 ["unavailable",()=>server({failTables:["automation_flow_canary_accounts"]})]
] as const){
 test(`publish_live: registry ${state} keeps its own reason, code and Arabic message (revision saved, never live)`,async()=>{
  const s=mk();
  const r=await s.call(live(A.a),"jwt-a",env(A.a));
  assert.equal(r.status,200);
  assert.deepEqual(r.body,{ok:true,status:"saved_not_live",revision:1,reason:REASONS[state],
   message:NOT_LIVE_MESSAGES[REASONS[state] as keyof typeof NOT_LIVE_MESSAGES],code:CODES[state]});
  assert.equal(s.mutations().length,0,"no activation");
  // The customer sees an Arabic sentence that passes the frontend's own safety filter; no code/ids/env/SQL.
  assert.equal(isSafeArabicMessage(r.body.message),true);
  assert.doesNotMatch(JSON.stringify(r.body.message),/automation_|FLOW_|canary|registry|PostgREST/i);
  const seen=classifyPublishLive(r.body);
  assert.deepEqual(seen,{kind:"saved_not_live",message:r.body.message});
 });
}

test("publish_live: registered account still goes live; unrelated refusals keep their old shape (no code field)",async()=>{
 const ok=server({registry:[reg(T.a,A.a)]});
 assert.deepEqual((await ok.call(live(A.a),"jwt-a",env(A.a))).body,{ok:true,status:"live",revision:1});
 const paused=server({accountPatch:{[A.a]:{auto_reply:false}}});
 const r=await paused.call(live(A.a),"jwt-a",env(A.a));
 assert.deepEqual(r.body,{ok:true,status:"saved_not_live",revision:1,reason:"account_paused",message:NOT_LIVE_MESSAGES.account_paused});
});

test("notLiveReason: registry codes win over the HTTP status; other 409/503 stay generic",()=>{
 const g=(status:number,code?:string)=>({ok:false as const,status,body:{ok:false as const,error:"x",...(code?{code}:{})}});
 assert.equal(notLiveReason(g(409,CODES.missing),false),"registry_missing");
 assert.equal(notLiveReason(g(409,CODES.another_account),false),"registry_other_account");
 assert.equal(notLiveReason(g(503,CODES.unavailable),false),"registry_unavailable");
 assert.equal(notLiveReason(g(409),false),"not_live_unknown");
 assert.equal(notLiveReason(g(409,"SOMETHING_ELSE"),false),"not_live_unknown");
 assert.equal(notLiveReason(g(503),false),"unavailable");
 assert.equal(notLiveReason(g(409,CODES.missing),true),"unsupported_feature");
});

// ------------------------------------------------------------ catalog honesty (active but not running)
const catalog=(s:ReturnType<typeof server>,e:Env,account=A.a)=>s.call({action:"catalog",accountId:account,flowKey:"default"},"jwt-a",e);
const activeDurable=(registry:ReturnType<typeof reg>[]|undefined,extra:Record<string,unknown>={})=>
 server({pubs:[pub(T.a,A.a,KEY,1,buttonsDoc)],acts:[act(T.a,A.a,KEY,1,true)],registry,...extra} as any);

test("catalog: allowlisted + registered + active durable flow = plain live entry (shape unchanged)",async()=>{
 const r=await catalog(activeDurable([reg(T.a,A.a)]),env(A.a));
 assert.equal(r.status,200);
 assert.deepEqual(r.body.activeFlows,[{flow_key:KEY,revision:1}]);
 assert.deepEqual(r.body.active,{flow_key:KEY,revision:1});
});

for(const [label,registry,reason] of [
 ["registry row removed",[],"registry_missing"],
 ["registry slot held by another account",[reg(T.a,A.a2)],"registry_other_account"]
] as const){
 test(`catalog: ${label} -> the active durable flow is reported as not running (activation untouched)`,async()=>{
  const s=activeDurable([...registry]);
  const r=await catalog(s,env(A.a));
  assert.equal(r.status,200);
  const expected={flow_key:KEY,revision:1,runtime:{status:"not_running",reason,message:RUNTIME_MESSAGES[reason]}};
  assert.deepEqual(r.body.activeFlows,[expected]);assert.deepEqual(r.body.active,expected);
  assert.equal(isSafeArabicMessage(RUNTIME_MESSAGES[reason]),true);
  // The activation row itself is untouched (no silent deactivation, no RPC).
  assert.equal(s.mutations().length,0);
  assert.equal(s.acts[0].is_active,true);
  const list=await s.call({action:"list",accountId:A.a,flowKey:KEY},"jwt-a",env(A.a));
  assert.equal(list.body.activation.is_active,true);
  // The frontend turns exactly this note into the visible reason for exactly this flow.
  assert.equal(catalogRuntimeNote(r.body,KEY),RUNTIME_MESSAGES[reason]);
  assert.equal(catalogRuntimeNote(r.body,"other_flow"),null);
  assert.deepEqual(catalogActiveFlows(r.body),[{flow_key:KEY,revision:1}],"existing parsing ignores the additive field");
 });
}

test("catalog: removed from the allowlist -> not_allowlisted; V2 text flows are never annotated",async()=>{
 const gone=await catalog(activeDurable([reg(T.a,A.a)]),env(A.a2));
 assert.equal(gone.body.activeFlows[0].runtime.reason,"not_allowlisted");
 const v2=server({pubs:[pub(T.a,A.a,KEY,1,v2Doc("HI"))],acts:[act(T.a,A.a,KEY,1,true)],registry:[]});
 assert.deepEqual((await catalog(v2,env(A.a))).body.activeFlows,[{flow_key:KEY,revision:1}]);
});

test("catalog: test_only tenants never needed the registry; registry read failure -> 503; tenant isolation",async()=>{
 const t=activeDurable([],{tenantSwitch:{enabled:true,production_approved:true,test_only:true}});
 assert.deepEqual((await catalog(t,env(A.a))).body.activeFlows,[{flow_key:KEY,revision:1}]);
 const bad=activeDurable(undefined,{failTables:["automation_flow_canary_accounts"]});
 const r=await catalog(bad,env(A.a));assert.equal(r.status,503);assert.equal(r.body.error,"Flow catalog unavailable");
 // Another tenant's registry row grants nothing here.
 const other=activeDurable([reg(T.b,A.a)]);
 assert.equal((await catalog(other,env(A.a))).body.activeFlows[0].runtime.reason,"registry_missing");
});

test("catalogRuntimeNote ignores unsafe or foreign content (fail closed to 'no note')",()=>{
 const mk=(runtime:unknown,key=KEY)=>({activeFlows:[{flow_key:key,revision:1,runtime}]});
 for(const bad of [{status:"not_running",message:"English only"},{status:"not_running",message:"عربي https://x.example"},
  {status:"running",message:RUNTIME_MESSAGES.registry_missing},{status:"not_running"},null,"x",
  {status:"not_running",message:"ع".repeat(201)}])
  assert.equal(catalogRuntimeNote(mk(bad),KEY),null,JSON.stringify(bad));
 assert.equal(catalogRuntimeNote(null,KEY),null);assert.equal(catalogRuntimeNote({activeFlows:"x"} as any,KEY),null);
});
