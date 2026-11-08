/**
 * Future authenticated Edge endpoint for Flow Builder.
 * NOT deployed. Requires owner-approved runtime+publication SQL and an
 * explicit per-function deployment GO. Legacy milan-api is untouched.
 */
import {createClient} from "npm:@supabase/supabase-js@2";
import {
 preparePublishedDocument,publicationCanActivate,testCanaryArmed,productionActivationAuthorized,
 UUID_REGEX,VALID_FLOW_KEY,type ProviderPlatform
} from "../../../src/flow/serverPublicationValidation.ts";
import {flowNeedsMedia,parseCapabilities,mediaActivationAllowed,withMediaGate,
 type FlowCapability} from "../../../src/flow/publicationGate.ts";
import {evaluateFlowReadiness} from "./readiness.ts";
import {simpleMessageFromDocument} from "../milan-api/flowPrepareMessage.ts";
import {supportedDurableDocument,durableCandidateKind,durableRuntimeNeeds,durableNeedsInternalActions,
 type DurableCandidateKind} from "../milan-api/flowDurableIngress.ts";
import {documentCommentTriggerProblem,commentFlowPlan} from "../milan-api/commentTrigger.ts";

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
  const action=request.action;

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
   const readiness=evaluateFlowReadiness({
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
   return respond({ok:true,readiness,candidateRevision:revision??null});
  }

  // Authenticated read-only catalog. Never accepts a tenant ID from the browser.
  // The existing account lookup above already scopes this account to auth.user.
  if(action==="catalog"){
   const [pubs,active]=await Promise.all([
    client.from("automation_flow_publications")
     .select("flow_key,revision")
     .eq("tenant_id",scope.tenantId).eq("channel_account_id",scope.accountId)
     .eq("platform",scope.platform)
     .order("revision",{ascending:false}).limit(500),
    client.from("automation_flow_activations")
     .select("flow_key,revision")
     .eq("tenant_id",scope.tenantId).eq("channel_account_id",scope.accountId)
     .eq("platform",scope.platform).eq("is_active",true).limit(2)
   ]);
   if(pubs.error||active.error)return error("Flow catalog unavailable",503);
   if((active.data??[]).length>1)return error("Conflicting active revisions",409);
   const unique=new Map<string,number>();
   for(const item of pubs.data??[]){
    if(typeof item.flow_key==="string"&&VALID_FLOW_KEY.test(item.flow_key)&&
       !unique.has(item.flow_key))unique.set(item.flow_key,item.revision);
   }
   return respond({ok:true,flows:[...unique].map(([flowKey,latestRevision])=>({
    flowKey,latestRevision
   })),active:active.data?.[0]??null,truncated:(pubs.data??[]).length===500});
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
   const doc=preparePublishedDocument(request.document,scope.platform);
   if(!doc)return error("Flow document is invalid or targets another channel",422);
   // Comment trigger config (scope/post id/match type/keywords/public reply):
   // server-side validation. Other triggers: no new requirement.
   if(documentCommentTriggerProblem(doc)!==null)
    return error("Comment trigger configuration is invalid",422);
   const {data,error:dbError}=await client.rpc("flow_publish_revision",{
    p_tenant_id:scope.tenantId,p_account_id:scope.accountId,
    p_platform:scope.platform,p_flow_key:flowKey,p_actor_id:scope.actorId,
    p_document:doc
   });
   if(dbError){console.error("[flow-publication] publish database error",dbError.code);
    return error("Flow publish is unavailable",503);}
   if(!Number.isSafeInteger(data)||data<1)
    return error("Publishing was rejected",403);
   return respond({ok:true,revision:data,activationChanged:false});
  }

  if(action==="list"){
   const [pubs,act]=await Promise.all([
    client.from("automation_flow_publications")
      .select("revision,created_at,platform")
      .eq("tenant_id",scope.tenantId)
      .eq("channel_account_id",scope.accountId)
      .eq("flow_key",flowKey).order("revision",{ascending:false}).limit(100),
    client.from("automation_flow_activations")
      .select("revision,is_active")
      .eq("tenant_id",scope.tenantId)
      .eq("channel_account_id",scope.accountId)
      .eq("platform",scope.platform)
      .eq("flow_key",flowKey).maybeSingle()
   ]);
   if(pubs.error||act.error)return error("Publication list unavailable",503);
   return respond({ok:true,items:pubs.data??[],activation:act.data??null});
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

   const {data:publication,error:publicationError}=await client
    .from("automation_flow_publications").select("document")
    .eq("tenant_id",scope.tenantId).eq("channel_account_id",scope.accountId)
    .eq("platform",scope.platform).eq("flow_key",flowKey)
    .eq("revision",rev).maybeSingle();
   if(publicationError)return error("Publication lookup unavailable",503);
   if(!publication)return error("Publication revision not found",404);
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
   if(commentFlow){
    const {data:enabled,error:dbError}=await client.rpc("flow_activate_revision",{
     p_tenant_id:scope.tenantId,p_account_id:scope.accountId,
     p_platform:scope.platform,p_flow_key:flowKey,p_revision:rev,p_actor_id:scope.actorId
    });
    if(dbError)return error("Activation unavailable",503);
    if(enabled!==true)return error("Global/tenant switch is OFF",423);
    return respond({ok:true,active:true,revision:rev});
   }
   // Not a comment flow: DM gating exactly as before (facebook/whatsapp DM
   // flows are never production-authorized; only the test canary remains).
   if(!canary&&!production)
    return error("Publication activation is disabled",423);
   if(!durable){
    if(simpleMessageFromDocument(publication.document,scope.platform)===null)
     return error("This flow uses unsupported runtime features",422);
    // message:image counts only while FLOW_MEDIA_SEND_ENABLED is on.
    const caps=canary?
     withMediaGate(parseCapabilities(env("FLOW_ACTIVATION_CAPABILITIES")),env("FLOW_MEDIA_SEND_ENABLED")==="true"):
     new Set<FlowCapability>(["execution-engine","instagram","trigger:message","message:text","condition"]);
    if(!publicationCanActivate(publication.document,scope.platform,caps,true))
     return error("This flow uses unsupported runtime features",422);
   }

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
