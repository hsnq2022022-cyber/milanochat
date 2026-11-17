/**
 * Activation gates for flow-publication, shared by every action that turns a
 * stored revision live (activate / rollback), and by publish_live for the
 * prepared document before its revision is created (optional `document`).
 * Extracted verbatim from index.ts: the same checks in the same order, the same env reads, the same
 * DB reads, the same HTTP statuses/bodies and the same fail-closed results.
 *
 * Pure decision: never mutates and never calls flow_activate_revision. On
 * {ok:true} the caller performs that RPC (which re-checks the global/tenant
 * switches transactionally). On {ok:false} the caller returns `body` with
 * `status` unchanged. Thrown errors propagate to the caller's catch (503).
 */
import {
 publicationCanActivate,testCanaryArmed,productionActivationAuthorized,
 type ProviderPlatform,
 messageScopeActivationProblem,MESSAGE_SCOPE_PROBLEM_MESSAGES
} from "../../../src/flow/serverPublicationValidation.ts";
import {flowNeedsMedia,parseCapabilities,mediaActivationAllowed,withMediaGate,
 type FlowCapability} from "../../../src/flow/publicationGate.ts";
import {simpleFlowDocumentSupported} from "../milan-api/flowPrepareMessage.ts";
import {supportedDurableDocument,durableRuntimeNeeds,durableNeedsInternalActions}
 from "../milan-api/flowDurableIngress.ts";
import {commentFlowPlan} from "../milan-api/commentTrigger.ts";

type Db={from:(table:string)=>any};

/** Canary capability set: trigger:keyword follows trigger:message (same V2 engine). */
export function withKeywordTrigger(caps:Set<FlowCapability>):Set<FlowCapability>{
 if(caps.has("trigger:message"))caps.add("trigger:keyword");
 return caps;
}

export type ActivationGateInput={
 client:Db;
 /** Edge env reader (absent = ""), injected by index.ts. */
 env:(k:string)=>string;
 /** index.ts commentSwitches (server env flags, fail-closed). */
 commentSwitches:()=>{commentAutomationEnabled:boolean;multichannelEnabled:boolean};
 /** Already authenticated and tenant/account-scoped by the caller. */
 scope:{tenantId:string;accountId:string;platform:ProviderPlatform};
 tenant:{is_active?:unknown};
 account:{is_active?:unknown;agent_enabled?:unknown;auto_reply?:unknown};
 flowKey:string;
 /** "rollback" is exempt from FLOW_MESSAGE_SCOPE_REQUIRED only. */
 action:"activate"|"rollback";
}&(
 /** Stored revision: its document is read (tenant/account/platform/flow_key scoped). Already validated (safe integer >= 1). */
 {rev:number;document?:undefined}|
 /**
  * publish_live: the caller's already validated and prepared document (exactly
  * what flow_publish_revision will store), evaluated BEFORE the revision exists.
  * Skips ONLY the stored-revision lookup; every other gate is unchanged.
  */
 {rev?:undefined;document:object}
);

export type ActivationGateResult=
 {ok:true}|
 {ok:false;status:number;body:{ok:false;error:string;code?:string}};

const error=(message:string,status:number):ActivationGateResult=>
 ({ok:false,status,body:{ok:false,error:message}});

export async function evaluateActivationGates(input:ActivationGateInput):Promise<ActivationGateResult>{
 const {client,env,commentSwitches,scope,tenant,account,flowKey,action}=input;
 if(tenant.is_active!==true||account.is_active!==true||
    account.agent_enabled!==true||account.auto_reply!==true)
  return error("Account is paused",403);

 // Production approval requires two OFF-by-default DB switches plus a
 // separate operator-owned production_approved bit. The RPC re-checks
 // global/tenant gates transactionally before committing activation.
 const canary=testCanaryArmed(env("FLOW_PUBLICATION_CANARY_READY"),
   env("FLOW_PUBLICATION_CANARY_TENANT_ID"),
   env("FLOW_PUBLICATION_CANARY_ACCOUNT_ID"),
   scope.tenantId,scope.accountId);
 const [globalSwitch,tenantSwitch]=await Promise.all([
  client.from("automation_flow_global_switch").select("enabled")
   .eq("singleton",true).maybeSingle(),
  client.from("automation_flow_tenant_switches")
   .select("enabled,production_approved").eq("tenant_id",scope.tenantId)
   .maybeSingle()
 ]);
 if(globalSwitch.error||tenantSwitch.error)
  return error("Automation switches unavailable",503);
 const production=productionActivationAuthorized(
  scope.platform,globalSwitch.data?.enabled,
  tenantSwitch.data?.enabled,tenantSwitch.data?.production_approved);
 // Platform-level comment authorization (instagram: same as production;
 // facebook: only with FLOW_COMMENT_AUTOMATION_ENABLED+FLOW_MULTICHANNEL_ENABLED;
 // whatsapp: never). It still needs a stored comment graph below.
 const switches=commentSwitches();
 const commentPlatformAuthorized=productionActivationAuthorized(
  scope.platform,globalSwitch.data?.enabled,
  tenantSwitch.data?.enabled,tenantSwitch.data?.production_approved,
  {commentTrigger:true,...switches});
 if(!canary&&!production&&!commentPlatformAuthorized)
  return error("Publication activation is disabled",423);

 // `any` as before (the untyped Db row): publicationCanActivate takes it unchanged.
 let publication:{document:any};
 if(input.document!==undefined)publication={document:input.document};
 else{
  const {data:stored,error:publicationError}=await client
   .from("automation_flow_publications").select("document")
   .eq("tenant_id",scope.tenantId).eq("channel_account_id",scope.accountId)
   .eq("platform",scope.platform).eq("flow_key",flowKey)
   .eq("revision",input.rev).maybeSingle();
  if(publicationError)return error("Publication lookup unavailable",503);
  if(!stored)return error("Publication revision not found",404);
  publication=stored;
 }
 // messageScope rules on the STORED document. "conversation_start" must be
 // a message trigger answering immediately (both actions). With
 // FLOW_MESSAGE_SCOPE_REQUIRED==="true" (default OFF) a message trigger must
 // carry its own messageScope to be ACTIVATED; a rollback is exempt so an
 // operator can always restore an older revision published before the rule.
 const scopeProblem=messageScopeActivationProblem(publication.document,
  action==="activate"&&env("FLOW_MESSAGE_SCOPE_REQUIRED")==="true");
 if(scopeProblem!==null)return {ok:false,status:422,body:{ok:false,
  error:MESSAGE_SCOPE_PROBLEM_MESSAGES[scopeProblem],code:scopeProblem}};
 // Advanced activation is independently gated by the operator AFTER the
 // durable ingress and sender have passed real provider integration.
 // This prevents a customer from activating a graph that would fall back
 // to legacy AI or never wake up from its first delay.
 // Explicit operator gates remain independent of browser publication controls.
 const rawDocument:unknown=publication.document;
 const durableGraph=supportedDurableDocument(rawDocument);
 // Flags follow the actual nodes: buttons sender for question/button
 // messages, scheduler for delays (both for mixed graphs, none for text).
 const needs=durableGraph?durableRuntimeNeeds(rawDocument):{buttons:true,scheduler:true};
 // tag/untag/notify/handoff run only through the internal executor.
 const needsInternal=!durableGraph||durableNeedsInternalActions(rawDocument);
 // Image blocks go live only with message:image in the server capability
 // set (FLOW_ACTIVATION_CAPABILITIES) AND FLOW_MEDIA_SEND_ENABLED; PDF never.
 const needsMedia=flowNeedsMedia(rawDocument);
 const mediaAllowed=mediaActivationAllowed(parseCapabilities(env("FLOW_ACTIVATION_CAPABILITIES")),
  env("FLOW_MEDIA_SEND_ENABLED")==="true");
 const durable=production&&scope.platform==="instagram"&&durableGraph&&
  env("FLOW_DURABLE_ACTIVATION_READY")==="true"&&
  env("FLOW_DURABLE_INGRESS_ENABLED")==="true"&&
  env("FLOW_DURABLE_CANARY_ACCOUNT_ID")===scope.accountId&&
  env("FLOW_WORKERS_OPERATOR_RELEASE")==="production-canary-approved"&&
  env("FLOW_OUTBOX_SEND_ENABLED")==="true"&&
  env("FLOW_ATOMIC_CONSUME_READY")==="true"&&
  env("FIELD_ENCRYPTION_KEY").length>0&&
  (!needs.buttons||env("FLOW_RICH_BUTTONS_ENABLED")==="true")&&
  (!needsInternal||env("FLOW_INTERNAL_ACTIONS_ENABLED")==="true")&&
  (!needsMedia||mediaAllowed)&&
  (!needs.scheduler||env("FLOW_DURABLE_SCHEDULER_ENABLED")==="true");
 // Comment automation (20261029300000; FLOW_COMMENT_AUTOMATION_ENABLED,
 // default OFF): the single supported comment graph (commentTrigger.ts
 // commentFlowPlan) under the same operator gates as the durable path.
 // OFF: false, so activation is decided exactly as before.
 // Platform rule lives in productionActivationAuthorized (instagram as
 // before; facebook Page comments also need FLOW_MULTICHANNEL_ENABLED;
 // whatsapp never: no comment surface), fed the stored document's plan.
 const commentGraph=!durableGraph&&switches.commentAutomationEnabled&&
  commentFlowPlan(rawDocument,scope.platform)!==null;
 const commentFlow=commentGraph&&commentPlatformAuthorized&&
  env("FLOW_DURABLE_ACTIVATION_READY")==="true"&&
  env("FLOW_DURABLE_INGRESS_ENABLED")==="true"&&
  env("FLOW_DURABLE_CANARY_ACCOUNT_ID")===scope.accountId&&
  env("FLOW_WORKERS_OPERATOR_RELEASE")==="production-canary-approved"&&
  env("FLOW_OUTBOX_SEND_ENABLED")==="true"&&
  env("FLOW_ATOMIC_CONSUME_READY")==="true"&&
  env("FIELD_ENCRYPTION_KEY").length>0;
 // A comment flow skips the DM gating below; the caller activates it.
 if(commentFlow)return {ok:true};
 // Not a comment flow: DM gating exactly as before (facebook/whatsapp DM
 // flows are never production-authorized; only the test canary remains).
 if(!canary&&!production)
  return error("Publication activation is disabled",423);
 // V2 shape (text-only / condition): text-independent check, so a keyword
 // trigger is accepted only with >= 1 valid keyword (matched at reply time).
 if(!durable){
  if(!simpleFlowDocumentSupported(publication.document,scope.platform))
   return error("This flow uses unsupported runtime features",422);
  // message:image counts only while FLOW_MEDIA_SEND_ENABLED is on.
  // trigger:keyword runs in the same V2 engine as trigger:message (keyword
  // gate before the reply), so a canary set that grants trigger:message
  // grants trigger:keyword too.
  const caps=canary?
   withKeywordTrigger(withMediaGate(parseCapabilities(env("FLOW_ACTIVATION_CAPABILITIES")),env("FLOW_MEDIA_SEND_ENABLED")==="true")):
   new Set<FlowCapability>(["execution-engine","instagram","trigger:message","trigger:keyword","message:text","condition"]);
  if(!publicationCanActivate(publication.document,scope.platform,caps,true))
   return error("This flow uses unsupported runtime features",422);
 }
 return {ok:true};
}
