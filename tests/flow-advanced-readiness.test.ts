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
 assert.match(ui,/copyText\(JSON\.stringify\(report,null,2\)\)/);
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

import {durableNeedsInternalActions,supportedDurableDocument}
 from "../supabase/functions/milan-api/flowDurableIngress.ts";
test("tag/untag/notify/handoff graphs additionally require FLOW_INTERNAL_ACTIONS_ENABLED; old callers unchanged",()=>{
 // Old inputs (no internal fields) keep exactly their previous results.
 for(const kind of ["buttons","delay","mixed","text"] as const){
  const before=evaluateFlowReadiness({...input,candidateKind:kind});
  assert.equal(before.needsInternalActions,false,kind);
  assert.equal(before.checks.internalActions,false,kind);
  const notNeeded=evaluateFlowReadiness({...input,candidateKind:kind,needsInternalActions:false,internalActionsEnabled:false});
  assert.equal(notNeeded.configured,before.configured,kind);
  assert.equal(notNeeded.buttonsConfigured,before.buttonsConfigured,kind);
  assert.equal(notNeeded.delayConfigured,before.delayConfigured,kind);
  const needed=evaluateFlowReadiness({...input,candidateKind:kind,needsInternalActions:true});
  assert.equal(needed.needsInternalActions,true);
  assert.equal(needed.configured,false,kind+": flag missing");
  assert.equal(needed.buttonsConfigured,false);assert.equal(needed.delayConfigured,false);
  const on=evaluateFlowReadiness({...input,candidateKind:kind,needsInternalActions:true,internalActionsEnabled:true});
  assert.equal(on.configured,before.configured,kind+": flag present");
  assert.equal(on.buttonsConfigured,before.buttonsConfigured);assert.equal(on.delayConfigured,before.delayConfigured);
 }
 // The flag never makes an unsupported candidate or a red base gate ready.
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"unsupported",needsInternalActions:true,internalActionsEnabled:true}).configured,false);
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"text",outboxEnabled:false,needsInternalActions:true,internalActionsEnabled:true}).configured,false);
 // The publication endpoint derives the need from the SAME whitelist and the real flag.
 const api=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 assert.match(api,/needsInternalActions:supported&&durableNeedsInternalActions\(published\),/);
 assert.match(api,/internalActionsEnabled:env\("FLOW_INTERNAL_ACTIONS_ENABLED"\)==="true"/);
 const T={id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}};
 const doc={version:3,nodes:[T,{id:"m",data:{kind:"message",text:"bye",image:"",options:[],contentBlocks:[]}},
  {id:"h",data:{kind:"action",actionType:"handoff",actionValue:""}}],
  edges:[{source:"start",target:"m",sourceHandle:"next"},{source:"m",target:"h",sourceHandle:"next"}]};
 assert.equal(supportedDurableDocument(doc),true);
 assert.equal(durableNeedsInternalActions(doc as any),true);
});
test("activation guard requires the internal executor flag exactly when the graph has internal actions",()=>{
 const api=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const start=api.indexOf("const rawDocument:unknown=publication.document");
 const guard=api.slice(start,api.indexOf("if(!durable){",start));
 assert.match(guard,/const needsInternal=!durableGraph\|\|durableNeedsInternalActions\(rawDocument\);/);
 assert.match(guard,/\(!needsInternal\|\|env\("FLOW_INTERNAL_ACTIONS_ENABLED"\)==="true"\)&&/);
});
import {flowNeedsMedia} from "../src/flow/publicationGate.ts";
test("image graphs additionally require message:image + FLOW_MEDIA_SEND_ENABLED; old callers unchanged",()=>{
 for(const kind of ["buttons","delay","mixed","text"] as const){
  const before=evaluateFlowReadiness({...input,candidateKind:kind});
  assert.equal(before.needsMedia,false,kind);assert.equal(before.checks.media,false,kind);
  const needed=evaluateFlowReadiness({...input,candidateKind:kind,needsMedia:true});
  assert.equal(needed.needsMedia,true);
  assert.equal(needed.configured,false,kind+": media not enabled");
  assert.equal(needed.buttonsConfigured,false);assert.equal(needed.delayConfigured,false);
  const on=evaluateFlowReadiness({...input,candidateKind:kind,needsMedia:true,mediaEnabled:true});
  assert.equal(on.configured,before.configured,kind);
  assert.equal(on.buttonsConfigured,before.buttonsConfigured);assert.equal(on.delayConfigured,before.delayConfigured);
  // Media never relaxes the internal-actions requirement (and vice versa).
  assert.equal(evaluateFlowReadiness({...input,candidateKind:kind,needsMedia:true,mediaEnabled:true,needsInternalActions:true}).configured,false);
 }
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"unsupported",needsMedia:true,mediaEnabled:true}).configured,false);
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"text",outboxEnabled:false,needsMedia:true,mediaEnabled:true}).configured,false);
 const api=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const start=api.indexOf('if(action==="readiness")'),body=api.slice(start,api.indexOf('// Authenticated read-only catalog.',start));
 assert.match(body,/needsMedia:supported&&flowNeedsMedia\(published\),/);
 assert.match(body,/mediaEnabled:mediaActivationAllowed\(parseCapabilities\(env\("FLOW_ACTIVATION_CAPABILITIES"\)\),\n\s+env\("FLOW_MEDIA_SEND_ENABLED"\)==="true"\)/);
 const T={id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}};
 const img={version:3,nodes:[T,{id:"m",data:{kind:"message",text:"x",image:"",options:[],
  contentBlocks:[{id:"b",type:"image",url:"https://abcd1234.supabase.co/storage/v1/object/public/flow-media/u1/a.webp"}]}}],
  edges:[{source:"start",target:"m",sourceHandle:"next"}]};
 assert.equal(flowNeedsMedia(img),true);
 const ui=readFileSync("src/flow/FlowPublicationPanel.tsx","utf8");
 assert.match(ui,/\(key!=="media"\|\|readinessNeeds\(report\)\.media\)\);/);
 assert.match(ui,/ media:r\.needsMedia===true\n\}\);/);
});
test("activation guard requires message:image and FLOW_MEDIA_SEND_ENABLED exactly when the graph has images",()=>{
 const api=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const start=api.indexOf("const rawDocument:unknown=publication.document");
 const guard=api.slice(start,api.indexOf("if(!durable){",start));
 assert.match(guard,/const needsMedia=flowNeedsMedia\(rawDocument\);/);
 assert.match(guard,/const mediaAllowed=mediaActivationAllowed\(parseCapabilities\(env\("FLOW_ACTIVATION_CAPABILITIES"\)\),\n\s+env\("FLOW_MEDIA_SEND_ENABLED"\)==="true"\);/);
 assert.match(guard,/\(!needsMedia\|\|mediaAllowed\)&&\n\s+\(!needs\.scheduler\|\|env\("FLOW_DURABLE_SCHEDULER_ENABLED"\)==="true"\);/);
 // Canary (non-durable) capability set: message:image only while the flag is on; default set unchanged.
 const after=api.slice(api.indexOf("if(!durable){",start));
 assert.match(after,/withMediaGate\(parseCapabilities\(env\("FLOW_ACTIVATION_CAPABILITIES"\)\),env\("FLOW_MEDIA_SEND_ENABLED"\)==="true"\)/);
 assert.match(after,/new Set<FlowCapability>\(\["execution-engine","instagram","trigger:message","message:text","condition"\]\)/);
 assert.match(after.slice(0,200),/simpleMessageFromDocument\(publication\.document,scope\.platform\)===null/,"V2 path still refuses image documents first");
});
test("Instagram website-button graphs are a buttons candidate: ready only with FLOW_RICH_BUTTONS_ENABLED",async()=>{
 const {durableCandidateKind}=await import("../supabase/functions/milan-api/flowDurableIngress.ts");
 const doc={version:3,nodes:[{id:"start",data:{kind:"trigger",platform:"instagram",triggerMode:"message"}},
  {id:"card",data:{kind:"message",platform:"instagram",text:"تفضل",image:"",contentBlocks:[],
   options:[{id:"w",label:"موقعنا",buttonType:"button",action:"website",url:"https://example.com"}]}},
  {id:"after",data:{kind:"message",text:"شكراً",image:"",contentBlocks:[],options:[]}}],
  edges:[{source:"start",target:"card",sourceHandle:"next"},{source:"card",target:"after",sourceHandle:"next"}]};
 const old=(globalThis as any).Deno;
 try{
  (globalThis as any).Deno={env:{get:(k:string)=>k==="FLOW_RICH_BUTTONS_ENABLED"?"true":undefined}};
  const kind=durableCandidateKind(doc);
  assert.equal(kind,"buttons");
  assert.equal(evaluateFlowReadiness({...input,candidateKind:kind}).configured,true);
  assert.equal(evaluateFlowReadiness({...input,candidateKind:kind,richButtonsEnabled:false}).configured,false);
  (globalThis as any).Deno={env:{get:()=>undefined}};
  assert.equal(durableCandidateKind(doc),"unsupported","flag OFF: existing refusal");
 }finally{(globalThis as any).Deno=old;}
});

import {evaluateCommentReadiness,documentHasCommentTrigger}
 from "../supabase/functions/flow-publication/readiness.ts";
import {commentFlowPlan} from "../supabase/functions/milan-api/commentTrigger.ts";
import {productionActivationAuthorized} from "../src/flow/serverPublicationValidation.ts";
const commentDoc=(platform:string,over:Record<string,unknown>={})=>({version:3,nodes:[
 {id:"start",data:{kind:"trigger",platform,triggerMode:"comment",commentScope:"all",
  commentMatchType:"any",keywords:"",publicReplyText:"أرسلنا لك رسالة",...over}},
 {id:"m",data:{kind:"message",text:"مرحباً",image:"",options:[],contentBlocks:[]}}],
 edges:[{source:"start",target:"m",sourceHandle:"next"}]});
const flagsOn={commentAutomationEnabled:true,multichannelEnabled:true};
const plan=(platform:"instagram"|"facebook"|"whatsapp",doc:unknown)=>
 commentFlowPlan(doc,platform)!==null;
test("comment flows: supported («مدعوم») for instagram and facebook when the server flags are on",()=>{
 for(const [platform,trigger] of [["instagram","instagram"],["facebook","messenger"]] as const){
  const doc=commentDoc(trigger);
  assert.equal(documentHasCommentTrigger(doc),true);
  const r=evaluateFlowReadiness({...input,platform,candidateKind:"unsupported",
   comment:{planValid:plan(platform,doc),...flagsOn}});
  assert.equal(r.candidateKind,"comment",platform);
  assert.equal(r.commentTrigger?.status,"supported",platform);
  assert.equal(r.commentTrigger?.supported,true);
  assert.deepEqual(r.commentTrigger?.statusLabel,{ar:"مدعوم",en:"Supported"});
  assert.equal(r.commentTrigger?.reason,"ok");
  assert.equal(r.checks.commentTrigger,true);
  assert.equal(r.checks.supportedCandidate,true);
  // No Instagram-only requirement on comment reports (Facebook included).
  assert.equal("instagram" in r.checks,false,platform);
  assert.equal(r.needsButtons,false);assert.equal(r.needsScheduler,false);
  assert.equal(r.configured,true,platform);
  assert.equal(r.buttonsConfigured,false);assert.equal(r.delayConfigured,false);
 }
 const fb=evaluateFlowReadiness({...input,platform:"facebook",candidateKind:"unsupported",
  comment:{planValid:true,...flagsOn}});
 assert.match(fb.commentTrigger!.label.en,/Facebook Page/);
 assert.doesNotMatch(JSON.stringify(fb.commentTrigger)+JSON.stringify(fb.checkLabels),/Instagram/);
 const ig=evaluateFlowReadiness({...input,candidateKind:"unsupported",comment:{planValid:true,...flagsOn}});
 assert.match(ig.commentTrigger!.label.en,/Instagram/);
 // Comment graphs never need the buttons sender or the scheduler.
 assert.equal(evaluateFlowReadiness({...input,richButtonsEnabled:false,schedulerEnabled:false,
  candidateKind:"unsupported",comment:{planValid:true,...flagsOn}}).configured,true);
});
test("comment flows: unsupported («غير مدعوم») when flags are off, on whatsapp, or with an invalid graph",()=>{
 const unsupported=(platform:string,comment:{planValid:boolean;commentAutomationEnabled:boolean;multichannelEnabled:boolean},reason:string)=>{
  const r=evaluateFlowReadiness({...input,platform,candidateKind:"unsupported",comment});
  assert.equal(r.commentTrigger?.status,"unsupported",platform+":"+reason);
  assert.deepEqual(r.commentTrigger?.statusLabel,{ar:"غير مدعوم",en:"Not supported"});
  assert.equal(r.commentTrigger?.reason,reason);
  assert.equal(r.checks.commentTrigger,false);
  assert.equal(r.configured,false);
  assert.equal("instagram" in r.checks,false);
  return r;
 };
 unsupported("instagram",{planValid:true,commentAutomationEnabled:false,multichannelEnabled:true},"comment_automation_off");
 unsupported("facebook",{planValid:true,commentAutomationEnabled:false,multichannelEnabled:true},"comment_automation_off");
 unsupported("facebook",{planValid:true,commentAutomationEnabled:true,multichannelEnabled:false},"multichannel_off");
 // Instagram does not need the multichannel flag (same as productionActivationAuthorized).
 assert.equal(evaluateFlowReadiness({...input,candidateKind:"unsupported",
  comment:{planValid:true,commentAutomationEnabled:true,multichannelEnabled:false}}).configured,true);
 // WhatsApp has no comment surface: never supported, even with every flag on.
 const wa=unsupported("whatsapp",{planValid:true,...flagsOn},"no_comment_surface");
 assert.equal(wa.candidateKind,"unsupported");
 assert.match(wa.commentTrigger!.label.en,/WhatsApp/);
 assert.equal(plan("whatsapp",commentDoc("whatsapp")),false);
 // Missing public reply text: the plan is refused, so the flow stays unsupported.
 for(const [platform,trigger] of [["instagram","instagram"],["facebook","messenger"]] as const){
  const noReply=commentDoc(trigger,{publicReplyText:"  "});
  assert.equal(plan(platform,noReply),false);
  const r=unsupported(platform,{planValid:plan(platform,noReply),...flagsOn},"invalid_comment_flow");
  assert.equal(r.candidateKind,"unsupported");assert.equal(r.checks.supportedCandidate,false);
 }
 // Fail-closed: only boolean true enables (truthy strings do not).
 assert.equal(evaluateCommentReadiness("instagram",{planValid:true,commentAutomationEnabled:"true" as any,multichannelEnabled:true}).supported,false);
 // Every operator/base gate still blocks a supported comment flow.
 for(const key of Object.keys(input) as Array<keyof ReadinessInput>){
  if(["platform","candidateKind","schedulerEnabled","richButtonsEnabled"].includes(key))continue;
  assert.equal(evaluateFlowReadiness({...input,[key]:false,candidateKind:"unsupported",
   comment:{planValid:true,...flagsOn}}).configured,false,key);
 }
 // Non-comment documents: no comment report, Instagram check unchanged.
 const dm=evaluateFlowReadiness({...input,platform:"facebook"});
 assert.equal("commentTrigger" in dm,false);assert.equal(dm.checks.instagram,false);
 assert.equal(documentHasCommentTrigger({version:3,nodes:[{id:"s",data:{kind:"trigger",triggerMode:"message"}}]}),false);
 assert.equal(documentHasCommentTrigger(null),false);
});
test("comment readiness platform rule matches productionActivationAuthorized (with the comment flag)",()=>{
 for(const platform of ["instagram","facebook","whatsapp"] as const)
  for(const commentAutomationEnabled of [true,false])
   for(const multichannelEnabled of [true,false]){
    const expected=commentAutomationEnabled&&productionActivationAuthorized(platform,true,true,true,
     {commentTrigger:true,commentAutomationEnabled,multichannelEnabled});
    assert.equal(evaluateCommentReadiness(platform,{planValid:true,commentAutomationEnabled,multichannelEnabled}).supported,
     expected,platform+commentAutomationEnabled+multichannelEnabled);
   }
});
test("readiness endpoint derives comment readiness from the stored document and server env only",()=>{
 const api=readFileSync("supabase/functions/flow-publication/index.ts","utf8");
 const start=api.indexOf('if(action==="readiness")'),body=api.slice(start,api.indexOf('// Authenticated read-only catalog.',start));
 assert.match(body,/const comment=!supported&&documentHasCommentTrigger\(published\)\?\{\n\s+planValid:commentFlowPlan\(published,scope\.platform\)!==null,\.\.\.commentSwitches\(\)\}:undefined;/);
 assert.doesNotMatch(body,/request\.(comment|commentAutomation|multichannel)/);
 assert.match(api,/commentAutomationEnabled:env\("FLOW_COMMENT_AUTOMATION_ENABLED"\)==="true"/);
 assert.match(api,/multichannelEnabled:env\("FLOW_MULTICHANNEL_ENABLED"\)==="true"/);
 const ui=readFileSync("src/flow/FlowPublicationPanel.tsx","utf8");
 // The UI renders the server's status/label; it never hardcodes «مدعوم».
 assert.doesNotMatch(ui,/"مدعوم"/);
 assert.match(ui,/serverText\(readiness\.commentTrigger\.statusLabel,en\)/);
 assert.match(ui,/serverText\(readiness\.checkLabels\?\.\[key\],en\)/);
});
