/**
 * STAGING CONTRACT ONLY. Never imported by the live Meta handlers.
 *
 * Integration rule: a trusted backend must write an inbound receipt, runtime
 * state, an immutable outgoing message ID, and a uniquely keyed outbox entry
 * in ONE database transaction. It must atomically CAS a delivery lease BEFORE
 * calling Meta. A response timeout is NOT evidence of a failed send, so the
 * record is quarantined instead of automatically retried.
 *
 * Nothing in this module performs IO, charges credits or sends a message.
 */
export const MAX_SEND_ATTEMPTS = 3;
export const SEND_LEASE_MS = 30_000;
export const MAX_DELIVERY_RETRY_MS = 60_000;

export type DeliveryStatus =
  | "pending" | "retry_wait" | "leased" | "uncertain"
  | "charge_pending" | "settled" | "billing_blocked"
  | "dead_letter" | "cancelled";

export type DeliveryRecord = {
  /** Generated ONCE by the trusted server before any provider send. */
  id: string;
  tenantId: string;
  accountId: string;
  conversationId: string;
  providerEventId: string;
  idempotencyKey: string;
  /** Must be a persisted messages.id used for consume_reply(p_message_id). */
  outgoingMessageId: string;
  status: DeliveryStatus;
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  retryAt: number | null;
  providerMessageId: string | null;
};

export type TrustedDeliveryGate = {
  verifiedTenantId: string;
  accountTenantId: string;
  conversationTenantId: string;
  globalFlowEnabled: boolean;
  tenantFlowEnabled: boolean;
  publicationActive: boolean;
  humanTakeover: boolean;
  agentEnabled: boolean;
  autoReplyEnabled: boolean;
  creditsRemaining: number;
  tokenValid: boolean;
  messagingWindowVerified: boolean;
};

export type GateDenial =
  | "invalid_record" | "wrong_tenant" | "disabled" | "human_takeover"
  | "agent_disabled" | "no_credits" | "invalid_token" | "window_unverified";

export type ClaimResult =
  | {decision:"leased"; record:DeliveryRecord}
  | {decision:"quarantined";record:DeliveryRecord;reason:"expired_lease"}
  | {decision:"skipped";record:DeliveryRecord;reason:"not_due"|"already_claimed"|"terminal"}
  | {decision:"denied";record:DeliveryRecord;reason:GateDenial};

function validId(x:unknown,max=256):x is string {
  return typeof x==="string" && x.length>0 && x.length<=max &&
    x.trim()===x && !/[\u0000-\u001f]/.test(x);
}

export function deliveryGate(record:DeliveryRecord,gate:TrustedDeliveryGate):GateDenial|null {
  if(!record || !gate || ![
    record.id, record.tenantId, record.accountId, record.conversationId,
    record.providerEventId, record.outgoingMessageId
  ].every(x=>validId(x)) || !validId(record.idempotencyKey,1024) ||
  !Number.isSafeInteger(record.attempts) || record.attempts<0 ||
  record.attempts>MAX_SEND_ATTEMPTS) return "invalid_record";

  if(!validId(gate.verifiedTenantId) || record.tenantId!==gate.verifiedTenantId ||
    gate.accountTenantId!==gate.verifiedTenantId ||
    gate.conversationTenantId!==gate.verifiedTenantId) return "wrong_tenant";
  if(!gate.globalFlowEnabled || !gate.tenantFlowEnabled || !gate.publicationActive)
    return "disabled";
  if(gate.humanTakeover) return "human_takeover";
  if(!gate.agentEnabled || !gate.autoReplyEnabled) return "agent_disabled";
  if(!Number.isFinite(gate.creditsRemaining) || gate.creditsRemaining<=0)
    return "no_credits";
  if(!gate.tokenValid) return "invalid_token";
  if(!gate.messagingWindowVerified) return "window_unverified";
  return null;
}

/**
 * Caller MUST persist the returned lease with compare-and-swap:
 * WHERE tenant_id = ... AND id = ... AND status = old_status
 * and dispatch to provider ONLY after the CAS commits successfully.
 */
export function claimDelivery(
  record:DeliveryRecord, gate:TrustedDeliveryGate, nowMs:number, leaseToken:string
):ClaimResult {
  if(!Number.isSafeInteger(nowMs)||nowMs<0 ||
     !Number.isSafeInteger(nowMs+SEND_LEASE_MS) ||
     !validId(leaseToken,128))return {decision:"denied",record,reason:"invalid_record"};

  // An expired lease may have already been accepted by Meta. Do not resend.
  if(record.status==="leased"){
    if(record.leaseExpiresAt!==null && nowMs>=record.leaseExpiresAt)
      return {decision:"quarantined",reason:"expired_lease",
        record:{...record,status:"uncertain",leaseToken:null,leaseExpiresAt:null}};
    return {decision:"skipped",reason:"already_claimed",record};
  }
  if(record.status!=="pending"&&record.status!=="retry_wait")
    return {decision:"skipped",reason:"terminal",record};
  if(record.status==="retry_wait" && (record.retryAt===null||!Number.isSafeInteger(record.retryAt)||nowMs<record.retryAt))
    return {decision:"skipped",reason:"not_due",record};
  // A pending record may be sent exactly once; subsequent attempts must carry
  // an explicit definitely-rejected retry_wait state.
  if((record.status==="pending"&&record.attempts!==0) ||
     (record.status==="retry_wait"&&record.attempts===0))
    return {decision:"denied",reason:"invalid_record",record};

  const denial=deliveryGate(record,gate);
  if(denial)return {decision:"denied",reason:denial,record};
  if(record.attempts>=MAX_SEND_ATTEMPTS)
    return {decision:"skipped",reason:"terminal",
      record:{...record,status:"dead_letter"}};
  return {decision:"leased",record:{
    ...record,status:"leased",attempts:record.attempts+1,leaseToken,
    leaseExpiresAt:nowMs+SEND_LEASE_MS,retryAt:null
  }};
}

export type PreDispatchResult =
  | {authorized:true}
  | {authorized:false;reason:GateDenial|"invalid_lease"};

/**
 * An additional server-side gate immediately BEFORE HTTP dispatch.
 * It does NOT prove an in-flight HTTP request can be cancelled; real workers
 * must re-read flags/ownership from DB before every attempted provider send.
 */
export function authorizeLeasedDispatch(
  record:DeliveryRecord,gate:TrustedDeliveryGate,
  nowMs:number,leaseToken:string
):PreDispatchResult {
  if(record.status!=="leased"||!validId(leaseToken,128)||
    record.leaseToken!==leaseToken||record.leaseExpiresAt===null||
    !Number.isSafeInteger(nowMs)||nowMs<0||nowMs>=record.leaseExpiresAt)
    return {authorized:false,reason:"invalid_lease"};
  const denial=deliveryGate(record,gate);
  if(denial)return {authorized:false,reason:denial};
  return {authorized:true};
}

export type ProviderOutcome =
  | {kind:"accepted";providerMessageId:string}
  | {kind:"definitely_rejected";retryable:boolean}
  | {kind:"unknown"};

export type ProviderResult =
  | {decision:"updated";record:DeliveryRecord}
  | {decision:"ignored";record:DeliveryRecord};

/**
 * A timeout/network reset is UNKNOWN, not a retryable rejection.
 * Only an explicit provider rejection known not to have sent may be retried.
 */
export function recordProviderOutcome(
  record:DeliveryRecord, leaseToken:string, outcome:ProviderOutcome, nowMs:number
):ProviderResult {
  if(record.status!=="leased"||record.leaseToken!==leaseToken ||
     !validId(leaseToken,128)||!Number.isSafeInteger(nowMs)||nowMs<0)
    return {decision:"ignored",record};
  const base={...record,leaseToken:null,leaseExpiresAt:null};
  if(outcome.kind==="accepted"){
    if(!validId(outcome.providerMessageId))
      return {decision:"updated",record:{...base,status:"uncertain"}};
    return {decision:"updated",record:{
      ...base,status:"charge_pending",providerMessageId:outcome.providerMessageId
    }};
  }
  if(outcome.kind==="unknown")
    return {decision:"updated",record:{...base,status:"uncertain"}};
  if(!outcome.retryable || record.attempts>=MAX_SEND_ATTEMPTS)
    return {decision:"updated",record:{...base,status:"dead_letter"}};
  const pause=Math.min(1000*Math.pow(2,Math.max(0,record.attempts-1)),
    MAX_DELIVERY_RETRY_MS);
  if(!Number.isSafeInteger(nowMs+pause))
    return {decision:"updated",record:{...base,status:"dead_letter"}};
  return {decision:"updated",record:{
    ...base,status:"retry_wait",retryAt:nowMs+pause
  }};
}

export type DebitOutcome = "charged"|"already_charged"|"insufficient"|"rpc_error";

/** Retry a failed debit using the SAME message UUID. NEVER resend the message. */
export function recordDebitOutcome(
  record:DeliveryRecord, outcome:DebitOutcome
):DeliveryRecord {
  if(record.status!=="charge_pending"||!validId(record.providerMessageId)||
     !validId(record.outgoingMessageId))return record;
  if(outcome==="charged"||outcome==="already_charged")
    return {...record,status:"settled"};
  if(outcome==="insufficient")
    return {...record,status:"billing_blocked"};
  return record; // durable charge_pending + alert; no new Meta send
}

/**
 * Manual reconciliation is permitted only with external provider evidence;
 * an operator cannot turn an unknown delivery into a retry automatically.
 */
export function reconcileUncertain(
  record:DeliveryRecord, result:
    | {kind:"confirmed_accepted";providerMessageId:string}
    | {kind:"confirmed_rejected"}
):DeliveryRecord {
  if(record.status!=="uncertain")return record;
  if(result.kind==="confirmed_accepted")
    return validId(result.providerMessageId) ?
      {...record,status:"charge_pending",providerMessageId:result.providerMessageId}
      : record;
  if(record.attempts>=MAX_SEND_ATTEMPTS)
    return {...record,status:"dead_letter"};
  return {...record,status:"retry_wait",retryAt:0};
}
