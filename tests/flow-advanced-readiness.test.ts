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
 assert.equal(ready.candidateKind,"buttons");
 assert.equal(ready.delayConfigured,false);
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"delay"}).candidateKind,"delay");
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
 assert.match(ui,/readiness\.candidateKind==="buttons"/);
 assert.match(ui,/readiness\.candidateKind==="delay"/);
 assert.match(ui,/readinessNeeds\(report\)\.scheduler/);
 assert.match(ui,/readinessNeeds\(report\)\.buttons/);
 assert.match(ui,/r\.candidateKind==="delay"/);
 assert.match(ui,/data-testid="flow-copy-readiness"/);
 assert.match(ui,/navigator\.clipboard\.writeText\(JSON\.stringify\(report,null,2\)\)/);
 assert.match(ui,/const report=\{revision:checkedRevision,kind:readiness\.candidateKind,configured,missing\}/);

 assert.match(ui,/data-testid=\{"readiness-published-revision-"\+v\.revision\}/);
 assert.match(ui,/action:"readiness",accountId,flowKey:managedFlowKey/);
});

test("real server activation cannot bypass durable worker gates",()=>{
 const api=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const start=api.indexOf("const rawDocument:unknown=publication.document");
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

test("mixed and text chains require exactly the operator flags their nodes need",()=>{
 const mixed=evaluateFlowReadiness({...input,candidateKind:"mixed"});
 assert.equal(mixed.configured,true);
 assert.equal(mixed.needsButtons,true);assert.equal(mixed.needsScheduler,true);
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"mixed",richButtonsEnabled:false}).configured,false);
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"mixed",schedulerEnabled:false}).configured,false);
 const text=evaluateFlowReadiness({...input,candidateKind:"text",richButtonsEnabled:false,schedulerEnabled:false});
 assert.equal(text.configured,true);
 assert.equal(text.needsButtons,false);assert.equal(text.needsScheduler,false);
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"buttons",schedulerEnabled:false}).configured,true);
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"buttons",richButtonsEnabled:false}).configured,false);
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"delay",richButtonsEnabled:false}).configured,true);
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"delay",schedulerEnabled:false}).configured,false);
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"unsupported"}).configured,false);
 // Every base gate still blocks the new kinds.
 for(const kind of ["mixed","text"] as const)
  for(const key of Object.keys(input) as Array<keyof ReadinessInput>){
   if(["platform","candidateKind","schedulerEnabled","richButtonsEnabled"].includes(key))continue;
   assert.equal(evaluateFlowReadiness({...input,candidateKind:kind,[key]:false}).configured,false,kind+":"+key);
  }
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"text",platform:"facebook"}).configured,false);
 // Old kinds keep their old outputs.
 assert.equal(mixed.buttonsConfigured,false);assert.equal(mixed.delayConfigured,false);
 const api=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 assert.match(api,/const candidateKind:DurableCandidateKind=supported\?durableCandidateKind\(published\):"unsupported";/);
});

import {durableCandidateKind,durableRuntimeNeeds}
 from "../supabase/functions/milan-api/flowDurableIngress.ts";
test("text/email/phone collection graphs are durable 'text' candidates needing neither buttons nor scheduler",()=>{
 const T={id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}};
 const ask=(id:string,inputMode:string,inputField:string)=>({id,data:{kind:"question",inputMode,inputField,
  text:"?",image:"",contentBlocks:[],options:[]}});
 const msg=(id:string,text:string)=>({id,data:{kind:"message",text,image:"",options:[],contentBlocks:[]}});
 const E=(source:string,target:string,sourceHandle="next")=>({source,target,sourceHandle});
 const collect={version:3,nodes:[T,ask("n","text","name"),ask("e","email","email"),ask("p","phone","phone"),
  msg("ok","شكراً {{name}}")],edges:[E("start","n"),E("n","e","valid"),E("e","p","valid"),E("p","ok","valid")]};
 assert.equal(durableCandidateKind(collect),"text");
 assert.deepEqual(durableRuntimeNeeds(collect as any),{buttons:false,scheduler:false});
 // Same readiness semantics as any text candidate: no buttons/scheduler flag needed.
 const r=evaluateFlowReadiness({...input,candidateKind:durableCandidateKind(collect),
  richButtonsEnabled:false,schedulerEnabled:false});
 assert.equal(r.configured,true);assert.equal(r.needsButtons,false);assert.equal(r.needsScheduler,false);
 // ...plus a delay: the scheduler only.
 const delayed={...collect,nodes:[...collect.nodes,{id:"w",data:{kind:"delay",delayValue:1,delayUnit:"hours"}}],
  edges:[...collect.edges.filter(e=>e.source!=="p"),E("p","w","valid"),E("w","ok")]};
 assert.equal(durableCandidateKind(delayed),"delay");
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"delay",richButtonsEnabled:false}).configured,true);
 // Number inputs and "message" fields stay unsupported (never activatable as durable).
 assert.equal(durableCandidateKind({...collect,nodes:collect.nodes.map(n=>n.id==="n"?ask("n","number","name"):n)}),"unsupported");
 assert.equal(durableCandidateKind({...collect,nodes:collect.nodes.map(n=>n.id==="n"?ask("n","text","message"):n)}),"unsupported");
});
