import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {evaluateFlowReadiness,type ReadinessInput}
 from "../supabase/functions/flow-publication/readiness.ts";

const input:ReadinessInput={
 platform:"instagram",candidateKind:"buttons",tenantActive:true,accountActive:true,
 agentEnabled:true,autoReply:true,globalEnabled:true,
 tenantEnabled:true,productionApproved:true,creditsAvailable:true,
 activePublication:true,durableIngress:true,activationApproved:true,canaryMatched:true,
 operatorReleased:true,schedulerEnabled:true,outboxEnabled:true,
 atomicDebitReady:true,richButtonsEnabled:true,encryptionConfigured:true
};

test("all required gates must be green before an advanced canary is configured",()=>{
 const ready=evaluateFlowReadiness(input);
 assert.equal(ready.buttonsConfigured,true);
 assert.equal(ready.delayConfigured,false);
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"delay"}).delayConfigured,true);
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"unsupported"}).buttonsConfigured,false);
 for(const key of Object.keys(input) as Array<keyof ReadinessInput>){
  if(key==="platform"||key==="candidateKind")continue;
  const changed={...input,[key]:false};
  const state=evaluateFlowReadiness(changed);
  if(key!=="schedulerEnabled")assert.equal(state.buttonsConfigured,false,key);
  const delayState=evaluateFlowReadiness({...changed,candidateKind:"delay"});
  if(key!=="richButtonsEnabled")assert.equal(delayState.delayConfigured,false,key);
 }
 assert.equal(evaluateFlowReadiness({...input,platform:"facebook"}).buttonsConfigured,false);
 assert.equal(evaluateFlowReadiness({...input,platform:"whatsapp"}).delayConfigured,false);
});
test("server checks are owner-scoped, read-only, and do not expose secret values",()=>{
 const api=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const ui=readFileSync("src/flow/FlowPublicationPanel.tsx","utf8");
 const start=api.indexOf('if(action==="readiness")');
 const end=api.indexOf('// Authenticated read-only catalog.',start);
 assert(start>api.indexOf('const {data:account,error:accountError}'));
 assert(end>start);
 const body=api.slice(start,end);
 for(const field of ["tenant_id","channel_account_id","flow_key"]){
  assert(body.includes(field),field);
 }
 assert.match(body,/evaluateFlowReadiness\(\{/);
 assert.match(body,/supportedDurableDocument\(published\)/);
 assert.match(body,/\.eq\("revision",revision\)\.maybeSingle\(\)/);
 assert.match(body,/return respond\(\{ok:true,readiness,candidateRevision:revision\?\?null\}\)/);
 assert.doesNotMatch(body,/\.insert\(|\.update\(|\.delete\(|sendProviderMessage|flow_activate_revision|flow_deactivate_revision/);
 assert.doesNotMatch(body,/env\("[^"]+"\)\s*[,}]/);
 assert.match(ui,/data-testid="flow-readiness-report"/);
 assert.match(ui,/data-testid=\{"readiness-published-revision-"\+v\.revision\}/);
 assert.match(ui,/action:"readiness",accountId,flowKey:managedFlowKey/);
});

test("real server activation cannot bypass durable worker gates",()=>{
 const api=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const start=api.indexOf("const durableGraph=supportedDurableDocument(publication.document)");
 const end=api.indexOf("if(!durable)",start);
 assert(start>0&&end>start);
 const guarded=api.slice(start,end);
 for(const flag of [
  "FLOW_DURABLE_ACTIVATION_READY","FLOW_DURABLE_INGRESS_ENABLED",
  "FLOW_DURABLE_CANARY_ACCOUNT_ID","FLOW_WORKERS_OPERATOR_RELEASE",
  "FLOW_OUTBOX_SEND_ENABLED","FLOW_ATOMIC_CONSUME_READY",
  "FIELD_ENCRYPTION_KEY","FLOW_RICH_BUTTONS_ENABLED",
  "FLOW_DURABLE_SCHEDULER_ENABLED"
 ])assert(guarded.includes(flag),flag);
 assert.match(api.slice(end,end+350),/simpleMessageFromDocument\(publication.document,scope.platform\)===null/);
});
