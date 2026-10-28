import {test} from "node:test";
import assert from "node:assert/strict";
import {makeNode,edgeFor} from "./model.ts";
import type {FlowDocument,FlowNode} from "./model.ts";
import {createRuntimeState,planRuntimeTransition} from "./runtimePlan.ts";
import {authorizeFlowAI,planFlowMetric} from "./aiMetricsGate.ts";

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
 const prices=makeNode("message",{x:0,y:90},{text:"قائمة الأسعار",options:[]});
 const agent=makeNode("message",{x:200,y:90},{text:"سيتابع الموظف",options:[]});
 const d=graph([start,q,prices,agent],[
  connect(start,q),connect(q,prices,"prices"),connect(q,agent,"agent")
 ]);
 const plan=planRuntimeTransition(d,createRuntimeState(d,"choice",1),context);
 assert.equal(plan.state.status,"awaiting_input");
 assert.deepEqual((plan.effects[0] as {choiceIds:string[]}).choiceIds,["prices","agent"]);
 assert.deepEqual((plan.effects[0] as {choices:string[]}).choices,["الأسعار","موظف"]);
 const selected=planRuntimeTransition(d,plan.state,{...context,eventKey:"tap",
  answer:"prices"});
 assert.equal(selected.state.status,"completed");
 assert.deepEqual(selected.effects.map(x=>x.kind),["message"]);
 assert.equal((selected.effects[0] as {text:string}).text,"قائمة الأسعار");
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
