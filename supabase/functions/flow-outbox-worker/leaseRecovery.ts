/**
 * Recovery of ABANDONED provider-delivery leases (message / question /
 * message_image). No provider call, no fetch, no billing, no resend.
 *
 * flow_reserve_outbox_delivery sets delivery_status='leased' and
 * lease_expires_at=now()+2 minutes and inserts the one-shot attempt row
 * ('attempting'). If the worker is killed (wall-clock limit, crash) or the
 * finish RPC fails after the reserve, the row stays 'leased' forever: it is not
 * listed by the tick, not shown in delivery review, and it holds the later
 * effects of its run. Whether the provider received the message is UNKNOWN,
 * so the row is finished exactly like a send-time failure: outcome
 * 'uncertain' with a NULL provider message id through the existing
 * flow_finish_outbox_delivery (same arguments executeOnce -> confirm
 * ("uncertain",null) uses). The RPC only acts on its own tenant's row whose
 * attempt is still 'attempting' and whose outbox row is still 'leased', so a
 * row that advanced meanwhile (charge_pending / settled / uncertain) is a
 * no-op. The row is NEVER reset to 'pending' (never resent).
 *
 * Grace (LEASE_RECOVERY_GRACE_MS): a live invocation can still be in flight
 * after lease_expires_at. The invocation that reserved the row cannot outlive
 * the Edge wall-clock limit (documented Supabase limit, not a repo value:
 * 150 s free / 400 s paid), so it ends at the latest reserve+400 s =
 * lease_expires_at+280 s. Required: grace > 400 s - 120 s = 280 s. Chosen:
 * 13 minutes, so recovery happens 15 minutes after the reserve, the same
 * "abandoned attempt" age the repo already uses
 * (flow_queue_outbox_human_review default p_min_age_minutes=15,
 * 20261028226000), about 3x the bound, and well below the 60 minute stale
 * sweep (OUTBOX_STALE_MINUTES).
 */
export const LEASE_RECOVERY_KINDS:readonly string[]=["message","question","message_image"];
/** Mirror of `interval '2 minutes'` in flow_reserve_outbox_delivery. */
export const OUTBOX_DELIVERY_LEASE_SECONDS=120;
/** Documented Supabase Edge wall-clock limit (paid plans; free: 150 s). */
export const EDGE_WALL_CLOCK_MAX_SECONDS=400;
export const LEASE_RECOVERY_GRACE_MS=13*60_000;
/**
 * Rows recovered per tick, oldest lease first. A tick can abandon at most
 * OUTBOX_DISPATCH_LIMIT (10) reservations (one per dispatched effect), so 2x
 * that always outpaces creation while bounding the pass to 20 small RPCs.
 */
/** 2 x OUTBOX_DISPATCH_LIMIT (skipPolicy.ts; pinned by flow-outbox-lease-recovery.test.ts). This module stays import-free. */
export const LEASE_RECOVERY_LIMIT=80;
export const LEASE_RECOVERY_COLUMNS="id,tenant_id,delivery_status,effect_kind,lease_expires_at";

export type LeaseCandidate={id:string;tenantId:string;expiresMs:number};
export type LeaseRecoveryReport={
 lookupFailed:boolean;eligible:number;recovered:number;unchanged:number;failed:number;
};
// Same convention as flow-internal-worker/internalEffects.ts (InternalDb).
// deno-lint-ignore no-explicit-any
type Query=any;
/** The subset of the Supabase client used here (one read + one RPC; no writes). */
export type LeaseRecoveryClient={from(table:string):Query;rpc(fn:string,args:Record<string,unknown>):Query};

/** Leases expiring strictly before this instant are recoverable. */
export function leaseRecoveryCutoffMs(nowMs:number):number{return nowMs-LEASE_RECOVERY_GRACE_MS;}

/** Exact flow_finish_outbox_delivery arguments of a send-time uncertain outcome. */
export function leaseRecoveryFinishArgs(tenantId:string,outboxId:string){
 return {p_tenant:tenantId,p_outbox:outboxId,p_result:"uncertain",p_provider_message_id:null};
}

/** Defense in depth over the query filters: leased, provider kind, expired past grace; bounded, oldest first. */
export function recoverableLeases(rows:unknown,nowMs:number,limit=LEASE_RECOVERY_LIMIT):LeaseCandidate[]{
 if(!Array.isArray(rows))return [];
 const cutoff=leaseRecoveryCutoffMs(nowMs);
 const out:LeaseCandidate[]=[];
 for(const r of rows){
  if(!r||typeof r!=="object")continue;
  const row=r as Record<string,unknown>;
  if(row.delivery_status!=="leased"||!LEASE_RECOVERY_KINDS.includes(String(row.effect_kind)))continue;
  if(typeof row.id!=="string"||!row.id||typeof row.tenant_id!=="string"||!row.tenant_id)continue;
  if(typeof row.lease_expires_at!=="string")continue;
  const expiresMs=Date.parse(row.lease_expires_at);
  if(!Number.isFinite(expiresMs)||!(expiresMs<cutoff))continue;
  out.push({id:row.id,tenantId:row.tenant_id,expiresMs});
 }
 out.sort((a,b)=>a.expiresMs-b.expiresMs||a.id.localeCompare(b.id));
 return out.slice(0,Math.max(0,limit));
}

/**
 * One bounded pass. Never throws; logs fixed tags and aggregate counts only
 * (no ids, tenant ids, text or tokens).
 */
export async function recoverAbandonedLeases(sb:LeaseRecoveryClient,nowMs:number):Promise<LeaseRecoveryReport>{
 const report:LeaseRecoveryReport={lookupFailed:false,eligible:0,recovered:0,unchanged:0,failed:0};
 let rows:unknown;
 try{
  const {data,error}=await sb.from("automation_flow_outbox").select(LEASE_RECOVERY_COLUMNS)
   .eq("delivery_status","leased").in("effect_kind",LEASE_RECOVERY_KINDS)
   .lt("lease_expires_at",new Date(leaseRecoveryCutoffMs(nowMs)).toISOString())
   .order("lease_expires_at",{ascending:true}).limit(LEASE_RECOVERY_LIMIT);
  if(error)throw error;
  rows=data;
 }catch{
  report.lookupFailed=true;
  console.error("[outbox] lease recovery lookup failed");
  return report;
 }
 const candidates=recoverableLeases(rows,nowMs);
 report.eligible=candidates.length;
 for(const c of candidates){
  try{
   // Tenant from the row itself; the RPC scopes every write by it.
   const {data,error}=await sb.rpc("flow_finish_outbox_delivery",leaseRecoveryFinishArgs(c.tenantId,c.id));
   if(error)throw error;
   if(data===true)report.recovered++;else report.unchanged++;
  }catch{
   report.failed++;
  }
 }
 if(report.failed)console.error("[outbox] lease recovery finish failed",{failed:report.failed});
 if(report.eligible)console.info("[outbox] lease recovery",{eligible:report.eligible,
  recovered:report.recovered,unchanged:report.unchanged,failed:report.failed});
 return report;
}
