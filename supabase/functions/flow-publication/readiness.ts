/**
 * Authenticated advanced-flow configuration preflight.
 * Does not query customers, disclose secret values or authorize sending.
 * A green configuration is NOT proof of real Meta delivery.
 */
export type ReadinessInput={
 platform:string;
 /**
  * Derived from the actual document by durableCandidateKind (milan-api
  * flowDurableIngress.ts, the same whitelist the live ingress uses):
  * buttons = needs the buttons sender, delay = needs the scheduler,
  * mixed = needs both, text = needs neither, unsupported = not live.
  */
 candidateKind:"buttons"|"delay"|"mixed"|"text"|"unsupported";
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
 activationApproved:boolean;
 canaryMatched:boolean;
 operatorReleased:boolean;
 schedulerEnabled:boolean;
 outboxEnabled:boolean;
 atomicDebitReady:boolean;
 richButtonsEnabled:boolean;
 encryptionConfigured:boolean;
 /**
  * The graph contains tag/untag/notify/handoff nodes (durableNeedsInternalActions,
  * same whitelist): the internal executor flag is then required. Optional so
  * older callers keep their exact results (absent = not needed).
  */
 needsInternalActions?:boolean;
 /** FLOW_INTERNAL_ACTIONS_ENABLED==="true" (internal executor released). */
 internalActionsEnabled?:boolean;
 /**
  * The document has image content (publicationGate.ts flowNeedsMedia).
  * Optional so older callers keep their exact results (absent = not needed).
  */
 needsMedia?:boolean;
 /** message:image in FLOW_ACTIVATION_CAPABILITIES AND FLOW_MEDIA_SEND_ENABLED==="true". */
 mediaEnabled?:boolean;
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
  supportedCandidate:input.candidateKind!=="unsupported",
  ingress:input.durableIngress,
  activation:input.activationApproved,
  canary:input.canaryMatched,
  operatorRelease:input.operatorReleased,
  outbox:input.outboxEnabled,
  atomicDebit:input.atomicDebitReady,
  encryption:input.encryptionConfigured,
  scheduler:input.schedulerEnabled,
  buttons:input.richButtonsEnabled,
  internalActions:input.internalActionsEnabled===true,
  media:input.mediaEnabled===true,
 };
 const base=["instagram","tenant","account","globalSwitch","tenantSwitch","credits",
  "activeRevision","supportedCandidate","ingress","activation","canary","operatorRelease","outbox",
  "atomicDebit","encryption"] as const;
 const baseReady=base.every(key=>checks[key]);
 const needsButtons=input.candidateKind==="buttons"||input.candidateKind==="mixed";
 const needsScheduler=input.candidateKind==="delay"||input.candidateKind==="mixed";
 const needsInternalActions=input.needsInternalActions===true;
 const internalOk=!needsInternalActions||checks.internalActions;
 const needsMedia=input.needsMedia===true;
 const extraOk=internalOk&&(!needsMedia||checks.media);
 return {
  checks,
  candidateKind:input.candidateKind,
  needsButtons,
  needsScheduler,
  needsInternalActions,
  needsMedia,
  buttonsConfigured:baseReady&&checks.buttons&&input.candidateKind==="buttons"&&extraOk,
  delayConfigured:baseReady&&checks.scheduler&&input.candidateKind==="delay"&&extraOk,
  // Any supported kind: every base gate plus exactly the flags its nodes need.
  configured:baseReady&&input.candidateKind!=="unsupported"&&
   (!needsButtons||checks.buttons)&&(!needsScheduler||checks.scheduler)&&extraOk,
  // These flags do not activate a revision, start Cron work, or send any message.
 };
}
