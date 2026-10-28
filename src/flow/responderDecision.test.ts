import {test} from "node:test";
import assert from "node:assert/strict";
import {makeNode} from "./model.ts";
import type {FlowDocument} from "./model.ts";
import {selectResponder,toFlowPlatform} from "./responderDecision.ts";
import type {TrustedResponderSnapshot} from "./responderDecision.ts";
import type {EnabledFlow,NormalizedInboundEvent} from "./eventRouting.ts";

const event:NormalizedInboundEvent={
 tenantId:"t1",accountId:"a1",eventId:"provider-mid-1",
 senderId:"sender-1",platform:"instagram",mode:"message",text:"مرحبا"
};
const trusted:TrustedResponderSnapshot={
 signatureVerified:true,webhookAccountVerified:true,
 tenantId:"t1",accountId:"a1",accountTenantId:"t1",conversationTenantId:"t1",
 humanTakeover:false,agentEnabled:true,autoReplyEnabled:true,
 creditsRemaining:5,globalFlowEnabled:false,tenantFlowEnabled:false
};
function published(id:string,keywords=""):EnabledFlow{
 const start=makeNode("trigger",{x:0,y:0},{
  triggerMode:keywords?"keyword":"message",keywords,platform:"instagram"
 });
 const text=makeNode("message",{x:0,y:80},{text:"مرحباً",options:[]});
 const document:FlowDocument={version:3,name:"Review only",nodes:[start,text],edges:[]};
 return {id,tenantId:"t1",accountId:"a1",document,enabled:true};
}

test("flag-off uses exactly the unchanged legacy AI owner even if flows match",()=>{
 for(const flows of [[],[published("one")],[published("one"),published("two")]]){
  const decision=selectResponder(trusted,event,flows);
  assert.deepEqual(decision,{owner:"legacy_ai",reason:"flow_off"});
 }
 // Missing flags are also OFF. A frontend visibility toggle has no effect.
 assert.deepEqual(selectResponder({...trusted,globalFlowEnabled:undefined,
  tenantFlowEnabled:undefined},event,[published("one")]),
  {owner:"legacy_ai",reason:"flow_off"});
});
test("unique matching server activation selects one flow; none and overlap use AI",()=>{
 const on={...trusted,globalFlowEnabled:true,tenantFlowEnabled:true};
 const match=selectResponder(on,event,[published("one")]);
 assert.equal(match.owner,"flow");
 if(match.owner!=="flow")throw Error("not a flow");
 assert.equal(match.match.flowId,"one");
 assert.equal(selectResponder(on,event,[]).owner,"legacy_ai");
 assert.deepEqual(selectResponder(on,event,[published("one"),published("two")]),
   {owner:"legacy_ai",reason:"ambiguous_match"});
 assert.equal(selectResponder(on,event,[published("missing-keyword","not-matched")]).owner,"legacy_ai");
});
test("signed verified identity and server tenant/account mapping required",()=>{
 const on={...trusted,globalFlowEnabled:true,tenantFlowEnabled:true};
 for(const [mod,reason] of [
  [{signatureVerified:false},"unverified_event"],
  [{webhookAccountVerified:false},"unverified_event"],
  [{tenantId:"other"},"ownership_mismatch"],
  [{accountId:"other"},"ownership_mismatch"],
  [{conversationTenantId:"other"},"ownership_mismatch"],
  [{accountTenantId:"other"},"ownership_mismatch"]
 ] as const){
  assert.deepEqual(selectResponder({...on,...mod},event,[published("one")]),
   {owner:"stop",reason});
 }
 assert.equal(selectResponder(on,{...event,isEcho:true},[published("one")]).owner,"stop");
 assert.equal(selectResponder(on,{...event,eventId:""},[published("one")]).owner,"stop");
 assert.equal(selectResponder(on,{...event,senderId:" bad "},[published("one")]).owner,"stop");
 assert.equal(selectResponder(on,{...event,accountId:"other"},[published("one")]).owner,"stop");
});
test("human takeover always wins ahead of any flow or AI",()=>{
 const on={...trusted,globalFlowEnabled:true,tenantFlowEnabled:true};
 assert.deepEqual(selectResponder({...on,humanTakeover:true},event,[published("one")]),
  {owner:"stop",reason:"human_takeover"});
 assert.deepEqual(selectResponder({...trusted,humanTakeover:true},event,[]),
  {owner:"stop",reason:"human_takeover"});
});
test("agent-disabled, auto-reply off and exhausted credits always stop",()=>{
 const on={...trusted,globalFlowEnabled:true,tenantFlowEnabled:true};
 for(const [mod,reason] of [
  [{agentEnabled:false},"agent_disabled"],
  [{autoReplyEnabled:false},"agent_disabled"],
  [{creditsRemaining:0},"no_credits"],
  [{creditsRemaining:-1},"no_credits"],
  [{creditsRemaining:NaN},"no_credits"]
 ] as const){
  assert.deepEqual(selectResponder({...on,...mod},event,[published("one")]),
   {owner:"stop",reason});
 }
});
test("unverified comment/referral/story or oversized messages fail closed",()=>{
 const on={...trusted,globalFlowEnabled:true,tenantFlowEnabled:true};
 for(const mode of ["comment","story","ad","live","referral"] as const){
  assert.deepEqual(selectResponder(on,{...event,mode},[published("one")]),
   {owner:"stop",reason:"unsupported_event"});
 }
 assert.equal(selectResponder(on,{...event,text:"x".repeat(8193)},[published("one")]).owner,"stop");
});
test("database platform names map strictly and never guess unsupported platforms",()=>{
 assert.equal(toFlowPlatform("facebook"),"messenger");
 assert.equal(toFlowPlatform("instagram"),"instagram");
 assert.equal(toFlowPlatform("whatsapp"),"whatsapp");
 assert.equal(toFlowPlatform("messenger"),null);
 assert.equal(toFlowPlatform("Instagram"),null);
 assert.equal(toFlowPlatform(""),null);
});
test("multiple inbound events never produce two responders from one decision",()=>{
 const on={...trusted,globalFlowEnabled:true,tenantFlowEnabled:true};
 for(let i=0;i<250;i++){
  const e={...event,eventId:"evt-"+i,text:i%2?"اشتراك":"مرحبا"};
  const flows=i%3===0?[]:i%3===1?[published("f1")]:[published("f1"),published("f2")];
  const decision=selectResponder(on,e,flows);
  assert.ok(["legacy_ai","flow","stop"].includes(decision.owner));
  if(flows.length>1)assert.notEqual(decision.owner,"flow");
 }
});
