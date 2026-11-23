/**
 * Several flows active at once on one (tenant, account, platform):
 * deterministic DM selection (flowInboundSelection.ts), routing between the
 * durable engine, V2 and the main AI chatbot, the flow-publication catalog /
 * activation API, and tenant/account isolation. Offline: fake clients only.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {register} from "node:module";
import {readFileSync} from "node:fs";
import {chooseInboundFlow,selectActiveFlowForInbound,compareActivationOrder,listActiveActivations,
 type ActiveFlowCandidate,type EngineClassifier} from "../supabase/functions/milan-api/flowInboundSelection.ts";
import {simpleFlowDocumentSupported,prepareSimpleFlowReply}
 from "../supabase/functions/milan-api/flowPrepareMessage.ts";
import {supportedDurableDocument,attemptDurableInstagram,durableIngressConfigured}
 from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {processExclusiveEvent,FlowRoutingUnavailableError}
 from "../supabase/functions/milan-api/exclusiveMessageClaim.ts";
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
const trig=(triggerMode:string,keywords="",platform="instagram")=>
 ({kind:"trigger",platform,triggerMode,keywords});
const v2Doc=(trigger:Record<string,unknown>,text:string)=>({version:3,nodes:[
 {id:"in",data:trigger},{id:"out",data:{kind:"message",text,options:[],contentBlocks:[],image:""}}],
 edges:[{source:"in",sourceHandle:"next",target:"out"}]});
const buttonsDoc=(trigger:Record<string,unknown>,question:string)=>({version:3,nodes:[
 {id:"start",data:trigger},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:question,image:"",contentBlocks:[],options:[
  {id:"prices",label:"Prices"},{id:"support",label:"Help"}]}},
 {id:"yes",data:{kind:"message",text:"P",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"H",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},
  {source:"choose",target:"yes",sourceHandle:"prices"},{source:"choose",target:"no",sourceHandle:"support"}]});
const delayDoc=(trigger:Record<string,unknown>,text:string)=>({version:3,nodes:[{id:"start",data:trigger},
 {id:"sleep",data:{kind:"delay",delayValue:1,delayUnit:"minutes"}},
 {id:"after",data:{kind:"message",text,image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"sleep",sourceHandle:"next"},{source:"sleep",target:"after",sourceHandle:"next"}]});
const commentDoc=(keywords:string)=>v2Doc({...trig("comment",keywords)},"COMMENT-DM");

/** Real engine classifier (both engines available). */
const both:EngineClassifier=d=>supportedDurableDocument(d,"instagram")?"durable":
 simpleFlowDocumentSupported(d,"instagram")?"v2":null;
const cand=(flowKey:string,document:unknown,activatedAt:string|null,revision=1):ActiveFlowCandidate=>
 ({flowKey,revision,activatedAt,document});
const shuffle=<T>(a:T[],seed:number)=>{const b=[...a];let s=seed;
 for(let i=b.length-1;i>0;i--){s=(s*1103515245+12345)%2147483648;const j=s%(i+1);[b[i],b[j]]=[b[j],b[i]];}return b;};
const permutations=<T>(a:T[]):T[][]=>a.length<=1?[a]:a.flatMap((x,i)=>
 permutations([...a.slice(0,i),...a.slice(i+1)]).map(p=>[x,...p]));

// ===================================================== 1. pure selection
test("selection: a matching keyword flow beats a catch-all message flow (any activation order)",()=>{
 const generic=cand("welcome",v2Doc(trig("message"),"WELCOME"),"2026-01-01T00:00:00Z");
 const prices=cand("prices",v2Doc(trig("keyword","price, سعر"),"PRICES"),"2026-06-01T00:00:00Z");
 for(const order of permutations([generic,prices])){
  assert.equal(chooseInboundFlow(order,"what is the PRICE?",both)?.flowKey,"prices");
  assert.equal(chooseInboundFlow(order,"كم سعر الباقة؟",both)?.flowKey,"prices");
  // token-aware contains: a prefixed form or a longer word is not the keyword
  assert.equal(chooseInboundFlow(order,"كم السعر",both)?.flowKey,"welcome");
  assert.equal(chooseInboundFlow(order,"pricey",both)?.flowKey,"welcome");
  // no keyword in the text: the catch-all answers
  assert.equal(chooseInboundFlow(order,"hello",both)?.flowKey,"welcome");
 }
 const w=chooseInboundFlow([generic,prices],"price",both)!;
 assert.equal(w.triggerMode,"keyword");assert.equal(w.matchedKeywordLength,5);assert.equal(w.engine,"v2");
});
test("selection: two keyword matches -> longest matching keyword, then earliest activated_at, then flow_key",()=>{
 const short=cand("a_short",v2Doc(trig("keyword","sub"),"S"),"2026-01-01T00:00:00Z");
 const long=cand("z_long",v2Doc(trig("keyword","subscription"),"L"),"2026-09-01T00:00:00Z");
 for(const order of permutations([short,long]))
  assert.equal(chooseInboundFlow(order,"my subscription please",both)?.flowKey,"z_long");
 // same keyword length: earliest activation
 const early=cand("k_late_key",v2Doc(trig("keyword","abc"),"E"),"2026-01-01T00:00:00Z");
 const late=cand("a_early_key",v2Doc(trig("keyword","xyz"),"L"),"2026-02-01T00:00:00Z");
 for(const order of permutations([early,late]))
  assert.equal(chooseInboundFlow(order,"abc xyz",both)?.flowKey,"k_late_key");
 // same length + same activation: flow_key ascending
 const x=cand("beta",v2Doc(trig("keyword","abc"),"B"),"2026-01-01T00:00:00Z");
 const y=cand("alpha",v2Doc(trig("keyword","xyz"),"A"),"2026-01-01T00:00:00Z");
 for(const order of permutations([x,y]))assert.equal(chooseInboundFlow(order,"abc xyz",both)?.flowKey,"alpha");
});
test("selection: two catch-alls -> earliest activated_at, NULL last, then flow_key",()=>{
 const a=cand("zeta",v2Doc(trig("message"),"Z"),"2026-01-01T00:00:00Z");
 const b=cand("alpha",v2Doc(trig("message"),"A"),"2026-03-01T00:00:00Z");
 const c=cand("aaa",v2Doc(trig("message"),"N"),null);
 for(const order of permutations([a,b,c]))assert.equal(chooseInboundFlow(order,"hi",both)?.flowKey,"zeta");
 const d=cand("beta",v2Doc(trig("message"),"B"),"2026-01-01T00:00:00Z");
 for(const order of permutations([a,d]))assert.equal(chooseInboundFlow(order,"hi",both)?.flowKey,"beta");
 for(const order of permutations([c,cand("bbb",v2Doc(trig("message"),"N2"),"garbage")]))
  assert.equal(chooseInboundFlow(order,"hi",both)?.flowKey,"aaa","unparsable = NULL, then flow_key");
 assert.ok(compareActivationOrder({activatedAt:"2026-01-01T00:00:00Z",flowKey:"b"},{activatedAt:null,flowKey:"a"})<0);
});
test("selection: non-matching keywords and comment-trigger flows are never DM candidates",()=>{
 const kw=cand("kw",v2Doc(trig("keyword","TOD"),"K"),"2026-01-01T00:00:00Z");
 const cm=cand("cm",commentDoc("hello"),"2025-01-01T00:00:00Z");
 assert.equal(chooseInboundFlow([kw,cm],"hello there",both),null);
 assert.equal(chooseInboundFlow([cm],"hello",both),null);
 assert.equal(chooseInboundFlow([],"hello",both),null);
 // unsupported documents / engine not available here
 assert.equal(chooseInboundFlow([cand("x",{version:3,nodes:[],edges:[]},null)],"hi",both),null);
 assert.equal(chooseInboundFlow([cand("d",buttonsDoc(trig("message"),"Q"),null)],"hi",
  d=>simpleFlowDocumentSupported(d,"instagram")?"v2":null),null);
});
test("selection: the exact activated revision's document is used (never another revision)",()=>{
 const w=chooseInboundFlow([cand("f",v2Doc(trig("message"),"R4"),null,4)],"hi",both)!;
 assert.equal(w.revision,4);assert.equal((w.document as any).nodes[1].data.text,"R4");
});
test("selection: deterministic across 200 shuffled input orders (mixed engines and triggers)",()=>{
 const pool=[
  cand("welcome",delayDoc(trig("message"),"W"),"2026-01-01T00:00:00Z",4),
  cand("menu",buttonsDoc(trig("message"),"M"),"2026-01-02T00:00:00Z"),
  cand("prices",v2Doc(trig("keyword","price"),"P"),"2026-03-01T00:00:00Z"),
  cand("pricing_plans",buttonsDoc(trig("keyword","price plan"),"PP"),"2026-05-01T00:00:00Z"),
  cand("comments",commentDoc("price"),"2025-01-01T00:00:00Z"),
  cand("subs",v2Doc(trig("keyword","sub"),"S"),"2025-02-01T00:00:00Z"),
 ];
 const expected={"the price plan?":"pricing_plans","price":"prices","sub please":"subs","subscribe":"welcome","hello":"welcome"};
 for(let seed=1;seed<=200;seed++)for(const [text,key] of Object.entries(expected))
  assert.equal(chooseInboundFlow(shuffle(pool,seed),text,both)?.flowKey,key,text+" seed "+seed);
});

// ================================================== fake database (stateful)
const T={a:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",b:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
const A={a:"11111111-1111-4111-8111-111111111111",b:"22222222-2222-4222-8222-222222222222"};
const CONV="44444444-4444-4444-8444-444444444444";
type Row={tenant:string;account:string;platform:string;flow_key:string;revision:number};
type Act=Row&{is_active:boolean;activated_at:string|null};
type Pub=Row&{document:unknown};
type Run={id:string;tenant_id:string;channel_account_id:string;platform:string;conversation_id:string;
 provider_event_id:string;flow_key:string;publication_revision:number;current_node_id:string;
 run_status:string;step_count:number;variables:Record<string,string>;wake_at:string|null};
function fakeDb(o:{acts:Act[];pubs:Pub[];runs?:Run[];actError?:boolean|"42703";pubError?:string;
 switches?:Record<string,unknown>}){
 const reads:Array<{table:string;filters:Record<string,unknown>;columns:string}>=[];
 const calls:Array<{name:string;args:any}>=[];
 const claims=new Map<string,string>(); // claim key -> route
 const runs:Run[]=o.runs??[];
 const match=(f:Record<string,unknown>,r:Row)=>
  (!("tenant_id" in f)||f.tenant_id===r.tenant)&&(!("channel_account_id" in f)||f.channel_account_id===r.account)&&
  (!("platform" in f)||f.platform===r.platform)&&(!("flow_key" in f)||f.flow_key===r.flow_key)&&
  (!("revision" in f)||Number(f.revision)===r.revision);
 const db:any={from:(table:string)=>{
  const filters:Record<string,unknown>={};let columns="";
  const q:any={select:(c:string)=>{columns=c;return q;},eq:(k:string,v:unknown)=>{filters[k]=v;return q;},
   in:(k:string,v:unknown)=>{filters[k]=v;return q;},gt:()=>q,lte:()=>q,order:()=>q,
   update:()=>{throw Error("unexpected write");},insert:()=>{throw Error("unexpected write");},
   maybeSingle:async()=>{reads.push({table,filters,columns});
    if(table==="automation_flow_global_switch")return {data:{enabled:true},error:null};
    if(table==="automation_flow_tenant_switches")return {data:o.switches??{enabled:true,test_only:false,production_approved:true},error:null};
    if(table==="automation_flow_publications"){
     if(o.pubError&&filters.flow_key===o.pubError)return {data:null,error:{code:"XX000",message:"db down"}};
     const hit=o.pubs.filter(p=>match(filters,p));
     return {data:hit.length===1?{document:hit[0].document}:null,error:null};
    }
    return {data:null,error:null};},
   limit:async()=>{reads.push({table,filters,columns});
    if(table==="automation_flow_activations"){
     if(o.actError===true)return {data:null,error:{code:"XX000",message:"db down"}};
     if(o.actError==="42703"&&columns.includes("activated_at"))return {data:null,error:{code:"42703",message:"column"}};
     return {data:o.acts.filter(a=>match(filters,a)&&(!("is_active" in filters)||a.is_active===filters.is_active))
      .map(a=>({flow_key:a.flow_key,revision:a.revision,is_active:a.is_active,
       ...(columns.includes("activated_at")?{activated_at:a.activated_at}:{})})),error:null};
    }
    if(table==="automation_flow_runs")return {data:runs.filter(r=>r.tenant_id===filters.tenant_id&&
     r.channel_account_id===filters.channel_account_id&&r.conversation_id===filters.conversation_id&&
     r.run_status===filters.run_status),error:null};
    if(table==="automation_message_claims")return {data:claims.has([filters.tenant_id,filters.channel_account_id,
     filters.platform,filters.provider_event_id].join("|"))?[{id:"c"}]:[],error:null};
    return {data:[],error:null};}
  };return q;},
  rpc:async(name:string,args:any)=>{
   calls.push({name,args});
   if(name==="flow_claim_begin_durable_run"){
    const k=[args.p_tenant,args.p_account,args.p_platform,args.p_event].join("|");
    if(claims.has(k))return {data:[{acquired:false,run_id:null}],error:null};
    claims.set(k,"flow");
    // emulates the SQL supersede of this conversation's active runs
    for(const r of runs)if(r.tenant_id===args.p_tenant&&r.conversation_id===args.p_conversation&&
     ["ready","sleeping","awaiting_input"].includes(r.run_status))r.run_status="superseded";
    runs.push({id:"88888888-8888-4888-8888-88888888888"+runs.length,tenant_id:args.p_tenant,
     channel_account_id:args.p_account,platform:args.p_platform,conversation_id:args.p_conversation,
     provider_event_id:args.p_event,flow_key:args.p_flow,publication_revision:args.p_revision,
     current_node_id:args.p_next,run_status:args.p_status,step_count:args.p_next_step,variables:{},wake_at:args.p_wake});
    return {data:[{acquired:true,run_id:runs[runs.length-1].id}],error:null};
   }
   if(name==="flow_claim_inbound"){
    // Production semantics (flow_claim_inbound body): route 'flow' only when the
    // server prepared a reply AND an activation of the account exists.
    const k=[args.p_tenant_id,args.p_account_id,args.p_platform,args.p_provider_event_id].join("|");
    if(claims.has(k))return {data:[{acquired:false,route:claims.get(k),claim_id:"c",outgoing_message_id:"o"}],error:null};
    const route=args.p_engine_ready===true&&o.acts.some(a=>a.tenant===args.p_tenant_id&&
     a.account===args.p_account_id&&a.platform===args.p_platform&&a.is_active)?"flow":"legacy_ai";
    claims.set(k,route);
    return {data:[{acquired:true,route,claim_id:"c-"+claims.size,outgoing_message_id:"o-"+claims.size}],error:null};
   }
   if(name==="flow_cancel_run")return {data:true,error:null};
   if(name==="flow_resume_button_run")return {data:true,error:null};
   throw Error("Unexpected RPC "+name);
  }};
 return {db,reads,calls,claims,runs};
}
const act=(tenant:string,account:string,flow_key:string,revision:number,activated_at:string|null,platform="instagram"):Act=>
 ({tenant,account,platform,flow_key,revision,is_active:true,activated_at});
const pub=(tenant:string,account:string,flow_key:string,revision:number,document:unknown,platform="instagram"):Pub=>
 ({tenant,account,platform,flow_key,revision,document});
const scopedTo=(reads:Array<{table:string;filters:Record<string,unknown>}>,tenant:string,account:string)=>{
 for(const r of reads){
  if(r.table==="automation_flow_global_switch")continue;
  assert.equal(r.filters.tenant_id,tenant,r.table+" without the verified tenant");
  if(["automation_flow_activations","automation_flow_publications","automation_message_claims","automation_flow_runs"].includes(r.table))
   assert.equal(r.filters.channel_account_id,account,r.table+" without the verified account");
 }
};

const ev=(over:Record<string,unknown>={})=>({tenantId:T.a,accountId:A.a,conversationId:CONV,
 inboundId:"77777777-7777-4777-8777-777777777771",eventId:"mid-1",platform:"instagram",
 providerEventIdGenuine:true,text:"hello",...over}) as any;
/**
 * Mirrors milan-api/index.ts handleIncomingWebhookMessage (durable attempt,
 * then processExclusiveEvent with prepareSimpleFlowReply + flow_claim_inbound
 * + legacy AI). tenantId/accountId are those of the verified account row.
 */
async function route(db:any,event:any){
 const sent:string[]=[];let ai=0;
 const durable=await attemptDurableInstagram(db,event);
 if(durable==="handled")return {durable,outcome:null,sent,ai};
 const outcome=await processExclusiveEvent({
  prepareFlow:()=>prepareSimpleFlowReply(db,event.tenantId,event.accountId,event.platform,event.text,
   durableIngressConfigured(event.accountId,event.platform)?
    {durableDocument:(d:unknown)=>supportedDurableDocument(d,event.platform)}:{}),
  claim:async(engineReady)=>{
   const {data,error}=await db.rpc("flow_claim_inbound",{p_tenant_id:event.tenantId,p_account_id:event.accountId,
    p_platform:event.platform,p_provider_event_id:event.eventId,p_conversation_id:event.conversationId,
    p_inbound_message_id:event.inboundId,p_engine_ready:engineReady});
   if(error||!Array.isArray(data)||data.length!==1)throw Error("claim unavailable");
   return data[0];
  },
  legacyAnswer:async()=>{ai++;return "AI-ANSWER";},
  send:async(t)=>{sent.push(t);return {providerMessageId:"pm-"+sent.length};},
  persistSent:async()=>true,debit:async()=>1
 });
 return {durable,outcome,sent,ai};
}
// Worker readiness gates (flowDurableIngress.ts durableWorkerGatesOpen): a NEW
// durable run starts only while the operator gates of the workers that produce
// its reply are open, so the durable start tests run with them open.
const WORKERS_READY:Record<string,string>={FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved",
 FLOW_OUTBOX_SEND_ENABLED:"true",FLOW_ATOMIC_CONSUME_READY:"true",FLOW_DURABLE_SCHEDULER_ENABLED:"true",
 FLOW_RICH_BUTTONS_ENABLED:"true",FLOW_INTERNAL_ACTIONS_ENABLED:"true",FIELD_ENCRYPTION_KEY:"test-only-field-key"};
const canary={...WORKERS_READY,FLOW_DURABLE_INGRESS_ENABLED:"true",FLOW_DURABLE_CANARY_ACCOUNT_ID:A.a};

test("index.ts wiring matches the routed helper: durable first, then V2/AI with the same selection",()=>{
 const src=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const fn=src.slice(src.indexOf("async function handleIncomingWebhookMessage("),src.indexOf("المعالج الرئيسي"));
 const durableAt=fn.indexOf("attemptDurableInstagram(sb,{"),prepareAt=fn.indexOf("prepareFlow: () => prepareSimpleFlowReply(");
 assert.ok(durableAt>0&&prepareAt>durableAt);
 assert.match(fn,/tenantId,accountId:String\(account\.id\),conversationId:String\(conv\.id\)/);
 assert.match(fn,/durableIngressConfigured\(String\(account\.id\),channel\)/);
 assert.match(fn,/const tenantId: string =\n\s+channel === "whatsapp"\n\s+\? account\.tenant_id\n\s+: account\.tenant_id;/);
});

// ===================================================== 2. routing
test("routing: no active flow -> the main AI chatbot answers (claim legacy_ai)",async()=>{
 for(const env of [{},canary])await withEnv(env,async()=>{
  const f=fakeDb({acts:[],pubs:[]});
  const r=await route(f.db,ev());
  assert.equal(r.outcome,"sent_and_billed");assert.deepEqual(r.sent,["AI-ANSWER"]);assert.equal(r.ai,1);
  assert.deepEqual([...f.claims.values()],["legacy_ai"]);
 });
});
test("routing: flows active but none matches -> AI answers; no flow claim, no run, sleeping run untouched",async()=>{
 const sleeping:Run={id:"99999999-9999-4999-8999-999999999991",tenant_id:T.a,channel_account_id:A.a,platform:"instagram",
  conversation_id:CONV,provider_event_id:"mid-old",flow_key:"welcome",publication_revision:4,current_node_id:"sleep",
  run_status:"sleeping",step_count:1,variables:{},wake_at:"2026-11-09T00:00:00Z"};
 for(const env of [{},canary])await withEnv(env,async()=>{
  const f=fakeDb({acts:[act(T.a,A.a,"prices",2,"2026-01-01T00:00:00Z"),act(T.a,A.a,"menu",1,"2026-01-02T00:00:00Z")],
   pubs:[pub(T.a,A.a,"prices",2,v2Doc(trig("keyword","price"),"PRICES")),
    pub(T.a,A.a,"menu",1,buttonsDoc(trig("keyword","menu"),"MENU"))],runs:[{...sleeping}]});
  const r=await route(f.db,ev({text:"good morning"}));
  assert.deepEqual(r.sent,["AI-ANSWER"]);assert.equal(r.ai,1);
  assert.deepEqual([...f.claims.values()],["legacy_ai"],"only the AI claim");
  assert.ok(!f.calls.some(c=>c.name==="flow_claim_begin_durable_run"||c.name==="flow_cancel_run"),
   "no run start, no supersede, no cancel");
  assert.equal(f.runs.length,1);assert.equal(f.runs[0].run_status,"sleeping");
  scopedTo(f.reads,T.a,A.a);
 });
});
test("routing: a V2 keyword flow matches -> exactly one flow reply, no AI reply (generic flow active too)",async()=>{
 await withEnv({},async()=>{
  const f=fakeDb({acts:[act(T.a,A.a,"welcome",3,"2026-01-01T00:00:00Z"),act(T.a,A.a,"prices",5,"2026-06-01T00:00:00Z")],
   pubs:[pub(T.a,A.a,"welcome",3,v2Doc(trig("message"),"WELCOME")),pub(T.a,A.a,"prices",4,v2Doc(trig("keyword","price"),"OLD")),
    pub(T.a,A.a,"prices",5,v2Doc(trig("keyword","price"),"PRICES-R5"))]});
  const r=await route(f.db,ev({text:"price?"}));
  assert.deepEqual(r.sent,["PRICES-R5"]);assert.equal(r.ai,0);
  assert.deepEqual([...f.claims.values()],["flow"]);
  const g=fakeDb({acts:[act(T.a,A.a,"welcome",3,"2026-01-01T00:00:00Z"),act(T.a,A.a,"prices",5,"2026-06-01T00:00:00Z")],
   pubs:[pub(T.a,A.a,"welcome",3,v2Doc(trig("message"),"WELCOME")),pub(T.a,A.a,"prices",5,v2Doc(trig("keyword","price"),"PRICES-R5"))]});
  assert.deepEqual((await route(g.db,ev({text:"hi"}))).sent,["WELCOME"]);
 });
});
test("routing: durable keyword flow beats a V2 catch-all; a V2 keyword flow beats a durable catch-all",async()=>{
 await withEnv(canary,async()=>{
  const acts=[act(T.a,A.a,"welcome",1,"2026-01-01T00:00:00Z"),act(T.a,A.a,"menu",2,"2026-02-01T00:00:00Z")];
  const f=fakeDb({acts,pubs:[pub(T.a,A.a,"welcome",1,v2Doc(trig("message"),"WELCOME")),
   pub(T.a,A.a,"menu",2,buttonsDoc(trig("keyword","menu"),"PICK"))]});
  const r=await route(f.db,ev({text:"show menu"}));
  assert.equal(r.durable,"handled");assert.deepEqual(r.sent,[]);assert.equal(r.ai,0);
  const start=f.calls.filter(c=>c.name==="flow_claim_begin_durable_run");
  assert.equal(start.length,1);assert.equal(start[0].args.p_flow,"menu");assert.equal(start[0].args.p_revision,2);
  // the reverse: durable delay catch-all vs V2 keyword
  const g=fakeDb({acts:[act(T.a,A.a,"ig_live_welcome",4,"2026-01-01T00:00:00Z"),act(T.a,A.a,"prices",1,"2026-05-01T00:00:00Z")],
   pubs:[pub(T.a,A.a,"ig_live_welcome",4,delayDoc(trig("message"),"LATER")),pub(T.a,A.a,"prices",1,v2Doc(trig("keyword","price"),"PRICES"))]});
  const s=await route(g.db,ev({text:"price"}));
  assert.equal(s.durable,"fallback");assert.deepEqual(s.sent,["PRICES"]);assert.equal(s.ai,0);
  assert.ok(!g.calls.some(c=>c.name==="flow_claim_begin_durable_run"));
  // and the catch-all durable still owns other messages (production-like single flow)
  const h=fakeDb({acts:[act(T.a,A.a,"ig_live_welcome",4,"2026-01-01T00:00:00Z"),act(T.a,A.a,"prices",1,"2026-05-01T00:00:00Z")],
   pubs:[pub(T.a,A.a,"ig_live_welcome",4,delayDoc(trig("message"),"LATER")),pub(T.a,A.a,"prices",1,v2Doc(trig("keyword","price"),"PRICES"))]});
  const t=await route(h.db,ev({text:"hello"}));
  assert.equal(t.durable,"handled");assert.equal(t.ai,0);
  assert.equal(h.calls.find(c=>c.name==="flow_claim_begin_durable_run")?.args.p_flow,"ig_live_welcome");
 });
});
test("routing: a durable winner the V2 path cannot run is never replaced by a lower-ranked V2 flow",async()=>{
 // Durable configured for the account, but the event is not durable-eligible
 // (synthetic provider id): V2 sees the same ranking -> null -> AI, as for a lone durable flow.
 await withEnv(canary,async()=>{
  const f=fakeDb({acts:[act(T.a,A.a,"menu",1,"2026-01-01T00:00:00Z"),act(T.a,A.a,"welcome",1,"2026-02-01T00:00:00Z")],
   pubs:[pub(T.a,A.a,"menu",1,buttonsDoc(trig("keyword","menu"),"PICK")),pub(T.a,A.a,"welcome",1,v2Doc(trig("message"),"WELCOME"))]});
  const r=await route(f.db,ev({text:"menu",providerEventIdGenuine:false}));
  assert.deepEqual(r.sent,["AI-ANSWER"]);
 });
});
test("routing: a read error is never 'no match' -> no claim, no AI reply (V2 and durable)",async()=>{
 const acts=[act(T.a,A.a,"prices",1,"2026-01-01T00:00:00Z"),act(T.a,A.a,"welcome",1,"2026-01-02T00:00:00Z")];
 const pubs=[pub(T.a,A.a,"prices",1,v2Doc(trig("keyword","price"),"P")),pub(T.a,A.a,"welcome",1,v2Doc(trig("message"),"W"))];
 for(const env of [{},canary])for(const o of [{actError:true},{pubError:"welcome"},{pubError:"prices"}] as const)
  await withEnv(env,async()=>{
   const f=fakeDb({acts,pubs,...o});
   const r=await route(f.db,ev({text:"hello"}));
   assert.deepEqual(r.sent,[],JSON.stringify(o));assert.equal(r.ai,0);
   assert.equal(f.claims.size,0,"no claim of any route");
   // eligibility unknown: the durable path reports "retry"; V2 "routing_unavailable" (both -> kept retryable)
   if(env===canary)assert.equal(r.durable,"retry");else assert.equal(r.outcome,"routing_unavailable");
  });
 // processExclusiveEvent: only the typed routing error stops the AI; other prepare errors keep the AI route.
 const deps=(prepare:()=>Promise<string|null>)=>{let claimed=0,ai=0;return {claimed:()=>claimed,ai:()=>ai,d:{
  prepareFlow:prepare,claim:async()=>{claimed++;return {acquired:true,route:"legacy_ai" as const,outgoing_message_id:"o"};},
  legacyAnswer:async()=>{ai++;return "AI";},send:async()=>({providerMessageId:"m"}),persistSent:async()=>true,debit:async()=>1}};};
 const x=deps(async()=>{throw new FlowRoutingUnavailableError();});
 assert.equal(await processExclusiveEvent(x.d),"routing_unavailable");assert.equal(x.claimed(),0);assert.equal(x.ai(),0);
 const y=deps(async()=>{throw Error("other");});
 assert.equal(await processExclusiveEvent(y.d),"sent_and_billed");assert.equal(y.ai(),1);
});
test("routing: activated_at column absent (42703) -> re-read without it, flow_key order",async()=>{
 await withEnv({},async()=>{
  const f=fakeDb({actError:"42703",acts:[act(T.a,A.a,"zz",1,null),act(T.a,A.a,"aa",1,null)],
   pubs:[pub(T.a,A.a,"zz",1,v2Doc(trig("message"),"Z")),pub(T.a,A.a,"aa",1,v2Doc(trig("message"),"A"))]});
  assert.deepEqual((await route(f.db,ev())).sent,["A"]);
  const g=fakeDb({actError:true,acts:[],pubs:[]});
  assert.equal(await listActiveActivations(g.db,{tenantId:T.a,accountId:A.a,platform:"instagram"}),null);
 });
});
test("routing: flow error after the flow claim -> no second, competing AI reply",async()=>{
 await withEnv({},async()=>{
  const f=fakeDb({acts:[act(T.a,A.a,"prices",1,null)],pubs:[pub(T.a,A.a,"prices",1,v2Doc(trig("keyword","price"),"P"))]});
  let ai=0;
  const outcome=await processExclusiveEvent({
   prepareFlow:()=>prepareSimpleFlowReply(f.db,T.a,A.a,"instagram","price"),
   claim:async(ready)=>(await f.db.rpc("flow_claim_inbound",{p_tenant_id:T.a,p_account_id:A.a,p_platform:"instagram",
    p_provider_event_id:"mid-9",p_engine_ready:ready})).data[0],
   legacyAnswer:async()=>{ai++;return "AI";},
   send:async()=>{throw Error("provider down");},persistSent:async()=>true,debit:async()=>1});
  assert.equal(outcome,"send_failed");assert.equal(ai,0);
  // the redelivered event sees the committed 'flow' claim: silent, no AI
  const again=await route(f.db,ev({eventId:"mid-9",text:"price"}));
  assert.equal(again.outcome,"duplicate");assert.deepEqual(again.sent,[]);assert.equal(again.ai,0);
 });
 // durable: a committed start is the flow's; nothing else answers
 await withEnv(canary,async()=>{
  const f=fakeDb({acts:[act(T.a,A.a,"menu",1,null)],pubs:[pub(T.a,A.a,"menu",1,buttonsDoc(trig("message"),"Q"))]});
  const r=await route(f.db,ev());
  assert.equal(r.durable,"handled");assert.equal(r.ai,0);assert.deepEqual(r.sent,[]);
 });
});
test("routing: duplicate webhook delivery of the same event -> one run / one reply",async()=>{
 await withEnv({},async()=>{
  const f=fakeDb({acts:[act(T.a,A.a,"prices",1,null),act(T.a,A.a,"welcome",1,null)],
   pubs:[pub(T.a,A.a,"prices",1,v2Doc(trig("keyword","price"),"P")),pub(T.a,A.a,"welcome",1,v2Doc(trig("message"),"W"))]});
  const one=await route(f.db,ev({text:"price"})),two=await route(f.db,ev({text:"price"}));
  assert.deepEqual([...one.sent,...two.sent],["P"]);assert.equal(two.outcome,"duplicate");assert.equal(one.ai+two.ai,0);
 });
 await withEnv(canary,async()=>{
  const f=fakeDb({acts:[act(T.a,A.a,"menu",1,null),act(T.a,A.a,"welcome",1,null)],
   pubs:[pub(T.a,A.a,"menu",1,buttonsDoc(trig("keyword","menu"),"Q")),pub(T.a,A.a,"welcome",1,v2Doc(trig("message"),"W"))]});
  await route(f.db,ev({text:"menu"}));const second=await route(f.db,ev({text:"menu"}));
  assert.equal(f.calls.filter(c=>c.name==="flow_claim_begin_durable_run").length,1);
  assert.equal(f.runs.length,1);assert.equal(second.durable,"handled");assert.equal(second.ai,0);assert.deepEqual(second.sent,[]);
 });
});
test("routing: waiting button run resumes on ITS OWN flow/revision regardless of selection",async()=>{
 await withEnv(canary,async()=>{
  const waiting:Run={id:"99999999-9999-4999-8999-999999999992",tenant_id:T.a,channel_account_id:A.a,platform:"instagram",
   conversation_id:CONV,provider_event_id:"mid-start",flow_key:"menu",publication_revision:2,current_node_id:"choose",
   run_status:"awaiting_input",step_count:1,variables:{},wake_at:null};
  const f=fakeDb({acts:[act(T.a,A.a,"menu",2,"2026-05-01T00:00:00Z"),act(T.a,A.a,"prices",1,"2026-01-01T00:00:00Z")],
   pubs:[pub(T.a,A.a,"menu",2,buttonsDoc(trig("keyword","menu"),"Q")),pub(T.a,A.a,"prices",1,buttonsDoc(trig("keyword","price"),"PQ"))],
   runs:[waiting]});
  (f.db as any).rpc=((orig:any)=>async(n:string,a:any)=>n==="flow_claim_inbound_durable"?
   (f.calls.push({name:n,args:a}),{data:[{acquired:true,route:"flow"}],error:null}):orig(n,a))(f.db.rpc);
  const r=await route(f.db,ev({eventId:"mid-tap",text:"price",selectedChoiceId:"prices"}));
  assert.equal(r.durable,"handled");
  const resume=f.calls.find(c=>c.name==="flow_resume_button_run");
  assert.equal(resume?.args.p_run,waiting.id);
  assert.ok(!f.calls.some(c=>c.name==="flow_claim_begin_durable_run"),"the tap never starts the keyword flow");
 });
});
test("routing: all flows deactivated -> AI answers again",async()=>{
 await withEnv({},async()=>{
  const acts=[act(T.a,A.a,"welcome",1,null),act(T.a,A.a,"prices",1,null)];
  const pubs=[pub(T.a,A.a,"welcome",1,v2Doc(trig("message"),"W")),pub(T.a,A.a,"prices",1,v2Doc(trig("keyword","price"),"P"))];
  assert.deepEqual((await route(fakeDb({acts,pubs}).db,ev())).sent,["W"]);
  const off=acts.map(a=>({...a,is_active:false}));
  const r=await route(fakeDb({acts:off,pubs}).db,ev({eventId:"mid-2"}));
  assert.deepEqual(r.sent,["AI-ANSWER"]);assert.equal(r.ai,1);
 });
});

// ===================================================== 4. isolation (routing)
test("isolation: identical flow names/triggers on two tenants; account A never selects B's flow",async()=>{
 const acts=[act(T.a,A.a,"welcome",1,"2026-02-01T00:00:00Z"),act(T.b,A.b,"welcome",1,"2026-01-01T00:00:00Z"),
  act(T.b,A.b,"prices",1,"2025-01-01T00:00:00Z")];
 const pubs=[pub(T.a,A.a,"welcome",1,v2Doc(trig("message"),"A-WELCOME")),pub(T.b,A.b,"welcome",1,v2Doc(trig("message"),"B-WELCOME")),
  pub(T.b,A.b,"prices",1,v2Doc(trig("keyword","price"),"B-PRICES"))];
 await withEnv({},async()=>{
  const f=fakeDb({acts,pubs});
  // B's keyword sent to A: A's catch-all, never B's flow.
  const r=await route(f.db,ev({text:"price"}));
  assert.deepEqual(r.sent,["A-WELCOME"]);
  scopedTo(f.reads,T.a,A.a);
  assert.ok(!f.reads.some(x=>x.filters.tenant_id===T.b||x.filters.channel_account_id===A.b));
  // Payload-like hints are not inputs: selection takes only the verified scope.
  const sel=await selectActiveFlowForInbound(f.db,{tenantId:T.a,accountId:A.a,platform:"instagram"},
   JSON.stringify({tenantId:T.b,accountId:A.b,text:"price"}),both);
  assert.equal(sel.status,"selected");assert.equal((sel as any).flow.flowKey,"welcome");
  assert.equal(((sel as any).flow.document as any).nodes[1].data.text,"A-WELCOME");
  // Same tenant, other account: nothing of A.
  const g=fakeDb({acts,pubs});
  const s=await selectActiveFlowForInbound(g.db,{tenantId:T.a,accountId:A.b,platform:"instagram"},"price",both);
  assert.equal(s.status,"none");
  // platform scope: an instagram activation never serves facebook
  const h=fakeDb({acts,pubs});
  assert.equal((await selectActiveFlowForInbound(h.db,{tenantId:T.a,accountId:A.a,platform:"facebook"},"hi",both)).status,"none");
 });
});

// ============================================= 3. activation / catalog API
const ORIGIN="https://hsnq2022022-cyber.github.io";
const USER={a:"99999999-9999-4999-8999-99999999999a",b:"99999999-9999-4999-8999-99999999999b"};
const ACCOUNTS=[{id:A.a,tenant_id:T.a,platform:"instagram",is_active:true,agent_enabled:true,auto_reply:true},
 {id:A.b,tenant_id:T.b,platform:"instagram",is_active:true,agent_enabled:true,auto_reply:true}];
/** Stateful server double: the confirmed production RPC semantics (per flow_key). */
function publicationServer(initial:{acts?:Act[];pubs?:Pub[]}={}){
 const acts:Act[]=initial.acts??[];const pubs:Pub[]=initial.pubs??[];
 const log:Array<{table?:string;rpc?:string;filters?:Record<string,unknown>;args?:any}>=[];
 let clock=Date.parse("2026-11-01T00:00:00Z");
 const factory=(token:string)=>({
  auth:{getUser:async()=>({data:{user:{id:token==="jwt-b"?USER.b:USER.a}},error:null})},
  from:(table:string)=>{
   const f:Record<string,unknown>={};
   const rows=()=>{
    if(table==="tenants")return [{id:T.a,user_id:USER.a,is_active:true,credits_remaining:10},{id:T.b,user_id:USER.b,is_active:true,credits_remaining:10}]
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
   if(name==="flow_publish_revision"){
    const rev=Math.max(0,...pubs.filter(p=>p.tenant===args.p_tenant_id&&p.account===args.p_account_id&&p.flow_key===args.p_flow_key).map(p=>p.revision))+1;
    pubs.push(pub(args.p_tenant_id,args.p_account_id,args.p_flow_key,rev,args.p_document,args.p_platform));
    return {data:rev,error:null};
   }
   if(name==="flow_activate_revision"){ // INSERT ... ON CONFLICT (tenant,account,platform,flow_key) DO UPDATE
    const k=(a:Act)=>a.tenant===args.p_tenant_id&&a.account===args.p_account_id&&a.platform===args.p_platform&&a.flow_key===args.p_flow_key;
    if(!pubs.some(p=>k(p as Act)&&p.revision===args.p_revision))return {data:false,error:null};
    const at=new Date(clock+=60000).toISOString();
    const row=acts.find(k);
    if(row){row.revision=args.p_revision;row.is_active=true;row.activated_at=at;}
    else acts.push(act(args.p_tenant_id,args.p_account_id,args.p_flow_key,args.p_revision,at,args.p_platform));
    return {data:true,error:null};
   }
   if(name==="flow_deactivate_revision"){ // is_active=false ONLY for that flow_key
    const row=acts.find(a=>a.tenant===args.p_tenant_id&&a.account===args.p_account_id&&a.platform===args.p_platform&&a.flow_key===args.p_flow_key&&a.is_active);
    if(!row)return {data:false,error:null};
    row.is_active=false;return {data:true,error:null};
   }
   throw Error("unexpected rpc "+name);
  }
 });
 const call=async(body:Record<string,unknown>,token="jwt-a",env:Env={})=>withEnv({SUPABASE_SERVICE_ROLE_KEY:"dummy",
  SUPABASE_URL:"http://localhost:54321",FLOW_OPERATOR_USER_IDS:USER.a+","+USER.b,...env},async()=>{
  const res=await handleFlowPublication(new Request("https://example.test/functions/v1/flow-publication",{method:"POST",
   headers:{origin:ORIGIN,authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body)}),
   ((_u:string,_k:string)=>factory(token)) as any);
  return {status:res.status,body:await res.json() as any};
 });
 return {acts,pubs,log,call};
}
/** Editor-shaped documents (publicationCanActivate validates the full model). */
function modelDoc(mode:"keyword"|"message",keywords:string,text:string):FlowDocument{
 const t=makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:mode,keywords});
 const m=makeNode("message",{x:0,y:200},{text});
 return {version:3,name:text,nodes:[t,m],edges:[edgeFor({source:t.id,target:m.id,sourceHandle:"next",targetHandle:"in"} as any)]};
}
const welcomeDoc=modelDoc("message","","WELCOME"),pricesDoc=modelDoc("keyword","price","PRICES");
const snapshot=(acts:Act[],key:string)=>JSON.stringify(acts.filter(a=>a.flow_key===key));

test("API: activate A then B -> both active, A unchanged; activating while another flow is active is allowed",async()=>{
 const s=publicationServer({pubs:[pub(T.a,A.a,"flow_a",1,welcomeDoc),pub(T.a,A.a,"flow_b",1,pricesDoc)]});
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:"flow_a",revision:1})).status,200);
 const aBefore=snapshot(s.acts,"flow_a");
 const b=await s.call({action:"activate",accountId:A.a,flowKey:"flow_b",revision:1});
 assert.equal(b.status,200);assert.deepEqual(b.body,{ok:true,active:true,revision:1});
 assert.equal(snapshot(s.acts,"flow_a"),aBefore,"A's activation row untouched");
 assert.deepEqual(s.acts.filter(a=>a.is_active).map(a=>a.flow_key).sort(),["flow_a","flow_b"]);
 // every mutation names exactly the requested flow
 for(const r of s.log.filter(l=>l.rpc==="flow_activate_revision"||l.rpc==="flow_deactivate_revision"))
  assert.equal(r.args.p_tenant_id,T.a);
 const cat=await s.call({action:"catalog",accountId:A.a,flowKey:"default"});
 assert.equal(cat.status,200,"no 409 with several active flows");
 assert.deepEqual(cat.body.activeFlows,[{flow_key:"flow_a",revision:1},{flow_key:"flow_b",revision:1}]);
 assert.deepEqual(cat.body.active,{flow_key:"flow_a",revision:1},"legacy single active: earliest activated");
});
test("API: deactivate A -> B still active; publish a new revision of A -> B untouched",async()=>{
 const s=publicationServer({pubs:[pub(T.a,A.a,"flow_a",1,welcomeDoc),pub(T.a,A.a,"flow_b",1,pricesDoc)]});
 await s.call({action:"activate",accountId:A.a,flowKey:"flow_a",revision:1});
 await s.call({action:"activate",accountId:A.a,flowKey:"flow_b",revision:1});
 const bBefore=snapshot(s.acts,"flow_b");
 const p=await s.call({action:"publish",accountId:A.a,flowKey:"flow_a",document:welcomeDoc});
 assert.equal(p.status,200);assert.equal(p.body.revision,2);assert.equal(p.body.activationChanged,false);
 assert.equal(snapshot(s.acts,"flow_b"),bBefore);
 // update A to r2: B still unchanged, A keeps its own revision
 assert.equal((await s.call({action:"activate",accountId:A.a,flowKey:"flow_a",revision:2})).status,200);
 assert.equal(snapshot(s.acts,"flow_b"),bBefore);
 const d=await s.call({action:"deactivate",accountId:A.a,flowKey:"flow_a"});
 assert.equal(d.status,200);
 assert.equal(snapshot(s.acts,"flow_b"),bBefore,"B still active at its own revision");
 const cat=await s.call({action:"catalog",accountId:A.a,flowKey:"default"});
 assert.deepEqual(cat.body.activeFlows,[{flow_key:"flow_b",revision:1}]);
 assert.deepEqual(cat.body.active,{flow_key:"flow_b",revision:1});
 const listA=await s.call({action:"list",accountId:A.a,flowKey:"flow_a"});
 assert.equal(listA.body.activation.is_active,false);
 const listB=await s.call({action:"list",accountId:A.a,flowKey:"flow_b"});
 assert.deepEqual(listB.body.activation,{flow_key:"flow_b",revision:1,is_active:true,activated_at:s.acts.find(a=>a.flow_key==="flow_b")!.activated_at});
 // the catalog legacy `active` order is deterministic: earliest activated_at then flow_key
 const t=publicationServer({acts:[act(T.a,A.a,"zz",1,"2026-01-01T00:00:00Z"),act(T.a,A.a,"aa",1,"2026-01-01T00:00:00Z"),
  act(T.a,A.a,"mm",1,null),act(T.a,A.a,"bb",1,"2025-01-01T00:00:00Z")]});
 const ordered=await t.call({action:"catalog",accountId:A.a,flowKey:"default"});
 assert.deepEqual(ordered.body.activeFlows.map((x:any)=>x.flow_key),["bb","aa","zz","mm"]);
 assert.equal(ordered.body.active.flow_key,"bb");
});
test("API: readiness/approval gates still enforced while another flow is active",async()=>{
 const s=publicationServer({pubs:[pub(T.a,A.a,"flow_a",1,welcomeDoc),pub(T.a,A.a,"adv",1,delayDoc(trig("message"),"X"))]});
 await s.call({action:"activate",accountId:A.a,flowKey:"flow_a",revision:1});
 const adv=await s.call({action:"activate",accountId:A.a,flowKey:"adv",revision:1});
 assert.equal(adv.status,422,"durable graph without the operator gates");
 const missing=await s.call({action:"activate",accountId:A.a,flowKey:"adv",revision:9});
 assert.equal(missing.status,404);
 assert.deepEqual(s.acts.filter(a=>a.is_active).map(a=>a.flow_key),["flow_a"]);
 const r=await s.call({action:"readiness",accountId:A.a,flowKey:"flow_a"});
 assert.equal(r.status,200);assert.equal(r.body.candidateRevision,1);
});
test("isolation (API): account A's session cannot list/activate/deactivate B; payload tenant ids ignored",async()=>{
 const s=publicationServer({acts:[act(T.b,A.b,"welcome",1,"2026-01-01T00:00:00Z")],
  pubs:[pub(T.a,A.a,"welcome",1,welcomeDoc),pub(T.b,A.b,"welcome",1,welcomeDoc)]});
 const before=JSON.stringify(s.acts);
 for(const action of ["list","catalog","activate","deactivate","readiness","rollback"]){
  const r=await s.call({action,accountId:A.b,flowKey:"welcome",revision:1,tenantId:T.b});
  assert.equal(r.status,403,action);
 }
 assert.equal(JSON.stringify(s.acts),before);
 // payload tenantId of B with A's account: scoped to the JWT tenant (A), B never read
 const ok=await s.call({action:"activate",accountId:A.a,flowKey:"welcome",revision:1,tenantId:T.b,tenant_id:T.b});
 assert.equal(ok.status,200);
 assert.ok(s.acts.some(a=>a.tenant===T.a&&a.flow_key==="welcome"&&a.is_active));
 assert.equal(s.acts.find(a=>a.tenant===T.b)!.revision,1);
 for(const l of s.log){
  if(l.filters&&"tenant_id" in l.filters&&l.table!=="channel_accounts")assert.notEqual(l.filters.tenant_id,T.b);
  if(l.args&&"p_tenant_id" in l.args)assert.equal(l.args.p_tenant_id,T.a);
 }
 const cat=await s.call({action:"catalog",accountId:A.a,flowKey:"default"});
 assert.deepEqual(cat.body.activeFlows,[{flow_key:"welcome",revision:1}]);
 // B's own session sees only B
 const catB=await s.call({action:"catalog",accountId:A.b,flowKey:"default"},"jwt-b");
 assert.deepEqual(catB.body.activeFlows,[{flow_key:"welcome",revision:1}]);
 assert.equal((await s.call({action:"catalog",accountId:A.a,flowKey:"default"},"jwt-b")).status,403);
});

test("selection: at equal keyword length an exact trigger beats a contains trigger (any order)",()=>{
 const contains=cand("a_contains",v2Doc(trig("keyword","menu"),"C"),"2025-01-01T00:00:00Z");
 const exact=cand("z_exact",v2Doc({...trig("keyword","menu"),operator:"exact"},"E"),"2026-12-01T00:00:00Z");
 for(const order of permutations([contains,exact])){
  assert.equal(chooseInboundFlow(order,"Menu",both)?.flowKey,"z_exact");
  // the exact flow does not match a longer message: contains wins alone
  assert.equal(chooseInboundFlow(order,"show the menu",both)?.flowKey,"a_contains");
 }
 // a matching exact keyword IS the whole message, so no contains keyword can be longer
 const phrase=cand("m_phrase",v2Doc(trig("keyword","menu please"),"P"),"2024-01-01T00:00:00Z");
 for(const order of permutations([contains,exact,phrase]))
  assert.equal(chooseInboundFlow(order,"menu please",both)?.flowKey,"m_phrase");
 // invalid stored mode never matches
 assert.equal(chooseInboundFlow([cand("bad",v2Doc({...trig("keyword","menu"),operator:"starts_with"},"B"),null)],"menu",both),null);
});

// ====================================== 5. deactivation -> reactivation -> re-selection (exact revision)
// SQL semantics of flow_activate_revision / flow_deactivate_revision on one (tenant, account, platform, flow_key)
// row, for the durable-runtime cases below that drive the state directly (the API cases use the real handler).
let sqlClock=Date.parse("2026-12-01T00:00:00Z");
const sqlActivate=(acts:Act[],key:string,revision:number)=>{
 const at=new Date(sqlClock+=60000).toISOString();
 const row=acts.find(a=>a.tenant===T.a&&a.account===A.a&&a.platform==="instagram"&&a.flow_key===key);
 if(row){row.revision=revision;row.is_active=true;row.activated_at=at;}
 else acts.push(act(T.a,A.a,key,revision,at));
};
const sqlDeactivate=(acts:Act[],key:string)=>{
 const row=acts.find(a=>a.flow_key===key&&a.is_active);if(row)row.is_active=false; // revision is kept
};
const replyDoc=(text:string)=>modelDoc("message","",text);

test("re-selection: deactivate then reactivate selects exactly the reactivated revision (never the latest, never the deactivated one)",async()=>{
 await withEnv({},async()=>{
  const s=publicationServer({pubs:[1,2,3].map(r=>pub(T.a,A.a,"welcome",r,replyDoc("R"+r)))});
  let n=0;
  const inbound=async()=>route(fakeDb({acts:s.acts,pubs:s.pubs}).db,ev({eventId:"mid-reselect-"+(++n)}));
  const call=(action:string,revision?:unknown)=>s.call({action,accountId:A.a,flowKey:"welcome",...(revision===undefined?{}:{revision})});
  assert.equal((await call("activate",2)).status,200);
  assert.deepEqual((await inbound()).sent,["R2"]);
  assert.equal((await call("deactivate")).status,200);
  // The row keeps the old revision reference (2) but is OFF: it is never selected.
  assert.deepEqual(s.acts.map(a=>[a.revision,a.is_active]),[[2,false]]);
  const off=await inbound();
  assert.deepEqual(off.sent,["AI-ANSWER"]);assert.equal(off.ai,1);
  // Selection layer on its own (independent of the SQL claim backstop): the stale reference is not a candidate.
  const scope={tenantId:T.a,accountId:A.a,platform:"instagram"};
  assert.equal((await selectActiveFlowForInbound(fakeDb({acts:s.acts,pubs:s.pubs}).db,scope,"hello",both)).status,"none");
  // Reactivate an OLDER revision: exactly r1 - not the stale r2 reference, not the latest r3.
  assert.equal((await call("activate",1)).status,200);
  const sel=await selectActiveFlowForInbound(fakeDb({acts:s.acts,pubs:s.pubs}).db,scope,"hello",both);
  assert.ok(sel.status==="selected"&&sel.flow.flowKey==="welcome"&&sel.flow.revision===1,"selection names exactly r1");
  assert.deepEqual((await inbound()).sent,["R1"]);
  assert.deepEqual(s.acts.map(a=>[a.revision,a.is_active]),[[1,true]],"one row per flow_key, now at r1");
  // Replace live r1 by the newest r3, deactivate, then reactivate r2 again: always exactly the requested one.
  for(const [rev,expected] of [[3,"R3"],[2,"R2"]] as const){
   assert.equal((await call("activate",rev)).status,200);
   assert.deepEqual((await inbound()).sent,[expected]);
   assert.equal((await call("deactivate")).status,200);
   assert.deepEqual((await inbound()).sent,["AI-ANSWER"]);
  }
  // At every point at most ONE active revision exists for the flow key (single-active-revision).
  assert.equal(s.acts.filter(a=>a.flow_key==="welcome").length,1);
  assert.ok(s.acts.filter(a=>a.flow_key==="welcome"&&a.is_active).length<=1);
 });
});

test("re-selection: stale, missing and mismatched revision references are refused and nothing becomes active",async()=>{
 const s=publicationServer({pubs:[pub(T.a,A.a,"welcome",1,replyDoc("W1")),pub(T.a,A.a,"other",5,replyDoc("O5"))]});
 await s.call({action:"activate",accountId:A.a,flowKey:"welcome",revision:1});
 await s.call({action:"deactivate",accountId:A.a,flowKey:"welcome"});
 const before=JSON.stringify(s.acts);
 const attempt=(revision:unknown)=>s.call({action:"activate",accountId:A.a,flowKey:"welcome",...(revision===undefined?{}:{revision})});
 assert.equal((await attempt(9)).status,404,"missing revision (never falls back to another)");
 assert.equal((await attempt(5)).status,404,"a revision that exists only for ANOTHER flow key is not this flow's revision");
 for(const bad of [undefined,null,0,-1,1.5,"1","latest"])assert.equal((await attempt(bad)).status,400,"invalid selection: "+String(bad));
 assert.equal(JSON.stringify(s.acts),before,"no refused request changed any activation");
 assert.equal(s.log.filter(l=>l.rpc==="flow_activate_revision").length,1,"only the original activation reached the RPC");
 // Even after those refusals the deactivated flow is not live: the inbound goes to the AI.
 await withEnv({},async()=>{
  const r=await route(fakeDb({acts:s.acts,pubs:s.pubs}).db,ev({eventId:"mid-refused"}));
  assert.deepEqual(r.sent,["AI-ANSWER"]);
 });
 // The same flow key on another account/tenant is untouched and cannot be reactivated from here.
 const iso=publicationServer({acts:[act(T.b,A.b,"welcome",1,"2026-01-01T00:00:00Z")],pubs:[pub(T.b,A.b,"welcome",1,replyDoc("B"))]});
 assert.equal((await iso.call({action:"activate",accountId:A.b,flowKey:"welcome",revision:1})).status,403);
 assert.equal(iso.acts[0].is_active,true);
});

test("re-selection: an active row whose revision has no publication is never executed; other flows keep working",async()=>{
 for(const env of [{},canary])await withEnv(env,async()=>{
  const acts=[act(T.a,A.a,"welcome",3,"2026-01-01T00:00:00Z"),act(T.a,A.a,"prices",1,"2026-02-01T00:00:00Z")];
  const pubs=[pub(T.a,A.a,"welcome",2,replyDoc("STALE-R2")),   // r3 is referenced but not published; r2 exists
   pub(T.a,A.a,"prices",1,v2Doc(trig("keyword","price"),"PRICES"))];
  // Selection itself: not a candidate, never substituted by r2 (previous) or any other revision.
  const sel=await selectActiveFlowForInbound(fakeDb({acts,pubs}).db,{tenantId:T.a,accountId:A.a,platform:"instagram"},"hello",both);
  assert.equal(sel.status,"none");
  const f=fakeDb({acts,pubs});
  const r=await route(f.db,ev({text:"hello"}));
  assert.deepEqual(r.sent,["AI-ANSWER"]);
  assert.ok(!f.calls.some(c=>c.name==="flow_claim_begin_durable_run"),"no run started from a dangling reference");
  assert.ok(![...f.claims.values()].includes("flow"));
  // The healthy keyword flow on the same account is unaffected by the dangling one.
  const g=fakeDb({acts,pubs});
  assert.deepEqual((await route(g.db,ev({eventId:"mid-price",text:"price?"}))).sent,["PRICES"]);
 });
});

test("durable runtime parity: V3 (buttons) and V4 (delay) start through the same exact-revision begin after reactivation",async()=>{
 await withEnv(canary,async()=>{
  const KEY="ig_live_welcome_20261029";
  const pubs=[pub(T.a,A.a,KEY,3,buttonsDoc(trig("message"),"Q3")),pub(T.a,A.a,KEY,4,delayDoc(trig("message"),"LATER4")),
   pub(T.a,A.a,KEY,5,delayDoc(trig("message"),"LATER5"))];
  const acts:Act[]=[];let n=0;
  const start=async()=>{const f=fakeDb({acts,pubs});const r=await route(f.db,ev({eventId:"mid-durable-"+(++n)}));
   return {r,begin:f.calls.filter(c=>c.name==="flow_claim_begin_durable_run")};};
  sqlActivate(acts,KEY,3);
  let x=await start();
  assert.equal(x.r.durable,"handled");assert.equal(x.begin.length,1);
  assert.equal(x.begin[0].args.p_flow,KEY);assert.equal(x.begin[0].args.p_revision,3,"V3 buttons: exactly r3");
  sqlDeactivate(acts,KEY);
  x=await start();
  assert.equal(x.begin.length,0,"deactivated: no durable start from the stale r3 reference");
  assert.deepEqual(x.r.sent,["AI-ANSWER"]);
  sqlActivate(acts,KEY,4);
  x=await start();
  assert.equal(x.begin.length,1);assert.equal(x.begin[0].args.p_revision,4,"V4 delay: exactly r4 (not the newer r5, not r3)");
  sqlDeactivate(acts,KEY);sqlActivate(acts,KEY,3);
  x=await start();
  assert.equal(x.begin[0].args.p_revision,3,"back to V3 after deactivation: exactly r3");
  assert.equal(acts.filter(a=>a.flow_key===KEY).length,1);
 });
});

test("durable runtime: a waiting run of revision N cannot resume under a different reactivated revision; the current revision still resumes",async()=>{
 await withEnv(canary,async()=>{
  const waiting=():Run=>({id:"99999999-9999-4999-8999-999999999993",tenant_id:T.a,channel_account_id:A.a,platform:"instagram",
   conversation_id:CONV,provider_event_id:"mid-start",flow_key:"menu",publication_revision:2,current_node_id:"choose",
   run_status:"awaiting_input",step_count:1,variables:{},wake_at:null});
  const pubs=[pub(T.a,A.a,"menu",2,buttonsDoc(trig("keyword","menu"),"Q2")),pub(T.a,A.a,"menu",3,buttonsDoc(trig("keyword","menu"),"Q3"))];
  const tap=async(acts:Act[])=>{
   const f=fakeDb({acts,pubs,runs:[waiting()]});
   (f.db as any).rpc=((orig:any)=>async(nme:string,a:any)=>nme==="flow_claim_inbound_durable"?
    (f.calls.push({name:nme,args:a}),{data:[{acquired:true,route:"flow"}],error:null}):orig(nme,a))(f.db.rpc);
   const r=await route(f.db,ev({eventId:"mid-tap",text:"prices",selectedChoiceId:"prices"}));
   return {f,r};
  };
  // Control: r2 is the live revision -> the run resumes on r2.
  const live=[act(T.a,A.a,"menu",2,"2026-01-01T00:00:00Z")];
  const ok=await tap(live);
  assert.equal(ok.r.durable,"handled");
  assert.equal(ok.f.calls.find(c=>c.name==="flow_resume_button_run")?.args.p_run,waiting().id);
  // Deactivate r2 and reactivate at r3: the stale r2 run must NOT continue under r3 and r3 is not started by the tap.
  const acts=[act(T.a,A.a,"menu",2,"2026-01-01T00:00:00Z")];
  sqlDeactivate(acts,"menu");sqlActivate(acts,"menu",3);
  const stale=await tap(acts);
  assert.ok(!stale.f.calls.some(c=>c.name==="flow_resume_button_run"),"the stale run never resumes");
  assert.ok(!stale.f.calls.some(c=>c.name==="flow_claim_begin_durable_run"),"the tap never starts r3");
  const cancel=stale.f.calls.filter(c=>c.name==="flow_cancel_run");
  assert.equal(cancel.length,1);assert.equal(cancel[0].args.p_reason,"revision_inactive");assert.equal(cancel[0].args.p_run,waiting().id);
  assert.equal(stale.r.durable,"fallback");
 });
});
