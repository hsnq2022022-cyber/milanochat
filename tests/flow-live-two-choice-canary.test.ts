import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {preparePublishedDocument} from "../src/flow/serverPublicationValidation.ts";
import {createRuntimeState,planRuntimeTransition} from "../src/flow/runtimePlan.ts";
import {supportedDurableDocument,selectedFlowChoice} from "../supabase/functions/milan-api/flowDurableIngress.ts";
import {metaQuickReplies} from "../supabase/functions/flow-outbox-worker/flowRichActions.ts";

const doc=JSON.parse(readFileSync("examples/flow-instagram-two-choice-v3.json","utf8"));
test("real two-choice graph passes BOTH browser publisher and server durable runtime",()=>{
 const compiled=preparePublishedDocument(doc,"instagram");
 assert(compiled,"Publisher rejected the actual example");
 assert.equal(supportedDurableDocument(compiled),true);
 assert.equal(supportedDurableDocument({...compiled,version:2}),false);
 assert.equal(supportedDurableDocument({...compiled,nodes:[...compiled.nodes,{id:"extra",data:{kind:"action"}}]}),false);
});
test("the exact incoming message -> question -> two answers are deterministic",()=>{
 const valid=preparePublishedDocument(doc,"instagram")!;
 const state=createRuntimeState(valid,"ig_live_welcome_20261029",3);
 const question=planRuntimeTransition(valid,state,{eventKey:"original-mid",nowMs:123456789,seed:0});
 assert.equal(question.error,undefined);
 assert.equal(question.state.status,"awaiting_input");
 assert.equal(question.effects.length,1);
 assert.equal(question.effects[0].kind,"question");
 if(question.effects[0].kind!=="question")return;
 assert.deepEqual(question.effects[0].choiceIds,["prices","info"]);
 const options=question.effects[0].choiceIds.map((id,i)=>({id,label:question.effects[0].kind==="question"?question.effects[0].choices[i]:""}));
 const meta=metaQuickReplies(options,"instagram");
 assert.deepEqual(meta.map(x=>x.payload),["flow-choice:prices","flow-choice:info"]);
 for(const [choice,reply] of [
  ["prices","أهلاً بيك 👋 حتى أساعدك بالسعر، اكتب اسم الخدمة أو المنتج المطلوب."],
  ["info","أهلاً بيك 👋 وصلتنا رسالتك عن طريق إدارة سوشيال. شلون نكدر نساعدك؟"]
 ] as const){
  assert.equal(selectedFlowChoice({quick_reply:{payload:"flow-choice:"+choice}}),choice);
  const next=planRuntimeTransition(valid,question.state,{
   eventKey:"choice-"+choice,nowMs:123456790,seed:0,answer:choice
  });
  assert.equal(next.error,undefined);
  assert.equal(next.state.status,"completed");
  assert.equal(next.effects.length,1);
  assert.equal(next.effects[0].kind,"message");
  if(next.effects[0].kind==="message"&&"text" in next.effects[0])
   assert.equal(next.effects[0].text,reply);
 }
});

test("a one-minute delay canary is accepted and emits exactly one wake-up reply",()=>{
 const delay=JSON.parse(readFileSync("examples/flow-instagram-one-minute-delay-v3.json","utf8"));
 const compiled=preparePublishedDocument(delay,"instagram");
 assert(compiled,"Publisher rejected the delay canary");
 assert.equal(supportedDurableDocument(compiled),true);
 const started=createRuntimeState(compiled,"ig_live_welcome_20261029",4);
 const before=planRuntimeTransition(compiled,started,{
  eventKey:"delay-start",nowMs:120000,seed:0
 });
 assert.equal(before.error,undefined);
 assert.equal(before.state.status,"sleeping");
 assert.equal(before.effects.length,1);
 assert.equal(before.effects[0].kind,"delay");
 assert.equal(before.state.wakeAt,180000);
 const early=planRuntimeTransition(compiled,before.state,{
  eventKey:"early-wake",nowMs:179999,seed:0
 });
 assert.equal(early.state.status,"sleeping");
 assert.equal(early.effects.length,0);
 const due=planRuntimeTransition(compiled,before.state,{
  eventKey:"scheduled-wake",nowMs:180001,seed:0
 });
 assert.equal(due.error,undefined);
 assert.equal(due.state.status,"completed");
 assert.equal(due.effects.length,1);
 assert.equal(due.effects[0].kind,"message");
 if(due.effects[0].kind==="message"&&"text" in due.effects[0])
  assert.equal(due.effects[0].text,"أهلاً بيك 👋 هذه رسالة وصلت بعد دقيقة من تشغيل التدفق الآلي.");
});
