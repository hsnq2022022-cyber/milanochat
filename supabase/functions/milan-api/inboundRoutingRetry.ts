/**
 * SERVER ONLY. Retryable inbound processing when FLOW ELIGIBILITY IS UNKNOWN
 * (a read error on the automation switches, the account's active activations
 * or their exact publications, in the V2 path or the durable path).
 *
 * Policy (milan-api/index.ts):
 *  (a) no flow and no AI run for that event;
 *  (b) the event stays retryable: the inbound message is already persisted
 *      and a row of public.automation_inbound_routing_retries (migration
 *      20261029340000) is 'retrying';
 *  (c) bounded: the webhook answers 503 so the provider (Meta) redelivers
 *      with ITS OWN backoff; the duplicate pre-check re-drives a redelivered
 *      event ONLY while its row is 'retrying'; at most
 *      INBOUND_ROUTING_MAX_ATTEMPTS failed lookups per event;
 *  (d) exactly-once stays with the existing claims
 *      (automation_message_claims unique key via flow_claim_inbound /
 *      flow_claim_inbound_durable / flow_claim_begin_durable_run): a re-drive
 *      never inserts a second inbound row and a second claim is impossible;
 *  (e) the AI answers only after a SUCCESSFUL lookup found no matching flow;
 *  (f) the last failed attempt marks the row 'exhausted' (terminal,
 *      observable, never a success); the webhook then acknowledges (200).
 * Every function here is fail-closed and logs only codes (no ids, no text).
 */
export const INBOUND_ROUTING_MAX_ATTEMPTS=5;
const RETRY_TABLE="automation_inbound_routing_retries";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RetryKey={tenantId:string;accountId:string;platform:string;eventId:string};
export type RetryEvent=RetryKey&{conversationId:string;inboundId:string};
/**
 *  retry:       state recorded 'retrying' -> answer the webhook with 503;
 *  exhausted:   max attempts reached ('exhausted' row) -> 200, investigate;
 *  claimed:     the event already has a claim (processed) -> 200;
 *  resolved:    a previous redelivery already resolved it -> 200;
 *  unavailable: the retry state could not be written (migration missing,
 *               RPC/database error, invalid ids) -> 200, NOT retried, logged.
 */
export type RetryDecision="retry"|"exhausted"|"claimed"|"resolved"|"unavailable";
type Db={from:(t:string)=>any;rpc:(n:string,a:Record<string,unknown>)=>any};

const validKey=(k:RetryKey)=>UUID.test(k.tenantId)&&UUID.test(k.accountId)&&
 ["instagram","facebook","whatsapp"].includes(k.platform)&&
 typeof k.eventId==="string"&&k.eventId.length>=1&&k.eventId.length<=256;

/** Records one failed lookup for this event; never throws. */
export async function recordRoutingFailure(db:Db,e:RetryEvent,
 maxAttempts=INBOUND_ROUTING_MAX_ATTEMPTS):Promise<RetryDecision>{
 if(!validKey(e)||!UUID.test(e.conversationId)||!UUID.test(e.inboundId))return "unavailable";
 try{
  const r=await db.rpc("flow_inbound_routing_failed",{
   p_tenant:e.tenantId,p_account:e.accountId,p_platform:e.platform,p_event:e.eventId,
   p_conversation:e.conversationId,p_inbound:e.inboundId,p_max_attempts:maxAttempts
  });
  if(r?.error)return "unavailable";
  const s=r?.data;
  return s==="retrying"?"retry":s==="exhausted"||s==="claimed"||s==="resolved"?s:"unavailable";
 }catch{return "unavailable";}
}

/** 'retrying' -> 'resolved' once a redelivered event's lookup succeeded. Best effort, never throws. */
export async function markRoutingResolved(db:Db,k:RetryKey):Promise<boolean>{
 if(!validKey(k))return false;
 try{
  const r=await db.rpc("flow_inbound_routing_resolved",{
   p_tenant:k.tenantId,p_account:k.accountId,p_platform:k.platform,p_event:k.eventId});
  return !r?.error&&r?.data===true;
 }catch{return false;}
}

/**
 * Duplicate pre-check helper: the persisted event to RE-DRIVE, or null.
 * Only a row that is exactly 'retrying' for this tenant/account/platform/event
 * qualifies; anything else (no row, terminal row, read error, missing table)
 * keeps today's behaviour: the duplicate is skipped.
 */
export async function retryableEvent(db:Db,k:RetryKey):Promise<{conversationId:string;inboundId:string}|null>{
 if(!validKey(k))return null;
 try{
  const r=await db.from(RETRY_TABLE).select("tenant_id,channel_account_id,platform,provider_event_id,conversation_id,inbound_message_id,status")
   .eq("tenant_id",k.tenantId).eq("channel_account_id",k.accountId)
   .eq("platform",k.platform).eq("provider_event_id",k.eventId).maybeSingle();
  const row=r?.data;
  if(r?.error||!row||row.status!=="retrying"||row.tenant_id!==k.tenantId||
     row.channel_account_id!==k.accountId||row.platform!==k.platform||row.provider_event_id!==k.eventId||
     typeof row.conversation_id!=="string"||typeof row.inbound_message_id!=="string")return null;
  return {conversationId:row.conversation_id,inboundId:row.inbound_message_id};
 }catch{return null;}
}

/**
 * Webhook HTTP status, decided AFTER the whole delivery was processed: 503
 * while any event of this delivery is retryable ("retry") or failed with an
 * unexpected exception ("error", see runBatchEvent), else 200.
 */
export const webhookStatusFor=(outcomes:readonly unknown[])=>
 outcomes.some(o=>o==="retry"||o===BATCH_EVENT_ERROR)?503:200;

/**
 * Meta delivers several events in ONE webhook POST and redelivers the whole
 * POST when it is not acknowledged. One event must never decide the fate of
 * the others:
 *  * every event of the batch is processed before the response is chosen
 *    (the handlers collect the outcomes and call webhookStatusFor at the end);
 *  * an event that THROWS no longer aborts the loop (the events after it used
 *    to be skipped and the request answered 500): it is isolated here and
 *    reported as BATCH_EVENT_ERROR, a TRANSIENT outcome (503 -> redelivery).
 * On the redelivery an event that was already processed is skipped by the
 * duplicate pre-check / its claim (never answered twice), a 'retrying' event
 * is re-driven, and an event that was not persisted is processed as new.
 * An event that threw AFTER its inbound row was persisted is skipped as a
 * duplicate by the redelivery; it is recovered only by the opt-in sweeper
 * (inboundRecovery.ts). Terminal outcomes never cause a 503.
 * Logs the error type only (no ids, no text).
 */
export const BATCH_EVENT_ERROR="error";
export async function runBatchEvent<T>(run:()=>Promise<T>):Promise<T|typeof BATCH_EVENT_ERROR>{
 try{return await run();}
 catch(e){
  console.error("[webhook-batch] event failed; remaining events still processed",
   {type:e instanceof Error?e.name:"unknown"});
  return BATCH_EVENT_ERROR;
 }
}

/**
 * processExclusiveEvent outcomes that leave the event UNOWNED: no claim was
 * acquired (flow eligibility unknown, or the claim RPC failed so its commit is
 * unknown). Retrying them is safe: a retry claims again and a committed claim
 * answers "duplicate", so nothing is ever sent twice. Every other outcome
 * (sent_*, send_failed, empty, delivery_unavailable, duplicate) follows an
 * ACQUIRED claim or a duplicate: terminal, never retried or re-sent.
 */
export const RETRYABLE_OUTCOMES=["routing_unavailable","claim_failed"] as const;
export const isRetryableOutcome=(o:unknown)=>(RETRYABLE_OUTCOMES as readonly unknown[]).includes(o);
/** Attempt cap: events without a provider id (B-5) are never retried. */
export const retryAttemptCap=(syntheticEvent:boolean)=>syntheticEvent?1:INBOUND_ROUTING_MAX_ATTEMPTS;
