/**
 * Flow engine "V3" (durable buttons revision) / "V4" (durable delay revision)
 * selection and the flow-publication readiness contract. Offline: fake
 * clients only, real handleFlowPublication.
 *
 * Reported response (copied safe report of FlowPublicationPanel):
 *   {revision:null,kind:"unsupported",configured:false,missing:["activeRevision","supportedCandidate"]}
 * is produced when NO revision is requested and the flow has NO active
 * revision (e.g. after the owner-authorized deactivation of revision 4): no
 * document is examined at all. The checks stay exactly as before (fail-closed);
 * the additive readiness.candidate diagnostics now say what was (not) examined
 * and why.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {register} from "node:module";
import {readFileSync} from "node:fs";
import {readinessCandidate} from "../supabase/functions/flow-publication/readiness.ts";
import {readinessBlockers,readinessCandidateSummary,readinessTargetKind}
 from "../src/flow/activationAccount.ts";
import {makeNode,edgeFor,type FlowDocument} from "../src/flow/model.ts";

register("data:text/javascript,"+encodeURIComponent(
 "export async function resolve(s,c,n){return s.startsWith('npm:@supabase/supabase-js')?"+
 "n('@supabase/supabase-js',c):n(s,c);}"),import.meta.url);
const {handleFlowPublication}=await import("../supabase/functions/flow-publication/index.ts");

type Env=Record<string,string|undefined>;
async function withEnv<T>(env:Env,fn:()=>Promise<T>|T):Promise<T>{
 const old=(globalThis as any).Deno;
 (globalThis as any).Deno={env:{get:(k:string)=>env[k]}};
 try{return await fn();}finally{(globalThis as any).Deno=old;}
}

// ------------------------------------------------------------ documents
const trig={kind:"trigger",platform:"instagram",triggerMode:"message",keywords:""};
const msg=(id:string,text:string)=>({id,data:{kind:"message",text,image:"",options:[],contentBlocks:[]}});
/** "V3": revision 3, two-choice question (durable buttons). */
const buttonsDoc={version:3,nodes:[{id:"start",data:trig},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"Q",image:"",contentBlocks:[],options:[
  {id:"prices",label:"Prices"},{id:"support",label:"Help"}]}},msg("yes","P"),msg("no","H")],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},
  {source:"choose",target:"yes",sourceHandle:"prices"},{source:"choose",target:"no",sourceHandle:"support"}]};
/** "V4": revision 4, one-minute delay (durable scheduler). */
const delayDoc={version:3,nodes:[{id:"start",data:trig},
 {id:"sleep",data:{kind:"delay",delayValue:1,delayUnit:"minutes"}},msg("after","D")],
 edges:[{source:"start",target:"sleep",sourceHandle:"next"},{source:"sleep",target:"after",sourceHandle:"next"}]};
/** Revision 2: V2 simple engine (editor-shaped, trigger -> text). */
function v2Doc(text:string):FlowDocument{
 const t=makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:"message",keywords:""});
 const m=makeNode("message",{x:0,y:200},{text});
 return {version:3,name:text,nodes:[t,m],edges:[edgeFor({source:t.id,target:m.id,sourceHandle:"next",targetHandle:"in"} as any)]};
}
const malformedDoc={version:3,nodes:"not-an-array",edges:[]};

// ------------------------------------------------------------ server double
const T={a:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",b:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
const A={a:"11111111-1111-4111-8111-111111111111",a2:"33333333-3333-4333-8333-333333333333",
 b:"22222222-2222-4222-8222-222222222222"};
const USER={a:"99999999-9999-4999-8999-99999999999a",b:"99999999-9999-4999-8999-99999999999b"};
const ORIGIN="https://hsnq2022022-cyber.github.io";
const KEY="ig_live_welcome_20261029";
type Row={tenant:string;account:string;platform:string;flow_key:string;revision:number};
type Act=Row&{is_active:boolean;activated_at:string|null};
type Pub=Row&{document:unknown};
const pub=(tenant:string,account:string,flow_key:string,revision:number,document:unknown):Pub=>
 ({tenant,account,platform:"instagram",flow_key,revision,document});
const act=(tenant:string,account:string,flow_key:string,revision:number,is_active:boolean):Act=>
 ({tenant,account,platform:"instagram",flow_key,revision,is_active,activated_at:"2026-11-01T00:00:00Z"});
const ACCOUNTS=[{id:A.a,tenant_id:T.a},{id:A.a2,tenant_id:T.a},{id:A.b,tenant_id:T.b}]
 .map(a=>({...a,platform:"instagram",is_active:true,agent_enabled:true,auto_reply:true}));

function server(initial:{acts?:Act[];pubs?:Pub[]}){
 const acts=initial.acts??[],pubs=initial.pubs??[];
 const log:Array<{table?:string;rpc?:string;filters?:Record<string,unknown>;args?:any}>=[];
 const factory=(token:string)=>({
  auth:{getUser:async()=>({data:{user:{id:token==="jwt-b"?USER.b:USER.a}},error:null})},
  from:(table:string)=>{
   const f:Record<string,unknown>={};
   const rows=()=>{
    if(table==="tenants")return [{id:T.a,user_id:USER.a,is_active:true,credits_remaining:10},
     {id:T.b,user_id:USER.b,is_active:true,credits_remaining:10}]
     .filter(t=>(!("user_id" in f)||t.user_id===f.user_id)&&(!("id" in f)||t.id===f.id));
    if(table==="channel_accounts")return ACCOUNTS.filter(a=>(!("id" in f)||a.id===f.id)&&(!("tenant_id" in f)||a.tenant_id===f.tenant_id));
    if(table==="automation_flow_global_switch")return [{enabled:true}];
    if(table==="automation_flow_tenant_switches")return [{enabled:true,production_approved:true}];
    const m=(r:Row)=>(!("tenant_id" in f)||r.tenant===f.tenant_id)&&(!("channel_account_id" in f)||r.account===f.channel_account_id)&&
     (!("platform" in f)||r.platform===f.platform)&&(!("flow_key" in f)||r.flow_key===f.flow_key)&&(!("revision" in f)||r.revision===Number(f.revision));
    if(table==="automation_flow_activations")return acts.filter(a=>m(a)&&(!("is_active" in f)||a.is_active===f.is_active))
     .map(a=>({flow_key:a.flow_key,revision:a.revision,is_active:a.is_active,activated_at:a.activated_at}));
    if(table==="automation_flow_publications")return pubs.filter(m).sort((x,y)=>y.revision-x.revision)
     .map(p=>({flow_key:p.flow_key,revision:p.revision,document:p.document,created_at:"2026-01-01",platform:p.platform}));
    return [];
   };
   const q:any={select:()=>q,eq:(k:string,v:unknown)=>{f[k]=v;return q;},order:()=>q,in:()=>q,
    maybeSingle:async()=>{log.push({table,filters:{...f}});const r=rows();return {data:r.length===1?r[0]:null,error:null};},
    limit:async()=>{log.push({table,filters:{...f}});return {data:rows(),error:null};}};
   return q;
  },
  rpc:async(name:string,args:any)=>{
   log.push({rpc:name,args});
   if(name==="flow_publication_rate_allow")return {data:true,error:null};
   if(name==="flow_activate_revision"){ // PK (tenant,account,platform,flow_key): ON CONFLICT DO UPDATE
    const k=(a:Row)=>a.tenant===args.p_tenant_id&&a.account===args.p_account_id&&a.platform===args.p_platform&&a.flow_key===args.p_flow_key;
    if(!pubs.some(p=>k(p)&&p.revision===args.p_revision))return {data:false,error:null};
    const row=acts.find(k);
    if(row){row.revision=args.p_revision;row.is_active=true;}
    else acts.push(act(args.p_tenant_id,args.p_account_id,args.p_flow_key,args.p_revision,true));
    return {data:true,error:null};
   }
   if(name==="flow_deactivate_revision"){
    const row=acts.find(a=>a.tenant===args.p_tenant_id&&a.account===args.p_account_id&&a.platform===args.p_platform&&a.flow_key===args.p_flow_key&&a.is_active);
    if(!row)return {data:false,error:null};
    row.is_active=false;return {data:true,error:null};
   }
   throw Error("unexpected rpc "+name);
  }
 });
 const call=async(body:Record<string,unknown>,token="jwt-a",env:Env=PROD_ENV)=>withEnv({SUPABASE_SERVICE_ROLE_KEY:"dummy",
  SUPABASE_URL:"http://localhost:54321",...env},async()=>{
  const res=await handleFlowPublication(new Request("https://example.test/functions/v1/flow-publication",{method:"POST",
   headers:{origin:ORIGIN,authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body)}),
   ((_u:string,_k:string)=>factory(token)) as any);
  return {status:res.status,body:await res.json() as any};
 });
 const mutations=()=>log.filter(l=>l.rpc==="flow_activate_revision"||l.rpc==="flow_deactivate_revision");
 return {acts,pubs,log,call,mutations};
}
/** Every durable operator gate open, canary = tenant A's first account (non-secret dummy values). */
const PROD_ENV:Env={FLOW_DURABLE_INGRESS_ENABLED:"true",FLOW_DURABLE_ACTIVATION_READY:"true",
 FLOW_DURABLE_CANARY_ACCOUNT_ID:A.a,FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved",
 FLOW_DURABLE_SCHEDULER_ENABLED:"true",FLOW_OUTBOX_SEND_ENABLED:"true",FLOW_ATOMIC_CONSUME_READY:"true",
 FLOW_RICH_BUTTONS_ENABLED:"true",FIELD_ENCRYPTION_KEY:"test-only-not-a-secret"};
/** Production state after 2026-11-15: revisions 2/3/4 published, the only activation row (r4) inactive. */
const prodState=()=>server({
 pubs:[pub(T.a,A.a,KEY,2,v2Doc("WELCOME")),pub(T.a,A.a,KEY,3,buttonsDoc),pub(T.a,A.a,KEY,4,delayDoc)],
 acts:[act(T.a,A.a,KEY,4,false)]});
/** Exactly the panel's copied `missing` list (FlowPublicationPanel missingReadinessChecks). */
function panelMissing(r:any):string[]{
 const needs={scheduler:typeof r.needsScheduler==="boolean"?r.needsScheduler:r.candidateKind==="delay",
  buttons:typeof r.needsButtons==="boolean"?r.needsButtons:r.candidateKind==="buttons",
  internalActions:r.needsInternalActions===true,media:r.needsMedia===true};
 return Object.entries(r.checks).filter(([k,v])=>v!==true&&(k!=="scheduler"||needs.scheduler)&&
  (k!=="buttons"||needs.buttons)&&(k!=="internalActions"||needs.internalActions)&&(k!=="media"||needs.media)).map(([k])=>k);
}
const activeOf=(acts:Act[],tenant:string,account:string)=>
 acts.filter(a=>a.tenant===tenant&&a.account===account&&a.is_active).map(a=>a.flow_key+"@"+a.revision);

// ============================================ 1. the exact reported response
test("reported readiness: no revision requested + no active revision -> exact legacy report, now explained",async()=>{
 const s=prodState();
 for(const flowKey of [KEY,"default"]){ // the server flow, and an unpublished local editor key
  const r=await s.call({action:"readiness",accountId:A.a,flowKey});
  assert.equal(r.status,200);
  const rd=r.body.readiness;
  // Unchanged legacy contract: byte-for-byte the reported copied report.
  assert.deepEqual({revision:r.body.candidateRevision,kind:rd.candidateKind,configured:rd.configured,missing:panelMissing(rd)},
   {revision:null,kind:"unsupported",configured:false,missing:["activeRevision","supportedCandidate"]});
  // New: nothing was examined, and why.
  assert.deepEqual(rd.candidate,{flowKey,revision:null,source:"none",found:false,activeRevision:null,engine:null,
   reasons:{activeRevision:"no_active_revision",supportedCandidate:"no_candidate_revision"}});
  // No document read at all (no fallback to the latest or the deactivated revision 4).
  assert.ok(!s.log.some(l=>l.table==="automation_flow_publications"));
  // Activation is never offered on a report that examined nothing.
  assert.deepEqual(readinessBlockers(rd,{currentlyActive:false}),["candidateNotFound"]);
 }
 assert.equal(s.mutations().length,0,"readiness never activates or deactivates");
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[]);
});

test("readiness for the exact revision: V3 = buttons, V4 = delay, r2 = V2; missing r9 is not found (no fallback)",async()=>{
 const s=prodState();
 const want:Record<number,{kind:string;engine:string|null;missing:string[];reason:string|null}>={
  3:{kind:"buttons",engine:"durable",missing:["activeRevision"],reason:null},
  4:{kind:"delay",engine:"durable",missing:["activeRevision"],reason:null},
  2:{kind:"unsupported",engine:"v2",missing:["activeRevision","supportedCandidate"],reason:"not_durable_v2"},
  9:{kind:"unsupported",engine:null,missing:["activeRevision","supportedCandidate"],reason:"revision_not_found"}};
 for(const [rev,w] of Object.entries(want).map(([k,v])=>[Number(k),v] as const)){
  const r=await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:rev});
  assert.equal(r.status,200);assert.equal(r.body.candidateRevision,rev);
  const rd=r.body.readiness;
  assert.equal(rd.candidateKind,w.kind,String(rev));
  assert.deepEqual(panelMissing(rd),w.missing,String(rev));
  assert.equal(rd.candidate.revision,rev);assert.equal(rd.candidate.source,"requested");
  assert.equal(rd.candidate.found,rev!==9);assert.equal(rd.candidate.engine,w.engine);
  assert.equal(rd.candidate.activeRevision,null);
  assert.deepEqual(rd.candidate.reasons,{activeRevision:"no_active_revision",supportedCandidate:w.reason});
  // The publication read targets exactly that revision.
  const reads=s.log.filter(l=>l.table==="automation_flow_publications");
  assert.equal(reads.at(-1)!.filters!.revision,rev);
 }
 const nf=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:9})).body.readiness;
 assert.deepEqual(readinessBlockers(nf,{currentlyActive:false}),["candidateNotFound"]);
 // V2 revision: simple target, no advanced blockers (server still authorizes).
 const v2=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:2})).body.readiness;
 assert.equal(readinessTargetKind(v2),"simple");assert.deepEqual(readinessBlockers(v2,{currentlyActive:false}),[]);
 assert.equal(s.mutations().length,0);
});

// ============================================ 2. V3 / V4 explicit switching
test("V3 then V4: explicit activation of the exact revision; one active revision per flow; never a fallback",async()=>{
 const s=prodState();
 const v3=await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:3});
 assert.equal(v3.status,200);assert.deepEqual(v3.body,{ok:true,active:true,revision:3});
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@3"]);
 // Readiness without a revision now examines the flow's own ACTIVE revision.
 let r=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY})).body;
 assert.equal(r.candidateRevision,3);
 assert.deepEqual(r.readiness.candidate,{flowKey:KEY,revision:3,source:"active",found:true,activeRevision:3,engine:"durable",
  reasons:{activeRevision:null,supportedCandidate:null}});
 assert.equal(r.readiness.configured,true);assert.deepEqual(panelMissing(r.readiness),[]);
 // Checking V4 while V3 is live: examined = 4, active = 3 (explicitly different).
 r=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:4})).body;
 assert.equal(r.readiness.candidate.revision,4);assert.equal(r.readiness.candidate.activeRevision,3);
 assert.equal(r.readiness.candidateKind,"delay");
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@3"],"readiness switched nothing");
 // Explicit switch to V4 (rollback action = same RPC, exact revision).
 const v4=await s.call({action:"rollback",accountId:A.a,flowKey:KEY,revision:4});
 assert.equal(v4.status,200);assert.equal(v4.body.revision,4);
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@4"],"V3 replaced, never both on one flow_key");
 // A missing revision is refused and the live V4 stays (no fallback to latest/other).
 const miss=await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:9});
 assert.equal(miss.status,404);
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@4"]);
 for(const m of s.mutations().filter(l=>l.rpc==="flow_activate_revision"))
  assert.ok([3,4].includes(m.args.p_revision),"only explicitly requested revisions");
 // Deactivate -> the reported state again.
 assert.equal((await s.call({action:"deactivate",accountId:A.a,flowKey:KEY})).status,200);
 r=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY})).body;
 assert.equal(r.readiness.candidate.source,"none");assert.equal(r.candidateRevision,null);
});

test("V3 and V4 can run side by side only as separate flow keys (per account), each with its own revision",async()=>{
 const s=server({pubs:[pub(T.a,A.a,"menu_v3",1,buttonsDoc),pub(T.a,A.a,"later_v4",1,delayDoc)]});
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:"menu_v3",revision:1})).status,200);
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:"later_v4",revision:1})).status,200);
 assert.deepEqual(activeOf(s.acts,T.a,A.a).sort(),["later_v4@1","menu_v3@1"]);
 const a=(await s.call({action:"readiness",accountId:A.a,flowKey:"menu_v3"})).body.readiness;
 const b=(await s.call({action:"readiness",accountId:A.a,flowKey:"later_v4"})).body.readiness;
 assert.equal(a.candidateKind,"buttons");assert.equal(a.candidate.flowKey,"menu_v3");
 assert.equal(b.candidateKind,"delay");assert.equal(b.candidate.flowKey,"later_v4");
});

// ============================================ 3. isolation
test("two tenants / two accounts: readiness and activation never cross scopes",async()=>{
 const s=server({
  pubs:[pub(T.a,A.a,KEY,3,buttonsDoc),pub(T.a,A.a,KEY,4,delayDoc),pub(T.a,A.a2,KEY,1,v2Doc("A2")),pub(T.a,A.a2,KEY,2,delayDoc),
   pub(T.b,A.b,KEY,3,buttonsDoc),pub(T.b,A.b,KEY,4,delayDoc)],
  acts:[act(T.b,A.b,KEY,3,true)]});
 // Tenant B has V3 live: tenant A still reports nothing active and examined nothing.
 const ra=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY})).body.readiness;
 assert.equal(ra.candidate.source,"none");assert.equal(ra.candidate.activeRevision,null);
 // Tenant B sees its own V3 (B's account is not the canary: canary check false there only).
 const rb=(await s.call({action:"readiness",accountId:A.b,flowKey:KEY},"jwt-b")).body.readiness;
 assert.equal(rb.candidate.source,"active");assert.equal(rb.candidate.revision,3);assert.equal(rb.checks.canary,false);
 assert.equal(ra.checks.canary,true);
 // Cross-tenant requests are refused (403) for every action, nothing changes.
 const before=JSON.stringify(s.acts);
 for(const action of ["readiness","activate","rollback","deactivate"]){
  assert.equal((await s.call({action,accountId:A.b,flowKey:KEY,revision:4,tenantId:T.b})).status,403,action);
  assert.equal((await s.call({action,accountId:A.a,flowKey:KEY,revision:4},"jwt-b")).status,403,action);
 }
 assert.equal(JSON.stringify(s.acts),before);
 // A activates V4 on its canary account: B's V3 and A's second account untouched.
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:4})).status,200);
 assert.deepEqual(activeOf(s.acts,T.b,A.b),[KEY+"@3"]);
 assert.deepEqual(activeOf(s.acts,T.a,A.a2),[]);
 // Second account of tenant A: its own flow and engine only (V2 revision 1 there).
 const r2=(await s.call({action:"readiness",accountId:A.a2,flowKey:KEY,revision:1})).body.readiness;
 assert.equal(r2.candidate.engine,"v2");assert.equal(r2.candidate.activeRevision,null);assert.equal(r2.checks.canary,false);
 // Durable V4 on a non-canary account is refused (the durable canary is ONE account); V2 is allowed there.
 assert.equal((await s.call({action:"activate",accountId:A.a2,flowKey:KEY,revision:2})).status,422,"V4 off-canary");
 assert.deepEqual(activeOf(s.acts,T.a,A.a2),[]);
 assert.equal((await s.call({action:"activate",accountId:A.a2,flowKey:KEY,revision:1})).status,200,"V2 allowed");
 assert.deepEqual(activeOf(s.acts,T.a,A.a2),[KEY+"@1"]);
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[KEY+"@4"]);
 for(const l of s.log.filter(l=>l.filters&&"tenant_id" in l.filters&&l.table!=="channel_accounts"&&l.table!=="automation_flow_tenant_switches"))
  assert.ok(l.filters!.tenant_id===T.a||l.filters!.tenant_id===T.b);
});

// ============================================ 4. fail closed
test("malformed or unsupported configurations fail closed",async()=>{
 const s=server({pubs:[pub(T.a,A.a,"bad",1,malformedDoc),pub(T.a,A.a,KEY,4,delayDoc)]});
 for(const revision of ["4",0,-1,1.5,Number.MAX_SAFE_INTEGER+1])
  assert.equal((await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision})).status,400,String(revision));
 const bad=(await s.call({action:"readiness",accountId:A.a,flowKey:"bad",revision:1})).body.readiness;
 assert.equal(bad.candidateKind,"unsupported");assert.equal(bad.configured,false);
 assert.deepEqual(bad.candidate.reasons,{activeRevision:"no_active_revision",supportedCandidate:"not_durable"});
 assert.equal(bad.candidate.found,true);assert.equal(bad.candidate.engine,null);
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:"bad",revision:1})).status,422);
 // V4 without the scheduler flag: readiness says so and activation is refused.
 const noSched={...PROD_ENV,FLOW_DURABLE_SCHEDULER_ENABLED:undefined};
 const r=(await s.call({action:"readiness",accountId:A.a,flowKey:KEY,revision:4},"jwt-a",noSched)).body.readiness;
 assert.equal(r.configured,false);assert.ok(panelMissing(r).includes("scheduler"));
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:KEY,revision:4},"jwt-a",noSched)).status,422);
 assert.deepEqual(activeOf(s.acts,T.a,A.a),[]);
});

// ============================================ 5. pure helpers / UI contract
test("readinessCandidate / readinessCandidateSummary: exact, validated, backward compatible",()=>{
 const base={flowKey:"k",requested:false,revision:null,activeRevision:null,activeCheck:false,found:false,
  durable:false,v2:false,commentDocument:false,candidateKind:"unsupported"};
 assert.equal(readinessCandidate(base).source,"none");
 assert.equal(readinessCandidate({...base,found:true}).found,false,"nothing examined is never 'found'");
 assert.equal(readinessCandidate({...base,revision:5,found:true,commentDocument:true}).reasons.supportedCandidate,"unsupported_comment_flow");
 assert.equal(readinessCandidate({...base,revision:5,found:true,candidateKind:"comment"}).engine,"comment");
 assert.equal(readinessCandidate({...base,revision:5,activeRevision:5,activeCheck:true,found:true,durable:true,candidateKind:"text"}).reasons.activeRevision,null);
 // Older server: no candidate -> previous blockers exactly.
 const old={checks:{activeRevision:false,supportedCandidate:false},candidateKind:"unsupported"};
 assert.equal(readinessCandidateSummary(old),null);
 assert.deepEqual(readinessBlockers(old,{currentlyActive:false}),[]);
 for(const candidate of [null,"x",[],{source:"other",flowKey:"k",found:true},{source:"none",flowKey:"",found:false},
  {source:"active",flowKey:"k"}])
  assert.equal(readinessCandidateSummary({...old,candidate}),null,JSON.stringify(candidate));
 const s=readinessCandidateSummary({...old,candidate:{source:"active",flowKey:"k",found:true,revision:3,activeRevision:3,
  engine:"weird",reasons:{activeRevision:"<script>",supportedCandidate:"not_durable"}}})!;
 assert.equal(s.engine,null);assert.deepEqual(s.reasons,{activeRevision:null,supportedCandidate:"not_durable"});
});

test("panel shows the examined candidate and copies it in the safe report (legacy keys unchanged)",()=>{
 const ui=readFileSync("src/flow/FlowPublicationPanel.tsx","utf8");
 assert.match(ui,/const report=\{revision:checkedRevision,kind:readiness\.candidateKind,configured,missing\};/);
 assert.match(ui,/if\(examined\)Object\.assign\(report,\{flowKey:examined\.flowKey,source:examined\.source,found:examined\.found,\n\s+activeRevision:examined\.activeRevision,engine:examined\.engine,reasons:examined\.reasons\}\);/);
 assert.match(ui,/data-testid="flow-readiness-candidate"/);
 assert.match(ui,/readinessCandidateSummary\(readiness\)\?\.source==="none"&&<p data-testid="flow-readiness-no-candidate"/);
 const flow=readFileSync("src/flow/useFlowActivation.ts","utf8");
 // The activation preflight still targets exactly one revision and checks the echoed one.
 assert.match(flow,/action:"readiness",accountId,flowKey:key,revision:target/);
 assert.match(flow,/checked!==target\?\["candidateRevision"\]:readinessBlockers\(r\.readiness/);
});
