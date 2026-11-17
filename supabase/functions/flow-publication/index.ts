/**
 * Future authenticated Edge endpoint for Flow Builder.
 * NOT deployed. Requires owner-approved runtime+publication SQL and an
 * explicit per-function deployment GO. Legacy milan-api is untouched.
 */
import {createClient} from "npm:@supabase/supabase-js@2";
import {
 preparePublishedDocument,productionActivationAuthorized,
 UUID_REGEX,VALID_FLOW_KEY,type ProviderPlatform,
 messageScopeActivationProblem,MESSAGE_SCOPE_PROBLEM_MESSAGES
} from "../../../src/flow/serverPublicationValidation.ts";
import {flowNeedsMedia,parseCapabilities,mediaActivationAllowed} from "../../../src/flow/publicationGate.ts";
import {evaluateFlowReadiness,documentHasCommentTrigger,readinessCandidate} from "./readiness.ts";
import {simpleFlowDocumentSupported} from "../milan-api/flowPrepareMessage.ts";
import {documentKeywordTriggerProblem} from "../milan-api/triggerKeywords.ts";
import {supportedDurableDocument,durableCandidateKind,durableNeedsInternalActions,
 type DurableCandidateKind} from "../milan-api/flowDurableIngress.ts";
import {documentCommentTriggerProblem,commentFlowPlan} from "../milan-api/commentTrigger.ts";
import {listActiveActivations,compareActivationOrder} from "../milan-api/flowInboundSelection.ts";
import {capabilityAvailability} from "./capabilities.ts";
import {aiStepEnabled} from "../flow-outbox-worker/aiStep.ts";
import {evaluateActivationGates} from "./activationGates.ts";
import {deriveRequirements} from "../../../src/flow/requirements.ts";
import {notLiveReason,savedNotLive} from "./publishLive.ts";
import {parseOperatorAllowlist,isOperator,isCustomerAction} from "./operatorAuth.ts";
import type {FlowDocument} from "../../../src/flow/model.ts";

const env=(k:string)=>Deno.env.get(k)??"";
// Only the existing production GitHub Pages origin. Never reflect Origin.
const APPROVED_ORIGIN="https://hsnq2022022-cyber.github.io";
const origins:Record<string,string>={
 "Access-Control-Allow-Origin":APPROVED_ORIGIN,
 "Vary":"Origin",
 "Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info",
 "Access-Control-Allow-Methods":"OPTIONS, POST",
 "Content-Type":"application/json; charset=utf-8",
 "Cache-Control":"no-store",
};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),
 {status,headers:origins});
const error=(message:string,status:number)=>respond({ok:false,error:message},status);
const hasPlatform=(v:unknown):v is ProviderPlatform=>
 v==="facebook"||v==="instagram"||v==="whatsapp";
// Server-only comment automation flags, read fail-closed (absent/not "true" = OFF).
// Facebook comment flows need both; WhatsApp has no comment surface (never).
const commentSwitches=()=>({
 commentAutomationEnabled:env("FLOW_COMMENT_AUTOMATION_ENABLED")==="true",
 multichannelEnabled:env("FLOW_MULTICHANNEL_ENABLED")==="true"
});

/** Canary capability set: trigger:keyword follows trigger:message (same V2 engine). */
export {withKeywordTrigger} from "./activationGates.ts";

/** Clear publish errors for DM keyword trigger problems (triggerKeywords.ts). */
const KEYWORD_PROBLEM_MESSAGES:Record<string,string>={
 keyword_trigger_requires_keywords:"Keyword trigger needs at least one keyword",
 keyword_trigger_invalid_match_mode:"Keyword trigger match mode is invalid",
 keyword_trigger_too_many_keywords:"Keyword trigger has more than 40 keywords",
 keyword_trigger_keyword_too_long:"Keyword trigger keyword is longer than 120 characters"
};

/**
 * Publish validation shared by `publish` and `publish_live` (same checks, same
 * order, same 422 bodies). Keyword trigger configuration is checked on the
 * RAW document first: import sanitizing would otherwise silently turn an
 * unknown mode into "contains". Explicit 422s, never truncation.
 */
function validatePublishDocument(raw:unknown,platform:ProviderPlatform):
 {ok:true;doc:FlowDocument}|{ok:false;response:Response}{
 const fail=(response:Response)=>({ok:false as const,response});
 // messageScope "conversation_start" needs a message trigger whose first
 // step answers immediately (explicit code; checked on the RAW document).
 const rawScopeProblem=messageScopeActivationProblem(raw,false);
 if(rawScopeProblem!==null)return fail(respond({ok:false,
  error:MESSAGE_SCOPE_PROBLEM_MESSAGES[rawScopeProblem],code:rawScopeProblem},422));
 const rawKeywordProblem=documentKeywordTriggerProblem(raw);
 if(rawKeywordProblem!==null)return fail(error(KEYWORD_PROBLEM_MESSAGES[rawKeywordProblem]??
  "Keyword trigger configuration is invalid",422));
 const doc=preparePublishedDocument(raw,platform);
 if(!doc)return fail(error("Flow document is invalid or targets another channel",422));
 // Comment trigger config (scope/post id/match type/keywords/public reply):
 // server-side validation. Other triggers: no new requirement.
 if(documentCommentTriggerProblem(doc)!==null)
  return fail(error("Comment trigger configuration is invalid",422));
 // DM keyword trigger: at least one keyword must survive server parsing
 // (triggerKeywords.ts, same rule as the runtime). Message triggers: unchanged.
 const keywordProblem=documentKeywordTriggerProblem(doc);
 if(keywordProblem!==null)return fail(error(KEYWORD_PROBLEM_MESSAGES[keywordProblem]??
  "Keyword trigger configuration is invalid",422));
 return {ok:true,doc};
}

/** The immutable revision (flow_publish_revision), same args/errors for publish and publish_live. */
async function createRevision(client:{rpc:(name:string,args:Record<string,unknown>)=>any},
 scope:{tenantId:string;accountId:string;platform:ProviderPlatform;actorId:string},
 flowKey:string,doc:FlowDocument):Promise<{ok:true;revision:number}|{ok:false;response:Response}>{
 const {data,error:dbError}=await client.rpc("flow_publish_revision",{
  p_tenant_id:scope.tenantId,p_account_id:scope.accountId,
  p_platform:scope.platform,p_flow_key:flowKey,p_actor_id:scope.actorId,
  p_document:doc
 });
 if(dbError){console.error("[flow-publication] publish database error",dbError.code);
  return {ok:false,response:error("Flow publish is unavailable",503)};}
 if(!Number.isSafeInteger(data)||data<1)
  return {ok:false,response:error("Publishing was rejected",403)};
 return {ok:true,revision:data};
}

const MAX_BODY_BYTES=4*1024*1024+4096;
const MAX_BEARER_BYTES=8192;

export async function handleFlowPublication(req:Request,
 clientFactory:typeof createClient=createClient):Promise<Response>{
 // Same-origin policy is explicit; anonymous clients and foreign browser
 // origins cannot use this privileged publishing endpoint.
 if(req.headers.get("origin")!==APPROVED_ORIGIN)
  return new Response(JSON.stringify({ok:false,error:"Origin not allowed"}),{
   status:403,headers:{"Content-Type":"application/json; charset=utf-8","Vary":"Origin"}});
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:origins});
 if(req.method!=="POST")return error("Method not allowed",405);

 const rawBearer=req.headers.get("authorization")??"";
 if(!rawBearer.startsWith("Bearer ")||
    rawBearer.length>MAX_BEARER_BYTES)return error("Not authenticated",401);

 const serviceKey=env("SUPABASE_SERVICE_ROLE_KEY");
 const supabaseUrl=env("SUPABASE_URL");
 if(!serviceKey||!supabaseUrl)return error("Service not configured",503);

 let request:Record<string,unknown>;
 try{
  const declared=Number(req.headers.get("content-length")??0);
  if(Number.isFinite(declared)&&declared>MAX_BODY_BYTES)
   return error("Request too large",413);
  if(!req.body)return error("Invalid JSON payload",400);
  const chunks:Uint8Array[]=[];
  let byteCount=0;
  const reader=req.body.getReader();
  try{
   while(true){
    const {value,done}=await reader.read();
    if(done)break;
    if(value){
     byteCount+=value.byteLength;
     if(byteCount>MAX_BODY_BYTES){
      await reader.cancel();
      return error("Request too large",413);
     }
     chunks.push(value);
    }
   }
  }finally{reader.releaseLock();}
  const data=new Uint8Array(byteCount);
  let offset=0;
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  const raw=new TextDecoder("utf-8",{fatal:true}).decode(data);
  const decoded:unknown=JSON.parse(raw);
  if(!decoded||typeof decoded!=="object"||Array.isArray(decoded))
   return error("Invalid JSON payload",400);
  request=decoded as Record<string,unknown>;
 }catch{return error("Invalid JSON payload",400);}

 const client=clientFactory(supabaseUrl,serviceKey,{
  auth:{persistSession:false,autoRefreshToken:false}
 });
 try{
  const {data:auth,error:authError}=await client.auth.getUser(rawBearer.slice(7));
  if(authError||!auth.user)return error("Not authenticated",401);
  const {data:tenant,error:tenantError}=await client
   .from("tenants").select("id,user_id,is_active")
   .eq("user_id",auth.user.id).maybeSingle();
  if(tenantError||!tenant||tenant.user_id!==auth.user.id||
     !UUID_REGEX.test(tenant.id))return error("Tenant not authorized",403);

  // Transactional, per-tenant UTC-minute limiter in PostgreSQL, never an
  // in-memory Deno map: one budget shared by all Edge instances.
  const {data:rateAllowed,error:rateError}=await client.rpc(
   "flow_publication_rate_allow",{p_tenant_id:tenant.id});
  if(rateError)return error("Rate limiter unavailable",503);
  if(rateAllowed!==true)
   return new Response(JSON.stringify({ok:false,error:"Rate limit exceeded"}),{
    status:429,headers:{...origins,
     "Retry-After":String(60-Math.floor(Date.now()/1000)%60)}});

  const action=request.action;
  // Operator allowlist (operatorAuth.ts), default deny: every action that is
  // not an explicit customer action needs the verified auth user id on
  // FLOW_OPERATOR_USER_IDS, parsed on every request. Checked before any
  // account lookup (no account-ownership oracle). One generic 403 for "not
  // listed" and "list missing/invalid"; never log ids, counts or the raw value.
  // Operators get NO cross-tenant access: the tenant scope above is unchanged.
  const customerAction=isCustomerAction(action);
  if(!customerAction||action==="operator_status"){
   const allowlist=parseOperatorAllowlist(env("FLOW_OPERATOR_USER_IDS"));
   if(!allowlist.ok)console.error("[flow-publication] operator_allowlist_unavailable");
   const operator=isOperator(auth.user.id,allowlist);
   if(action==="operator_status")return respond({ok:true,operator});
   if(!operator)return error("Operator access required",403);
  }

  // Only the authenticated tenant's accounts are ever returned.
  if(request.action==="accounts"){
   const [accounts,globalSwitch,tenantSwitch]=await Promise.all([
    client.from("channel_accounts")
     .select("id,platform,is_active,agent_enabled,auto_reply")
     .eq("tenant_id",tenant.id).limit(100),
    client.from("automation_flow_global_switch").select("enabled")
     .eq("singleton",true).maybeSingle(),
    client.from("automation_flow_tenant_switches")
     .select("enabled,production_approved").eq("tenant_id",tenant.id).maybeSingle()
   ]);
   if(accounts.error||globalSwitch.error||tenantSwitch.error)
    return error("Account list unavailable",503);
   const switches=commentSwitches();
   const visible=(accounts.data??[]).filter((a:{platform:unknown})=>hasPlatform(a.platform))
    .map((a:{id:string;platform:ProviderPlatform;is_active:boolean;agent_enabled:boolean;auto_reply:boolean})=>{
      const accountReady=tenant.is_active===true&&a.is_active===true&&
       a.agent_enabled===true&&a.auto_reply===true;
      return {
       id:a.id,platform:a.platform,is_active:a.is_active,
       // Unchanged: DM (any flow) activation for this account.
       canActivate:accountReady&&
        productionActivationAuthorized(a.platform,globalSwitch.data?.enabled,
         tenantSwitch.data?.enabled,tenantSwitch.data?.production_approved),
       // UI hint only: a comment-trigger flow could be activated on this
       // account. The activate action re-derives it from the stored document.
       canActivateComments:accountReady&&
        productionActivationAuthorized(a.platform,globalSwitch.data?.enabled,
         tenantSwitch.data?.enabled,tenantSwitch.data?.production_approved,
         {commentTrigger:true,...switches})
      };
    });
   return respond({ok:true,accounts:visible});
  }

  const accountId=request.accountId;
  const flowKey=request.flowKey;
  if(typeof accountId!=="string"||!UUID_REGEX.test(accountId)||
     typeof flowKey!=="string"||!VALID_FLOW_KEY.test(flowKey))
   return error("Invalid account or flow identifier",400);

  const {data:account,error:accountError}=await client
   .from("channel_accounts")
   .select("id,tenant_id,platform,is_active,agent_enabled,auto_reply")
   .eq("id",accountId).eq("tenant_id",tenant.id).maybeSingle();
  if(accountError||!account||account.tenant_id!==tenant.id||
     !hasPlatform(account.platform))return error("Account not authorized",403);

  const scope={tenantId:tenant.id,accountId,platform:account.platform,
    actorId:auth.user.id};

  // Account-scoped, read-only capability availability for the editor. The same
  // gate inputs as the activate action below; only booleans and stable reason
  // codes leave the server (never env names/values, never other ids). Any read
  // error fails closed (503, nothing reported as available). Never mutates.
  if(action==="capabilities"){
   const [globalSwitch,tenantSwitch]=await Promise.all([
    client.from("automation_flow_global_switch").select("enabled")
     .eq("singleton",true).maybeSingle(),
    client.from("automation_flow_tenant_switches")
     .select("enabled,production_approved").eq("tenant_id",scope.tenantId).maybeSingle()
   ]);
   if(globalSwitch.error||tenantSwitch.error)return error("Capabilities unavailable",503);
   const switches=commentSwitches();
   const report=capabilityAvailability({platform:scope.platform,
    tenantActive:tenant.is_active===true,accountActive:account.is_active===true,
    agentEnabled:account.agent_enabled===true,autoReply:account.auto_reply===true,
    globalEnabled:globalSwitch.data?.enabled===true,tenantEnabled:tenantSwitch.data?.enabled===true,
    productionApproved:tenantSwitch.data?.production_approved===true,
    activationReady:env("FLOW_DURABLE_ACTIVATION_READY")==="true",
    durableIngress:env("FLOW_DURABLE_INGRESS_ENABLED")==="true",
    canaryMatched:env("FLOW_DURABLE_CANARY_ACCOUNT_ID")===scope.accountId,
    operatorReleased:env("FLOW_WORKERS_OPERATOR_RELEASE")==="production-canary-approved",
    outboxEnabled:env("FLOW_OUTBOX_SEND_ENABLED")==="true",
    atomicDebitReady:env("FLOW_ATOMIC_CONSUME_READY")==="true",
    encryptionConfigured:env("FIELD_ENCRYPTION_KEY").length>0,
    richButtons:env("FLOW_RICH_BUTTONS_ENABLED")==="true",
    scheduler:env("FLOW_DURABLE_SCHEDULER_ENABLED")==="true",
    internalActions:env("FLOW_INTERNAL_ACTIONS_ENABLED")==="true",
    mediaAllowed:mediaActivationAllowed(parseCapabilities(env("FLOW_ACTIVATION_CAPABILITIES")),
     env("FLOW_MEDIA_SEND_ENABLED")==="true"),
    aiStep:aiStepEnabled(env),
    commentAutomation:switches.commentAutomationEnabled,multichannel:switches.multichannelEnabled});
   return respond({ok:true,platform:scope.platform,capabilities:report.capabilities,canPublish:report.canPublish});
  }

  // Account-scoped, read-only release preflight. Never returns secret values,
  // alters an activation, claims a message, or dispatches an Outbox item.
  if(action==="readiness"){
   const requestedRevision=request.revision;
   if(requestedRevision!==undefined&&
      (typeof requestedRevision!=="number"||
       !Number.isSafeInteger(requestedRevision)||requestedRevision<1))
    return error("Invalid revision",400);
   const [global,tenantFlags,activated,credit]=await Promise.all([
    client.from("automation_flow_global_switch")
     .select("enabled").eq("singleton",true).maybeSingle(),
    client.from("automation_flow_tenant_switches")
     .select("enabled,production_approved").eq("tenant_id",scope.tenantId).maybeSingle(),
    client.from("automation_flow_activations")
     .select("revision").eq("tenant_id",scope.tenantId)
     .eq("channel_account_id",scope.accountId).eq("platform",scope.platform)
     .eq("flow_key",flowKey).eq("is_active",true).limit(2),
    client.from("tenants").select("credits_remaining").eq("id",scope.tenantId).maybeSingle()
   ]);
   if(global.error||tenantFlags.error||activated.error||credit.error)
    return error("Readiness check unavailable",503);
   if((activated.data??[]).length>1)return error("Conflicting active revisions",409);
   const revision=requestedRevision??activated.data?.[0]?.revision;
   const candidate=typeof revision==="number"?
    await client.from("automation_flow_publications").select("document")
     .eq("tenant_id",scope.tenantId).eq("channel_account_id",scope.accountId)
     .eq("platform",scope.platform).eq("flow_key",flowKey)
     .eq("revision",revision).maybeSingle():null;
   if(candidate?.error)return error("Candidate revision unavailable",503);
   const published:unknown=candidate?.data?.document;
   // Same whitelist and flag needs as the live ingress and the activation guard.
   const supported=supportedDurableDocument(published);
   const candidateKind:DurableCandidateKind=supported?durableCandidateKind(published):"unsupported";
   // Comment-trigger documents (never durable DM graphs): the same plan and
   // server-env flags (fail-closed) the activate action's comment path uses.
   const comment=!supported&&documentHasCommentTrigger(published)?{
    planValid:commentFlowPlan(published,scope.platform)!==null,...commentSwitches()}:undefined;
   const evaluated=evaluateFlowReadiness({
    comment,
    platform:scope.platform,candidateKind,tenantActive:tenant.is_active===true,
    accountActive:account.is_active===true,
    agentEnabled:account.agent_enabled===true,autoReply:account.auto_reply===true,
    globalEnabled:global.data?.enabled===true,
    tenantEnabled:tenantFlags.data?.enabled===true,
    productionApproved:tenantFlags.data?.production_approved===true,
    creditsAvailable:typeof credit.data?.credits_remaining==="number"&&
     credit.data.credits_remaining>0,
    activePublication:(activated.data??[]).length===1,
    durableIngress:env("FLOW_DURABLE_INGRESS_ENABLED")==="true",
    activationApproved:env("FLOW_DURABLE_ACTIVATION_READY")==="true",
    canaryMatched:env("FLOW_DURABLE_CANARY_ACCOUNT_ID")===scope.accountId,
    operatorReleased:env("FLOW_WORKERS_OPERATOR_RELEASE")==="production-canary-approved",
    schedulerEnabled:env("FLOW_DURABLE_SCHEDULER_ENABLED")==="true",
    outboxEnabled:env("FLOW_OUTBOX_SEND_ENABLED")==="true",
    atomicDebitReady:env("FLOW_ATOMIC_CONSUME_READY")==="true",
    richButtonsEnabled:env("FLOW_RICH_BUTTONS_ENABLED")==="true",
    encryptionConfigured:env("FIELD_ENCRYPTION_KEY").length>0,
    // tag/untag/notify/handoff nodes need the internal executor flag.
    needsInternalActions:supported&&durableNeedsInternalActions(published),
    internalActionsEnabled:env("FLOW_INTERNAL_ACTIONS_ENABLED")==="true",
    // Image blocks: message:image in the server capability set AND the media flag.
    needsMedia:supported&&flowNeedsMedia(published),
    mediaEnabled:mediaActivationAllowed(parseCapabilities(env("FLOW_ACTIVATION_CAPABILITIES")),
     env("FLOW_MEDIA_SEND_ENABLED")==="true")
   });
   // Additive diagnostics (checks/candidateKind/configured are unchanged and
   // stay fail-closed): WHICH flow and revision were examined and WHY
   // activeRevision/supportedCandidate are false. No fallback: only the
   // requested revision, else the flow's own active one, else nothing.
   const activeRow=activated.data?.[0]?.revision;
   const readiness={...evaluated,candidate:readinessCandidate({flowKey,
    requested:requestedRevision!==undefined,revision:typeof revision==="number"?revision:null,
    activeRevision:typeof activeRow==="number"?activeRow:null,activeCheck:evaluated.checks.activeRevision,
    found:published!==undefined&&published!==null,durable:supported,
    v2:simpleFlowDocumentSupported(published,scope.platform),commentDocument:comment!==undefined,
    candidateKind:evaluated.candidateKind})};
   return respond({ok:true,readiness,candidateRevision:revision??null});
  }

  // Authenticated read-only catalog. Never accepts a tenant ID from the browser.
  // The existing account lookup above already scopes this account to auth.user.
  // Several flows may be active on one account (each flow_key independently):
  // `activeFlows` lists ALL of them, each with its own active revision, in
  // activation order (earliest activated_at, NULL last, then flow_key; see
  // flowInboundSelection.ts compareActivationOrder). The legacy single
  // `active` stays populated for the already deployed client: the FIRST of
  // that order (deterministic), null when none. No 409 for several actives.
  if(action==="catalog"){
   const [pubs,active]=await Promise.all([
    client.from("automation_flow_publications")
     .select("flow_key,revision")
     .eq("tenant_id",scope.tenantId).eq("channel_account_id",scope.accountId)
     .eq("platform",scope.platform)
     .order("revision",{ascending:false}).limit(500),
    listActiveActivations(client,scope)
   ]);
   if(pubs.error||active===null)return error("Flow catalog unavailable",503);
   const unique=new Map<string,number>();
   for(const item of pubs.data??[]){
    if(typeof item.flow_key==="string"&&VALID_FLOW_KEY.test(item.flow_key)&&
       !unique.has(item.flow_key))unique.set(item.flow_key,item.revision);
   }
   const activeFlows=[...active].sort(compareActivationOrder)
    .map(a=>({flow_key:a.flowKey,revision:a.revision}));
   return respond({ok:true,flows:[...unique].map(([flowKey,latestRevision])=>({
    flowKey,latestRevision
   })),activeFlows,active:activeFlows[0]??null,truncated:(pubs.data??[]).length===500});
  }

  // Read only an immutable revision owned by the signed-in account.
  // Import into the editor is always explicit and makes a NEW local copy.
  if(action==="read"){
   const revision=request.revision;
   if(typeof revision!=="number"||!Number.isSafeInteger(revision)||revision<1)
    return error("Invalid revision",400);
   const {data:publication,error:readError}=await client
    .from("automation_flow_publications").select("document")
    .eq("tenant_id",scope.tenantId).eq("channel_account_id",scope.accountId)
    .eq("platform",scope.platform).eq("flow_key",flowKey)
    .eq("revision",revision).maybeSingle();
   if(readError)return error("Publication read unavailable",503);
   if(!publication)return error("Publication not found",404);
   return respond({ok:true,revision,document:publication.document});
  }

  if(action==="publish"){
   if(tenant.is_active!==true||account.is_active!==true)
    return error("Account is disabled",403);
   const prepared=validatePublishDocument(request.document,scope.platform);
   if(!prepared.ok)return prepared.response;
   const created=await createRevision(client,scope,flowKey,prepared.doc);
   if(!created.ok)return created.response;
   return respond({ok:true,revision:created.revision,activationChanged:false});
  }

  // One call: validate (exactly as publish) -> derive requirements -> every
  // activation gate on the prepared document -> create the immutable revision
  // -> activate THAT exact revision. Gate blocked / activation not confirmed:
  // the revision stays saved and the answer is saved_not_live (never "live").
  // Validation or revision-creation failure: publish's errors, nothing saved.
  if(action==="publish_live"){
   if(tenant.is_active!==true||account.is_active!==true)
    return error("Account is disabled",403);
   const prepared=validatePublishDocument(request.document,scope.platform);
   if(!prepared.ok)return prepared.response;
   const doc=prepared.doc;
   // Phase 1 derivation: a block no live engine runs can never go live.
   const unsupported=deriveRequirements(doc,scope.platform).required.includes("unsupported_block");
   const gate=await evaluateActivationGates({client,env,commentSwitches,
    scope,tenant,account,flowKey,document:doc,action:"activate"});
   const created=await createRevision(client,scope,flowKey,doc);
   if(!created.ok)return created.response;
   const revision=created.revision;
   if(!gate.ok||unsupported)
    return respond(savedNotLive(revision,notLiveReason(gate.ok?null:gate,unsupported)));
   try{
    const {data:enabled,error:dbError}=await client.rpc("flow_activate_revision",{
     p_tenant_id:scope.tenantId,p_account_id:scope.accountId,
     p_platform:scope.platform,p_flow_key:flowKey,p_revision:revision,p_actor_id:scope.actorId
    });
    if(dbError)return respond(savedNotLive(revision,"unavailable"));
    if(enabled!==true)return respond(savedNotLive(revision,"switch_off"));
   }catch{return respond(savedNotLive(revision,"unavailable"));}
   return respond({ok:true,status:"live",revision});
  }

  if(action==="list"){
   const [pubs,act]=await Promise.all([
    client.from("automation_flow_publications")
      .select("revision,created_at,platform")
      .eq("tenant_id",scope.tenantId)
      .eq("channel_account_id",scope.accountId).eq("platform",scope.platform)
      .eq("flow_key",flowKey).order("revision",{ascending:false}).limit(100),
    client.from("automation_flow_activations")
      .select("revision,is_active")
      .eq("tenant_id",scope.tenantId)
      .eq("channel_account_id",scope.accountId)
      .eq("platform",scope.platform)
      .eq("flow_key",flowKey).maybeSingle()
   ]);
   if(pubs.error||act.error)return error("Publication list unavailable",503);
   // truncated: additive, older revisions beyond the newest 100 are not listed.
   return respond({ok:true,items:pubs.data??[],activation:act.data??null,
    truncated:(pubs.data??[]).length===100});
  }

  if(action==="deactivate"){
   const {data,error:dbError}=await client.rpc("flow_deactivate_revision",{
    p_tenant_id:scope.tenantId,p_account_id:scope.accountId,
    p_platform:scope.platform,p_flow_key:flowKey,p_actor_id:scope.actorId
   });
   if(dbError)return error("Deactivation unavailable",503);
   return data===true ? respond({ok:true,active:false}) :
    error("No active publication found",404);
  }

  if(action==="activate"||action==="rollback"){
   const rev=request.revision;
   if(typeof rev!=="number"||!Number.isSafeInteger(rev)||rev<1)
    return error("Invalid revision",400);
   // Every activation gate (account paused, canary/production/comment
   // authorization, stored revision, messageScope, durable/comment operator
   // flags, V2 capabilities) lives in activationGates.ts, same order and
   // results. Comment flows and DM flows that pass end in the same RPC.
   const gate=await evaluateActivationGates({client,env,commentSwitches,
    scope,tenant,account,flowKey,rev,action});
   if(!gate.ok)return respond(gate.body,gate.status);

   const {data:enabled,error:dbError}=await client.rpc("flow_activate_revision",{
    p_tenant_id:scope.tenantId,p_account_id:scope.accountId,
    p_platform:scope.platform,p_flow_key:flowKey,p_revision:rev,p_actor_id:scope.actorId
   });
   if(dbError)return error("Activation unavailable",503);
   if(enabled!==true)return error("Global/tenant switch is OFF",423);
   return respond({ok:true,active:true,revision:rev});
  }
  return error("Unknown action",400);
 }catch(e){
  console.error("[flow-publication] unexpected error",
    e instanceof Error?e.name:"unknown");
  return error("Service temporarily unavailable",503);
 }
}

if(import.meta.main)Deno.serve((req)=>handleFlowPublication(req));
