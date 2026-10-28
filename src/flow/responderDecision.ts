import {resolveExclusiveEventRoute} from "./eventRouting.ts";
import type {EnabledFlow, NormalizedInboundEvent, EventMatch} from "./eventRouting.ts";

/**
 * REVIEW-ONLY, pure policy. A trusted Edge Function must resolve every
 * property below from the verified raw Meta webhook + server database.
 * Never copy flags, tenant IDs or publication lists from a browser request.
 *
 * No flow is sent or activated by this module. The real milan-api is unchanged.
 */
export type TrustedResponderSnapshot = {
  signatureVerified: boolean;
  webhookAccountVerified: boolean;
  tenantId: string;
  accountId: string;
  accountTenantId: string;
  conversationTenantId: string;
  humanTakeover: boolean;
  agentEnabled: boolean;
  autoReplyEnabled: boolean;
  creditsRemaining: number;
  globalFlowEnabled?: boolean;
  tenantFlowEnabled?: boolean;
};

export type ResponderDecision =
  | {owner:"stop";reason:"unverified_event"|"ownership_mismatch"|
      "human_takeover"|"agent_disabled"|"no_credits"|"unsupported_event"}
  | {owner:"legacy_ai";reason:"flow_off"|"no_match"|"ambiguous_match"}
  | {owner:"flow";reason:"unique_match";match:EventMatch};

function safeId(value:unknown):value is string {
  return typeof value==="string" && value.length>0 && value.length<=256 &&
    value.trim()===value && !/[\u0000-\u001f]/.test(value);
}

/**
 * Source enum and canonical storage values differ: DB "facebook" is
 * routing "messenger". This is a *mapping*, not Meta webhook validation.
 */
export function toFlowPlatform(value:string):"instagram"|"messenger"|"whatsapp"|null {
  if(value==="facebook")return "messenger";
  if(value==="instagram"||value==="whatsapp")return value;
  return null;
}

/**
 * Exactly one system is nominated per event, never both.
 * Current AI remains the owner with new automation flags OFF.
 * When flags are ON, an unambiguous enabled flow may own the event.
 * Ambiguous/zero matches fall through to the legacy AI owner.
 *
 * A future adapter must use this decision BEFORE any side effect and
 * atomically reserve the inbound event/run/outbox before flow sending.
 */
export function selectResponder(
  trusted:TrustedResponderSnapshot,
  inbound:NormalizedInboundEvent,
  serverPublishedFlows:readonly EnabledFlow[]
):ResponderDecision {
  if(!trusted || !inbound || trusted.signatureVerified!==true ||
     trusted.webhookAccountVerified!==true || inbound.isEcho===true ||
     !safeId(inbound.eventId)||!safeId(inbound.senderId))
    return {owner:"stop",reason:"unverified_event"};

  if(!safeId(trusted.tenantId)||!safeId(trusted.accountId)||
     trusted.tenantId!==trusted.accountTenantId ||
     trusted.tenantId!==trusted.conversationTenantId ||
     inbound.tenantId!==trusted.tenantId ||
     inbound.accountId!==trusted.accountId)
    return {owner:"stop",reason:"ownership_mismatch"};

  if(trusted.humanTakeover)return {owner:"stop",reason:"human_takeover"};
  if(!trusted.agentEnabled||!trusted.autoReplyEnabled)
    return {owner:"stop",reason:"agent_disabled"};
  if(!Number.isFinite(trusted.creditsRemaining)||trusted.creditsRemaining<=0)
    return {owner:"stop",reason:"no_credits"};

  // Until comment and other Meta subscription modes have signed E2E tests,
  // never route them through the new engine or a guessed legacy AI path.
  if(inbound.platform!=="instagram"&&inbound.platform!=="messenger"&&
     inbound.platform!=="whatsapp")
    return {owner:"stop",reason:"unsupported_event"};
  if(inbound.mode!=="message"&&inbound.mode!=="keyword")
    return {owner:"stop",reason:"unsupported_event"};
  if(typeof inbound.text!=="string"||inbound.text.length>8192)
    return {owner:"stop",reason:"unsupported_event"};

  if(trusted.globalFlowEnabled!==true || trusted.tenantFlowEnabled!==true)
    return {owner:"legacy_ai",reason:"flow_off"};

  // This function must receive only server-read, activated publications.
  // The browser's local editor enable toggle has NO authority here.
  const selected=resolveExclusiveEventRoute(inbound,serverPublishedFlows);
  if(selected.status==="none")return {owner:"legacy_ai",reason:"no_match"};
  if(selected.status==="ambiguous")
    return {owner:"legacy_ai",reason:"ambiguous_match"};
  return {owner:"flow",reason:"unique_match",match:selected.match};
}
