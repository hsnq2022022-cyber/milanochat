import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeFor, makeNode } from "./model.ts";
import type { FlowDocument, FlowNode } from "./model.ts";
import {
  createRuntimeState, planRuntimeTransition, MAX_RUNTIME_STEPS,
  MAX_TRANSITIONS_PER_TICK,
} from "./runtimePlan.ts";

const input = { eventKey: "verified-provider-event-123", nowMs: 1750000000000, seed: 123 };
function doc(nodes: FlowNode[], wires: Array<[FlowNode,string,FlowNode]>): FlowDocument {
  return { version: 3, name: "test", nodes, edges: wires.map(([a,port,b]) =>
    edgeFor({source:a.id,sourceHandle:port,target:b.id,targetHandle:"in"})) };
}
function trigger() { return makeNode("trigger",{x:0,y:0},{triggerMode:"message"}); }

test("plans but never sends a real message and preserves input state/document",()=>{
  const t=trigger(), m=makeNode("message",{x:0,y:100},{text:"Hi",options:[]});
  const flow=doc([t,m],[[t,"next",m]]);
  const original=JSON.stringify(flow), state=createRuntimeState(flow,"flow1",2);
  const result=planRuntimeTransition(flow,state,input);
  assert.equal(result.state.status,"completed");
  assert.equal(result.effects[0].kind,"message");
  assert.equal(result.effects[0].idempotencyKey,
    planRuntimeTransition(flow,state,input).effects[0].idempotencyKey);
  assert.equal(JSON.stringify(state),JSON.stringify(createRuntimeState(flow,"flow1",2)));
  assert.equal(JSON.stringify(flow),original);
});
test("requires explicit input and validates email before advancing",()=>{
  const t=trigger(),q=makeNode("question",{x:0,y:80},{text:"Email?",inputMode:"email",inputField:"email"});
  const msg=makeNode("message",{x:0,y:200},{text:"Thank you",options:[]});
  const flow=doc([t,q,msg],[[t,"next",q],[q,"valid",msg]]);
  const start=planRuntimeTransition(flow,createRuntimeState(flow,"a",1),input);
  assert.equal(start.state.status,"awaiting_input");
  assert.equal(start.effects[0].kind,"question");
  const invalid=planRuntimeTransition(flow,start.state,{...input,answer:"nope"});
  assert.equal(invalid.state.status,"awaiting_input");
  assert.equal(invalid.effects.length,0);
  const valid=planRuntimeTransition(flow,start.state,{...input,eventKey:"reply-1",answer:"a@example.com"});
  assert.equal(valid.state.variables.email,"a@example.com");
  assert.equal(valid.effects[0].kind,"message");
  assert.equal(valid.state.status,"completed");
});
test("question buttons route only supported step actions",()=>{
  const t=trigger(),q=makeNode("question",{x:0,y:80},{
    text:"Choose",inputMode:"buttons",options:[{id:"a",label:"A"},{id:"b",label:"B"}]
  });
  const a=makeNode("message",{x:0,y:250},{text:"A selected",options:[]});
  const b=makeNode("message",{x:200,y:250},{text:"B selected",options:[]});
  const flow=doc([t,q,a,b],[[t,"next",q],[q,"a",a],[q,"b",b]]);
  const ask=planRuntimeTransition(flow,createRuntimeState(flow,"f",1),input);
  assert.equal(ask.state.status,"awaiting_input");
  const reply=planRuntimeTransition(flow,ask.state,{...input,eventKey:"reply",answer:"B"});
  assert.equal(reply.effects[0].kind,"message");
  assert.equal((reply.effects[0] as {text:string}).text,"B selected");
});
test("delay uses persisted wake time and cannot emit twice before due",()=>{
  const t=trigger(),d=makeNode("delay",{x:0,y:70},{delayValue:2,delayUnit:"minutes"});
  const m=makeNode("message",{x:0,y:200},{text:"Due",options:[]});
  const flow=doc([t,d,m],[[t,"next",d],[d,"next",m]]);
  const scheduled=planRuntimeTransition(flow,createRuntimeState(flow,"f",1),input);
  assert.equal(scheduled.state.status,"sleeping");
  assert.equal(scheduled.effects[0].kind,"delay");
  const early=planRuntimeTransition(flow,scheduled.state,{...input,nowMs:input.nowMs+119999});
  assert.equal(early.state.status,"sleeping");
  assert.equal(early.effects.length,0);
  const due=planRuntimeTransition(flow,scheduled.state,{...input,nowMs:input.nowMs+120000,eventKey:"scheduled-wakeup"});
  assert.equal(due.state.status,"completed");
  assert.equal(due.effects[0].kind,"message");
});
test("unsupported external requests and AI actions fail closed with zero outbound effects",()=>{
  for(const kind of ["request","action"] as const) {
    const t=trigger(),n=makeNode(kind,{x:0,y:100},{
      ...(kind==="action"?{actionType:"ai"}:{requestUrl:"https://example.com"})
    });
    const flow=doc([t,n],[[t,"next",n]]);
    const plan=planRuntimeTransition(flow,createRuntimeState(flow,"f",1),input);
    assert.equal(plan.state.status,"blocked");
    assert.equal(plan.effects.length,0);
  }
});
test("handoff is a single declared effect and stops the AI/automation path",()=>{
  const t=trigger(),n=makeNode("action",{x:0,y:100},{actionType:"handoff"});
  const flow=doc([t,n],[[t,"next",n]]);
  const state=planRuntimeTransition(flow,createRuntimeState(flow,"f",1),input);
  assert.equal(state.state.status,"handoff");
  assert.deepEqual(state.effects.map(x=>x.kind),["handoff"]);
  assert.deepEqual(planRuntimeTransition(flow,state.state,input).effects,[]);
});
test("cyclic goto and invalid input cannot cause an unbounded execution request",()=>{
  const t=trigger(),goto=makeNode("goto",{x:0,y:100},{});
  goto.data.gotoNode=goto.id;
  const flow=doc([t,goto],[[t,"next",goto]]);
  const result=planRuntimeTransition(flow,createRuntimeState(flow,"f",1),input);
  assert.equal(result.state.status,"blocked");
  assert.match(result.error||"",/too many synchronous transitions/);
  assert.ok(result.state.stepCount<=MAX_TRANSITIONS_PER_TICK);
  assert.equal(MAX_RUNTIME_STEPS,150);
  const invalid=planRuntimeTransition(flow,createRuntimeState(flow,"f",1),{...input,eventKey:""});
  assert.equal(invalid.state.status,"blocked");
});
test("missing published revision and malformed state are rejected",()=>{
  const t=trigger(), flow=doc([t],[]);
  assert.throws(()=>createRuntimeState(flow,"f",0),/invalid published/);
  const state=createRuntimeState(flow,"f",1);
  assert.equal(planRuntimeTransition(flow,{...state,stepCount:-1},input).state.status,"blocked");
});
