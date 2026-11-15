/**
 * SERVER ONLY. B-3/B-4: bounded, opt-in recovery of PERSISTED inbound events
 * that never reached an owner (no automation_message_claims row): the
 * function died between the inbound insert and the exclusive claim, or a
 * 'retrying' event (inboundRoutingRetry.ts) was never redelivered.
 *
 * State and atomic leases live in migration 20261029360000
 * (flow_inbound_recovery_lease: FOR UPDATE SKIP LOCKED, per-tenant opt-in,
 * hard 48 hour age cap, bounded attempts; flow_inbound_recovery_finish:
 * lease-token-checked completion with backoff 1m, 5m, 15m, 60m).
 *
 * This module is the ONLY caller. For every leased event it rebuilds the
 * webhook context from stored rows ONLY, re-checks eligibility, and re-drives
 * the event through the SAME function as the webhook
 * (milan-api/index.ts handleIncomingWebhookMessage in re-drive mode: the
 * existing inbound row, the durable attempt, the V2/AI path and the exclusive
 * claim). There is no second runtime and no competing queue: exactly-once
 * stays with automation_message_claims, so a provider redelivery and the
 * sweeper can never both answer one event.
 *
 * Reconstruction (anything not provable is 'exhausted' with a reason code,
 * never a guess):
 *  account      conversations.account_id -> channel_accounts of the SAME tenant
 *  chat id      conversations.wa_chat_id, prefix = the account's channel
 *  event id     messages.wa_message_id. Ids starting with "ig_" are the
 *               synthetic ids milan-api derives when Meta sent no mid
 *               (syntheticEventId.ts / `ig_<ms>`): never provider ids, never
 *               replayed. WhatsApp ids must be Cloud API ids ("wamid.").
 *  phone id     WhatsApp only: the account's external_id (digits)
 *  text         messages.body_encrypted decrypted IN MEMORY with the field
 *               key (strict: a legacy plaintext or undecryptable body is
 *               exhausted). Never logged, never stored, never put in an error.
 *  button taps  a quick-reply / postback choice id is NOT stored. An event
 *               of a conversation with durable flow context (a run that is
 *               waiting/sleeping, or was active in the 24h before the
 *               message) may be a button choice: exhausted, never replayed
 *               as free text.
 * Known terminal conditions resolve the event WITHOUT a reply: tenant
 * missing/inactive, conversation missing, account inactive, human takeover,
 * credits pause / no credits, agent or auto reply off, already claimed, or a
 * later message in the conversation (the customer or the business moved on:
 * an old message is never answered after the fact).
 *
 * LIMITS: a message that was never persisted cannot be recovered (the
 * provider's own redelivery is the only source); events older than 48 hours,
 * events of tenants that have not opted in, and events persisted before the
 * tenant's opt-in time are never touched.
 * Logs carry reason CODES and counters only (no ids, no text).
 */
export const RECOVERY_MAX_AGE_HOURS=48;
export const RECOVERY_MAX_ATTEMPTS=5;
/** Backoff after attempt 1, 2, 3, then every further attempt (owned by the SQL finish function). */
export const RECOVERY_BACKOFF_SECONDS=[60,300,900,3600] as const;
export const RECOVERY_BATCH=5;
export const RECOVERY_LEASE_SECONDS=180;
/** A live webhook delivery is long finished after this; younger events are never swept. */
export const RECOVERY_GRACE_SECONDS=300;
const RUN_CONTEXT_WINDOW_MS=24*3600*1000;
const MAX_TEXT=4096;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Rec=Record<string,unknown>;
const rec=(v:unknown):v is Rec=>!!v&&typeof v==="object"&&!Array.isArray(v);
// deno-lint-ignore no-explicit-any
type Db={from:(t:string)=>any;rpc:(n:string,a:Record<string,unknown>)=>any};
export type RecoveryChannel="instagram"|"facebook"|"whatsapp";
export type RedriveEvent={
 account:Rec;chatId:string;text:string;eventId:string;channel:RecoveryChannel;
 phoneId?:string;conversationId:string;inboundId:string;
};
export type RecoveryDeps={
 /** Strict field decryption; must THROW when the value cannot be decrypted. */
 decrypt:(stored:string)=>Promise<string>;
 /** handleIncomingWebhookMessage in re-drive mode: "retry" = unknown state. */
 redrive:(e:RedriveEvent)=>Promise<"retry"|void>;
 nowMs?:()=>number;
 /** Optional: sweep ONE tenant only (the SQL lease is restricted to it). */
 tenantId?:string;
};
type Decision={result:"resolved"|"exhausted"|"retry";reason:string};
const resolved=(reason:string):Decision=>({result:"resolved",reason});
const exhausted=(reason:string):Decision=>({result:"exhausted",reason});
const retry=(reason:string):Decision=>({result:"retry",reason});

/**
 * Operator gate, default OFF: FLOW_INBOUND_RECOVERY_ENABLED must be exactly
 * "true" AND the same worker release gate as the flow workers must be open.
 * Fail-closed (a throwing reader = OFF).
 */
export function inboundRecoveryEnabled(get:(k:string)=>string|undefined):boolean{
 try{
  return get("FLOW_INBOUND_RECOVERY_ENABLED")==="true"&&
   get("FLOW_WORKERS_OPERATOR_RELEASE")==="production-canary-approved";
 }catch{return false;}
}

/** Same rule as milan-api handleIncomingWebhookMessage / eligibility.ts. */
function takeoverActive(conv:Rec,nowMs:number):boolean{
 if(conv.transferred==null||conv.transferred===false)return false;
 if(conv.transferred!==true)return true;
 if(conv.auto_paused_reason!=="manual_takeover"||typeof conv.human_agent_expires_at!=="string")return true;
 const t=Date.parse(conv.human_agent_expires_at);
 return !Number.isFinite(t)||t>nowMs;
}

/**
 * Webhook side of the mutual exclusion: true while the sweeper holds an
 * unexpired lease on this inbound message. The webhook then does NOT re-drive
 * the redelivered event itself (it answers 503 and the provider redelivers).
 * Missing table / read error -> false (behaviour before 20261029360000; the
 * exclusive claim still guarantees a single reply).
 */
export async function recoveryLeaseActive(db:Db,k:{tenantId:string;inboundId:string},
 nowMs=Date.now()):Promise<boolean>{
 if(!UUID.test(k.tenantId)||!UUID.test(k.inboundId))return false;
 try{
  const r=await db.from("automation_inbound_recovery")
   .select("tenant_id,inbound_message_id,status,lease_expires_at")
   .eq("tenant_id",k.tenantId).eq("inbound_message_id",k.inboundId).maybeSingle();
  const row=r?.data;
  if(r?.error||!rec(row)||row.tenant_id!==k.tenantId||row.inbound_message_id!==k.inboundId||
     row.status!=="leased"||typeof row.lease_expires_at!=="string")return false;
  const t=Date.parse(row.lease_expires_at);
  return Number.isFinite(t)&&t>nowMs;
 }catch{return false;}
}

type Lease={tenantId:string;inboundId:string;conversationId:string;token:string};

/** One leased event -> decision. Every read is scoped to lease.tenantId. */
async function recoverOne(db:Db,deps:RecoveryDeps,lease:Lease,nowMs:number):Promise<Decision>{
 const T=lease.tenantId;
 // Opt-in, re-read at re-drive time (default OFF: no row = never processed).
 const opt=await db.from("automation_inbound_recovery_tenants").select("tenant_id,enabled")
  .eq("tenant_id",T).maybeSingle();
 if(opt?.error)return retry("read_error");
 if(!rec(opt?.data)||opt.data.tenant_id!==T||opt.data.enabled!==true)return retry("opt_in_off");

 const tenant=await db.from("tenants").select("id,is_active,credits_remaining").eq("id",T).maybeSingle();
 if(tenant?.error)return retry("read_error");
 if(!rec(tenant?.data)||tenant.data.id!==T)return resolved("tenant_missing");
 if(tenant.data.is_active===false)return resolved("tenant_inactive");

 const msg=await db.from("messages")
  .select("id,tenant_id,conversation_id,direction,wa_message_id,body_encrypted,created_at")
  .eq("tenant_id",T).eq("id",lease.inboundId).maybeSingle();
 if(msg?.error)return retry("read_error");
 const m=msg?.data;
 if(!rec(m)||m.tenant_id!==T||m.id!==lease.inboundId||m.direction!=="in")return exhausted("message_missing");
 if(m.conversation_id!==lease.conversationId)return exhausted("context_mismatch");
 const createdMs=typeof m.created_at==="string"?Date.parse(m.created_at):Number.NaN;
 if(!Number.isFinite(createdMs))return exhausted("message_time_unproven");
 if(nowMs-createdMs>RECOVERY_MAX_AGE_HOURS*3600*1000)return exhausted("expired");

 const claimed=async():Promise<boolean|null>=>{
  const c=await db.from("automation_message_claims").select("id,tenant_id")
   .eq("tenant_id",T).eq("inbound_message_id",lease.inboundId).limit(1);
  if(c?.error||!Array.isArray(c?.data))return null;
  return c.data.some((x:unknown)=>rec(x)&&x.tenant_id===T);
 };
 const prior=await claimed();
 if(prior===null)return retry("read_error");
 if(prior)return resolved("claimed");

 const convRead=await db.from("conversations")
  .select("id,tenant_id,account_id,wa_chat_id,transferred,auto_paused_reason,human_agent_expires_at")
  .eq("tenant_id",T).eq("id",lease.conversationId).maybeSingle();
 if(convRead?.error)return retry("read_error");
 const conv=convRead?.data;
 if(!rec(conv)||conv.tenant_id!==T||conv.id!==lease.conversationId)return resolved("conversation_missing");
 // e.g. a WhatsApp conversation created through a binding without a proven account.
 if(typeof conv.account_id!=="string"||!UUID.test(conv.account_id))return exhausted("account_unproven");

 const accRead=await db.from("channel_accounts")
  .select("id, tenant_id, channel, external_id, status, agent_enabled, auto_reply, access_token_encrypted")
  .eq("tenant_id",T).eq("id",conv.account_id).maybeSingle();
 if(accRead?.error)return retry("read_error");
 const account=accRead?.data;
 if(!rec(account)||account.tenant_id!==T||account.id!==conv.account_id)return exhausted("account_missing");
 const channel=account.channel;
 if(channel!=="instagram"&&channel!=="facebook"&&channel!=="whatsapp")return exhausted("channel_unsupported");
 if(account.status!=="active")return resolved("account_inactive");

 const chatId=conv.wa_chat_id;
 if(typeof chatId!=="string"||!chatId.startsWith(channel+":")||
    chatId.length<=channel.length+1||chatId.length>160)return exhausted("chat_unproven");

 const eventId=m.wa_message_id;
 if(typeof eventId!=="string"||eventId.length<1||eventId.length>256)return exhausted("event_id_missing");
 // Synthetic ids (no Meta mid) are never provider ids and never replayed.
 if(eventId.startsWith("ig_"))return exhausted("synthetic_event_id");
 let phoneId:string|undefined;
 if(channel==="whatsapp"){
  if(!eventId.startsWith("wamid."))return exhausted("event_id_unproven");
  if(typeof account.external_id!=="string"||!/^[0-9]{5,30}$/.test(account.external_id))
   return exhausted("phone_id_unproven");
  phoneId=account.external_id;
 }

 if(takeoverActive(conv,nowMs))return resolved("human_takeover");
 if(conv.auto_paused_reason==="credits")return resolved("credits_paused");
 if(account.agent_enabled===false||account.auto_reply===false)return resolved("auto_reply_off");
 if(!(Number(tenant.data.credits_remaining??0)>0))return resolved("no_credits");

 // The conversation moved on: an old message is never answered afterwards.
 const later=await db.from("messages").select("id,tenant_id")
  .eq("tenant_id",T).eq("conversation_id",lease.conversationId)
  .gt("created_at",m.created_at).limit(1);
 if(later?.error||!Array.isArray(later?.data))return retry("read_error");
 if(later.data.some((x:unknown)=>rec(x)&&x.tenant_id===T&&x.id!==lease.inboundId))return resolved("superseded");

 // Possible button choice (its choice id is not stored): never replayed.
 const runs=await db.from("automation_flow_runs").select("id,tenant_id,conversation_id,run_status,updated_at")
  .eq("tenant_id",T).eq("conversation_id",lease.conversationId).limit(50);
 if(runs?.error||!Array.isArray(runs?.data))return retry("read_error");
 for(const r of runs.data as unknown[]){
  if(!rec(r)||r.tenant_id!==T||r.conversation_id!==lease.conversationId)continue;
  if(["awaiting_input","sleeping","ready"].includes(String(r.run_status)))return exhausted("flow_context_unrecoverable");
  const u=typeof r.updated_at==="string"?Date.parse(r.updated_at):Number.NaN;
  if(!Number.isFinite(u)||u>=createdMs-RUN_CONTEXT_WINDOW_MS)return exhausted("flow_context_unrecoverable");
 }
 if(runs.data.length>=50)return exhausted("flow_context_unrecoverable");

 // Text: decrypted in memory only; strict (no legacy plaintext, no placeholder).
 if(typeof m.body_encrypted!=="string"||!m.body_encrypted.startsWith("enc:v1:"))return exhausted("body_undecryptable");
 let text="";
 try{text=await deps.decrypt(m.body_encrypted);}catch{return exhausted("body_undecryptable");}
 if(typeof text!=="string"||!text.trim()||text.length>MAX_TEXT)return exhausted("body_unusable");

 let outcome:"retry"|void;
 try{
  outcome=await deps.redrive({account,chatId,text,eventId,channel,phoneId,
   conversationId:lease.conversationId,inboundId:lease.inboundId});
 }catch{
  // The claim (if any) decides on the next attempt; never re-sent blindly.
  return retry("redrive_error");
 }
 text="";
 if(outcome==="retry")return retry("routing_unknown");
 const after=await claimed();
 if(after===true)return resolved("processed");
 const rr=await db.from("automation_inbound_routing_retries").select("tenant_id,status")
  .eq("tenant_id",T).eq("inbound_message_id",lease.inboundId).limit(1);
 if(!rr?.error&&Array.isArray(rr?.data)&&
    rr.data.some((x:unknown)=>rec(x)&&x.tenant_id===T&&x.status==="exhausted"))
  return exhausted("routing_exhausted");
 return resolved("no_reply_terminal");
}

/**
 * One bounded sweep. The caller must have authenticated the request and
 * checked inboundRecoveryEnabled(). Returns counters only.
 */
export async function runInboundRecovery(db:Db,deps:RecoveryDeps):Promise<Record<string,number>>{
 const out:Record<string,number>={};
 const count=(k:string)=>{out[k]=(out[k]??0)+1;};
 const now=deps.nowMs??(()=>Date.now());
 if(deps.tenantId!==undefined&&!UUID.test(deps.tenantId)){count("invalid_tenant");return out;}
 let leased:unknown;
 try{
  const r=await db.rpc("flow_inbound_recovery_lease",{
   p_limit:RECOVERY_BATCH,p_lease_seconds:RECOVERY_LEASE_SECONDS,
   p_max_age_hours:RECOVERY_MAX_AGE_HOURS,p_max_attempts:RECOVERY_MAX_ATTEMPTS,
   p_grace_seconds:RECOVERY_GRACE_SECONDS,p_tenant:deps.tenantId??null});
  if(r?.error||!Array.isArray(r?.data)){
   console.error("[inbound-recovery] recovery state unavailable");
   count("lease_unavailable");return out;
  }
  leased=r.data;
 }catch{
  console.error("[inbound-recovery] recovery state unavailable");
  count("lease_unavailable");return out;
 }
 for(const row of leased as unknown[]){
  if(!rec(row)||typeof row.tenant_id!=="string"||!UUID.test(row.tenant_id)||
     typeof row.inbound_message_id!=="string"||!UUID.test(row.inbound_message_id)||
     typeof row.conversation_id!=="string"||!UUID.test(row.conversation_id)||
     typeof row.lease_token!=="string"||!UUID.test(row.lease_token)||
     (deps.tenantId!==undefined&&row.tenant_id!==deps.tenantId)){
   count("invalid_lease");continue;
  }
  const lease:Lease={tenantId:row.tenant_id,inboundId:row.inbound_message_id,
   conversationId:row.conversation_id,token:row.lease_token};
  let decision:Decision;
  try{decision=await recoverOne(db,deps,lease,now());}
  catch{decision=retry("internal_error");}
  let status:unknown=null;
  try{
   const f=await db.rpc("flow_inbound_recovery_finish",{
    p_tenant:lease.tenantId,p_inbound:lease.inboundId,p_token:lease.token,
    p_result:decision.result,p_reason:decision.reason,p_max_attempts:RECOVERY_MAX_ATTEMPTS});
   status=f?.error?null:f?.data;
  }catch{status=null;}
  if(typeof status!=="string"){
   // Lease lost or state unavailable: the row is re-leased after its expiry
   // and the claim decides; nothing is repeated blindly.
   count("finish_unconfirmed");
   console.warn("[inbound-recovery] finish unconfirmed",{code:decision.reason});
   continue;
  }
  count(status+":"+decision.reason);
  if(status==="exhausted")console.warn("[inbound-recovery] event exhausted",{code:decision.reason});
 }
 return out;
}
