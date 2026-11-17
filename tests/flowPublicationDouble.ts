/**
 * Shared offline double for flow-publication handler tests: the real
 * handleFlowPublication with a stateful fake Supabase client (tenants, channel
 * accounts, switches, publications, activations with the production PK
 * (tenant, account, platform, flow_key) and the activate/deactivate RPCs).
 * No network, no secrets (dummy env values only).
 */
import {register} from "node:module";
import {makeNode,edgeFor,type FlowDocument} from "../src/flow/model.ts";

register("data:text/javascript,"+encodeURIComponent(
 "export async function resolve(s,c,n){return s.startsWith('npm:@supabase/supabase-js')?"+
 "n('@supabase/supabase-js',c):n(s,c);}"),import.meta.url);
const {handleFlowPublication}=await import("../supabase/functions/flow-publication/index.ts");

export type Env=Record<string,string|undefined>;
export async function withEnv<T>(env:Env,fn:()=>Promise<T>|T):Promise<T>{
 const old=(globalThis as any).Deno;
 (globalThis as any).Deno={env:{get:(k:string)=>env[k]}};
 try{return await fn();}finally{(globalThis as any).Deno=old;}
}

// ------------------------------------------------------------ documents
export const trig={kind:"trigger",platform:"instagram",triggerMode:"message",keywords:""};
export const msg=(id:string,text:string)=>({id,data:{kind:"message",text,image:"",options:[],contentBlocks:[]}});
/** "V3": revision 3, two-choice question (durable buttons). */
export const buttonsDoc={version:3,nodes:[{id:"start",data:trig},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"Q",image:"",contentBlocks:[],options:[
  {id:"prices",label:"Prices"},{id:"support",label:"Help"}]}},msg("yes","P"),msg("no","H")],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},
  {source:"choose",target:"yes",sourceHandle:"prices"},{source:"choose",target:"no",sourceHandle:"support"}]};
/** "V4": revision 4, one-minute delay (durable scheduler). */
export const delayDoc={version:3,nodes:[{id:"start",data:trig},
 {id:"sleep",data:{kind:"delay",delayValue:1,delayUnit:"minutes"}},msg("after","D")],
 edges:[{source:"start",target:"sleep",sourceHandle:"next"},{source:"sleep",target:"after",sourceHandle:"next"}]};
/** Revision 2: V2 simple engine (editor-shaped, trigger -> text). */
export function v2Doc(text:string):FlowDocument{
 const t=makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:"message",keywords:""});
 const m=makeNode("message",{x:0,y:200},{text});
 return {version:3,name:text,nodes:[t,m],edges:[edgeFor({source:t.id,target:m.id,sourceHandle:"next",targetHandle:"in"} as any)]};
}
export const malformedDoc={version:3,nodes:"not-an-array",edges:[]};

// ------------------------------------------------------------ server double
export const T={a:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",b:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
export const A={a:"11111111-1111-4111-8111-111111111111",a2:"33333333-3333-4333-8333-333333333333",
 b:"22222222-2222-4222-8222-222222222222"};
export const USER={a:"99999999-9999-4999-8999-99999999999a",b:"99999999-9999-4999-8999-99999999999b"};
/** Signed in but owns no tenant (tenant-staff style): token "jwt-staff". "jwt-invalid": auth error. */
export const STAFF_USER="99999999-9999-4999-8999-9999999999cc";
/** Test-only dummy operator allowlist: both tenant owners (USER.a, USER.b). Override per call via env. */
export const OPERATOR_IDS=USER.a+","+USER.b;
export const ORIGIN="https://hsnq2022022-cyber.github.io";
export const KEY="ig_live_welcome_20261029";
export type Row={tenant:string;account:string;platform:string;flow_key:string;revision:number};
export type Act=Row&{is_active:boolean;activated_at:string|null};
export type Pub=Row&{document:unknown};
export const pub=(tenant:string,account:string,flow_key:string,revision:number,document:unknown):Pub=>
 ({tenant,account,platform:"instagram",flow_key,revision,document});
export const act=(tenant:string,account:string,flow_key:string,revision:number,is_active:boolean):Act=>
 ({tenant,account,platform:"instagram",flow_key,revision,is_active,activated_at:"2026-11-01T00:00:00Z"});
export const ACCOUNTS=[{id:A.a,tenant_id:T.a},{id:A.a2,tenant_id:T.a},{id:A.b,tenant_id:T.b}]
 .map(a=>({...a,platform:"instagram",is_active:true,agent_enabled:true,auto_reply:true}));

export function server(initial:{acts?:Act[];pubs?:Pub[];
 /** Tables whose reads return a database error. */
 failTables?:string[];
 /** Switch rows (default: global on, tenant enabled + production_approved). null = no row. */
 globalSwitch?:{enabled:boolean}|null;tenantSwitch?:{enabled:boolean;production_approved:boolean}|null;
 /** Channel account overrides by id (e.g. paused auto reply). */
 accountPatch?:Record<string,Record<string,unknown>>;
 /** flow_publish_revision / flow_activate_revision overrides (default: stateful fakes). */
 publishRpc?:(args:any)=>{data:unknown;error:unknown};
 activateRpc?:(args:any)=>{data:unknown;error:unknown}}){
 const acts=initial.acts??[],pubs=initial.pubs??[];
 const log:Array<{table?:string;rpc?:string;filters?:Record<string,unknown>;args?:any}>=[];
 const factory=(token:string)=>({
  auth:{getUser:async()=>token==="jwt-invalid"?{data:{user:null},error:{message:"invalid"}}:
   ({data:{user:{id:token==="jwt-b"?USER.b:token==="jwt-staff"?STAFF_USER:USER.a}},error:null})},
  from:(table:string)=>{
   const f:Record<string,unknown>={};
   const rows=()=>{
    if(table==="tenants")return [{id:T.a,user_id:USER.a,is_active:true,credits_remaining:10},
     {id:T.b,user_id:USER.b,is_active:true,credits_remaining:10}]
     .filter(t=>(!("user_id" in f)||t.user_id===f.user_id)&&(!("id" in f)||t.id===f.id));
    if(table==="channel_accounts")return ACCOUNTS.map(a=>({...a,...(initial.accountPatch?.[a.id]??{})})).filter(a=>(!("id" in f)||a.id===f.id)&&(!("tenant_id" in f)||a.tenant_id===f.tenant_id));
    if(table==="automation_flow_global_switch")return initial.globalSwitch===null?[]:[initial.globalSwitch??{enabled:true}];
    if(table==="automation_flow_tenant_switches")return initial.tenantSwitch===null?[]:[initial.tenantSwitch??{enabled:true,production_approved:true}];
    const m=(r:Row)=>(!("tenant_id" in f)||r.tenant===f.tenant_id)&&(!("channel_account_id" in f)||r.account===f.channel_account_id)&&
     (!("platform" in f)||r.platform===f.platform)&&(!("flow_key" in f)||r.flow_key===f.flow_key)&&(!("revision" in f)||r.revision===Number(f.revision));
    if(table==="automation_flow_activations")return acts.filter(a=>m(a)&&(!("is_active" in f)||a.is_active===f.is_active))
     .map(a=>({flow_key:a.flow_key,revision:a.revision,is_active:a.is_active,activated_at:a.activated_at}));
    if(table==="automation_flow_publications")return pubs.filter(m).sort((x,y)=>y.revision-x.revision)
     .map(p=>({flow_key:p.flow_key,revision:p.revision,document:p.document,created_at:"2026-01-01",platform:p.platform}));
    return [];
   };
   const q:any={select:()=>q,eq:(k:string,v:unknown)=>{f[k]=v;return q;},order:()=>q,in:()=>q,
    maybeSingle:async()=>{log.push({table,filters:{...f}});
     if(initial.failTables?.includes(table))return {data:null,error:{code:"XX000"}};
     const r=rows();return {data:r.length===1?r[0]:null,error:null};},
    limit:async()=>{log.push({table,filters:{...f}});
     if(initial.failTables?.includes(table))return {data:null,error:{code:"XX000"}};
     return {data:rows(),error:null};}};
   return q;
  },
  rpc:async(name:string,args:any)=>{
   log.push({rpc:name,args});
   if(name==="flow_publication_rate_allow")return {data:true,error:null};
   if(name==="flow_publish_revision"){ // next revision per (tenant,account,platform,flow_key)
    if(initial.publishRpc)return initial.publishRpc(args);
    const rev=Math.max(0,...pubs.filter(p=>p.tenant===args.p_tenant_id&&p.account===args.p_account_id&&
     p.platform===args.p_platform&&p.flow_key===args.p_flow_key).map(p=>p.revision))+1;
    pubs.push({...pub(args.p_tenant_id,args.p_account_id,args.p_flow_key,rev,args.p_document),platform:args.p_platform});
    return {data:rev,error:null};
   }
   if(name==="flow_activate_revision"&&initial.activateRpc)return initial.activateRpc(args);
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
 const call=async(body:Record<string,unknown>,token="jwt-a",env:Env=PROD_ENV,
  headers:Record<string,string>={})=>withEnv({SUPABASE_SERVICE_ROLE_KEY:"dummy",
  SUPABASE_URL:"http://localhost:54321",FLOW_OPERATOR_USER_IDS:OPERATOR_IDS,...env},async()=>{
  const res=await handleFlowPublication(new Request("https://example.test/functions/v1/flow-publication",{method:"POST",
   headers:{origin:ORIGIN,authorization:"Bearer "+token,"content-type":"application/json",...headers},body:JSON.stringify(body)}),
   ((_u:string,_k:string)=>factory(token)) as any);
  return {status:res.status,body:await res.json() as any,headers:res.headers};
 });
 const mutations=()=>log.filter(l=>l.rpc==="flow_activate_revision"||l.rpc==="flow_deactivate_revision");
 return {acts,pubs,log,call,mutations};
}
/** Every durable operator gate open, canary = tenant A's first account (non-secret dummy values). */
export const PROD_ENV:Env={FLOW_DURABLE_INGRESS_ENABLED:"true",FLOW_DURABLE_ACTIVATION_READY:"true",
 FLOW_DURABLE_CANARY_ACCOUNT_ID:A.a,FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved",
 FLOW_DURABLE_SCHEDULER_ENABLED:"true",FLOW_OUTBOX_SEND_ENABLED:"true",FLOW_ATOMIC_CONSUME_READY:"true",
 FLOW_RICH_BUTTONS_ENABLED:"true",FIELD_ENCRYPTION_KEY:"test-only-not-a-secret"};
/** Production state after 2026-11-15: revisions 2/3/4 published, the only activation row (r4) inactive. */
export const prodState=()=>server({
 pubs:[pub(T.a,A.a,KEY,2,v2Doc("WELCOME")),pub(T.a,A.a,KEY,3,buttonsDoc),pub(T.a,A.a,KEY,4,delayDoc)],
 acts:[act(T.a,A.a,KEY,4,false)]});
/** Exactly the panel's copied `missing` list (FlowPublicationPanel missingReadinessChecks). */
export function panelMissing(r:any):string[]{
 const needs={scheduler:typeof r.needsScheduler==="boolean"?r.needsScheduler:r.candidateKind==="delay",
  buttons:typeof r.needsButtons==="boolean"?r.needsButtons:r.candidateKind==="buttons",
  internalActions:r.needsInternalActions===true,media:r.needsMedia===true};
 return Object.entries(r.checks).filter(([k,v])=>v!==true&&(k!=="scheduler"||needs.scheduler)&&
  (k!=="buttons"||needs.buttons)&&(k!=="internalActions"||needs.internalActions)&&(k!=="media"||needs.media)).map(([k])=>k);
}
export const activeOf=(acts:Act[],tenant:string,account:string)=>
 acts.filter(a=>a.tenant===tenant&&a.account===account&&a.is_active).map(a=>a.flow_key+"@"+a.revision);

