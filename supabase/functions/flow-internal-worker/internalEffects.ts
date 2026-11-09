/**
 * SERVER ONLY. Executor for durable Flow INTERNAL effects:
 *   tag / untag          -> flow_conversation_tags (20261028228000)
 *   staff_notification   -> flow_staff_notifications (20261028228000)
 *   handoff              -> conversations human takeover, the SAME fields the
 *                           existing automatic handoff writes (server/src/rag/
 *                           reply.ts): transferred=true,
 *                           auto_paused_reason='ai_handoff',
 *                           human_agent_expires_at=now+15 min. Like every
 *                           'ai_handoff' it stays a takeover until staff
 *                           release it (milan-api only auto-releases
 *                           'manual_takeover'; flow_conversation_human_takeover
 *                           and humanTakeoverActive agree).
 * Never calls Meta, never touches credits/billing, never logs payload text or
 * customer data (ids and codes only).
 *
 * Exactly once per effect:
 *  - claim: conditional pending -> leased transition (attempts+1, new lease
 *    token, 2 min lease) on the observed state; a crashed lease is reclaimed
 *    only after it expired. Only the claimant writes.
 *  - every write is idempotent (tag PK, notification PK = outbox id, untag =
 *    delete, handoff only when not already transferred), so re-running a
 *    crashed attempt never duplicates anything.
 *  - finish: leased -> settled only with the own lease token.
 * Failure handling: transient errors go back to pending (bounded by
 * INTERNAL_MAX_ATTEMPTS = the outbox attempts CHECK 0..3), then dead_letter;
 * permanent errors (invalid payload, no recipient, broken FK) -> dead_letter;
 * scope/lifecycle problems -> cancelled with the existing cancel reasons.
 * A final attempt whose lease expired after its write committed is verified
 * read-only (alreadyApplied) and settled, never reported as a failure.
 * dead_letter rows (kind + attempts, no reason column) are listed to the
 * owner by flow-delivery-review; cancelled rows keep cancel_reason in the
 * outbox but are NOT in that failure list (operator: SQL / worker counters).
 *
 * Ordering (per tenant + run, payload.seq inside one commit): an internal
 * effect waits until every EARLIER provider effect (message/question) of the
 * run was attempted (settled, charge_pending, uncertain) or ended (cancelled,
 * dead_letter, billing_blocked), and every earlier internal effect is
 * settled/cancelled/dead_letter. So a tag after a message never runs before
 * the message went out and a handoff (always the last effect) waits for the
 * handoff message: the takeover can therefore never cancel that message.
 * Messages are NOT held by internal effects (customer-invisible).
 *
 * Gates (all must hold, else the effect stays pending): caller-checked
 * FLOW_INTERNAL_ACTIONS_ENABLED + operator release, global switch, tenant
 * switch enabled AND production_approved, Instagram run/account, the
 * operator canary account (FLOW_DURABLE_CANARY_ACCOUNT_ID), exact active
 * revision (else cancelled 'revision_inactive'), tenant/account active and
 * agent_enabled/auto_reply on (temporary pause, like messages). Effects still
 * pending after INTERNAL_STALE_MINUTES are cancelled 'stale'.
 * Pure helpers have no Deno/npm imports (node --experimental-strip-types).
 */
import {compareOutbox,effectSeq,type OrderRow} from "../flow-outbox-worker/effectOrder.ts";

// deno-lint-ignore no-explicit-any
type Query=any;
export type InternalDb={from(table:string):Query};
type Row=Record<string,unknown>;
const record=(v:unknown):v is Row=>!!v&&typeof v==="object"&&!Array.isArray(v);

export const INTERNAL_KINDS=["tag","untag","staff_notification","handoff"] as const;
export type InternalKind=typeof INTERNAL_KINDS[number];
export const PROVIDER_KINDS=["message","question"];
export const INTERNAL_MAX_ATTEMPTS=3;
export const INTERNAL_LEASE_SECONDS=120;
export const INTERNAL_STALE_MINUTES=1440;
export const INTERNAL_SCAN_LIMIT=50;
export const INTERNAL_SIBLING_LIMIT=1000;
/** Same expiry the existing automatic handoff writes (reply.ts). */
export const HANDOFF_EXPIRY_MINUTES=15;
const TAG=/^[\p{L}\p{N}_ -]{1,64}$/u;
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Operator flags of the executor (checked before any database access). */
export function internalActionsReleased(get:(k:string)=>string|undefined):boolean{
 return get("FLOW_INTERNAL_ACTIONS_ENABLED")==="true"&&
  get("FLOW_WORKERS_OPERATOR_RELEASE")==="production-canary-approved";
}

/** Validated execution input, or null (= permanent: dead_letter). */
export function internalPayload(kind:unknown,payload:unknown):
 {kind:"tag"|"untag";tag:string}|{kind:"staff_notification";text:string}|{kind:"handoff"}|null{
 if(!record(payload)||payload.kind!==kind)return null;
 if(kind==="tag"||kind==="untag"){
  const tag=payload.tag;
  return typeof tag==="string"&&TAG.test(tag)&&tag.trim()===tag?{kind,tag}:null;
 }
 if(kind==="staff_notification"){
  const text=payload.text;
  if(typeof text!=="string"||CONTROL.test(text))return null;
  const n=Array.from(text).length;
  return n>=1&&n<=500&&text.trim().length>0?{kind,text}:null;
 }
 return kind==="handoff"?{kind}:null;
}

const PROVIDER_DONE=new Set(["settled","charge_pending","uncertain","cancelled","dead_letter","billing_blocked"]);
const INTERNAL_DONE=new Set(["settled","cancelled","dead_letter"]);
const earlier=(row:OrderRow,c:OrderRow)=>{
 const a=String(row.created_at),b=String(c.created_at);
 return a<b||(a===b&&effectSeq(row.payload)<effectSeq(c.payload));
};
/**
 * True when an earlier effect of the same tenant/run must finish first.
 * Unknown statuses hold (fail closed); delay rows never hold.
 */
export function internalHeld(candidate:OrderRow,siblings:readonly OrderRow[]):boolean{
 for(const row of siblings){
  if(row.id===candidate.id||row.tenant_id!==candidate.tenant_id||
     row.run_id!==candidate.run_id||!earlier(row,candidate))continue;
  if(PROVIDER_KINDS.includes(row.effect_kind)){
   if(!PROVIDER_DONE.has(row.delivery_status))return true;
  }else if((INTERNAL_KINDS as readonly string[]).includes(row.effect_kind)){
   if(!INTERNAL_DONE.has(row.delivery_status))return true;
  }
 }
 return false;
}

type Candidate=OrderRow&{attempts?:unknown;lease_token?:unknown;lease_expires_at?:unknown};
const iso=(ms:number)=>new Date(ms).toISOString();
const errCode=(e:unknown)=>record(e)&&typeof e.code==="string"?e.code:"unknown";
/** Class of a failed write: duplicates are success, FK/check/format are permanent. */
const failureClass=(e:unknown):"duplicate"|"permanent"|"transient"=>{
 const c=errCode(e);
 if(c==="23505")return "duplicate";
 if(c==="23503"||c==="23514"||c==="23502"||c.startsWith("22"))return "permanent";
 return "transient";
};

export type InternalDeps={
 now?:()=>number;
 canaryAccountId:string;
 newToken?:()=>string;
};
type Outcome="applied"|"noop"|"transient"|"permanent";

/**
 * One bounded tick. Returns outcome counters only (no payloads).
 * The caller must have verified internalActionsReleased() and auth.
 */
export async function runInternalEffects(sb:InternalDb,deps:InternalDeps):Promise<Record<string,number>>{
 const now=deps.now??(()=>Date.now());
 const token=deps.newToken??(()=>crypto.randomUUID());
 const out:Record<string,number>={};
 const report=(k:string)=>{out[k]=(out[k]??0)+1;};
 if(typeof deps.canaryAccountId!=="string"||!deps.canaryAccountId){report("blocked_config");return out;}
 const g=await sb.from("automation_flow_global_switch").select("enabled").eq("singleton",true).maybeSingle();
 if(g.error||g.data?.enabled!==true){report("blocked_global");return out;}
 const listed=await sb.from("automation_flow_outbox")
  .select("id,tenant_id,run_id,delivery_status,effect_kind,payload,created_at,attempts,lease_token,lease_expires_at")
  .in("effect_kind",[...INTERNAL_KINDS]).in("delivery_status",["pending","leased"])
  .order("created_at",{ascending:true}).limit(INTERNAL_SCAN_LIMIT);
 if(listed.error||!Array.isArray(listed.data)){report("list_failed");return out;}
 const nowMs=now();
 // A leased row is a candidate only once its lease expired (crashed attempt).
 const items=(listed.data as Candidate[]).filter(r=>record(r)&&
  (r.delivery_status==="pending"||(r.delivery_status==="leased"&&
   typeof r.lease_expires_at==="string"&&Date.parse(r.lease_expires_at)<=nowMs)))
  .sort(compareOutbox);
 const siblingsByTenant=new Map<string,OrderRow[]|null>();
 for(const tenantId of new Set(items.map(e=>String(e.tenant_id)))){
  const runIds=[...new Set(items.filter(e=>e.tenant_id===tenantId).map(e=>String(e.run_id)))];
  const s=await sb.from("automation_flow_outbox")
   .select("id,tenant_id,run_id,delivery_status,effect_kind,payload,created_at")
   .eq("tenant_id",tenantId).in("run_id",runIds).limit(INTERNAL_SIBLING_LIMIT);
  siblingsByTenant.set(tenantId,s.error||!Array.isArray(s.data)||s.data.length>=INTERNAL_SIBLING_LIMIT?null:
   (s.data as OrderRow[]).filter(r=>record(r)&&r.tenant_id===tenantId));
 }
 // Effects settled in this tick release later effects of the same run.
 const local=new Map<string,string>();
 for(const effect of items){
  const tenantId=String(effect.tenant_id);
  const scope=()=>{ // filters for a transition from the OBSERVED state only
   let q=(b:Query)=>b.eq("tenant_id",tenantId).eq("id",effect.id);
   if(effect.delivery_status==="pending"){const p=q;q=(b:Query)=>p(b).eq("delivery_status","pending");}
   else{const p=q;q=(b:Query)=>p(b).eq("delivery_status","leased")
    .eq("lease_token",String(effect.lease_token)).lte("lease_expires_at",iso(nowMs));}
   return q;
  };
  const end=async(status:"cancelled"|"dead_letter",reason:string|null,key:string)=>{
   const patch:Row={delivery_status:status,lease_token:null,lease_expires_at:null};
   if(status==="cancelled"){patch.cancel_reason=reason;patch.cancelled_at=iso(now());}
   const r=await scope()(sb.from("automation_flow_outbox").update(patch)).select("id");
   if(r.error||!Array.isArray(r.data)||r.data.length!==1){report("transition_failed");return;}
   local.set(effect.id,status);report(key);
   if(status==="dead_letter")console.warn("[flow-internal] effect failed terminally",
    {tenantId,outboxId:effect.id,kind:effect.effect_kind});
  };
  try{
   // Bounded wait: a pending internal effect never waits forever.
   if(Date.parse(String(effect.created_at))<=nowMs-INTERNAL_STALE_MINUTES*60000){
    await end("cancelled","stale","skipped_stale");continue;
   }
   const siblings=siblingsByTenant.get(tenantId);
   if(!siblings){report("blocked_order");continue;}
   const view=siblings.map(r=>local.has(r.id)?{...r,delivery_status:local.get(r.id)!}:r);
   if(internalHeld(effect,view)){report("held_order");continue;}
   const [sw,run,tenant]=await Promise.all([
    sb.from("automation_flow_tenant_switches").select("enabled,production_approved")
     .eq("tenant_id",tenantId).maybeSingle(),
    sb.from("automation_flow_runs")
     .select("id,tenant_id,channel_account_id,platform,conversation_id,flow_key,publication_revision")
     .eq("tenant_id",tenantId).eq("id",String(effect.run_id)).maybeSingle(),
    sb.from("tenants").select("id,is_active,user_id").eq("id",tenantId).maybeSingle()
   ]);
   if(sw.error||run.error||tenant.error){report("blocked");continue;}
   if(sw.data?.enabled!==true||sw.data?.production_approved!==true){report("blocked_switch");continue;}
   const r=run.data;
   if(!record(r)||r.tenant_id!==tenantId||r.id!==effect.run_id||!record(tenant.data)||
      tenant.data.id!==tenantId){await end("cancelled","ineligible","skipped_ineligible");continue;}
   if(r.platform!=="instagram"){await end("cancelled","ineligible","skipped_ineligible");continue;}
   const [account,conversation,activation]=await Promise.all([
    sb.from("channel_accounts").select("id,tenant_id,platform,is_active,agent_enabled,auto_reply")
     .eq("tenant_id",tenantId).eq("id",String(r.channel_account_id)).maybeSingle(),
    sb.from("conversations").select("id,tenant_id,account_id,transferred")
     .eq("tenant_id",tenantId).eq("id",String(r.conversation_id)).maybeSingle(),
    sb.from("automation_flow_activations").select("revision,is_active")
     .eq("tenant_id",tenantId).eq("channel_account_id",String(r.channel_account_id))
     .eq("platform","instagram").eq("flow_key",String(r.flow_key))
     .eq("revision",r.publication_revision as number).eq("is_active",true).maybeSingle()
   ]);
   if(account.error||conversation.error||activation.error){report("blocked");continue;}
   const a=account.data,c=conversation.data;
   if(!record(a)||!record(c)||a.tenant_id!==tenantId||c.tenant_id!==tenantId||
      a.id!==r.channel_account_id||a.platform!=="instagram"||c.id!==r.conversation_id||
      c.account_id!==a.id){await end("cancelled","ineligible","skipped_ineligible");continue;}
   if(a.id!==deps.canaryAccountId){report("blocked_canary");continue;}
   if(activation.data?.is_active!==true){
    await end("cancelled","revision_inactive","skipped_revision_inactive");continue;
   }
   if(tenant.data.is_active!==true||a.is_active!==true||a.agent_enabled!==true||a.auto_reply!==true){
    report("paused");continue;
   }
   const input=internalPayload(effect.effect_kind,effect.payload);
   if(!input){await end("dead_letter",null,"failed_invalid");continue;}
   const attempts=Number(effect.attempts??0);
   if(!Number.isSafeInteger(attempts)||attempts<0||attempts>=INTERNAL_MAX_ATTEMPTS){
    // The FINAL attempt crashed after its lease was taken (expired lease):
    // its write may have committed before the settle was lost. No further
    // attempt is allowed (attempts CHECK 0..3), so verify read-only and
    // settle an already applied effect instead of reporting a false failure.
    if(effect.delivery_status==="leased"&&Number.isSafeInteger(attempts)){
     const done=await alreadyApplied(sb,input,{tenantId,conversationId:String(r.conversation_id),
      accountId:String(a.id),outboxId:effect.id});
     if(done===null){report("blocked");continue;}
     if(done){
      const s=await scope()(sb.from("automation_flow_outbox")
       .update({delivery_status:"settled",lease_token:null,lease_expires_at:null})).select("id");
      if(s.error||!Array.isArray(s.data)||s.data.length!==1){report("transition_failed");continue;}
      local.set(effect.id,"settled");report(effect.effect_kind+"_recovered");continue;
     }
    }
    await end("dead_letter",null,"failed_exhausted");continue;
   }
   // Claim (exactly one claimant).
   const mine=token();
   const claimed=await scope()(sb.from("automation_flow_outbox").update({
    delivery_status:"leased",attempts:attempts+1,lease_token:mine,
    lease_expires_at:iso(now()+INTERNAL_LEASE_SECONDS*1000)
   })).eq("attempts",attempts).select("id");
   if(claimed.error||!Array.isArray(claimed.data)||claimed.data.length!==1){report("busy");continue;}
   const result=await execute(sb,input,{tenantId,outboxId:effect.id,
    conversationId:String(r.conversation_id),accountId:String(a.id),
    ownerId:typeof tenant.data.user_id==="string"?tenant.data.user_id:null,nowMs:now()});
   const mineScope=(b:Query)=>b.eq("tenant_id",tenantId).eq("id",effect.id)
    .eq("delivery_status","leased").eq("lease_token",mine);
   let patch:Row;
   if(result==="applied"||result==="noop")
    patch={delivery_status:"settled",lease_token:null,lease_expires_at:null};
   else if(result==="permanent"||attempts+1>=INTERNAL_MAX_ATTEMPTS)
    patch={delivery_status:"dead_letter",lease_token:null,lease_expires_at:null};
   else patch={delivery_status:"pending",lease_token:null,lease_expires_at:null};
   const fin=await mineScope(sb.from("automation_flow_outbox").update(patch)).select("id");
   if(fin.error||!Array.isArray(fin.data)||fin.data.length!==1){
    // Lease expires; the idempotent write is re-checked by the next claimant.
    console.error("[flow-internal] finish failed",{tenantId,outboxId:effect.id,code:errCode(fin.error)});
    report("finish_failed");continue;
   }
   local.set(effect.id,String(patch.delivery_status));
   if(patch.delivery_status==="dead_letter")console.warn("[flow-internal] effect failed terminally",
    {tenantId,outboxId:effect.id,kind:effect.effect_kind});
   report(patch.delivery_status==="settled"?(effect.effect_kind+"_"+result):
    patch.delivery_status==="dead_letter"?"failed_"+result:"retry_"+result);
  }catch(e){
   console.error("[flow-internal] effect error",{tenantId,outboxId:effect.id,
    type:e instanceof Error?e.name:"unknown"});
   report("error");
  }
 }
 return out;
}

type Ctx={tenantId:string;outboxId:string;conversationId:string;accountId:string;
 ownerId:string|null;nowMs:number};
/**
 * READ-ONLY: is the effect's outcome already in place (what a re-run would
 * treat as applied/noop)? true/false, null = lookup failed (retry next tick).
 * tag: the tag exists; untag: it is absent; notification: its row (PK =
 * outbox id) exists; handoff: the conversation is transferred. Tenant-scoped.
 */
async function alreadyApplied(sb:InternalDb,input:NonNullable<ReturnType<typeof internalPayload>>,
 ctx:Pick<Ctx,"tenantId"|"conversationId"|"accountId"|"outboxId">):Promise<boolean|null>{
 if(input.kind==="tag"||input.kind==="untag"){
  const t=await sb.from("flow_conversation_tags").select("tag").eq("tenant_id",ctx.tenantId)
   .eq("conversation_id",ctx.conversationId).eq("tag",input.tag).maybeSingle();
  if(t.error)return null;
  return input.kind==="tag"?record(t.data):!record(t.data);
 }
 if(input.kind==="staff_notification"){
  const n=await sb.from("flow_staff_notifications").select("outbox_id").eq("tenant_id",ctx.tenantId)
   .eq("outbox_id",ctx.outboxId).maybeSingle();
  return n.error?null:record(n.data);
 }
 const c=await sb.from("conversations").select("id,transferred").eq("tenant_id",ctx.tenantId)
  .eq("id",ctx.conversationId).eq("account_id",ctx.accountId).maybeSingle();
 return c.error?null:record(c.data)&&c.data.transferred===true;
}
/** Kind-specific idempotent write; every statement carries tenant_id. */
async function execute(sb:InternalDb,
 input:NonNullable<ReturnType<typeof internalPayload>>,ctx:Ctx):Promise<Outcome>{
 const fail=(e:unknown,where:string):Outcome=>{
  const k=failureClass(e);
  if(k==="duplicate")return "noop";
  console.error("[flow-internal] write failed",{tenantId:ctx.tenantId,outboxId:ctx.outboxId,where,code:errCode(e)});
  return k;
 };
 if(input.kind==="tag"){
  const r=await sb.from("flow_conversation_tags").insert({tenant_id:ctx.tenantId,
   conversation_id:ctx.conversationId,tag:input.tag,created_by_outbox:ctx.outboxId});
  return r.error?fail(r.error,"tag"):"applied";
 }
 if(input.kind==="untag"){
  const r=await sb.from("flow_conversation_tags").delete().eq("tenant_id",ctx.tenantId)
   .eq("conversation_id",ctx.conversationId).eq("tag",input.tag);
  return r.error?fail(r.error,"untag"):"applied";
 }
 if(input.kind==="staff_notification"){
  // Same recipient rule as flow_apply_internal_effect: the oldest active
  // assignment of an active agent/admin, else the tenant owner. No broadcast.
  const as=await sb.from("tenant_conversation_assignments").select("tenant_id,user_id,created_at")
   .eq("tenant_id",ctx.tenantId).eq("conversation_id",ctx.conversationId).eq("status","active")
   .order("created_at",{ascending:true}).limit(20);
  if(as.error)return fail(as.error,"assignments");
  const assigned=(Array.isArray(as.data)?as.data as Row[]:[])
   .filter(x=>record(x)&&x.tenant_id===ctx.tenantId&&typeof x.user_id==="string")
   .sort((x,y)=>String(x.created_at).localeCompare(String(y.created_at))||
    String(x.user_id).localeCompare(String(y.user_id)));
  let recipient:string|null=null;
  if(assigned.length){
   const ms=await sb.from("tenant_staff_memberships").select("tenant_id,user_id,role,status")
    .eq("tenant_id",ctx.tenantId).in("user_id",assigned.map(x=>x.user_id as string))
    .eq("status","active").limit(20);
   if(ms.error)return fail(ms.error,"memberships");
   const ok=new Set((Array.isArray(ms.data)?ms.data as Row[]:[]).filter(m=>record(m)&&
    m.tenant_id===ctx.tenantId&&m.status==="active"&&(m.role==="agent"||m.role==="admin"))
    .map(m=>m.user_id as string));
   recipient=(assigned.find(x=>ok.has(x.user_id as string))?.user_id as string|undefined)??null;
  }
  recipient=recipient??ctx.ownerId;
  if(!recipient)return "permanent";
  const r=await sb.from("flow_staff_notifications").insert({tenant_id:ctx.tenantId,
   outbox_id:ctx.outboxId,conversation_id:ctx.conversationId,recipient_user_id:recipient,body:input.text});
  return r.error?fail(r.error,"notification"):"applied";
 }
 // handoff: only a conversation not yet under takeover is switched, so an
 // existing manual takeover (and its expiry) is never overwritten.
 const patch={transferred:true,auto_paused_reason:"ai_handoff",
  human_agent_expires_at:iso(ctx.nowMs+HANDOFF_EXPIRY_MINUTES*60000)};
 const base=(b:Query)=>b.eq("tenant_id",ctx.tenantId).eq("id",ctx.conversationId)
  .eq("account_id",ctx.accountId);
 const u=await base(sb.from("conversations").update(patch)).eq("transferred",false).select("id");
 if(u.error)return fail(u.error,"handoff");
 if(Array.isArray(u.data)&&u.data.length===1){
  console.info("[flow-internal] conversation handed off",{tenantId:ctx.tenantId,outboxId:ctx.outboxId});
  return "applied";
 }
 const n=await base(sb.from("conversations").update(patch)).is("transferred",null).select("id");
 if(n.error)return fail(n.error,"handoff");
 if(Array.isArray(n.data)&&n.data.length===1)return "applied";
 // Already transferred (e.g. staff took over first) -> nothing to do.
 const cur=await base(sb.from("conversations").select("id,transferred")).maybeSingle();
 if(cur.error)return fail(cur.error,"handoff");
 return record(cur.data)&&cur.data.transferred===true?"noop":"permanent";
}
