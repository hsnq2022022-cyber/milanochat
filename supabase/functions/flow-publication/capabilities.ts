/**
 * PURE per-account capability availability for the `capabilities` action.
 * Inputs are the SAME gates the activate action evaluates (index.ts:
 * productionActivationAuthorized, the durable operator gates, the per-node
 * flags, the comment path); this module only re-expresses them per capability.
 * Output: booleans + stable reason codes. Never env names/values or ids.
 * Fail closed: anything not exactly true is OFF.
 */
import {productionActivationAuthorized,type ProviderPlatform} from "../../../src/flow/serverPublicationValidation.ts";
import {CAPABILITIES,type Capability,type AvailabilityEntry} from "../../../src/flow/requirements.ts";

export type CapabilityReason=
 |"account_paused"|"account_not_approved"|"channel_not_supported"|"advanced_not_enabled"
 |"buttons_not_enabled"|"delay_not_enabled"|"internal_actions_not_enabled"|"media_not_enabled"
 |"ai_not_enabled"|"comments_not_enabled"|"not_supported"|"unavailable";
export type CapabilityInputs={
 platform:ProviderPlatform;
 tenantActive:boolean;accountActive:boolean;agentEnabled:boolean;autoReply:boolean;
 globalEnabled:boolean;tenantEnabled:boolean;productionApproved:boolean;
 /** FLOW_DURABLE_ACTIVATION_READY / INGRESS / canary account match / operator release / outbox / atomic debit / encryption key. */
 activationReady:boolean;durableIngress:boolean;canaryMatched:boolean;operatorReleased:boolean;
 outboxEnabled:boolean;atomicDebitReady:boolean;encryptionConfigured:boolean;
 richButtons:boolean;scheduler:boolean;internalActions:boolean;
 /** mediaActivationAllowed(FLOW_ACTIVATION_CAPABILITIES, FLOW_MEDIA_SEND_ENABLED). */
 mediaAllowed:boolean;
 /** FLOW_AI_STEP_ENABLED AND FLOW_RAG_ENABLED (aiStep.ts aiStepEnabled). */
 aiStep:boolean;
 commentAutomation:boolean;multichannel:boolean;
};
export type CapabilityReport={
 capabilities:Record<Capability,AvailabilityEntry>;
 /** Which kind of flow could be activated at all (API only, never displayed). */
 canPublish:{basic:boolean;advanced:boolean;comments:boolean};
};

const BASIC:Capability[]=["trigger_message","keyword_trigger","message_scope","text","conditions"];
const ADVANCED_FLAG:Partial<Record<Capability,keyof CapabilityInputs>>={
 buttons:"richButtons",website_buttons:"richButtons",delay:"scheduler",
 internal_actions:"internalActions",media_image:"mediaAllowed",ai_step:"aiStep"};
const FLAG_REASON:Partial<Record<Capability,CapabilityReason>>={
 buttons:"buttons_not_enabled",website_buttons:"buttons_not_enabled",delay:"delay_not_enabled",
 internal_actions:"internal_actions_not_enabled",media_image:"media_not_enabled",ai_step:"ai_not_enabled"};
const COMMENT:Capability[]=["comment_trigger","public_reply","private_reply"];

export function capabilityAvailability(i:CapabilityInputs):CapabilityReport{
 const t=(v:unknown)=>v===true;
 const accountReady=t(i.tenantActive)&&t(i.accountActive)&&t(i.agentEnabled)&&t(i.autoReply);
 const approved=t(i.globalEnabled)&&t(i.tenantEnabled)&&t(i.productionApproved);
 const production=productionActivationAuthorized(i.platform,i.globalEnabled,i.tenantEnabled,i.productionApproved);
 const commentAuthorized=productionActivationAuthorized(i.platform,i.globalEnabled,i.tenantEnabled,i.productionApproved,
  {commentTrigger:true,commentAutomationEnabled:t(i.commentAutomation),multichannelEnabled:t(i.multichannel)});
 const ops=t(i.activationReady)&&t(i.durableIngress)&&t(i.canaryMatched)&&t(i.operatorReleased)&&
  t(i.outboxEnabled)&&t(i.atomicDebitReady)&&t(i.encryptionConfigured);
 const account:CapabilityReason|null=!accountReady?"account_paused":!approved?"account_not_approved":null;
 const entry=(reason:CapabilityReason|null):AvailabilityEntry=>({available:reason===null,reason});
 const out={} as Record<Capability,AvailabilityEntry>;
 for(const c of CAPABILITIES){
  let reason:CapabilityReason|null;
  if(c==="unsupported_block")reason="not_supported";
  else if(account)reason=account;
  else if(BASIC.includes(c))reason=production?null:"channel_not_supported";
  else if(COMMENT.includes(c))
   reason=i.platform==="whatsapp"?"channel_not_supported":
    !t(i.commentAutomation)||!commentAuthorized?"comments_not_enabled":!ops?"advanced_not_enabled":null;
  else{
   // Durable-only blocks: the activate action's `durable` gate (Instagram only).
   const flag=ADVANCED_FLAG[c];
   reason=!production||i.platform!=="instagram"?"channel_not_supported":!ops?"advanced_not_enabled":
    flag&&!t(i[flag])?FLAG_REASON[c]!:null;
  }
  out[c]=entry(reason);
 }
 return {capabilities:out,canPublish:{basic:out.text.available,
  advanced:account===null&&production&&i.platform==="instagram"&&ops,
  comments:out.comment_trigger.available}};
}

/** Every capability unavailable with one reason (read errors, unknown state). */
export function capabilitiesUnavailable(reason:CapabilityReason="unavailable"):CapabilityReport{
 const out={} as Record<Capability,AvailabilityEntry>;
 for(const c of CAPABILITIES)out[c]={available:false,reason:c==="unsupported_block"?"not_supported":reason};
 return {capabilities:out,canPublish:{basic:false,advanced:false,comments:false}};
}
