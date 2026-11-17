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
 /**
  * Present ONLY when the server-stored document has a comment trigger (and is
  * not a durable DM graph). Every field is server-derived: never from a browser.
  * Absent = exactly the previous (DM) readiness.
  */
 comment?:CommentReadinessInput;
};
export type CommentReadinessInput={
 /** commentFlowPlan(stored document, account platform)!==null (graph + trigger config incl. public reply). */
 planValid:boolean;
 /** FLOW_COMMENT_AUTOMATION_ENABLED==="true" (server env, fail-closed). */
 commentAutomationEnabled:boolean;
 /** FLOW_MULTICHANNEL_ENABLED==="true" (server env, fail-closed; Facebook Page comments). */
 multichannelEnabled:boolean;
};
type Text={ar:string;en:string};
export type CommentReadinessReason="ok"|"no_comment_surface"|"comment_automation_off"|
 "multichannel_off"|"invalid_comment_flow";
export type CommentReadiness={
 platform:string;
 supported:boolean;
 status:"supported"|"unsupported";
 /** Platform-specific check title (a Facebook flow never shows an Instagram requirement). */
 label:Text;
 /** «مدعوم» / «غير مدعوم». */
 statusLabel:Text;
 reason:CommentReadinessReason;
 detail:Text;
};

/** The stored document has a comment-mode trigger (any platform). Pure, never throws. */
export function documentHasCommentTrigger(doc:unknown):boolean{
 if(!doc||typeof doc!=="object"||Array.isArray(doc))return false;
 const nodes=(doc as {nodes?:unknown}).nodes;
 return Array.isArray(nodes)&&nodes.some(n=>!!n&&typeof n==="object"&&
  (n as {data?:{kind?:unknown;triggerMode?:unknown}}).data?.kind==="trigger"&&
  (n as {data:{triggerMode?:unknown}}).data.triggerMode==="comment");
}

const COMMENT_LABEL:Record<string,Text>={
 instagram:{ar:"مشغّل التعليقات (Instagram)",en:"Comment trigger (Instagram)"},
 facebook:{ar:"مشغّل التعليقات (صفحة Facebook)",en:"Comment trigger (Facebook Page)"},
 whatsapp:{ar:"مشغّل التعليقات (WhatsApp)",en:"Comment trigger (WhatsApp)"},
};
const COMMENT_DETAIL:Record<Exclude<CommentReadinessReason,"ok">,Text>={
 no_comment_surface:{ar:"لا يوفّر WhatsApp تعليقات، لذلك لا يمكن تشغيل تدفق تعليقات عليه.",
  en:"WhatsApp has no comments, so a comment flow cannot run on it."},
 comment_automation_off:{ar:"أتمتة التعليقات غير مفعّلة على الخادم.",
  en:"Comment automation is not enabled on the server."},
 multichannel_off:{ar:"تعليقات صفحات Facebook غير مفعّلة على الخادم.",
  en:"Facebook Page comments are not enabled on the server."},
 invalid_comment_flow:{ar:"المدعوم فقط: مشغّل تعليق مع نص رد عام ← رسالة خاصة نصية واحدة (← نهاية اختيارية).",
  en:"Only supported shape: comment trigger with public reply text -> one plain private message (-> optional end)."},
};
const COMMENT_OK:Record<string,Text>={
 instagram:{ar:"تعليقات Instagram مفعّلة على الخادم: رد عام ثم رسالة خاصة واحدة.",
  en:"Instagram comments are enabled on the server: public reply, then one private message."},
 facebook:{ar:"تعليقات صفحة Facebook مفعّلة على الخادم: رد عام ثم رسالة خاصة واحدة.",
  en:"Facebook Page comments are enabled on the server: public reply, then one private message."},
};

/**
 * Same platform rule as productionActivationAuthorized(...,{commentTrigger:true})
 * plus FLOW_COMMENT_AUTOMATION_ENABLED, which the activate action requires for
 * every comment graph: instagram = comment flag; facebook = comment flag AND
 * multichannel flag; whatsapp/other = never (no comment surface). Fail-closed:
 * only the boolean true enables anything.
 */
export function evaluateCommentReadiness(platform:string,c:CommentReadinessInput):CommentReadiness{
 const reason:CommentReadinessReason=
  platform!=="instagram"&&platform!=="facebook"?"no_comment_surface":
  c.commentAutomationEnabled!==true?"comment_automation_off":
  platform==="facebook"&&c.multichannelEnabled!==true?"multichannel_off":
  c.planValid!==true?"invalid_comment_flow":"ok";
 const supported=reason==="ok";
 return {
  platform,supported,status:supported?"supported":"unsupported",
  label:COMMENT_LABEL[platform]??{ar:"مشغّل التعليقات",en:"Comment trigger"},
  statusLabel:supported?{ar:"مدعوم",en:"Supported"}:{ar:"غير مدعوم",en:"Not supported"},
  reason,
  detail:reason==="ok"?COMMENT_OK[platform]:COMMENT_DETAIL[reason],
 };
}

/**
 * Why activeRevision / supportedCandidate are false (null = that check passed):
 * - no_active_revision: the flow has no active activation row on this account;
 * - no_candidate_revision: no revision was requested and the flow has no
 *   active one, so NO document was examined (candidateKind "unsupported" then
 *   means "nothing examined", not "the document is unsupported");
 * - revision_not_found: the requested/active revision has no publication;
 * - not_durable_v2: a V2 simple-engine document (not a durable candidate);
 * - not_durable: neither a durable, V2 nor supported comment document;
 * - unsupported_comment_flow: a comment-trigger document that cannot run here.
 */
export type ReadinessCandidateReason="no_active_revision"|"no_candidate_revision"|
 "revision_not_found"|"not_durable_v2"|"not_durable"|"unsupported_comment_flow";
export type ReadinessCandidate={
 flowKey:string;
 /** Exactly the examined revision (requested, else the flow's active one), null = none. */
 revision:number|null;
 source:"requested"|"active"|"none";
 found:boolean;
 /** The flow's own active revision on this account, null = OFF. Never another flow's. */
 activeRevision:number|null;
 /** Engine the examined document targets, null = none examined or not runnable. */
 engine:"durable"|"v2"|"comment"|null;
 reasons:{activeRevision:ReadinessCandidateReason|null;supportedCandidate:ReadinessCandidateReason|null};
};
/** Pure: additive diagnostics for the readiness report. Never changes a check. */
export function readinessCandidate(i:{flowKey:string;requested:boolean;revision:number|null;
 activeRevision:number|null;activeCheck:boolean;found:boolean;durable:boolean;v2:boolean;
 commentDocument:boolean;candidateKind:string}):ReadinessCandidate{
 const source=i.revision===null?"none":i.requested?"requested":"active";
 const found=source!=="none"&&i.found;
 const engine=!found?null:i.durable?"durable":i.candidateKind==="comment"?"comment":i.v2?"v2":null;
 const supportedReason:ReadinessCandidateReason|null=
  source==="none"?"no_candidate_revision":!found?"revision_not_found":
  i.candidateKind!=="unsupported"?null:i.commentDocument?"unsupported_comment_flow":
  i.v2?"not_durable_v2":"not_durable";
 return {flowKey:i.flowKey,revision:source==="none"?null:i.revision,source,found,
  activeRevision:i.activeRevision,engine,
  reasons:{activeRevision:i.activeCheck===true?null:"no_active_revision",
   supportedCandidate:supportedReason}};
}

export function evaluateFlowReadiness(input:ReadinessInput){
 if(input.comment)return evaluateCommentFlowReadiness(input,input.comment);
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

/**
 * Comment-trigger document: the Instagram-only channel check is replaced by the
 * platform-specific comment check; every other base gate is the same operator
 * gate the activate action's comment path requires. Comment graphs never need
 * the buttons sender or the scheduler (commentFlowPlan: one plain DM only).
 */
function evaluateCommentFlowReadiness(input:ReadinessInput,comment:CommentReadinessInput){
 const commentTrigger=evaluateCommentReadiness(input.platform,comment);
 const candidateKind:"comment"|"unsupported"=comment.planValid===true&&
  commentTrigger.reason!=="no_comment_surface"?"comment":"unsupported";
 const checks={
  commentTrigger:commentTrigger.supported,
  tenant:input.tenantActive,
  account:input.accountActive&&input.agentEnabled&&input.autoReply,
  globalSwitch:input.globalEnabled,
  tenantSwitch:input.tenantEnabled&&input.productionApproved,
  credits:input.creditsAvailable,
  activeRevision:input.activePublication,
  supportedCandidate:candidateKind==="comment",
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
 const base=["commentTrigger","tenant","account","globalSwitch","tenantSwitch","credits",
  "activeRevision","supportedCandidate","ingress","activation","canary","operatorRelease","outbox",
  "atomicDebit","encryption"] as const;
 const needsInternalActions=input.needsInternalActions===true;
 const needsMedia=input.needsMedia===true;
 const extraOk=(!needsInternalActions||checks.internalActions)&&(!needsMedia||checks.media);
 return {
  checks,
  candidateKind,
  needsButtons:false,
  needsScheduler:false,
  needsInternalActions,
  needsMedia,
  buttonsConfigured:false,
  delayConfigured:false,
  configured:base.every(key=>checks[key])&&candidateKind==="comment"&&extraOk,
  commentTrigger,
  // Server-provided titles for checks whose meaning differs for comment flows.
  checkLabels:{
   commentTrigger:commentTrigger.label,
   supportedCandidate:{ar:"الإصدار المحدد تدفق تعليقات مدعوم (رد عام ← رسالة خاصة واحدة)",
    en:"Selected revision is a supported comment flow (public reply -> one private message)"},
  } as Record<string,Text>,
 };
}
