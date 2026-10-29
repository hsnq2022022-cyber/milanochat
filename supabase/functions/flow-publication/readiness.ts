/**
 * Authenticated advanced-flow configuration preflight.
 * Does not query customers, disclose secret values or authorize sending.
 * A green configuration is NOT proof of real Meta delivery.
 */
export type ReadinessInput={
 platform:string;
 tenantActive:boolean;
 accountActive:boolean;
 agentEnabled:boolean;
 autoReply:boolean;
 globalEnabled:boolean;
 tenantEnabled:boolean;
 productionApproved:boolean;
 creditsAvailable:boolean;
 activePublication:boolean;
 durableIngress:boolean;
 canaryMatched:boolean;
 operatorReleased:boolean;
 schedulerEnabled:boolean;
 outboxEnabled:boolean;
 atomicDebitReady:boolean;
 richButtonsEnabled:boolean;
 encryptionConfigured:boolean;
};
export function evaluateFlowReadiness(input:ReadinessInput){
 const checks={
  instagram:input.platform==="instagram",
  tenant:input.tenantActive,
  account:input.accountActive&&input.agentEnabled&&input.autoReply,
  globalSwitch:input.globalEnabled,
  tenantSwitch:input.tenantEnabled&&input.productionApproved,
  credits:input.creditsAvailable,
  activeRevision:input.activePublication,
  ingress:input.durableIngress,
  canary:input.canaryMatched,
  operatorRelease:input.operatorReleased,
  outbox:input.outboxEnabled,
  atomicDebit:input.atomicDebitReady,
  encryption:input.encryptionConfigured,
  scheduler:input.schedulerEnabled,
  buttons:input.richButtonsEnabled,
 };
 const base=["instagram","tenant","account","globalSwitch","tenantSwitch","credits",
  "activeRevision","ingress","canary","operatorRelease","outbox",
  "atomicDebit","encryption"] as const;
 const baseReady=base.every(key=>checks[key]);
 return {
  checks,
  buttonsConfigured:baseReady&&checks.buttons,
  delayConfigured:baseReady&&checks.scheduler,
  // These flags do not activate a revision, start Cron work, or send any message.
 };
}
