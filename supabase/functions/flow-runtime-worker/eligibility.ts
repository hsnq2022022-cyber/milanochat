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
  if(typeof v.accountId!=="string"||!v.accountId||
    v.canaryAccountId!==v.accountId||v.accountTenantMatches!==true||
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
 * TEMPORARY conditions (tenant/account inactive, agent_enabled or auto_reply
 * off) and operator rollout gates (global/tenant switch, approval, canary,
 * platform) return null: the run stays sleeping and resumes when re-enabled;
 * flow_end_stale_paused_runs bounds how long it can stay paused.
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
