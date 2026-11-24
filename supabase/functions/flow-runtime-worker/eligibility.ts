import {durableAccountAllowed} from "../_shared/durableAccounts.ts";
/** Fail-closed eligibility for one durable wake, independent of the lease RPC. */
export type WakeEligibility={
  runPlatform:unknown;
  runStatus:unknown;
  runRevision:unknown;
  /** false only when the tenant row lookup succeeded and returned no row. */
  tenantFound?:unknown;
  tenantActive:unknown;
  tenantSwitchEnabled:unknown;
  tenantTestOnly:unknown;
  tenantProductionApproved:unknown;
  globalEnabled:unknown;
  accountId:unknown;
  canaryAccountId:unknown;
  accountTenantMatches:unknown;
  accountActive:unknown;
  agentEnabled:unknown;
  autoReply:unknown;
  conversationTenantMatches:unknown;
  conversationAccountMatches:unknown;
  /** conversations.transferred */
  humanTransferred:unknown;
  /** conversations.human_agent_expires_at (canonical; human_agent_until does not exist). */
  humanAgentExpiresAt:unknown;
  /** conversations.auto_paused_reason */
  humanPausedReason:unknown;
  activeRevision:unknown;
  revisionIsActive:unknown;
  /**
   * The operator registry holds exactly this tenant/account/platform (same question as the SQL claim
   * flow_claim_inbound_durable). Required unless the tenant is test_only (that mode never used it).
   * Absent / not exactly true = NOT registered. The REGISTRY is a hold that must not burn the run's
   * retry budget: flow_lease_due_runs (20261115160000) never leases a registry-blocked run, and when
   * the worker still meets one after leasing (removal between lease and check, or a registry read
   * error) it RELEASES the lease (registryOnlyHold) instead of failing it. The run stays sleeping and
   * resumes after re-registration; flow_end_stale_paused_runs ends it 24 hours past wake_at.
   * (A removed ALLOWLIST entry is different: it still fails the lease, see wakeEndReason.)
   */
  registryRegistered?:unknown;
};
/**
 * Same rule as milan-api (lazy expiry ~index.ts:1672-1700) and the SQL helper
 * flow_conversation_human_takeover (20261029150000): a takeover is active while
 * transferred is true, unless its human_agent_expires_at has passed for a
 * 'manual_takeover' (the only case milan-api releases automatically). Any
 * other transferred=true (e.g. 'ai_handoff', no reason) stays active until a
 * human releases it. Malformed values fail closed (= takeover).
 */
export function humanTakeoverActive(transferred:unknown,expiresAt:unknown,
  pausedReason:unknown,nowMs:number):boolean{
  if(transferred==null||transferred===false)return false;
  if(transferred!==true)return true;
  if(expiresAt==null)return true;
  if(typeof expiresAt!=="string")return true;
  const t=Date.parse(expiresAt);
  if(!Number.isFinite(t)||!Number.isFinite(nowMs)||t>nowMs)return true;
  return pausedReason!=="manual_takeover";
}
export function canWakeDurableRun(v:WakeEligibility,nowMs:number):boolean{
  if(!Number.isFinite(nowMs))return false;
  if(v.runPlatform!=="instagram"||v.runStatus!=="sleeping"||
    !Number.isSafeInteger(v.runRevision)||typeof v.runRevision!=="number"||
    v.runRevision<1||v.activeRevision!==v.runRevision||
    v.revisionIsActive!==true)return false;
  if(v.globalEnabled!==true||v.tenantFound===false||v.tenantActive!==true||
    v.tenantSwitchEnabled!==true||
    (v.tenantTestOnly!==true&&v.tenantProductionApproved!==true))return false;
  if(v.tenantTestOnly!==true&&v.registryRegistered!==true)return false;
  if(typeof v.accountId!=="string"||!v.accountId||
    !durableAccountAllowed(v.canaryAccountId,v.accountId)||v.accountTenantMatches!==true||
    v.accountActive!==true||v.agentEnabled!==true||v.autoReply!==true)return false;
  if(v.conversationTenantMatches!==true||v.conversationAccountMatches!==true)return false;
  return !humanTakeoverActive(v.humanTransferred,v.humanAgentExpiresAt,
    v.humanPausedReason,nowMs);
}
/**
 * Why a wake that canWakeDurableRun refused should END the run (null = leave
 * it sleeping). Only PERMANENT conditions end it:
 *  - revision_inactive: exact revision gone or deactivated;
 *  - human_takeover: a human took over (kept terminal by design: the flow does
 *    not resume behind the agent's back after the takeover ends);
 *  - ineligible: tenant row gone, account/conversation ownership mismatch or
 *    conversation gone.
 * TEMPORARY conditions the SQL knows about (tenant/account inactive, agent_enabled or auto_reply
 * off, tenant switch / approval) never reach this worker: flow_lease_due_runs does not lease them
 * and flow_end_stale_paused_runs ends them 24 hours past wake_at. The OPERATOR REGISTRY is handled
 * the same way (flow_registry_blocks_run, 20261115160000), and a registry refusal that still
 * arrives here is a lease RELEASE (registryOnlyHold), not a failure.
 * Gates only this worker evaluates return null here. The FLOW_DURABLE_CANARY_ACCOUNT_ID allowlist is
 * PARKED when FLOW_WAKE_MAX_OVERDUE_MINUTES is valid (allowlistOnlyHold; the overdue bound then ends
 * the run), and otherwise, like the platform gate and every other refusal, the worker FAILS the lease:
 * the run stays sleeping, but every re-lease adds an attempt and the 4th lease ends it as
 * lease_exhausted (about 6 minutes), the previous behaviour.
 */
export type WakeEndReason="revision_inactive"|"human_takeover"|"ineligible";
export function wakeEndReason(v:WakeEligibility,nowMs:number):WakeEndReason|null{
  if(v.runStatus!=="sleeping")return null;
  if(v.activeRevision!==v.runRevision||v.revisionIsActive!==true)return "revision_inactive";
  if(v.conversationTenantMatches===true&&v.conversationAccountMatches===true&&
    humanTakeoverActive(v.humanTransferred,v.humanAgentExpiresAt,v.humanPausedReason,
      Number.isFinite(nowMs)?nowMs:Number.NaN))return "human_takeover";
  if(v.tenantFound===false||v.accountTenantMatches!==true||
    v.conversationTenantMatches!==true||v.conversationAccountMatches!==true)return "ineligible";
  return null;
}
/**
 * True when the ONLY thing refusing this wake is the operator registry: the same facts with the
 * registry satisfied would pass canWakeDurableRun. The worker then releases the lease (no attempt
 * consumed) instead of failing the lease. Any other refusal (or a permanent end reason) is unchanged.
 */
export function registryOnlyHold(v:WakeEligibility,nowMs:number):boolean{
  return v.tenantTestOnly!==true&&v.registryRegistered!==true&&
    canWakeDurableRun({...v,registryRegistered:true},nowMs);
}
/**
 * How long an ALLOWLIST-held run's lease is parked (minutes). Equal to the smallest valid
 * FLOW_WAKE_MAX_OVERDUE_MINUTES (overdueGuard.ts), so the overdue bound is checked at least that
 * often and a re-allowlisted account resumes within this time with no manual step.
 */
export const ALLOWLIST_PARK_MINUTES=5;
/**
 * True when the ONLY thing refusing this wake is the FLOW_DURABLE_CANARY_ACCOUNT_ID allowlist: the
 * account is not in it (also when the secret is unset or malformed, which admits nobody), and with the
 * allowlist satisfied every other fact (registry in production, tenant/account state, takeover,
 * revision, ownership) passes canWakeDurableRun. Registry-also-missing, a registry read error, a
 * permanent end reason or any other refusal is NOT an allowlist-only hold.
 */
export function allowlistOnlyHold(v:WakeEligibility,nowMs:number):boolean{
  if(durableAccountAllowed(v.canaryAccountId,v.accountId))return false;
  return canWakeDurableRun({...v,canaryAccountId:v.accountId},nowMs);
}
