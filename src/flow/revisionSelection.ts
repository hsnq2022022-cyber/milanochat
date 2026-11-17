/**
 * PURE helpers for EXPLICIT revision selection (editor + publications panel).
 * UI hints only: the flow-publication Edge Function re-checks tenant/account
 * scope, switches, approval and the stored document on every activate.
 * Never picks a revision by itself: no selection = refusal, never "latest".
 */
import {readinessBlockers,readinessCandidateSummary,type ReadinessReport} from "./activationAccount.ts";

type Text={ar:string;en:string};
/**
 * active    = the flow's live revision on this account (server list/activation);
 * candidate = published and its readiness report allows activation;
 * unchecked = published, readiness not checked yet (checked before activating);
 * unsupported = the server cannot run this document (reason codes below);
 * blocked   = supported document, but server gates/flags are missing;
 * missing   = the server found no such revision (stale selection).
 */
export type RevisionStatus="active"|"candidate"|"unchecked"|"unsupported"|"blocked"|"missing";
export type RevisionRow={revision:number;status:RevisionStatus;
 /** Reason codes: readiness check keys (readinessLabels) or candidate reason codes (REASON_LABELS). */
 reasons:string[];activatable:boolean};

/** Candidate reason codes from the server's readiness.candidate (readiness.ts readinessCandidate). */
export const REASON_LABELS:Record<string,Text>={
 not_durable:{ar:"مستند الإصدار غير مدعوم في أي محرك (لا متقدم ولا بسيط)",en:"The revision document is not supported by any engine"},
 unsupported_comment_flow:{ar:"تدفق تعليقات لا يمكن تشغيله على هذا الحساب أو الإعدادات",en:"Comment flow that cannot run on this account or configuration"},
 revision_not_found:{ar:"الإصدار غير موجود لهذا التدفق والحساب",en:"Revision not found for this flow and account"},
 no_candidate_revision:{ar:"لم يُفحص أي إصدار",en:"No revision was examined"},
 candidateNotFound:{ar:"الإصدار غير موجود لهذا التدفق والحساب",en:"Revision not found for this flow and account"},
 readiness_unavailable:{ar:"تقرير الجاهزية غير متاح",en:"Readiness report unavailable"},
 readiness_unclassified:{ar:"تعذر تصنيف تقرير الجاهزية",en:"Readiness report could not be classified"},
 configured:{ar:"الإعدادات غير مكتملة",en:"Configuration incomplete"},
 candidateRevision:{ar:"تقرير الجاهزية لا يخص الإصدار المحدد",en:"Readiness report is not for the selected revision"},
};
const UNSUPPORTED=new Set(["not_durable","unsupported_comment_flow"]);

/**
 * Status of one published revision. `report` must be the server readiness
 * report for EXACTLY this revision (reportRevision===revision), else ignored.
 */
export function classifyRevision(input:{revision:number;activeRevision:number|null;
 report?:ReadinessReport|null;reportRevision?:number|null}):RevisionRow{
 const {revision,activeRevision}=input;
 if(activeRevision!==null&&revision===activeRevision)return {revision,status:"active",reasons:[],activatable:false};
 const report=input.report&&input.reportRevision===revision?input.report:null;
 if(!report)return {revision,status:"unchecked",reasons:[],activatable:true};
 const c=readinessCandidateSummary(report);
 if(c&&!c.found)return {revision,status:"missing",reasons:["candidateNotFound"],activatable:false};
 const reason=c?.reasons.supportedCandidate??null;
 if(reason!==null&&UNSUPPORTED.has(reason))return {revision,status:"unsupported",reasons:[reason],activatable:false};
 const blockers=readinessBlockers(report,{currentlyActive:activeRevision!==null});
 if(blockers.length)return {revision,status:"blocked",reasons:blockers,activatable:false};
 return {revision,status:"candidate",reasons:[],activatable:true};
}

export const STATUS_LABELS:Record<RevisionStatus|"draft"|"stale",Text>={
 active:{ar:"نشط حاليًا",en:"Active"},
 candidate:{ar:"جاهز للتفعيل",en:"Ready to activate"},
 unchecked:{ar:"منشور (لم يُفحص بعد)",en:"Published (not checked yet)"},
 unsupported:{ar:"غير مدعوم",en:"Unsupported"},
 blocked:{ar:"محجوب",en:"Blocked"},
 missing:{ar:"غير موجود",en:"Not found"},
 draft:{ar:"مسودة غير منشورة (لا يمكن تفعيلها قبل النشر)",en:"Unpublished draft (cannot be activated until published)"},
 stale:{ar:"اختيار قديم (تغيّر الإصدار على الخادم)",en:"Stale selection (changed on the server)"},
};

export type SelectionRefusal="no_selection"|"revision_missing"|"active_changed"|"already_active";
export const REFUSAL_TEXT:Record<SelectionRefusal,Text>={
 no_selection:{ar:"لم يُحدَّد إصدار؛ اختر الإصدار المطلوب أولًا. لم يتم أي تغيير.",
  en:"No revision selected; choose the exact revision first. Nothing was changed."},
 revision_missing:{ar:"الإصدار المحدد لم يعد منشورًا لهذا التدفق؛ تم تحديث القائمة. لم يتم أي تغيير.",
  en:"The selected revision is no longer published for this flow; the list was refreshed. Nothing was changed."},
 active_changed:{ar:"تغيّر الإصدار النشط على الخادم منذ التحميل؛ تم تحديث الحالة، راجعها ثم أعد المحاولة. لم يتم أي تغيير.",
  en:"The active revision changed on the server since loading; status refreshed, review it and retry. Nothing was changed."},
 already_active:{ar:"الإصدار المحدد نشط بالفعل. لم يتم أي تغيير.",en:"The selected revision is already active. Nothing was changed."},
};

/**
 * Stale/selection guard against a FRESH server read of the same flow
 * (list action: published revisions + this flow's activation). Null = proceed.
 * Never substitutes another revision.
 */
export function selectionRefusal(input:{selected:number|null|undefined;
 freshRevisions:readonly number[];freshActive:number|null;loadedActive:number|null}):SelectionRefusal|null{
 const s=input.selected;
 if(typeof s!=="number"||!Number.isSafeInteger(s)||s<1)return "no_selection";
 if(!input.freshRevisions.includes(s))return "revision_missing";
 if(input.freshActive!==input.loadedActive)return "active_changed";
 if(input.freshActive===s)return "already_active";
 return null;
}

/** Revision numbers of a server `list` reply (malformed entries dropped). */
export function listedRevisions(items:unknown):number[]{
 if(!Array.isArray(items))return [];
 return items.map(i=>i&&typeof i==="object"?(i as {revision?:unknown}).revision:undefined)
  .filter((r):r is number=>typeof r==="number"&&Number.isSafeInteger(r)&&r>0);
}
/** This flow's active revision from a `list` reply's activation (null = OFF). */
export function listedActive(activation:unknown):number|null{
 if(!activation||typeof activation!=="object")return null;
 const a=activation as {revision?:unknown;is_active?:unknown};
 return a.is_active===true&&typeof a.revision==="number"?a.revision:null;
}

/** Bilingual confirmation naming the flow and the exact revision (and the one it replaces). */
export function activationConfirmText(flowKey:string,from:number|null,to:number):string{
 if(from!==null&&from!==to)
  return "الإصدار v"+from+" (النشط حاليًا) للتدفق «"+flowKey+"» سيُستبدل بالإصدار v"+to+". لن تتأثر التدفقات الأخرى. متابعة؟"+
   "\nRevision v"+from+" (currently active) of flow \""+flowKey+"\" will be replaced by revision v"+to+". Other flows are not affected. Continue?";
 return "تفعيل الأتمتة الفعلية للتدفق «"+flowKey+"» بالإصدار v"+to+"؟ لن تتأثر التدفقات الأخرى."+
  "\nActivate live automation for flow \""+flowKey+"\" at revision v"+to+"? Other flows are not affected.";
}
