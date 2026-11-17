/**
 * T4 S1/S2: messageScope "conversation_start".
 *  - conversationStart.ts history read (tenant/conversation scoped, comment
 *    ingress rows excluded, re-drive excludes its own row, fail closed);
 *  - selection (flowInboundSelection.ts) and both engines (durable NEW run,
 *    V2), durable resume paths unaffected;
 *  - publication rules (FLOW_MESSAGE_SCOPE_NOT_IMMEDIATE) and the activation
 *    guard (FLOW_MESSAGE_SCOPE_REQUIRED, default OFF, rollback exempt);
 *  - index.ts wiring (read before persist; failure -> unknown state).
 * Offline: fake clients only.
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {register} from "node:module";
import {readFileSync} from "node:fs";
import {readConversationStart,ConversationStartUnavailableError}
 from "../supabase/functions/milan-api/conversationStart.ts";
import {chooseInboundFlow,selectActiveFlowForInbound,type ActiveFlowCandidate,type EngineClassifier}
 from "../supabase/functions/milan-api/flowInboundSelection.ts";
import {simpleFlowDocumentSupported,prepareSimpleFlowReply}
 from "../supabase/functions/milan-api/flowPrepareMessage.ts";
import {supportedDurableDocument,attemptDurableInstagram}
 from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {makeNode,edgeFor,validateDocument,conversationStartScopeProblem,
 FLOW_MESSAGE_SCOPE_NOT_IMMEDIATE,type FlowDocument} from "../src/flow/model.ts";
import {preparePublishedDocument,messageScopeActivationProblem,FLOW_MESSAGE_SCOPE_REQUIRED,
 MESSAGE_SCOPE_PROBLEM_MESSAGES} from "../src/flow/serverPublicationValidation.ts";

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
const T={a:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",b:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
const A={a:"11111111-1111-4111-8111-111111111111",b:"22222222-2222-4222-8222-222222222222"};
const CONV="44444444-4444-4444-8444-444444444444",CONV2="55555555-5555-4555-8555-555555555555";
const INBOUND="77777777-7777-4777-8777-777777777771";

// ======================================== 1. history read (conversationStart.ts)
type Msg={id:string;tenant_id:string;conversation_id:string;direction:string;kind:string;wa_message_id:string|null};
/** Minimal PostgREST evaluator for the operators the read uses (eq/neq/or is.null|like|not.like). */
function historyDb(rows:Msg[],o:{error?:boolean;data?:unknown;throws?:boolean}={}){
 const calls:Array<unknown[]>=[];
 const like=(v:unknown,p:string)=>typeof v==="string"&&
  new RegExp("^"+p.replace(/[.+?^${}()|[\]\\]/g,"\\$&").replace(/\*/g,".*")+"$").test(v);
 const db={from:(table:string)=>{
  calls.push(["from",table]);
  const preds:Array<(r:any)=>boolean>=[];
  const q:any={
   select:(c:string)=>{calls.push(["select",c]);return q;},
   eq:(k:string,v:unknown)=>{calls.push(["eq",k,v]);preds.push(r=>r[k]===v);return q;},
   neq:(k:string,v:unknown)=>{calls.push(["neq",k,v]);preds.push(r=>r[k]!==v);return q;},
   or:(expr:string)=>{calls.push(["or",expr]);
    const parts=expr.split(",").map(p=>{
     const m=/^(\w+)\.(is\.null|not\.like\.(.+)|like\.(.+))$/.exec(p);
     if(!m)throw Error("unsupported or "+p);
     return (r:any)=>m[2]==="is.null"?r[m[1]]===null:m[3]!==undefined?r[m[1]]!==null&&!like(r[m[1]],m[3]):like(r[m[1]],m[4]);
    });
    preds.push(r=>parts.some(f=>f(r)));return q;},
   limit:async(n:number)=>{calls.push(["limit",n]);
    if(o.throws)throw Error("network");
    if(o.error)return {data:null,error:{code:"XX000",message:"down"}};
    if("data" in o)return {data:o.data,error:null};
    return {data:rows.filter(r=>table==="messages"&&preds.every(p=>p(r))).slice(0,n).map(r=>({id:r.id})),error:null};}
  };
  return q;
 }};
 return {db,calls};
}
const msg=(over:Partial<Msg>):Msg=>({id:"m-"+Math.random(),tenant_id:T.a,conversation_id:CONV,direction:"in",
 kind:"customer",wa_message_id:"mid-x",...over});
const input=(over:Record<string,unknown>={})=>({tenantId:T.a,accountId:A.a,
 conversation:{id:CONV,account_id:A.a},...over}) as any;

test("history: empty conversation is a start; one earlier customer DM is not",async()=>{
 assert.equal(await readConversationStart(historyDb([]).db,input()),true);
 assert.equal(await readConversationStart(historyDb([msg({})]).db,input()),false);
 // legacy NULL wa_message_id rows count as earlier DMs (fail closed)
 assert.equal(await readConversationStart(historyDb([msg({wa_message_id:null})]).db,input()),false);
});
test("history: comment ingress rows (wa_message_id 'comment:*') are excluded",async()=>{
 const rows=[msg({wa_message_id:"comment:1789"}),msg({wa_message_id:"comment:abc"})];
 assert.equal(await readConversationStart(historyDb(rows).db,input()),true);
 assert.equal(await readConversationStart(historyDb([...rows,msg({wa_message_id:"mid-dm"})]).db,input()),false);
});
test("history: business/outbound and non-customer rows never count",async()=>{
 const rows=[msg({direction:"out",kind:"bot"}),msg({direction:"out",kind:"customer"}),msg({kind:"system"})];
 assert.equal(await readConversationStart(historyDb(rows).db,input()),true);
});
test("history: tenant and conversation filters (another tenant / conversation never counts)",async()=>{
 const rows=[msg({tenant_id:T.b}),msg({conversation_id:CONV2})];
 const h=historyDb(rows);
 assert.equal(await readConversationStart(h.db,input()),true);
 assert.deepEqual(h.calls.filter(c=>c[0]==="eq"),[["eq","tenant_id",T.a],["eq","conversation_id",CONV],
  ["eq","direction","in"],["eq","kind","customer"]]);
 assert.deepEqual(h.calls.find(c=>c[0]==="from"),["from","messages"]);
 assert.deepEqual(h.calls.find(c=>c[0]==="limit"),["limit",1]);
});
test("history: a re-drive excludes its own persisted inbound row only",async()=>{
 const own=msg({id:INBOUND});
 assert.equal(await readConversationStart(historyDb([own]).db,input({excludeInboundId:INBOUND})),true);
 assert.equal(await readConversationStart(historyDb([own,msg({})]).db,input({excludeInboundId:INBOUND})),false);
 // live (no exclusion): the row counts
 const h=historyDb([own]);
 assert.equal(await readConversationStart(h.db,input()),false);
 assert.ok(!h.calls.some(c=>c[0]==="neq"),"no neq on a live event");
});
test("history: read error, malformed reply or throw -> ConversationStartUnavailableError (never a start)",async()=>{
 for(const o of [{error:true},{data:null},{data:{}},{data:"x"},{throws:true}])
  await assert.rejects(readConversationStart(historyDb([],o as any).db,input()),ConversationStartUnavailableError,JSON.stringify(o));
 await assert.rejects(readConversationStart({from:()=>{throw Error("x");}},input()),ConversationStartUnavailableError);
 await assert.rejects(readConversationStart(historyDb([]).db,input({conversation:{id:null}})),ConversationStartUnavailableError);
 await assert.rejects(readConversationStart(historyDb([]).db,input({tenantId:""})),ConversationStartUnavailableError);
});
test("history: a conversation bound to another account is never a start (no read)",async()=>{
 const h=historyDb([]);
 assert.equal(await readConversationStart(h.db,input({conversation:{id:CONV,account_id:A.b}})),false);
 assert.equal(h.calls.length,0);
 // NULL / absent account_id (legacy conversations): read as usual
 assert.equal(await readConversationStart(historyDb([]).db,input({conversation:{id:CONV,account_id:null}})),true);
 assert.equal(await readConversationStart(historyDb([]).db,input({conversation:{id:CONV}})),true);
});

// ======================================== 2. selection
const trig=(over:Record<string,unknown>={})=>({kind:"trigger",platform:"instagram",triggerMode:"message",keywords:"",...over});
const v2Doc=(trigger:Record<string,unknown>,text:string)=>({version:3,nodes:[
 {id:"in",data:trigger},{id:"out",data:{kind:"message",text,options:[],contentBlocks:[],image:""}}],
 edges:[{source:"in",sourceHandle:"next",target:"out"}]});
const buttonsDoc=(trigger:Record<string,unknown>)=>({version:3,nodes:[
 {id:"start",data:trigger},
 {id:"choose",data:{kind:"question",inputMode:"buttons",text:"Q",image:"",contentBlocks:[],options:[
  {id:"prices",label:"Prices"},{id:"support",label:"Help"}]}},
 {id:"yes",data:{kind:"message",text:"P",image:"",options:[],contentBlocks:[]}},
 {id:"no",data:{kind:"message",text:"H",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"choose",sourceHandle:"next"},
  {source:"choose",target:"yes",sourceHandle:"prices"},{source:"choose",target:"no",sourceHandle:"support"}]});
const both:EngineClassifier=d=>supportedDurableDocument(d,"instagram")?"durable":
 simpleFlowDocumentSupported(d,"instagram")?"v2":null;
const cand=(flowKey:string,document:unknown,activatedAt:string|null,revision=1):ActiveFlowCandidate=>
 ({flowKey,revision,activatedAt,document});

test("selection: legacy (no scope) and every_message triggers pass for every value of conversationStart",()=>{
 for(const t of [trig(),trig({messageScope:"every_message"})])
  for(const cs of [true,false,null,undefined])
   assert.equal(chooseInboundFlow([cand("f",v2Doc(t,"X"),null)],"hi",both,cs)?.flowKey,"f",JSON.stringify(t)+cs);
 // omitted argument: legacy result unchanged
 assert.equal(chooseInboundFlow([cand("f",v2Doc(trig(),"X"),null)],"hi",both)?.flowKey,"f");
});
test("selection: conversation_start wins only with conversationStart===true, else loses to the next flow / AI",()=>{
 const welcome=cand("welcome",v2Doc(trig({messageScope:"conversation_start"}),"WELCOME"),"2026-01-01T00:00:00Z");
 const general=cand("general",v2Doc(trig(),"GENERAL"),"2026-02-01T00:00:00Z");
 assert.equal(chooseInboundFlow([welcome,general],"hi",both,true)?.flowKey,"welcome");
 for(const cs of [false,null,undefined]){
  assert.equal(chooseInboundFlow([welcome,general],"hi",both,cs)?.flowKey,"general",String(cs));
  assert.equal(chooseInboundFlow([welcome],"hi",both,cs),null,"alone -> AI "+cs);
 }
});
test("selection: an invalid messageScope is never a candidate",()=>{
 for(const bad of ["always","Conversation_Start",null,1])
  for(const cs of [true,false])
   assert.equal(chooseInboundFlow([cand("x",v2Doc(trig({messageScope:bad}),"X"),null)],"hi",both,cs),null);
});
test("selection: keyword precedence is unchanged; a scoped catch-all never beats a matching keyword",()=>{
 const welcome=cand("welcome",v2Doc(trig({messageScope:"conversation_start"}),"W"),"2025-01-01T00:00:00Z");
 const prices=cand("prices",v2Doc(trig({triggerMode:"keyword",keywords:"price"}),"P"),"2026-01-01T00:00:00Z");
 assert.equal(chooseInboundFlow([welcome,prices],"price?",both,true)?.flowKey,"prices");
 assert.equal(chooseInboundFlow([welcome,prices],"hello",both,true)?.flowKey,"welcome");
});

type Act={tenant:string;account:string;platform:string;flow_key:string;revision:number;is_active:boolean;activated_at:string|null};
type Pub={tenant:string;account:string;platform:string;flow_key:string;revision:number;document:unknown};
const act=(flow_key:string,activated_at:string|null,revision=1):Act=>
 ({tenant:T.a,account:A.a,platform:"instagram",flow_key,revision,is_active:true,activated_at});
const pub=(flow_key:string,document:unknown,revision=1):Pub=>
 ({tenant:T.a,account:A.a,platform:"instagram",flow_key,revision,document});
/** Runtime double: activations/publications/runs + durable RPCs (pattern of flow-multi-active-selection). */
function runtimeDb(o:{acts:Act[];pubs:Pub[];runs?:any[]}){
 const calls:Array<{name:string;args:any}>=[];
 const m=(f:Record<string,unknown>,r:any)=>(!("tenant_id" in f)||f.tenant_id===r.tenant)&&
  (!("channel_account_id" in f)||f.channel_account_id===r.account)&&(!("platform" in f)||f.platform===r.platform)&&
  (!("flow_key" in f)||f.flow_key===r.flow_key)&&(!("revision" in f)||Number(f.revision)===r.revision);
 const db:any={from:(table:string)=>{
  const f:Record<string,unknown>={};
  const q:any={select:()=>q,eq:(k:string,v:unknown)=>{f[k]=v;return q;},in:()=>q,gt:()=>q,lte:()=>q,order:()=>q,
   or:()=>q,neq:()=>q,
   insert:()=>{throw Error("unexpected write");},update:()=>{throw Error("unexpected write");},
   maybeSingle:async()=>{
    if(table==="automation_flow_global_switch")return {data:{enabled:true},error:null};
    if(table==="automation_flow_tenant_switches")return {data:{enabled:true,test_only:false,production_approved:true},error:null};
    if(table==="automation_flow_publications"){const h=o.pubs.filter(p=>m(f,p));
     return {data:h.length===1?{document:h[0].document}:null,error:null};}
    return {data:null,error:null};},
   limit:async()=>{
    if(table==="automation_flow_activations")return {data:o.acts.filter(a=>m(f,a)&&(!("is_active" in f)||a.is_active===f.is_active))
     .map(a=>({flow_key:a.flow_key,revision:a.revision,is_active:a.is_active,activated_at:a.activated_at})),error:null};
    if(table==="automation_flow_runs")return {data:(o.runs??[]).filter(r=>r.tenant_id===f.tenant_id&&
     r.conversation_id===f.conversation_id&&(!("run_status" in f)||r.run_status===f.run_status)),error:null};
    return {data:[],error:null};}};
  return q;},
  rpc:async(name:string,args:any)=>{calls.push({name,args});
   if(name==="flow_claim_begin_durable_run")return {data:[{acquired:true,run_id:"88888888-8888-4888-8888-888888888881"}],error:null};
   if(name==="flow_claim_inbound_durable")return {data:[{acquired:true,route:"flow",claim_id:"c",outgoing_message_id:"o"}],error:null};
   if(name==="flow_resume_button_run")return {data:true,error:null};
   if(name==="flow_cancel_run")return {data:true,error:null};
   throw Error("unexpected rpc "+name);}};
 return {db,calls};
}
test("selection DB wrapper forwards conversationStart (tenant/account scoped as before)",async()=>{
 const o={acts:[act("welcome","2026-01-01T00:00:00Z"),act("general","2026-02-01T00:00:00Z")],
  pubs:[pub("welcome",v2Doc(trig({messageScope:"conversation_start"}),"W")),pub("general",v2Doc(trig(),"G"))]};
 const scope={tenantId:T.a,accountId:A.a,platform:"instagram"};
 const pick=async(cs?:boolean|null)=>{const s=await selectActiveFlowForInbound(runtimeDb(o).db,scope,"hi",both,cs);
  return s.status==="selected"?s.flow.flowKey:s.status;};
 assert.equal(await pick(true),"welcome");
 assert.equal(await pick(false),"general");
 assert.equal(await pick(null),"general");
 assert.equal(await pick(),"general");
 // other tenant: nothing
 const s=await selectActiveFlowForInbound(runtimeDb(o).db,{...scope,tenantId:T.b},"hi",both,true);
 assert.equal(s.status,"none");
});

// ======================================== 3. engines
test("V2: conversation_start replies only on a proven start; otherwise null (legacy AI), legacy flows unchanged",async()=>{
 await withEnv({FLOW_RUNTIME_MODE:"message_only"},async()=>{
  const scoped={acts:[act("welcome",null)],pubs:[pub("welcome",v2Doc(trig({messageScope:"conversation_start"}),"WELCOME"))]};
  const legacy={acts:[act("plain",null)],pubs:[pub("plain",v2Doc(trig(),"PLAIN"))]};
  const reply=(o:any,opts:any)=>prepareSimpleFlowReply(runtimeDb(o).db,T.a,A.a,"instagram","hi",opts);
  assert.equal(await reply(scoped,{conversationStart:true}),"WELCOME");
  for(const opts of [{conversationStart:false},{conversationStart:null},{}])
   assert.equal(await reply(scoped,opts),null,JSON.stringify(opts));
  for(const opts of [{conversationStart:true},{conversationStart:false},{conversationStart:null},{}])
   assert.equal(await reply(legacy,opts),"PLAIN",JSON.stringify(opts));
  // with the durable ranking option too
  assert.equal(await reply(scoped,{durableDocument:()=>false,conversationStart:true}),"WELCOME");
  assert.equal(await reply(scoped,{durableDocument:()=>false,conversationStart:false}),null);
 });
});

const WORKERS_READY:Env={FLOW_WORKERS_OPERATOR_RELEASE:"production-canary-approved",
 FLOW_OUTBOX_SEND_ENABLED:"true",FLOW_ATOMIC_CONSUME_READY:"true",FLOW_DURABLE_SCHEDULER_ENABLED:"true",
 FLOW_RICH_BUTTONS_ENABLED:"true",FLOW_INTERNAL_ACTIONS_ENABLED:"true",FIELD_ENCRYPTION_KEY:"test-only-field-key"};
const canary:Env={...WORKERS_READY,FLOW_DURABLE_INGRESS_ENABLED:"true",FLOW_DURABLE_CANARY_ACCOUNT_ID:A.a};
const ev=(over:Record<string,unknown>={})=>({tenantId:T.a,accountId:A.a,conversationId:CONV,
 inboundId:INBOUND,eventId:"mid-1",platform:"instagram",providerEventIdGenuine:true,text:"hello",...over}) as any;

test("durable NEW run: conversation_start starts only with conversationStart===true",async()=>{
 await withEnv(canary,async()=>{
  const o={acts:[act("welcome",null)],pubs:[pub("welcome",buttonsDoc(trig({messageScope:"conversation_start"})))]};
  const yes=runtimeDb(o);
  assert.equal(await attemptDurableInstagram(yes.db,ev({conversationStart:true})),"handled");
  assert.deepEqual(yes.calls.map(c=>c.name),["flow_claim_begin_durable_run"]);
  for(const cs of [false,null,undefined]){
   const no=runtimeDb(o);
   assert.equal(await attemptDurableInstagram(no.db,ev({conversationStart:cs})),"fallback",String(cs));
   assert.deepEqual(no.calls,[],"nothing claimed/started "+cs);
  }
  // legacy durable flow: unchanged for every value
  for(const cs of [true,false,null,undefined]){
   const l=runtimeDb({acts:[act("menu",null)],pubs:[pub("menu",buttonsDoc(trig()))]});
   assert.equal(await attemptDurableInstagram(l.db,ev({conversationStart:cs})),"handled",String(cs));
  }
 });
});
test("durable NEW run: a skipped conversation_start flow lets the next-ranked durable flow start",async()=>{
 await withEnv(canary,async()=>{
  const o={acts:[act("welcome","2026-01-01T00:00:00Z"),act("menu","2026-02-01T00:00:00Z")],
   pubs:[pub("welcome",buttonsDoc(trig({messageScope:"conversation_start"}))),pub("menu",buttonsDoc(trig()))]};
  const f=runtimeDb(o);
  assert.equal(await attemptDurableInstagram(f.db,ev({conversationStart:false})),"handled");
  assert.equal(f.calls[0].args.p_flow,"menu");
  const g=runtimeDb(o);
  assert.equal(await attemptDurableInstagram(g.db,ev({conversationStart:true})),"handled");
  assert.equal(g.calls[0].args.p_flow,"welcome");
 });
});
test("durable resume (button tap on a waiting run) is unaffected by conversationStart",async()=>{
 await withEnv(canary,async()=>{
  for(const cs of [false,null,undefined,true]){
   const run={id:"99999999-9999-4999-8999-999999999991",tenant_id:T.a,channel_account_id:A.a,platform:"instagram",
    conversation_id:CONV,provider_event_id:"mid-old",flow_key:"welcome",publication_revision:1,current_node_id:"choose",
    run_status:"awaiting_input",step_count:1,variables:{},wake_at:null};
   const f=runtimeDb({acts:[act("welcome",null)],pubs:[pub("welcome",buttonsDoc(trig({messageScope:"conversation_start"})))],runs:[run]});
   assert.equal(await attemptDurableInstagram(f.db,ev({selectedChoiceId:"prices",conversationStart:cs})),"handled",String(cs));
   assert.deepEqual(f.calls.map(c=>c.name),["flow_claim_inbound_durable","flow_resume_button_run"],String(cs));
  }
 });
});
test("source: each engine re-checks the scope on the exact selected document and forwards the signal",()=>{
 const durable=readFileSync("supabase/functions/milan-api/flowDurableIngress.ts","utf8");
 assert.match(durable,/v2&&simpleFlowDocumentSupported\(d,event\.platform as "instagram"\|"facebook"\|"whatsapp"\)\?"v2":null,\n\s+event\.conversationStart\);/);
 assert.match(durable,/!messageScopeAllowsFlow\(classifyMessageScope\(documentTriggerData\(doc\)\),event\.conversationStart\)\)\n\s+return "fallback";/);
 const v2=readFileSync("supabase/functions/milan-api/flowPrepareMessage.ts","utf8");
 assert.match(v2,/"durable":null,options\.conversationStart\);/);
 assert.match(v2,/if\(!messageScopeAllowsFlow\(classifyMessageScope\(documentTriggerData\(selection\.flow\.document\)\),\n\s+options\.conversationStart\)\)return null;/);
 // resume paths come before the selection and never read the signal
 const fn=durable.slice(durable.indexOf("export async function attemptDurableInstagram("));
 assert.ok(fn.indexOf("conversationStart")>fn.indexOf("selectActiveFlowForInbound(db,"));
});

// ======================================== 4. index.ts wiring
test("index.ts: history read between the conversation null-check and persist; failure -> unknown state, nothing persisted",()=>{
 const src=readFileSync("supabase/functions/milan-api/index.ts","utf8");
 const fn=src.slice(src.indexOf("async function handleIncomingWebhookMessage("),src.indexOf("المعالج الرئيسي"));
 const nullCheck=fn.indexOf("[${channel}_webhook] conversation is null");
 const read=fn.indexOf("conversationStart = await readConversationStart(sb, {");
 const persist=fn.indexOf("await persistInboundOnce(");
 assert.ok(nullCheck>0&&read>nullCheck&&persist>read,"order: null-check -> read -> persist");
 const block=fn.slice(read,persist);
 assert.match(block,/tenantId: String\(tenantId\), accountId: account\.id, conversation: conv,\n\s+excludeInboundId: redrive \? redrive\.inboundId : null,/);
 assert.match(block,/\} catch \{\n.*\n\s+console\.warn\("\[webhook-routing\] conversation start unknown", \{ code: "conversation_start_unavailable" \}\);\n\s+return await unknownState\(\);\n\s+\}/);
 assert.doesNotMatch(block,/insert\(|persistInboundOnce|keepRetryable/,"no write before/in the failure exit");
 // only channels whose events can reach a flow, and only with a proven account
 assert.match(fn,/if \(typeof account\?\.id === "string" && account\.id\.length > 0 &&\n\s+\(channel === "instagram" \|\| multichannelEnabled\(\) \|\| env\("FLOW_RUNTIME_MODE"\) === "message_only"\)\) \{/);
 assert.match(fn,/const durable=await attemptDurableInstagram\(sb,\{\n\s+conversationStart,\n\s+tenantId,/);
 assert.match(fn,/durableRanked\?\{durableDocument:\(d\)=>supportedDurableDocument\(d,channel\),conversationStart\}:\{conversationStart\}/);
 assert.equal(fn.split("readConversationStart(").length,2,"one read per event");
});

// ======================================== 5. publication rules
type Node=ReturnType<typeof makeNode>;
/** Leaves the trigger without its own messageScope key (legacy). */
const ABSENT=Symbol("absent");
const link=(a:Node,b:Node,h="next")=>edgeFor({source:a.id,sourceHandle:h,target:b.id,targetHandle:"in"} as any);
function scopedDoc(kind:"message"|"delay-node"|"delay-block"|"goto-delay"|"goto-message"|"late-delay",
 scope:unknown="conversation_start",mode:"message"|"keyword"="message"):FlowDocument{
 const t=makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:mode,keywords:mode==="keyword"?"price":""});
 if(scope!==ABSENT)(t.data as any).messageScope=scope;
 const m=makeNode("message",{x:0,y:400},{text:"أهلًا",options:[]});
 if(kind==="message")return {version:3,name:"d",nodes:[t,m],edges:[link(t,m)]};
 if(kind==="delay-node"){const d=makeNode("delay",{x:0,y:200},{delayValue:1});
  return {version:3,name:"d",nodes:[t,d,m],edges:[link(t,d),link(d,m)]};}
 if(kind==="delay-block"){const b=makeNode("message",{x:0,y:200},{text:"x",options:[],
   contentBlocks:[{id:"b1",type:"delay",seconds:3} as any,{id:"b2",type:"text",text:"hi"} as any]});
  return {version:3,name:"d",nodes:[t,b],edges:[link(t,b)]};}
 if(kind==="late-delay"){const d=makeNode("delay",{x:0,y:600},{delayValue:1});const m2=makeNode("message",{x:0,y:800},{text:"بعدين",options:[]});
  return {version:3,name:"d",nodes:[t,m,d,m2],edges:[link(t,m),link(m,d),link(d,m2)]};}
 const target=kind==="goto-delay"?makeNode("delay",{x:0,y:600},{delayValue:1}):m;
 const g=makeNode("goto",{x:0,y:200},{gotoNode:target.id});
 const nodes=kind==="goto-delay"?[t,g,target,m]:[t,g,m];
 return {version:3,name:"d",nodes,edges:kind==="goto-delay"?[link(t,g),link(target,m)]:[link(t,g)]};
}
const raw=(d:unknown)=>JSON.parse(JSON.stringify(d));

test("publication: conversation_start with an immediate first message publishes; delay later is allowed",()=>{
 for(const k of ["message","late-delay","goto-message"] as const){
  assert.equal(conversationStartScopeProblem(scopedDoc(k)),false,k);
  assert.ok(preparePublishedDocument(raw(scopedDoc(k)),"instagram"),k);
  assert.equal(messageScopeActivationProblem(raw(scopedDoc(k)),false),null,k);
  assert.ok(!validateDocument(scopedDoc(k)).some(i=>i.code===FLOW_MESSAGE_SCOPE_NOT_IMMEDIATE),k);
 }
});
test("publication: delay node / delay-first message / goto->delay right after the trigger is rejected",()=>{
 for(const k of ["delay-node","delay-block","goto-delay"] as const){
  assert.equal(conversationStartScopeProblem(scopedDoc(k)),true,k);
  assert.equal(preparePublishedDocument(raw(scopedDoc(k)),"instagram"),null,k);
  assert.equal(messageScopeActivationProblem(raw(scopedDoc(k)),false),"FLOW_MESSAGE_SCOPE_NOT_IMMEDIATE",k);
  const issue=validateDocument(scopedDoc(k)).find(i=>i.code===FLOW_MESSAGE_SCOPE_NOT_IMMEDIATE);
  assert.ok(issue&&issue.severity==="error"&&/بداية المحادثة/.test(issue.message),k);
  // the same graphs with every_message / without a scope: no new rule
  for(const s of ["every_message",ABSENT]){
   assert.equal(conversationStartScopeProblem(scopedDoc(k,s)),false,k+String(s));
   assert.equal(messageScopeActivationProblem(raw(scopedDoc(k,s)),false),null,k+String(s));
  }
 }
});
test("publication: conversation_start on a non-message trigger is rejected (never silently dropped)",()=>{
 const d=scopedDoc("message","conversation_start","keyword");
 assert.equal(conversationStartScopeProblem(d),true);
 assert.equal(preparePublishedDocument(raw(d),"instagram"),null);
 assert.equal(messageScopeActivationProblem(raw(d),false),"FLOW_MESSAGE_SCOPE_NOT_IMMEDIATE");
 assert.ok(validateDocument(d).some(i=>i.code===FLOW_MESSAGE_SCOPE_NOT_IMMEDIATE));
 // every_message on a keyword trigger: dropped by import exactly as before
 assert.ok(preparePublishedDocument(raw(scopedDoc("message","every_message","keyword")),"instagram"));
});
test("publication: hostile / malformed documents",()=>{
 assert.equal(conversationStartScopeProblem(null),false);
 assert.equal(conversationStartScopeProblem({nodes:"x"}),false);
 const loop={nodes:[{id:"t",data:{kind:"trigger",triggerMode:"message",messageScope:"conversation_start"}},
  {id:"g1",data:{kind:"goto",gotoNode:"g2"}},{id:"g2",data:{kind:"goto",gotoNode:"g1"}}],
  edges:[{source:"t",target:"g1"}]};
 assert.equal(conversationStartScopeProblem(loop),false,"goto cycle terminates");
 const hostile={nodes:[{id:"t",get data(){throw Error("x");}}]};
 assert.equal(conversationStartScopeProblem(hostile),true,"throw fails closed");
});
test("activation guard: FLOW_MESSAGE_SCOPE_REQUIRED only when required, only for message triggers without own scope",()=>{
 const legacy=raw(scopedDoc("message",ABSENT));
 assert.equal(messageScopeActivationProblem(legacy,false),null,"flag OFF: legacy unchanged");
 assert.equal(messageScopeActivationProblem(legacy,true),"FLOW_MESSAGE_SCOPE_REQUIRED");
 for(const s of ["every_message","conversation_start"])
  assert.equal(messageScopeActivationProblem(raw(scopedDoc("message",s)),true),null,s);
 const kw=raw(scopedDoc("message",ABSENT,"keyword"));
 assert.equal(messageScopeActivationProblem(kw,true),null,"keyword trigger: no scope needed");
 assert.equal(FLOW_MESSAGE_SCOPE_REQUIRED,"FLOW_MESSAGE_SCOPE_REQUIRED");
 assert.equal(FLOW_MESSAGE_SCOPE_NOT_IMMEDIATE,"FLOW_MESSAGE_SCOPE_NOT_IMMEDIATE");
 for(const m of Object.values(MESSAGE_SCOPE_PROBLEM_MESSAGES))assert.match(m,/[؀-ۿ]/,"Arabic message");
});

// ======================================== 6. flow-publication API
const ORIGIN="https://hsnq2022022-cyber.github.io";
const USER="99999999-9999-4999-8999-99999999999a";
function publicationServer(pubs:Pub[]){
 const log:Array<{rpc:string;args:any}>=[];
 const factory=()=>({
  auth:{getUser:async()=>({data:{user:{id:USER}},error:null})},
  from:(table:string)=>{
   const f:Record<string,unknown>={};
   const rows=()=>{
    if(table==="tenants")return [{id:T.a,user_id:USER,is_active:true}];
    if(table==="channel_accounts")return [{id:A.a,tenant_id:T.a,platform:"instagram",is_active:true,agent_enabled:true,auto_reply:true}]
     .filter(a=>(!("id" in f)||a.id===f.id)&&(!("tenant_id" in f)||a.tenant_id===f.tenant_id));
    if(table==="automation_flow_global_switch")return [{enabled:true}];
    if(table==="automation_flow_tenant_switches")return [{enabled:true,production_approved:true}];
    if(table==="automation_flow_publications")return pubs.filter(p=>p.tenant===f.tenant_id&&p.account===f.channel_account_id&&
     p.flow_key===f.flow_key&&p.revision===Number(f.revision)).map(p=>({document:p.document}));
    return [];
   };
   const q:any={select:()=>q,eq:(k:string,v:unknown)=>{f[k]=v;return q;},order:()=>q,in:()=>q,
    maybeSingle:async()=>{const r=rows();return {data:r.length===1?r[0]:null,error:null};},
    limit:async()=>({data:rows(),error:null})};
   return q;
  },
  rpc:async(name:string,args:any)=>{log.push({rpc:name,args});
   if(name==="flow_publication_rate_allow")return {data:true,error:null};
   if(name==="flow_publish_revision")return {data:7,error:null};
   if(name==="flow_activate_revision")return {data:true,error:null};
   throw Error("unexpected rpc "+name);}
 });
 const call=(body:Record<string,unknown>,env:Env={})=>withEnv({SUPABASE_SERVICE_ROLE_KEY:"dummy",
  SUPABASE_URL:"http://localhost:54321",FLOW_OPERATOR_USER_IDS:USER,...env},async()=>{
  const res=await handleFlowPublication(new Request("https://example.test/functions/v1/flow-publication",{method:"POST",
   headers:{origin:ORIGIN,authorization:"Bearer jwt","content-type":"application/json"},body:JSON.stringify(body)}),
   factory as any);
  return {status:res.status,body:await res.json() as any};
 });
 return {log,call};
}
const legacyDoc=()=>raw(scopedDoc("message",ABSENT));
const activated=(log:Array<{rpc:string}>)=>log.some(l=>l.rpc==="flow_activate_revision");

test("API publish: NOT_IMMEDIATE -> 422 with code; valid scoped document publishes",async()=>{
 const s=publicationServer([]);
 const bad=await s.call({action:"publish",accountId:A.a,flowKey:"welcome",document:raw(scopedDoc("delay-node"))});
 assert.equal(bad.status,422);
 assert.deepEqual(bad.body,{ok:false,error:MESSAGE_SCOPE_PROBLEM_MESSAGES.FLOW_MESSAGE_SCOPE_NOT_IMMEDIATE,code:"FLOW_MESSAGE_SCOPE_NOT_IMMEDIATE"});
 assert.ok(!s.log.some(l=>l.rpc==="flow_publish_revision"));
 const ok=await s.call({action:"publish",accountId:A.a,flowKey:"welcome",document:raw(scopedDoc("message"))});
 assert.equal(ok.status,200);assert.equal(ok.body.revision,7);
});
test("API activate: guard flag OFF (default) -> legacy document activates exactly as before",async()=>{
 for(const env of [{},{FLOW_MESSAGE_SCOPE_REQUIRED:"false"},{FLOW_MESSAGE_SCOPE_REQUIRED:"TRUE"}]){
  const s=publicationServer([pub("welcome",legacyDoc())]);
  const r=await s.call({action:"activate",accountId:A.a,flowKey:"welcome",revision:1},env);
  assert.equal(r.status,200,JSON.stringify(env));assert.ok(activated(s.log));
 }
});
test("API activate: guard flag ON -> unscoped message trigger 422 FLOW_MESSAGE_SCOPE_REQUIRED, scoped activates",async()=>{
 const on={FLOW_MESSAGE_SCOPE_REQUIRED:"true"};
 const s=publicationServer([pub("welcome",legacyDoc())]);
 const r=await s.call({action:"activate",accountId:A.a,flowKey:"welcome",revision:1},on);
 assert.equal(r.status,422);
 assert.deepEqual(r.body,{ok:false,error:MESSAGE_SCOPE_PROBLEM_MESSAGES.FLOW_MESSAGE_SCOPE_REQUIRED,code:"FLOW_MESSAGE_SCOPE_REQUIRED"});
 assert.ok(!activated(s.log));
 for(const sc of ["every_message","conversation_start"]){
  const t=publicationServer([pub("welcome",raw(scopedDoc("message",sc)))]);
  assert.equal((await t.call({action:"activate",accountId:A.a,flowKey:"welcome",revision:1},on)).status,200,sc);
  assert.ok(activated(t.log));
 }
});
test("API rollback: exempt from FLOW_MESSAGE_SCOPE_REQUIRED",async()=>{
 const s=publicationServer([pub("welcome",legacyDoc())]);
 const r=await s.call({action:"rollback",accountId:A.a,flowKey:"welcome",revision:1},{FLOW_MESSAGE_SCOPE_REQUIRED:"true"});
 assert.equal(r.status,200);assert.ok(activated(s.log));
});
test("API activate and rollback: a stored revision violating NOT_IMMEDIATE is never activated",async()=>{
 for(const action of ["activate","rollback"])for(const env of [{},{FLOW_MESSAGE_SCOPE_REQUIRED:"true"}]){
  const s=publicationServer([pub("welcome",raw(scopedDoc("delay-node")))]);
  const r=await s.call({action,accountId:A.a,flowKey:"welcome",revision:1},env);
  assert.equal(r.status,422,action);assert.equal(r.body.code,"FLOW_MESSAGE_SCOPE_NOT_IMMEDIATE");
  assert.ok(!activated(s.log));
 }
});
