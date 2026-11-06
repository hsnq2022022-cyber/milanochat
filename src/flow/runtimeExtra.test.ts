import {test} from "node:test";
import assert from "node:assert/strict";
import {makeNode,edgeFor} from "./model.ts";
import type {FlowDocument,FlowNode} from "./model.ts";
import {createRuntimeState,planRuntimeTransition} from "./runtimePlan.ts";
import {authorizeFlowAI,planFlowMetric} from "./aiMetricsGate.ts";
import {planUntilWait} from "./runtimeChain.ts";

const context={eventKey:"signed-event",nowMs:1793200000000,seed:7};
const connect=(source:FlowNode,target:FlowNode,port="next")=>
 edgeFor({source:source.id,sourceHandle:port,target:target.id,targetHandle:"in"});
const graph=(nodes:FlowNode[],edges:ReturnType<typeof connect>[]):FlowDocument=>({
 version:3,name:"Stage 4",nodes,edges
});
const trigger=()=>makeNode("trigger",{x:0,y:0},{triggerMode:"message"});
test("interactive message buttons persist awaiting input and select exactly one path",()=>{
 const t=trigger(),btn=makeNode("message",{x:0,y:50},{
  text:"اختار",options:[{id:"yes",label:"نعم"},{id:"no",label:"لا"}]});
 const yes=makeNode("message",{x:0,y:100},{text:"تم",options:[]});
 const no=makeNode("message",{x:0,y:100},{text:"رفض",options:[]});
 const doc=graph([t,btn,yes,no],[connect(t,btn),connect(btn,yes,"yes"),connect(btn,no,"no")]);
 const first=planRuntimeTransition(doc,createRuntimeState(doc,"flow",1),context);
 assert.equal(first.state.status,"awaiting_input");
 assert.deepEqual(first.effects.map(x=>x.kind),["question"]);
 const response=planRuntimeTransition(doc,first.state,{...context,eventKey:"answer2",answer:"نعم"});
 assert.equal(response.state.status,"completed");
 assert.deepEqual(response.effects.map(x=>x.kind),["message"]);
 assert.equal((response.effects[0] as {text:string}).text,"تم");
 const replay=planRuntimeTransition(doc,first.state,{...context,eventKey:"answer2",answer:"نعم"});
 assert.deepEqual(response.effects,replay.effects);
});
test("tag and untag actions emit bounded, separate idempotent effects",()=>{
 const t=trigger(),tag=makeNode("action",{x:0,y:40},{actionType:"tag",actionValue:"عميل جديد"});
 const untag=makeNode("action",{x:0,y:80},{actionType:"untag",actionValue:"عميل جديد"});
 const doc=graph([t,tag,untag],[connect(t,tag),connect(tag,untag)]);
 const first=planRuntimeTransition(doc,createRuntimeState(doc,"tag",1),context);
 assert.equal(first.effects[0].kind,"tag");
 const next=planRuntimeTransition(doc,first.state,{...context,eventKey:"next"});
 assert.equal(next.effects[0].kind,"untag");
 assert.notEqual(first.effects[0].idempotencyKey,next.effects[0].idempotencyKey);
});
test("invalid tag action cannot create external effect",()=>{
 const t=trigger(),action=makeNode("action",{x:0,y:50},{actionType:"tag",actionValue:"<script>"});
 const d=graph([t,action],[connect(t,action)]);
 const output=planRuntimeTransition(d,createRuntimeState(d,"flow",1),context);
 assert.equal(output.state.status,"blocked");assert.deepEqual(output.effects,[]);
});
test("notify generates staff-only effect and handoff stops all automated paths",()=>{
 const t=trigger(),notify=makeNode("action",{x:0,y:20},{actionType:"notify",actionValue:"راجع الطلب"});
 const handoff=makeNode("action",{x:0,y:50},{actionType:"handoff"});
 const d=graph([t,notify,handoff],[connect(t,notify),connect(notify,handoff)]);
 const a=planRuntimeTransition(d,createRuntimeState(d,"handoff",1),context);
 assert.equal(a.effects[0].kind,"staff_notification");
 const b=planRuntimeTransition(d,a.state,{...context,eventKey:"second"});
 assert.equal(b.effects[0].kind,"handoff");
 assert.equal(b.state.status,"handoff");
 assert.deepEqual(planRuntimeTransition(d,b.state,{...context,eventKey:"again"}).effects,[]);
});
test("AI node plans trusted knowledge placeholder but never invents an answer",()=>{
 const t=trigger(),ai=makeNode("action",{x:0,y:40},{actionType:"ai"});
 const d=graph([t,ai],[connect(t,ai)]);
 const output=planRuntimeTransition(d,createRuntimeState(d,"ai",1),context);
 assert.deepEqual(output.effects.map(x=>x.kind),["message"]);
 assert.equal((output.effects[0] as {source?:string}).source,"knowledge_ai");
 assert.equal((output.effects[0] as {text:string}).text,"");
 assert.deepEqual(authorizeFlowAI({
  verifiedTenantId:"a",publishedFlowTenantId:"a",knowledgeTenantId:"b",
  conversationTenantId:"a",sourceCount:1,retrievedEvidenceCount:1,
  knowledgeRetrievalSucceeded:true,creditBalance:5,agentEnabled:true,humanTakeover:false
 }),{allowed:false,reason:"wrong_tenant"});
 assert.equal(planFlowMetric({tenantId:"a",runId:"r",kind:"delivered",
  occurredAt:"2026-10-28T00:00:00Z"}),null);
});

test("outbox quick reply stores stable option IDs for authenticated customer choice",()=>{
 const start=trigger(),q=makeNode("question",{x:0,y:40},{
  inputMode:"buttons",text:"شنو تحتاج؟",options:[
   {id:"prices",label:"الأسعار"},{id:"agent",label:"موظف"}]});
 const finish=makeNode("end",{x:0,y:80});
 const d=graph([start,q,finish],[connect(start,q),connect(q,finish,"prices"),connect(q,finish,"agent")]);
 const plan=planRuntimeTransition(d,createRuntimeState(d,"choice",1),context);
 assert.equal(plan.state.status,"awaiting_input");
 assert.deepEqual((plan.effects[0] as {choiceIds:string[]}).choiceIds,["prices","agent"]);
 assert.deepEqual((plan.effects[0] as {choices:string[]}).choices,["الأسعار","موظف"]);
 const selected=planRuntimeTransition(d,plan.state,{...context,eventKey:"tap",
  answer:"prices"});
 assert.notEqual(selected.state.status,"blocked");
});
test("Messenger HTTPS website buttons are a declared outbound effect, not a fake quick reply",()=>{
 const start=trigger(),card=makeNode("message",{x:0,y:40},{
  text:"زوروا موقعنا",platform:"messenger",
  options:[{id:"go",label:"موقعنا",buttonType:"button",
   action:"website",url:"https://example.org/shop"}]});
 const d=graph([start,card],[connect(start,card)]);
 const output=planRuntimeTransition(d,createRuntimeState(d,"web",1),context);
 assert.equal(output.state.status,"completed");
 assert.equal(output.effects[0].kind,"message");
 assert.deepEqual((output.effects[0] as {websiteButtons:unknown}).websiteButtons,
  [{label:"موقعنا",url:"https://example.org/shop"}]);
 card.data.options[0].url="http://example.org";
 const reject=planRuntimeTransition(d,createRuntimeState(d,"web",1),context);
 assert.equal(reject.state.status,"blocked");
 assert.deepEqual(reject.effects,[]);
});
test("Instagram website buttons: message effect carries label/url in order, then continues",()=>{
 const web=(n:number,text="تفضل بزيارة متجرنا",label=(i:number)=>"زر "+i)=>{
  const start=trigger(),card=makeNode("message",{x:0,y:40},{text,platform:"instagram",
   options:Array.from({length:n},(_,i)=>({id:"w"+i,label:label(i),buttonType:"button" as const,
    action:"website" as const,url:"https://example.org/p"+i}))});
  const after=makeNode("message",{x:0,y:80},{text:"شكرًا",options:[]});
  const d=graph([start,card,after],[connect(start,card),connect(card,after)]);
  return planUntilWait(d,createRuntimeState(d,"ig-web",1),context);
 };
 const ok=web(3);
 assert.equal(ok.error,undefined);
 assert.deepEqual(ok.effects.map(e=>e.kind),["message","message"]);
 assert.deepEqual((ok.effects[0] as {websiteButtons:unknown}).websiteButtons,
  [0,1,2].map(i=>({label:"زر "+i,url:"https://example.org/p"+i})));
 assert.equal((ok.effects[0] as {text:string}).text,"تفضل بزيارة متجرنا");
 assert.ok(!("websiteButtons" in ok.effects[1]));
 assert.equal(web(4).effects.length,0);
 assert.equal(web(4).state.status,"blocked");
 assert.equal(web(1,"ن".repeat(640)).effects.length,2);
 assert.equal(web(1,"ن".repeat(641)).effects.length,0);
 assert.equal(web(1,"x",()=>"😀".repeat(20)).effects.length,2);
 assert.equal(web(1,"x",()=>"a".repeat(21)).effects.length,0);
 // Website + step buttons together are not representable: refused, never dropped.
 const start=trigger(),mixed=makeNode("message",{x:0,y:40},{text:"x",platform:"instagram",
  options:[{id:"w",label:"site",buttonType:"button",action:"website",url:"https://example.org"},{id:"s",label:"step"}]});
 const md=graph([start,mixed],[connect(start,mixed)]);
 assert.equal(planRuntimeTransition(md,createRuntimeState(md,"mix",1),context).state.status,"blocked");
});
test("too many rich choices fail closed before producing Outbox effects",()=>{
 const start=trigger(),q=makeNode("question",{x:0,y:40},{
  inputMode:"buttons",options:Array.from({length:14},(_,i)=>({
   id:"id"+i,label:"option"+i
  }))});
 const doc=graph([start,q],[connect(start,q)]);
 const result=planRuntimeTransition(doc,createRuntimeState(doc,"limit",1),context);
 assert.equal(result.state.status,"blocked");
 assert.deepEqual(result.effects,[]);
});
test("WhatsApp website button: exactly ONE cta_url effect (label <= 20 code points, body <= 1024), then continues",()=>{
 const web=(n:number,text="زوروا متجرنا",label=(i:number)=>"زر "+i,url=(i:number)=>"https://example.org/p"+i)=>{
  const start=trigger(),card=makeNode("message",{x:0,y:40},{text,platform:"whatsapp",
   options:Array.from({length:n},(_,i)=>({id:"w"+i,label:label(i),buttonType:"button" as const,
    action:"website" as const,url:url(i)}))});
  const after=makeNode("message",{x:0,y:80},{text:"شكرًا",options:[],platform:"whatsapp"});
  const d=graph([start,card,after],[connect(start,card),connect(card,after)]);
  return planUntilWait(d,createRuntimeState(d,"wa-web",1),context);
 };
 const ok=web(1);
 assert.equal(ok.error,undefined);
 assert.deepEqual(ok.effects.map(e=>e.kind),["message","message"]);
 assert.deepEqual((ok.effects[0] as {websiteButtons:unknown}).websiteButtons,[{label:"زر 0",url:"https://example.org/p0"}]);
 assert.equal((ok.effects[0] as {text:string}).text,"زوروا متجرنا");
 for(const [why,plan] of [["2 buttons",web(2)],["3 buttons",web(3)],["label 21",web(1,"x",()=>"a".repeat(21))],
  ["http",web(1,"x",undefined,()=>"http://example.org")],["body 1025",web(1,"ن".repeat(1025))]] as const){
  assert.equal(plan.effects.length,0,why);
  assert.equal(plan.state.status,"blocked",why);
 }
 assert.equal(web(1,"ن".repeat(1024)).effects.length,2,"1024 boundary");
 assert.equal(web(1,"x",()=>"😀".repeat(20)).effects.length,2,"20 code points");
 // Messenger keeps its rules (1..3 buttons, text <= 80); Instagram keeps 1..3 / 640.
 const fb=(n:number,text="x")=>{
  const start=trigger(),card=makeNode("message",{x:0,y:40},{text,platform:"messenger",
   options:Array.from({length:n},(_,i)=>({id:"w"+i,label:"b"+i,buttonType:"button" as const,
    action:"website" as const,url:"https://example.org/"+i}))});
  const d=graph([start,card],[connect(start,card)]);
  return planRuntimeTransition(d,createRuntimeState(d,"fb-web",1),context);
 };
 assert.equal((fb(3).effects[0] as {websiteButtons:unknown[]}).websiteButtons.length,3);
 assert.equal(fb(4).state.status,"blocked");
 assert.equal(fb(1,"x".repeat(81)).state.status,"blocked");
});
test("image blocks: the same ordered message / message_image effects on Instagram, WhatsApp and Messenger",()=>{
 const IMG="https://abcd1234.supabase.co/storage/v1/object/public/flow-media/u1/0f8c2b1e-1111-4222-8333-444455556666.png";
 const plan=(platform:"instagram"|"whatsapp"|"messenger")=>{
  const start=trigger(),pic=makeNode("message",{x:0,y:40},{text:"صورة المنتج",platform,options:[],
   contentBlocks:[{id:"b1",type:"image",url:IMG},{id:"b2",type:"text",text:"السعر 10"}]});
  pic.id="pic";
  const d=graph([start,pic],[connect(start,pic)]);
  return planUntilWait(d,createRuntimeState(d,"img",1),context);
 };
 const strip=(p:ReturnType<typeof plan>)=>p.effects.map(e=>({...e}));
 const ig=plan("instagram");
 assert.equal(ig.error,undefined);
 assert.deepEqual(ig.effects.map(e=>[e.kind,(e as {url?:string}).url??(e as {text?:string}).text]),
  [["message","صورة المنتج"],["message_image",IMG],["message","السعر 10"]]);
 assert.deepEqual(strip(plan("whatsapp")),strip(ig),"WhatsApp: identical effects");
 assert.deepEqual(strip(plan("messenger")),strip(ig),"Messenger: identical effects");
});
test("WhatsApp cta_url text with placeholders is clipped at 1024 code points (not the Messenger 80)",()=>{
 const start=trigger(),card=makeNode("message",{x:0,y:40},{text:"{{first_name}} "+"x".repeat(900),platform:"whatsapp",
  options:[{id:"w",label:"site",buttonType:"button",action:"website",url:"https://example.org"}]});
 const d=graph([start,card],[connect(start,card)]);
 const text=(planUntilWait(d,createRuntimeState(d,"wa-ph",1),context).effects[0] as {text:string}).text;
 assert.doesNotMatch(text,/\{\{/);
 assert.ok([...text].length>80&&[...text].length<=1024,String([...text].length));
});
