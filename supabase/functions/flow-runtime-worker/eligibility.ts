/** Fail-closed eligibility for one durable wake, independent of the lease RPC. */
export type WakeEligibility={
  runPlatform:unknown;
  runStatus:unknown;
  runRevision:unknown;
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
  humanTransferred:unknown;
  humanAgentUntil:unknown;
  activeRevision:unknown;
  revisionIsActive:unknown;
};
export function canWakeDurableRun(v:WakeEligibility,nowMs:number):boolean{
  if(v.runPlatform!=="instagram"||v.runStatus!=="sleeping"||
    !Number.isSafeInteger(v.runRevision)||typeof v.runRevision!=="number"||
    v.runRevision<1||v.activeRevision!==v.runRevision||
    v.revisionIsActive!==true)return false;
  if(v.globalEnabled!==true||v.tenantActive!==true||
    v.tenantSwitchEnabled!==true||
    (v.tenantTestOnly!==true&&v.tenantProductionApproved!==true))return false;
  if(typeof v.accountId!=="string"||!v.accountId||
    v.canaryAccountId!==v.accountId||v.accountTenantMatches!==true||
    v.accountActive!==true||v.agentEnabled!==true||v.autoReply!==true)return false;
  if(v.conversationTenantMatches!==true||
    v.conversationAccountMatches!==true||v.humanTransferred===true)return false;
  if(v.humanAgentUntil!=null){
    if(typeof v.humanAgentUntil!=="string")return false;
    const until=Date.parse(v.humanAgentUntil);
    if(!Number.isFinite(until)||!Number.isFinite(nowMs)||until>nowMs)return false;
  }
  return Number.isFinite(nowMs);
}
