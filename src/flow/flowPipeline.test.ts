import {test} from "node:test";
import assert from "node:assert/strict";
import {edgeFor,makeNode} from "./model.ts";
import type {FlowDocument} from "./model.ts";
import {planVerifiedInbound} from "./flowPipeline.ts";
import type {ServerPublishedFlow} from "./flowPipeline.ts";
import type {TrustedResponderSnapshot} from "./responderDecision.ts";
import type {FlowCapability} from "./publicationGate.ts";
import type {NormalizedInboundEvent} from "./eventRouting.ts";

const trusted:TrustedResponderSnapshot={
  signatureVerified:true,webhookAccountVerified:true,
  tenantId:"tenant-A",accountId:"account-A",
  accountTenantId:"tenant-A",conversationTenantId:"tenant-A",
  humanTakeover:false,agentEnabled:true,autoReplyEnabled:true,
  creditsRemaining:7,globalFlowEnabled:false,tenantFlowEnabled:false
};
const event:NormalizedInboundEvent={
  tenantId:"tenant-A",accountId:"account-A",eventId:"meta-mid-123",
  platform:"instagram",mode:"message",senderId:"user-42",text:"مرحبا"
};
const capabilities:ReadonlySet<FlowCapability>=new Set([
 "execution-engine","instagram","trigger:message","message:text"
]);
function publication(id="welcome"):ServerPublishedFlow {
 const start=makeNode("trigger",{x:0,y:0},{platform:"instagram",triggerMode:"message"});
 const msg=makeNode("message",{x:0,y:200},{text:"أهلًا بك",options:[]});
 const document:FlowDocument={version:3,name:"الترحيب",nodes:[start,msg],
  edges:[edgeFor({source:start.id,sourceHandle:"next",target:msg.id,targetHandle:"in"})]};
 return {id,tenantId:"tenant-A",accountId:"account-A",
  enabled:true,revision:1,document};
}
const now=1780000000000,seed=5;
test("OFF flag always preserves legacy AI, even when server publication matches",()=>{
 const docs=[publication()];
 for(const flags of [
  {},{globalFlowEnabled:true},{tenantFlowEnabled:true}
 ]){
  const result=planVerifiedInbound({...trusted,...flags},event,docs,capabilities,now,seed);
  assert.deepEqual(result,{owner:"legacy_ai",reason:"flow_off"});
 }
});
test("server-published valid unique flow yields exactly one text effect, never sends",()=>{
 const doc=publication(),old=JSON.stringify(doc);
 const enabled={...trusted,globalFlowEnabled:true,tenantFlowEnabled:true};
 const result=planVerifiedInbound(enabled,event,[doc],capabilities,now,seed);
 assert.equal(result.owner,"flow");
 if(result.owner!=="flow")throw Error("missing flow plan");
 assert.equal(result.flowId,doc.id);
 assert.equal(result.revision,1);
 assert.equal(result.plan.effects.length,1);
 assert.equal(result.plan.effects[0].kind,"message");
 assert.equal(result.plan.state.status,"completed");
 assert.equal(result.plan.effects[0].idempotencyKey,
  (planVerifiedInbound(enabled,event,[doc],capabilities,now,seed) as typeof result)
    .plan.effects[0].idempotencyKey);
 assert.equal(JSON.stringify(doc),old,"planner must not mutate publication");
});
test("zero and overlapping activated publications preserve one legacy AI owner",()=>{
 const on={...trusted,globalFlowEnabled:true,tenantFlowEnabled:true};
 assert.deepEqual(planVerifiedInbound(on,event,[],capabilities,now,seed),
  {owner:"legacy_ai",reason:"no_match"});
 assert.deepEqual(planVerifiedInbound(on,event,[publication("one"),publication("two")],
  capabilities,now,seed),{owner:"legacy_ai",reason:"ambiguous_match"});
});
test("no client-defined capabilities can override server publication audit",()=>{
 const on={...trusted,globalFlowEnabled:true,tenantFlowEnabled:true};
 assert.deepEqual(planVerifiedInbound(on,event,[publication()],new Set(),now,seed),
  {owner:"stop",reason:"invalid_publication"});
 const broken=publication();
 broken.document.edges=[];
 assert.deepEqual(planVerifiedInbound(on,event,[broken],capabilities,now,seed),
  {owner:"stop",reason:"invalid_publication"});
});
test("human takeover, unknown account and low credits stop before any effects",()=>{
 const on={...trusted,globalFlowEnabled:true,tenantFlowEnabled:true};
 for(const [change,reason] of [
  [{humanTakeover:true},"human_takeover"],
  [{creditsRemaining:0},"no_credits"],
  [{accountTenantId:"tenant-B"},"ownership_mismatch"],
  [{signatureVerified:false},"unverified_event"],
 ] as const){
  assert.deepEqual(planVerifiedInbound({...on,...change},event,[publication()],
   capabilities,now,seed),{owner:"stop",reason});
 }
});
test("bad revision, malformed published graph and invalid tick all fail closed",()=>{
 const on={...trusted,globalFlowEnabled:true,tenantFlowEnabled:true};
 assert.deepEqual(planVerifiedInbound(on,event,[{...publication(),revision:0}],
  capabilities,now,seed),{owner:"stop",reason:"invalid_revision"});
 const invalid=publication();
 (invalid.document as any).nodes=null;
 assert.equal(planVerifiedInbound(on,event,[invalid],capabilities,now,seed).owner,"stop");
 assert.deepEqual(planVerifiedInbound(on,event,[publication()],capabilities,-1,seed),
  {owner:"stop",reason:"invalid_tick"});
});
