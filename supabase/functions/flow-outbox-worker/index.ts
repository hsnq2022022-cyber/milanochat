/**
 * REVIEW-ONLY source. NOT deployed or scheduled.
 * Effect dispatcher: text messages only. Internal effects (tags, staff
 * notifications, handoff) are executed afterwards by the separate executor
 * flow-internal-worker/internalEffects.ts (FLOW_INTERNAL_ACTIONS_ENABLED),
 * never sent or billed. Never resend uncertain effects.
 *
 * Necessary server-side gates (ALL default OFF):
 * FLOW_OUTBOX_SEND_ENABLED, FLOW_ATOMIC_CONSUME_READY, global and tenant test_only,
 * activated publication, account permission, no human takeover, positive credit.
 *
 * message_image effects (Instagram image attachment) additionally need
 * FLOW_MEDIA_SEND_ENABLED (default OFF; see mediaPolicy.ts). DO NOT ENABLE
 * before the operator GO and before 20261029210000_flow_media_effects is
 * applied (CHECK, flow_commit_run_step, flow_reserve_outbox_delivery and the
 * 'rejected' -> dead_letter outcome of flow_finish_outbox_delivery).
 */
import {createClient} from "npm:@supabase/supabase-js@2";
import {acceptsFlowWorkerBearer} from "../flowWorkerAuth.ts";
import {sendProviderMessage,decryptAccountToken,encryptMessageBody,deliveredText} from "./deliveryCore.ts";
import {answerWithVerifiedKnowledgeOutcome,knowledgeQuestionValid,openAIKnowledgeDependencies}
 from "./flowKnowledge.ts";
import {resolveKnowledgeEffect,recoverKnowledgeCharge,AI_MAX_ATTEMPTS,AI_CLAIM_LEASE_SECONDS,
 AI_ANSWER_MISSING_CODE,BILLING_BLOCKED_ANSWER_MISSING,type AiClaim} from "./knowledgeRetry.ts";
import {executeOnce} from "./executeOnce.ts";
import {canDispatchOutbox} from "./productionGate.ts";
import {confirmedOutboxMid,matchesPreviouslyPersistedReply} from "./confirmedSettlement.ts";
import {permanentOutboxBlock,temporaryOutboxPause,humanTakeoverActive,OUTBOX_SCAN_LIMIT,
 OUTBOX_DISPATCH_LIMIT,OUTBOX_STALE_MINUTES,type OutboxSkipReason} from "./skipPolicy.ts";
import {compareOutbox,heldByEarlierEffect,statusAfterOutcome,ORDERED_KINDS,
 ORDER_SIBLING_LIMIT,type OrderRow} from "./effectOrder.ts";
import {plainInputQuestion} from "./questionMode.ts";
import {instagramButtonTemplateProblem} from "./flowRichActions.ts";
import {sendMultichannelMessage,multichannelPayloadProblem,classifyMultichannelFailure,
 type MultichannelFailure} from "./multichannelSend.ts";
import {mediaEffectGate,classifyMediaFailure,finishOutcome,type MediaFailure,type FinishOutcome}
 from "./mediaPolicy.ts";
import {runInternalEffects,internalActionsReleased} from "../flow-internal-worker/internalEffects.ts";

const env=(name:string)=>Deno.env.get(name)??"";
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),
 {status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const blocked=()=>json({status:"disabled",sends:0},423);
const allowedChannel=(p:string):p is "instagram"|"facebook"|"whatsapp"=>
 ["instagram","facebook","whatsapp"].includes(p);
Deno.serve(async req=>{
 if(req.method!=="POST")return json({error:"Method not allowed"},405);
 // Do not rely on a public Bearer supplied by a browser.
 const secret=env("SUPABASE_SERVICE_ROLE_KEY");
 const cronKey=env("flow_worker_service_role_key");
 if(!acceptsFlowWorkerBearer(req.headers.get("authorization"),secret,cronKey))
  return json({error:"Unauthorized"},401);
 // A separate fail-closed rollout gate prevents existing Cron from sending
 // or charging after this authentication fix is deployed.
 if(env("FLOW_WORKERS_OPERATOR_RELEASE")!=="production-canary-approved")return blocked();
 if(env("FLOW_OUTBOX_SEND_ENABLED")!=="true"||
    env("FLOW_ATOMIC_CONSUME_READY")!=="true")return blocked();
 const base=env("SUPABASE_URL"),fieldKey=env("FIELD_ENCRYPTION_KEY");
 if(!base||!fieldKey)return json({error:"Service configuration unavailable"},503);
 let input:unknown;
 try{input=await req.json();}catch{return json({error:"Bad JSON"},400);}
 if(!input||typeof input!=="object"||
    (input as Record<string,unknown>).mode!=="tick")return json({error:"Invalid mode"},400);
 const sb=createClient(base,secret,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:g,error:ge}=await sb.from("automation_flow_global_switch")
  .select("enabled").eq("singleton",true).single();
 if(ge||g?.enabled!==true)return blocked();
 // Cancel stale effects and effects whose run ended, whose revision is inactive
 // or whose conversation is under human takeover BEFORE listing, so they are
 // never sent later. Fail closed: without this sweep a stale message could be
 // delivered after a takeover ends.
 const {error:sweepError}=await sb.rpc("flow_skip_blocked_outbox",{
  p_max_age_minutes:OUTBOX_STALE_MINUTES,p_limit:200
 });
 if(sweepError){
  console.error("[outbox] stale sweep failed",{code:sweepError.code});
  return json({error:"Outbox lifecycle unavailable",sends:0},503);
 }
 const OUTBOX_COLUMNS="id,tenant_id,run_id,delivery_status,effect_kind,payload,outgoing_message_id,provider_message_id,created_at";
 const {data:listed,error:listError}=await sb.from("automation_flow_outbox")
  .select(OUTBOX_COLUMNS)
  .in("delivery_status",["pending","charge_pending"]).in("effect_kind",["message","question","message_image"])
  .order("created_at",{ascending:true}).limit(OUTBOX_SCAN_LIMIT);
 if(listError)return json({error:"Outbox lookup failed"},503);
 // retry_wait rows (knowledge_ai backoff) are read only once retry_at is due,
 // in a separate bounded query: a backed-off effect never occupies a scan slot
 // of newer effects. A failure here only delays retries; it never sends.
 const {data:dueRetries,error:retryListError}=await sb.from("automation_flow_outbox")
  .select(OUTBOX_COLUMNS)
  .eq("delivery_status","retry_wait").lte("retry_at",new Date().toISOString())
  .in("effect_kind",["message","question"])
  .order("retry_at",{ascending:true}).limit(OUTBOX_DISPATCH_LIMIT);
 if(retryListError)console.error("[outbox] retry lookup failed",{code:retryListError.code});
 const seen=new Set<string>();
 const items=[...(listed??[]),...(retryListError?[]:dueRetries??[])]
  .filter(e=>!seen.has(e.id)&&!!seen.add(e.id))
  .sort(compareOutbox);
 // Per-run order (effectOrder.ts): ONE tenant-scoped query per tenant per tick
 // loads every provider effect of the candidate runs. Lookup error or a
 // truncated result holds that tenant's effects this tick (fail closed).
 const siblingsByTenant=new Map<string,OrderRow[]|null>();
 for(const tenantId of new Set(items.map(e=>String(e.tenant_id)))){
  const runIds=[...new Set(items.filter(e=>e.tenant_id===tenantId).map(e=>String(e.run_id)))];
  const {data:siblings,error:siblingError}=await sb.from("automation_flow_outbox")
   .select("id,tenant_id,run_id,delivery_status,effect_kind,payload,created_at")
   .eq("tenant_id",tenantId).in("run_id",runIds).in("effect_kind",ORDERED_KINDS)
   .limit(ORDER_SIBLING_LIMIT);
  if(siblingError)console.error("[outbox] order lookup failed",{code:siblingError.code});
  siblingsByTenant.set(tenantId,siblingError||!Array.isArray(siblings)||
   siblings.length>=ORDER_SIBLING_LIMIT?null:
   (siblings as OrderRow[]).filter(r=>r.tenant_id===tenantId));
 }
 // Status changes made during this tick (sent/cancelled/uncertain) so a later
 // seq of the same run can follow in the same tick.
 const localStatus=new Map<string,string>();
 const outcomes:Record<string,number>={};
 // Scan more rows than are dispatched: rows still waiting on an operator gate
 // (paused tenant, approval, credit, flags) must not starve newer effects.
 let dispatched=0;
 for(const effect of items??[]){
  if(dispatched>=OUTBOX_DISPATCH_LIMIT)break;
  const report=(key:string)=>{
   const after=statusAfterOutcome(key);
   if(after)localStatus.set(effect.id,after);
   return outcomes[key]=(outcomes[key]??0)+1;
  };
  const siblings=siblingsByTenant.get(String(effect.tenant_id));
  if(!siblings){report("blocked_order");continue;}
  if(heldByEarlierEffect(effect as OrderRow,siblings,localStatus)){report("held_order");continue;}
  // Permanently unsendable: mark cancelled (tenant-scoped, pending rows only)
  // so it is never sent later. In-flight/charge_pending rows are never touched.
  const skip=async(reason:OutboxSkipReason,fallback="blocked")=>{
   // retry_wait = not yet sent (AI backoff); leased/charge_pending never skipped.
   if(effect.delivery_status!=="pending"&&effect.delivery_status!=="retry_wait"){
    report(fallback);return;
   }
   const {data:skipped,error:skipError}=await sb.rpc("flow_skip_outbox_effect",{
    p_tenant:effect.tenant_id,p_outbox:effect.id,p_reason:reason
   });
   if(skipError)console.error("[outbox] skip failed",{code:skipError.code,id:effect.id});
   report(!skipError&&skipped===true?"skipped_"+reason:fallback);
  };
  try{
   const {data:tenant,error:tenantError}=await sb.from("tenants")
    .select("id,business_name,is_active,credits_remaining")
    .eq("id",effect.tenant_id).maybeSingle();
   const {data:sw,error:switchError}=await sb.from("automation_flow_tenant_switches")
    .select("enabled,test_only,production_approved").eq("tenant_id",effect.tenant_id).maybeSingle();
   const {data:run,error:runError}=await sb.from("automation_flow_runs").select("*")
    .eq("id",effect.run_id).eq("tenant_id",effect.tenant_id).maybeSingle();
   if(tenantError||switchError||runError){report("blocked");continue;}
   // Missing tenant/run is permanent. An inactive tenant is a TEMPORARY pause
   // (classified below): the effect stays pending, bounded by the stale sweep.
   if(!tenant||!run){await skip("ineligible");continue;}
   // Paused tenant: stays pending (bounded by the stale sweep), not cancelled.
   if(!sw?.enabled){report("blocked");continue;}
   const [accountResult,conversationResult,activationResult]=await Promise.all([
    sb.from("channel_accounts").select("id,tenant_id,platform,is_active,agent_enabled,auto_reply,external_id,access_token_encrypted")
      .eq("tenant_id",effect.tenant_id).eq("id",run.channel_account_id).maybeSingle(),
    // human_agent_expires_at is the canonical takeover expiry (milan-api,
    // human_agent_migration.sql); selecting a missing column fails the query.
    sb.from("conversations").select("id,tenant_id,account_id,wa_chat_id,transferred,auto_paused_reason,human_agent_expires_at")
      .eq("tenant_id",effect.tenant_id).eq("id",run.conversation_id).maybeSingle(),
    sb.from("automation_flow_activations").select("revision,is_active")
      .eq("tenant_id",effect.tenant_id)
      .eq("channel_account_id",run.channel_account_id)
      .eq("platform",run.platform).eq("flow_key",run.flow_key)
      .eq("revision",run.publication_revision)
      .eq("is_active",true).maybeSingle()
   ]);
   const account=accountResult.data,conversation=conversationResult.data;
   if(accountResult.error||conversationResult.error||activationResult.error){
    report("blocked");continue;
   }
   const permanent=permanentOutboxBlock({
    tenantFound:true,tenantActive:tenant.is_active,runFound:true,
    accountFound:!!account,conversationFound:!!conversation,
    accountTenantMatches:account?.tenant_id===tenant.id,
    conversationTenantMatches:conversation?.tenant_id===tenant.id,
    accountPlatformMatchesRun:account?.platform===run.platform,
    conversationAccountMatches:!!account&&conversation?.account_id===account.id,
    accountActive:account?.is_active,agentEnabled:account?.agent_enabled,
    autoReply:account?.auto_reply,allowedChannel:allowedChannel(String(account?.platform??"")),
    humanTransferred:conversation?.transferred,
    humanAgentExpiresAt:conversation?.human_agent_expires_at,
    humanPausedReason:conversation?.auto_paused_reason,
    revisionActive:activationResult.data?.is_active
   },Date.now());
   if(permanent){await skip(permanent);continue;}
   // auto_reply/agent_enabled off or tenant/account inactive: keep pending
   // (resumes when re-enabled; flow_skip_blocked_outbox cancels it as 'stale'
   // after OUTBOX_STALE_MINUTES). Never cancelled here.
   const pause=temporaryOutboxPause({tenantActive:tenant.is_active,
    accountActive:account?.is_active,agentEnabled:account?.agent_enabled,
    autoReply:account?.auto_reply});
   if(pause){report("paused_"+pause);continue;}
   const takeover=humanTakeoverActive(conversation?.transferred,
    conversation?.human_agent_expires_at,conversation?.auto_paused_reason,Date.now());
   // Defense in depth: the original full gate still decides every dispatch.
   if(!account||!conversation||
      account.tenant_id!==tenant.id||conversation.tenant_id!==tenant.id||
      account.platform!==run.platform||
      conversation.account_id!==account.id||account.is_active!==true||
      account.agent_enabled!==true||account.auto_reply!==true||
      !allowedChannel(String(account.platform))||
      takeover||
      !canDispatchOutbox({
       globalEnabled:g?.enabled,tenantEnabled:sw?.enabled,
       testOnly:sw?.test_only,productionApproved:sw?.production_approved,
       platform:account.platform,accountId:account.id,
       canaryAccountId:env("FLOW_DURABLE_CANARY_ACCOUNT_ID"),
       accountActive:account.is_active,
       agentEnabled:account.agent_enabled,autoReply:account.auto_reply,
       tenantActive:tenant.is_active,credits:tenant.credits_remaining,
       revisionActive:activationResult.data?.is_active,
       humanTakeover:takeover,
       multichannelEnabled:env("FLOW_MULTICHANNEL_ENABLED")==="true"
      })){
    report("blocked");continue;
   }
   const recipientRaw=String(conversation.wa_chat_id??"");
   const expectedPrefix=account.platform==="facebook"?"facebook":account.platform;
   if(!recipientRaw.startsWith(expectedPrefix+":")){await skip("ineligible");continue;}
   const recipient=recipientRaw.slice(expectedPrefix.length+1);
   // FLOW_MULTICHANNEL_ENABLED (default OFF): WhatsApp/Facebook effects use the
   // separate multichannelSend.ts senders. OFF: false, every gate and request
   // below is exactly as before. Instagram is never affected.
   const multichannel=env("FLOW_MULTICHANNEL_ENABLED")==="true"&&
    (account.platform==="whatsapp"||account.platform==="facebook");
   const multichannelWhatsApp=multichannel&&account.platform==="whatsapp";
   // Do not allow the AI prompt to dictate recipient, account, URL or tenant.
   const payload=effect.payload;
   if(!payload||typeof payload!=="object"||payload.kind!==effect.effect_kind){
    await skip("ineligible","invalid");continue;
   }
   // Only knowledge_ai effects have an AI backoff; anything else in retry_wait
   // is left alone (flow_reserve_outbox_delivery only accepts 'pending').
   if(effect.delivery_status==="retry_wait"&&payload.source!=="knowledge_ai"){
    report("blocked");continue;
   }
   // Durable text/email/phone question (Instagram): plain text, no buttons.
   const plainQuestion=effect.effect_kind==="question"&&
    plainInputQuestion(payload,account.platform);
   if(effect.effect_kind==="question" && !plainQuestion &&
      (env("FLOW_RICH_BUTTONS_ENABLED")!=="true" ||
       (!["instagram","facebook"].includes(account.platform) && !multichannelWhatsApp) ||
       payload.inputMode!=="buttons")){
    report("blocked");continue;
   }
   // Instagram image attachment (mediaPolicy.ts), decided before any send.
   // Flag OFF: row untouched (any status). Other platform / URL outside the
   // allowlist: cancelled for good without a request. Already sent
   // (charge_pending): billing recovery below, never a send.
   let imageUrl:string|undefined;
   if(effect.effect_kind==="message_image"){
    const media=mediaEffectGate({flagEnabled:env("FLOW_MEDIA_SEND_ENABLED")==="true",
     platform:account.platform,payload,supabaseUrl:base});
    if(media.action==="hold"||(effect.delivery_status==="charge_pending"&&media.action!=="send")){
     report("blocked");continue;
    }
    if(media.action==="fail"){
     console.warn("[outbox] image effect not sendable",{id:effect.id,code:media.code});
     report(media.code);await skip("ineligible","invalid");continue;
    }
    if("source" in payload){await skip("ineligible","invalid");continue;}
    imageUrl=media.url;
   }
   dispatched++;
   // An image is persisted (encrypted, like text) with its URL as the body.
   let messageText=imageUrl!==undefined?imageUrl:
    typeof payload.text==="string"?payload.text.trim():"";
   if(payload.source==="knowledge_ai"){
    if(env("FLOW_RAG_ENABLED")!=="true"){report("blocked");continue;}
    if(effect.delivery_status==="charge_pending"){
     // Billing recovery persists EXACTLY the answer that was sent: read the
     // stored encrypted answer, never call the model again. Fail closed.
     // Legacy rows without a stored answer end ONCE as billing_blocked
     // (no send, no debit) instead of occupying the scan forever.
     const recovered=await recoverKnowledgeCharge({
      readStored:async()=>{
       const {data:cachedRow,error:cachedError}=await sb.from("automation_flow_outbox")
        .select("ai_answer_encrypted").eq("tenant_id",effect.tenant_id).eq("id",effect.id)
        .maybeSingle();
       if(cachedError)return null;
       return {found:!!cachedRow,answerEncrypted:typeof cachedRow?.ai_answer_encrypted==="string"?
        cachedRow.ai_answer_encrypted:null};
      },
      decrypt:enc=>decryptAccountToken(enc,fieldKey),
      markAnswerMissing:async()=>{
       const {data:marked,error:markError}=await sb.from("automation_flow_outbox")
        .update({delivery_status:"billing_blocked",ai_last_error_code:AI_ANSWER_MISSING_CODE})
        .eq("tenant_id",effect.tenant_id).eq("id",effect.id)
        .eq("delivery_status","charge_pending").is("ai_answer_encrypted",null)
        .select("id").maybeSingle();
       if(markError)console.error("[outbox] answer-missing mark failed",{code:markError.code});
       return !markError&&!!marked;
      }
     });
     if(recovered.status!=="bill"){
      if(recovered.key===BILLING_BLOCKED_ANSWER_MISSING)
       console.warn("[outbox] charge_pending without stored answer: billing_blocked",
        {tenantId:effect.tenant_id,outboxId:effect.id});
      report(recovered.key);continue;
     }
     messageText=recovered.text;
    }else{
     const question=typeof run.variables?.message==="string"?run.variables.message:"";
     // No customer question is not retryable (previous behaviour: skipped).
     if(!knowledgeQuestionValid(question)){await skip("ineligible","invalid");continue;}
     const resolved=await resolveKnowledgeEffect({
      claim:async():Promise<AiClaim|null>=>{
       const {data,error}=await sb.rpc("flow_claim_outbox_ai",{
        p_tenant:effect.tenant_id,p_outbox:effect.id,
        p_max_attempts:AI_MAX_ATTEMPTS,p_lease_seconds:AI_CLAIM_LEASE_SECONDS
       });
       if(error){console.error("[outbox] ai claim error",{code:error.code});return null;}
       const row=Array.isArray(data)?data[0]:data;
       if(!row||typeof row.outcome!=="string")return null;
       if(row.outcome==="claimed")
        return typeof row.claim_token==="string"&&Number.isInteger(row.attempt)?
         {outcome:"claimed",token:row.claim_token,attempt:row.attempt}:null;
       if(row.outcome==="cached")
        return typeof row.answer_encrypted==="string"?
         {outcome:"cached",answerEncrypted:row.answer_encrypted}:null;
       return ["busy","not_due","not_claimable","exhausted"].includes(row.outcome)?
        {outcome:row.outcome} as AiClaim:null;
      },
      decrypt:enc=>decryptAccountToken(enc,fieldKey),
      generate:()=>answerWithVerifiedKnowledgeOutcome(sb,{
        tenantId:tenant.id,publishedTenantId:run.tenant_id,
        conversationTenantId:conversation.tenant_id,agentEnabled:account.agent_enabled,
        humanTakeover:takeover,credits:tenant.credits_remaining,
        businessName:tenant.business_name
      },question,openAIKnowledgeDependencies()),
      store:async(token,text)=>{
       const {data,error}=await sb.rpc("flow_store_outbox_ai_answer",{
        p_tenant:effect.tenant_id,p_outbox:effect.id,p_token:token,
        p_answer_encrypted:await encryptMessageBody(text,fieldKey)
       });
       if(error)console.error("[outbox] ai store error",{code:error.code});
       return !error&&data===true;
      },
      finish:async(token,decision)=>{
       const {data,error}=await sb.rpc("flow_finish_outbox_ai",{
        p_tenant:effect.tenant_id,p_outbox:effect.id,p_token:token,
        p_result:decision.result,
        p_error_code:"code" in decision?decision.code:null,
        p_delay_seconds:decision.result==="retry"?decision.delaySeconds:60,
        p_max_attempts:AI_MAX_ATTEMPTS
       });
       if(error)console.error("[outbox] ai finish error",{code:error.code});
       return !error&&typeof data==="string"?data:null;
      }
     });
     if(resolved.status!=="send"){
      if(resolved.key!=="ai_retry_scheduled"&&resolved.key!=="ai_busy"&&resolved.key!=="ai_not_due")
       console.warn("[outbox] knowledge effect not sent",{id:effect.id,result:resolved.key});
      report(resolved.key);continue;
     }
     messageText=resolved.text;
    }
   }
   if(!messageText||messageText.length>4000){await skip("ineligible","invalid");continue;}
   const quickReplies=effect.effect_kind==="question" && !plainQuestion &&
     Array.isArray(payload.choices)&&Array.isArray(payload.choiceIds)&&
     payload.choiceIds.length===payload.choices.length?
     payload.choices.map((label:unknown,i:number)=>({id:payload.choiceIds[i],label})):undefined;
   if(effect.effect_kind==="question" && !plainQuestion && !quickReplies){await skip("ineligible","invalid");continue;}
   const websiteButtons=effect.effect_kind==="message" &&
     Array.isArray(payload.websiteButtons)?payload.websiteButtons:undefined;
   if(websiteButtons && (env("FLOW_RICH_BUTTONS_ENABLED")!=="true" ||
      (!["facebook","instagram"].includes(account.platform) && !multichannelWhatsApp))){
     report("blocked");continue;
   }
   // WhatsApp/Facebook (flag ON only, multichannelSend.ts): not representable
   // (more than 3 WhatsApp reply buttons, cta_url mixed or with several URLs,
   // text/title over the platform limit, ...) is cancelled for good BEFORE any
   // reservation and without a request. Already sent: left for review.
   if(multichannel && imageUrl===undefined){
     const problem=multichannelPayloadProblem({platform:account.platform,
      externalId:String(account.external_id??""),token:"validation-only",recipient,
      text:messageText,quickReplies,websiteButtons});
     if(problem){
      if(effect.delivery_status==="charge_pending"){report("blocked");continue;}
      console.warn("[outbox] multichannel payload not sendable",{id:effect.id,code:problem});
      report(problem);await skip("ineligible","invalid");continue;
     }
   }
   // Instagram button template (flowRichActions.ts): decided BEFORE any
   // reservation. Not representable (more than 3 buttons, text over 640,
   // title over 20, non-https/credential URL): cancelled for good, no request,
   // never silently trimmed. Already sent (charge_pending): left for review.
   if(websiteButtons && account.platform==="instagram"){
     const problem=instagramButtonTemplateProblem(messageText,websiteButtons);
     if(problem){
      if(effect.delivery_status==="charge_pending"){report("blocked");continue;}
      console.warn("[outbox] instagram button template not sendable",{id:effect.id,code:problem});
      report(problem);await skip("ineligible","invalid");continue;
     }
   }
   // Stored body = exactly what the customer received: the same single scrub
   // pass sendProviderMessage applies to the raw messageText (pre-fix effects
   // may hold {{...}}), computed BEFORE encryption. Images keep their URL.
   // The send below still receives the raw messageText (scrubbed once there).
   const storedBody=imageUrl!==undefined?messageText:
    deliveredText({platform:account.platform,text:messageText,websiteButtons});
   const persistAndBill=async(providerId:string):Promise<boolean>=>{
     if(typeof providerId!=="string"||!providerId.trim())return false;
     const encrypted=await encryptMessageBody(storedBody,fieldKey);
     const {error:insertError}=await sb.from("messages").insert({
      id:effect.outgoing_message_id,tenant_id:tenant.id,
      conversation_id:conversation.id,direction:"out",body_encrypted:encrypted,
      kind:"answer",is_auto:true,wa_message_id:providerId,
      external_message_id:providerId
     });
     if(insertError?.code==="23505"){
      // Unique conflicts on a different provider MID must NEVER authorize
      // a debit of the expected outgoing UUID.
      const {data:prior,error:priorError}=await sb.from("messages")
       .select("id,tenant_id,conversation_id,direction,wa_message_id,external_message_id,is_auto")
       .eq("id",effect.outgoing_message_id).maybeSingle();
      if(priorError||!matchesPreviouslyPersistedReply(prior,{
       id:effect.outgoing_message_id,tenantId:tenant.id,
       conversationId:conversation.id,providerMid:providerId
      }))return false;
     }else if(insertError){
      console.error("[outbox] outgoing persisted failed",{code:insertError.code});
      return false;
     }
     const {data:charge,error:chargeError}=await sb.rpc("consume_flow_reply",{
      p_tenant_id:tenant.id,p_message_id:effect.outgoing_message_id
     });
     if(chargeError||typeof charge!=="number"||!(charge>=0||charge===-2)){
      console.error("[outbox] charge pending",{
       code:chargeError?.code??"credit_status",
       tenantId:tenant.id,outboxId:effect.id,result:charge
      });
      return false;
     }
     const {data:settled,error:finalizeError}=await sb.from("automation_flow_outbox")
      .update({delivery_status:"settled"}).eq("tenant_id",tenant.id)
      .eq("id",effect.id).eq("delivery_status","charge_pending")
      .select("id").maybeSingle();
     if(finalizeError||!settled){
      console.error("[outbox] settlement failed",{code:finalizeError?.code??"missing_transition"});
      return false;
     }
     return true;
   };
   // A previous Meta 2xx cannot be re-sent. Recover an already confirmed
   // journal entry by persisting and billing only, never using sendProviderMessage.
   if(effect.delivery_status==="charge_pending"){
    const {data:attempt,error:attemptError}=await sb
     .from("automation_flow_delivery_attempts")
     .select("status,provider_message_id")
     .eq("tenant_id",effect.tenant_id).eq("outbox_id",effect.id).maybeSingle();
    const mid=confirmedOutboxMid(effect,attempt);
    if(attemptError||!mid){report("blocked");continue;}
    report(await persistAndBill(mid)?"settled":"billing_pending");
    continue;
   }
   const token=account.platform==="whatsapp"?
    (env("WA_ACCESS_TOKEN")||env("WHATSAPP_ACCESS_TOKEN")):
    await decryptAccountToken(String(account.access_token_encrypted??""),fieldKey);
   if(!token){report("blocked");continue;}
   // Images are not idempotent: NO failure is ever resent. A permanent Meta
   // rejection of the image (4xx such as code 100) is finished as 'rejected'
   // (dead_letter, 20261029210000); auth/5xx/429/network stay uncertain.
   const media:{failure:MediaFailure|null;rejected:boolean}={failure:null,rejected:false};
   // WhatsApp/Facebook (FLOW_MULTICHANNEL_ENABLED only): same reserve ->
   // send once -> finish -> persist/bill sequence. Failures are classified for
   // the report only: the delivery finishes 'uncertain' (never resent;
   // 'rejected' is image-only in SQL).
   if(multichannel && imageUrl===undefined){
    let multichannelFailure:MultichannelFailure|null=null;
    const sent=await executeOnce({
     reserve:async()=>{
      const {data,error}=await sb.rpc("flow_reserve_outbox_delivery",{
       p_tenant:effect.tenant_id,p_outbox:effect.id
      });
      if(error){console.error("[outbox] reserve error",{code:error.code});return false;}
      return data===true;
     },
     send:()=>sendMultichannelMessage({
      platform:account.platform,externalId:String(account.external_id??""),
      token,recipient,text:messageText,quickReplies,websiteButtons
     }).catch(e=>{multichannelFailure=classifyMultichannelFailure(e);throw e;}),
     confirm:async(status,providerId)=>{
      const {data,error}=await sb.rpc("flow_finish_outbox_delivery",{
       p_tenant:effect.tenant_id,p_outbox:effect.id,p_result:status,
       p_provider_message_id:providerId
      });
      if(error){console.error("[outbox] finish error",{code:error.code});return false;}
      return data===true;
     },
     persistAndBill
    });
    report(sent);
    if(multichannelFailure){
     console.warn("[outbox] multichannel send failed",{id:effect.id,code:multichannelFailure});
     report("multichannel_"+multichannelFailure);
    }
    continue;
   }
   const res=await executeOnce({
    reserve:async()=>{
     const {data,error}=await sb.rpc("flow_reserve_outbox_delivery",{
      p_tenant:effect.tenant_id,p_outbox:effect.id
     });
     if(error){console.error("[outbox] reserve error",{code:error.code});return false;}
     return data===true;
    },
    send:()=>imageUrl===undefined?sendProviderMessage({
     platform:account.platform,externalId:String(account.external_id??""),
     token,recipient,text:messageText,quickReplies,websiteButtons
    }):sendProviderMessage({
     platform:account.platform,externalId:String(account.external_id??""),
     token,recipient,text:"",imageUrl,imageHost:base
    }).catch(e=>{media.failure=classifyMediaFailure(e);throw e;}),
    confirm:async(status,providerId)=>{
     const finish=async(result:FinishOutcome):Promise<boolean|null>=>{
      const {data,error}=await sb.rpc("flow_finish_outbox_delivery",{
       p_tenant:effect.tenant_id,p_outbox:effect.id,p_result:result,
       p_provider_message_id:providerId
      });
      if(error){console.error("[outbox] finish error",{code:error.code});return null;}
      return data===true;
     };
     if(finishOutcome(status,media.failure)==="rejected"){
      const rejected=await finish("rejected");
      if(rejected===true){media.rejected=true;return true;}
      // Database without the 'rejected' outcome: record uncertain as before.
      if(rejected===null)return false;
     }
     return await finish(status)===true;
    },

    persistAndBill
   });
   report(media.rejected?"dead_letter_media_rejected":res);
   if(media.failure){
    console.warn("[outbox] image send failed",{id:effect.id,code:media.failure});
    report(media.failure==="media_rejected"?"media_rejected":"media_"+media.failure);
   }
  }catch(err){
   // No automatic retry of any reserved provider call, even on timeout.
   console.error("[outbox] effect blocked/uncertain",{id:effect.id,
    type:err instanceof Error?err.name:"unknown"});
   report("error");
  }
 }
 // Internal effects (tag/untag/staff_notification/handoff) after the message
 // pass, so a handoff/tag that follows a message sent in THIS tick can run in
 // the same tick. Never sends, never bills; OFF unless both operator flags.
 const internal=internalActionsReleased(k=>Deno.env.get(k))?
  await runInternalEffects(sb,{canaryAccountId:env("FLOW_DURABLE_CANARY_ACCOUNT_ID")}).catch(e=>{
   // Effects stay pending/leased (reclaimed later); log the type only, never data.
   console.error("[outbox] internal pass failed",{type:e instanceof Error?e.name:"unknown"});
   return {error:1};
  }):
  undefined;
 return json({processed:(items??[]).length,dispatched,status:outcomes,
  ...(internal?{internal}:{})});
});
