/**
 * PURE response helpers for the flow-publication `publish_live` action.
 * Customer fields carry only a stable reason code and a short Arabic sentence:
 * never env/flag names, engine names, internal error text, ids or readiness
 * details. The revision number is returned separately by the caller.
 */
import type {ActivationGateResult} from "./activationGates.ts";
import {REGISTRY_MISSING_CODE,REGISTRY_ANOTHER_ACCOUNT_CODE,REGISTRY_UNAVAILABLE_CODE} from "./registryGate.ts";

export type NotLiveReason=
 |"account_paused"|"not_enabled"|"unsupported_feature"|"settings_incomplete"
 |"switch_off"|"unavailable"|"not_live_unknown"
 |"registry_missing"|"registry_other_account"|"registry_unavailable";

export const NOT_LIVE_MESSAGES:Record<NotLiveReason,string>={
 account_paused:"تم حفظ التدفق، لكنه غير مفعّل لأن الحساب متوقف حالياً.",
 not_enabled:"تم حفظ التدفق، لكنه غير مفعّل لأن بعض ميزاته غير متاحة لحسابك بعد.",
 unsupported_feature:"تم حفظ التدفق، لكنه غير مفعّل لأنه يحتوي على خطوات غير مدعومة.",
 settings_incomplete:"تم حفظ التدفق، لكنه غير مفعّل لأن نطاق الرسائل في بدايته غير محدد.",
 switch_off:"تم حفظ التدفق، لكن التشغيل التلقائي متوقف حالياً لذلك لم يُفعّل.",
 unavailable:"تم حفظ التدفق، لكن تعذّر تفعيله الآن. حاول مرة أخرى لاحقاً.",
 not_live_unknown:"تم حفظ التدفق، لكنه غير مفعّل حالياً.",
 // Operator registry (publication/runtime agreement). Arabic only, no ids/env/SQL names.
 registry_missing:"تم حفظ التدفق، لكن حسابك غير مفعّل للمسارات المتقدمة بعد.",
 registry_other_account:"تم حفظ التدفق، لكن المسارات المتقدمة مفعّلة لحساب آخر لديك.",
 registry_unavailable:"تم حفظ التدفق، لكن تعذّر التحقق من تفعيل الحساب الآن."
};

/** Registry gate codes carried through publish_live (diagnostics), and their reasons. */
const REGISTRY_REASONS:Record<string,NotLiveReason>={
 [REGISTRY_MISSING_CODE]:"registry_missing",
 [REGISTRY_ANOTHER_ACCOUNT_CODE]:"registry_other_account",
 [REGISTRY_UNAVAILABLE_CODE]:"registry_unavailable"
};

/**
 * One gate failure (status/body from evaluateActivationGates) -> reason code.
 * `unsupported`: deriveRequirements reported unsupported_block (never runnable).
 * Unknown combinations -> "not_live_unknown".
 */
export function notLiveReason(gate:Exclude<ActivationGateResult,{ok:true}>|null,unsupported:boolean):NotLiveReason{
 if(unsupported)return "unsupported_feature";
 if(!gate)return "not_live_unknown";
 // Registry refusals keep their own reason whatever the HTTP status (409 / 503).
 const registry=typeof gate.body.code==="string"?REGISTRY_REASONS[gate.body.code]:undefined;
 if(registry)return registry;
 switch(gate.status){
  case 403:return "account_paused";        // Account is paused
  case 423:return "not_enabled";           // Publication activation is disabled
  case 503:return "unavailable";           // switches / lookup unavailable
  case 422:return typeof gate.body.code==="string"?"settings_incomplete": // messageScope rule
   "not_enabled";                          // a supported block this account cannot run yet
  default:return "not_live_unknown";
 }
}

/** The original registry code is echoed (registry reasons only) so diagnostics keep it; other shapes are unchanged. */
export const registryCodeOf=(gate:Exclude<ActivationGateResult,{ok:true}>|null):string|undefined=>
 gate&&typeof gate.body.code==="string"&&gate.body.code in REGISTRY_REASONS?gate.body.code:undefined;
export const savedNotLive=(revision:number,reason:NotLiveReason,code?:string)=>
 ({ok:true as const,status:"saved_not_live" as const,revision,reason,message:NOT_LIVE_MESSAGES[reason],
  ...(code!==undefined?{code}:{})});
