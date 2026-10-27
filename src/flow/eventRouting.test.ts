import test from "node:test";
import assert from "node:assert/strict";
import {makeNode} from "./model.ts";
import type {FlowDocument,Platform,TriggerMode} from "./model";
import {matchInboundEvent,normalizeTriggerText,parseTriggerKeywords} from "./eventRouting.ts";
import type {EnabledFlow,NormalizedInboundEvent} from "./eventRouting";

const makeFlow=(mode:TriggerMode,keywords="",platform:Platform="instagram",id="f1"):EnabledFlow=>{
  const trigger=makeNode("trigger",{x:0,y:0},{platform,triggerMode:mode,keywords});
  const message=makeNode("message",{x:0,y:300},{text:"Hello"});
  const document:FlowDocument={version:3,name:"Demo",nodes:[trigger,message],edges:[]};
  return {id,tenantId:"t1",accountId:"a1",enabled:true,document};
};
const event=(mode:TriggerMode,text="مرحبا",platform:Platform="instagram"):NormalizedInboundEvent=>({
  tenantId:"t1",accountId:"a1",eventId:"evt-1",senderId:"sender-1",platform,mode,text
});

test("normalization handles Arabic hamza, tatweel, tashkeel, whitespace and mixed case",()=>{
  assert.equal(normalizeTriggerText("  إِشْتِرَاك\t   الآن  "),"اشتراك الان");
  assert.deepEqual(parseTriggerKeywords("سعر، أسعار, سعر\n  اشتراك  "),["سعر","اسعار","اشتراك"]);
});
test("direct message trigger matches all messages, not comments or stories",()=>{
  const flow=makeFlow("message");
  assert.equal(matchInboundEvent(event("message"),[flow]).length,1);
  assert.equal(matchInboundEvent(event("keyword"),[flow]).length,0);
  assert.equal(matchInboundEvent(event("comment"),[flow]).length,0);
  assert.equal(matchInboundEvent(event("story"),[flow]).length,0);
});
test("keyword trigger matches message text but not a comment, and requires keywords",()=>{
  const flow=makeFlow("keyword","إشتراك، أسعار");
  assert.equal(matchInboundEvent(event("message","هل لديكم الاشتراك؟"),[flow]).length,1);
  assert.equal(matchInboundEvent(event("keyword","أريد أسعار"),[flow]).length,1);
  assert.equal(matchInboundEvent(event("comment","اشتراك"),[flow]).length,0);
  assert.equal(matchInboundEvent(event("message","مساء الخير"),[flow]).length,0);
  assert.equal(matchInboundEvent(event("message","اشتراك"),[makeFlow("keyword")]).length,0);
});
test("comment trigger matches comments with optional keyword filter",()=>{
  assert.equal(matchInboundEvent(event("comment","مرحبا"),[makeFlow("comment")]).length,1);
  assert.equal(matchInboundEvent(event("comment","السعر"),[makeFlow("comment","سعر")]).length,1);
  assert.equal(matchInboundEvent(event("comment","مرحبا"),[makeFlow("comment","سعر")]).length,0);
  assert.equal(matchInboundEvent(event("message","السعر"),[makeFlow("comment","سعر")]).length,0);
});
test("unsupported event modes fail closed; WhatsApp comments cannot match",()=>{
  const flow=makeFlow("message");
  for(const mode of ["story","ad","live","referral"] as TriggerMode[])
    assert.equal(matchInboundEvent(event(mode),[flow]).length,0);
  assert.equal(matchInboundEvent(event("comment","hi","whatsapp"),[makeFlow("comment","","whatsapp")]).length,0);
});
test("tenant, connected account, platform, disabled state and malformed flow isolation",()=>{
  const flow=makeFlow("message");
  assert.equal(matchInboundEvent({...event("message"),tenantId:"other"},[flow]).length,0);
  assert.equal(matchInboundEvent({...event("message"),accountId:"other"},[flow]).length,0);
  assert.equal(matchInboundEvent(event("message","hi","messenger"),[flow]).length,0);
  assert.equal(matchInboundEvent(event("message"),[{...flow,enabled:false}]).length,0);
  assert.equal(matchInboundEvent(event("message"),[{...flow,document:{...flow.document,nodes:[...flow.document.nodes,flow.document.nodes[0]]}}]).length,0);
});
test("echoes, empty IDs and oversized text are rejected",()=>{
  const flow=makeFlow("message");
  assert.equal(matchInboundEvent({...event("message"),isEcho:true},[flow]).length,0);
  assert.equal(matchInboundEvent({...event("message"),eventId:""},[flow]).length,0);
  assert.equal(matchInboundEvent({...event("message"),senderId:" "},[flow]).length,0);
  assert.equal(matchInboundEvent(event("message","x".repeat(8193)),[flow]).length,0);
});
test("same event has stable distinct idempotency keys per flow and account",()=>{
  const flows=[makeFlow("message","","instagram","f1"),makeFlow("message","","instagram","f2")];
  const first=matchInboundEvent(event("message"),flows);
  assert.equal(first.length,2);
  assert.notEqual(first[0].idempotencyKey,first[1].idempotencyKey);
  assert.deepEqual(first,matchInboundEvent(event("message"),flows));
  assert.notEqual(first[0].idempotencyKey,matchInboundEvent({...event("message"),eventId:"evt-2"},flows)[0].idempotencyKey);
});
