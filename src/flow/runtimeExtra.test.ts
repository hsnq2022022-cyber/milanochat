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
