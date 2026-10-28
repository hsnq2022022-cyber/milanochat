import {test} from "node:test";
import assert from "node:assert/strict";
import {edgeFor,makeNode} from "./model.ts";
import type {FlowDocument,FlowNode} from "./model.ts";
import {createRuntimeState,planRuntimeTransition} from "./runtimePlan.ts";

const event={eventKey:"verified-event-1",nowMs:1770000000000,seed:71};
function build(actionType:"tag"|"untag"|"notify"|"set_field"|"ai",actionValue:unknown){
 const trigger=makeNode("trigger",{x:0,y:0},{triggerMode:"message"});
 const action=makeNode("action",{x:0,y:100},{actionType,actionValue} as any);
 const next=makeNode("message",{x:0,y:220},{text:"Finished",options:[]});
 const doc:FlowDocument={version:3,name:"test",nodes:[trigger,action,next],
  edges:[
   edgeFor({source:trigger.id,sourceHandle:"next",target:action.id,targetHandle:"in"}),
   edgeFor({source:action.id,sourceHandle:"next",target:next.id,targetHandle:"in"})
  ]};
 return doc;
}

test("tag planning preserves inputs and emits one stable, idempotent ADD intent",()=>{
 const doc=build("tag","عميل جديد");
 const before=JSON.stringify(doc),state=createRuntimeState(doc,"f",1);
 const first=planRuntimeTransition(doc,state,event);
 assert.equal(first.effects.length,1);
 assert.equal(first.effects[0].kind,"tag");
 if(first.effects[0].kind!=="tag")throw Error("not a tag");
 assert.equal(first.effects[0].action,"add");
 assert.equal(first.effects[0].tag,"عميل جديد");
 assert.equal(first.state.status,"ready");
 assert.equal(first.effects[0].idempotencyKey,
  planRuntimeTransition(doc,state,event).effects[0].idempotencyKey);
 assert.equal(JSON.stringify(doc),before);
 assert.equal(state.stepCount,0);
 const follow=planRuntimeTransition(doc,first.state,{...event,eventKey:"next-tick"});
 assert.equal(follow.effects[0].kind,"message");
});
test("untag intent is distinct and has no provider-side output",()=>{
 const doc=build("untag","VIP");
 const result=planRuntimeTransition(doc,createRuntimeState(doc,"f",2),event);
 assert.equal(result.effects.length,1);
 assert.deepEqual(result.effects.map(e=>e.kind),["tag"]);
 if(result.effects[0].kind!=="tag")throw Error("not a tag");
 assert.equal(result.effects[0].action,"remove");
 assert.equal(result.effects[0].tag,"VIP");
});
test("notify is internal staff intent, not a customer/Meta send",()=>{
 const doc=build("notify","العميل يحتاج متابعة");
 const result=planRuntimeTransition(doc,createRuntimeState(doc,"f",1),event);
 assert.equal(result.effects.length,1);
 assert.equal(result.effects[0].kind,"staff_notification");
 if(result.effects[0].kind!=="staff_notification")throw Error("wrong notification");
 assert.equal(result.effects[0].message,"العميل يحتاج متابعة");
 assert.equal(result.state.status,"ready");
});
test("rejects malformed tag names including control characters and oversized UTF-8",()=>{
 for(const value of [""," ","bad\nlabel","a".repeat(65),"😀","ق".repeat(65),null,123]){
  const doc=build("tag",value);
  const result=planRuntimeTransition(doc,createRuntimeState(doc,"f",1),event);
  assert.equal(result.state.status,"blocked",String(value));
  assert.equal(result.effects.length,0);
 }
});
test("rejects invalid staff messages and never executes external delivery",()=>{
 for(const value of [""," ",null,123,"x".repeat(501),"secret\u0000value"]){
  const doc=build("notify",value);
  const result=planRuntimeTransition(doc,createRuntimeState(doc,"f",1),event);
  assert.equal(result.state.status,"blocked",String(value));
  assert.equal(result.effects.length,0);
 }
});
test("invalid custom field value fails closed rather than throwing",()=>{
 for(const value of [null,undefined,123,{},[], "bad"]){
  const doc=build("set_field",value);
  assert.doesNotThrow(()=>{
   const result=planRuntimeTransition(doc,createRuntimeState(doc,"f",1),event);
   assert.equal(result.state.status,"blocked");
   assert.equal(result.effects.length,0);
  });
 }
});
test("AI remains blocked until trusted evidence retrieval and server execution exist",()=>{
 const doc=build("ai","anything");
 const result=planRuntimeTransition(doc,createRuntimeState(doc,"f",1),event);
 assert.equal(result.state.status,"blocked");
 assert.equal(result.effects.length,0);
});
