/**
 * Plain-language texts for capability reason codes (server `capabilities`
 * action and requirements.ts unsupported reasons). Customer-facing Arabic:
 * simple words, no technical terms (see tests/flow-capability-gating.test.ts
 * for the forbidden-word check). English is for operators/support only.
 * Also the PURE editor gating rules used by the palette and the node editor.
 */
import {createContext,useContext} from "react";
import {CAPABILITIES,nodeRequirements,type Availability,type Capability,type ProviderPlatform} from "./requirements.ts";
import {UNSUPPORTED_TEXT} from "./runtimeSupport.ts";

type Text={ar:string;en:string};
export const REASON_TEXT:Record<string,Text>={
 ...UNSUPPORTED_TEXT, // structural reasons: one shared source (runtimeSupport.ts)
 account_paused:{ar:"حسابك أو الرد التلقائي متوقف حاليًا، لذلك لن تعمل هذه الخطوة حتى يُعاد تشغيله.",en:"The account or auto reply is paused."},
 account_not_approved:{ar:"الردود الآلية غير مفعّلة لحسابك بعد. يمكنك الاستمرار في تصميم التدفق وحفظه.",en:"Automation is not approved for this account yet."},
 channel_not_supported:{ar:"هذه الخطوة غير متاحة على هذه القناة حاليًا.",en:"Not available on this channel."},
 advanced_not_enabled:{ar:"هذه الميزة غير متاحة لحسابك حاليًا. يمكنك استخدام الرسائل النصية والشروط البسيطة.",en:"Advanced steps are not enabled for this account."},
 buttons_not_enabled:{ar:"الأزرار غير متاحة لحسابك حاليًا.",en:"Buttons are not enabled."},
 delay_not_enabled:{ar:"الانتظار قبل الرسالة التالية غير متاح لحسابك حاليًا.",en:"Delays are not enabled."},
 internal_actions_not_enabled:{ar:"الوسوم وتنبيه الفريق وتحويل المحادثة لموظف غير متاحة لحسابك حاليًا.",en:"Tag/notify/handoff are not enabled."},
 media_not_enabled:{ar:"إرسال الصور غير متاح لحسابك حاليًا.",en:"Image sending is not enabled."},
 ai_not_enabled:{ar:"الرد بالذكاء الاصطناعي داخل التدفق غير متاح لحسابك حاليًا.",en:"The AI step is not enabled."},
 comments_not_enabled:{ar:"الرد على التعليقات غير متاح لحسابك حاليًا.",en:"Comment automation is not enabled."},
 not_supported:{ar:"هذه الخطوة غير مدعومة بعد، ولن تعمل بعد النشر.",en:"Not supported yet."},
 unavailable:{ar:"تعذر التحقق من الميزات المتاحة لحسابك الآن.",en:"Availability could not be checked."},
};
export function reasonText(code:string|null|undefined,en=false):string{
 const t=REASON_TEXT[code??""]??REASON_TEXT.unavailable;
 return en?t.en:t.ar;
}
/** Short visible badge text (not colour-only). */
export const UNAVAILABLE_BADGE:Text={ar:"غير متاح لحسابك",en:"Not available"};

export type CapabilityState=
 |{status:"idle"|"loading"|"failed";accountId:string|null;platform:null;capabilities:null}
 |{status:"ready";accountId:string;platform:ProviderPlatform;capabilities:Availability};
/**
 * Account-wide reasons are shown once (not per block) and never disable
 * drafting; "unavailable" means unknown, never a claim either way.
 */
const ACCOUNT_LEVEL=new Set(["account_paused","account_not_approved","channel_not_supported","unavailable"]);
export type Gate={reason:string;text:string;capability:Capability};

/**
 * Gate for one node's data (palette candidate or existing block), or null.
 * Only when capabilities are READY for exactly `accountId`: loading, failed,
 * demo (no backend) or another account's report never gate.
 */
export function blockGate(data:unknown,state:CapabilityState|null|undefined,accountId:string|null,en=false):Gate|null{
 if(!state||state.status!=="ready"||!accountId||state.accountId!==accountId)return null;
 const req=nodeRequirements(data,null);
 if(req.unsupported.length){
  const code=req.unsupported[0];
  return {reason:code,text:reasonText(code,en),capability:"unsupported_block"};
 }
 for(const c of req.capabilities){
  const a=state.capabilities[c];
  if(a&&a.available===true)continue;
  const reason=a&&typeof a.reason==="string"?a.reason:"unavailable";
  if(ACCOUNT_LEVEL.has(reason))continue;
  return {reason,text:reasonText(reason,en),capability:c};
 }
 return null;
}
/** One account-wide notice (account paused / not approved / channel), else null. */
export function accountNotice(state:CapabilityState|null|undefined,accountId:string|null,en=false):string|null{
 if(!state||state.status!=="ready"||state.accountId!==accountId)return null;
 const r=state.capabilities.text?.reason;
 return r&&ACCOUNT_LEVEL.has(r)&&r!=="unavailable"?reasonText(r,en):null;
}

/* Server `capabilities` reply parsing. */
/** Validated report, or null (malformed = treated as a failure, fail closed). */
export function parseCapabilities(accountId:string,reply:{ok?:boolean;platform?:unknown;capabilities?:unknown}|null|undefined):CapabilityState|null{
 if(!reply||reply.ok!==true)return null;
 const p=reply.platform;
 if(p!=="instagram"&&p!=="facebook"&&p!=="whatsapp")return null;
 const raw=reply.capabilities;
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const caps:Availability={};
 for(const c of CAPABILITIES){
  const e=(raw as Record<string,unknown>)[c];
  if(!e||typeof e!=="object")continue;
  const {available,reason}=e as {available?:unknown;reason?:unknown};
  caps[c]={available:available===true,reason:typeof reason==="string"&&/^[a-z_]{1,40}$/.test(reason)?reason:null};
 }
 return {status:"ready",accountId,platform:p as ProviderPlatform,capabilities:caps};
}

/** Node id -> gate, for the canvas badges (AutomationNode). */
export const CapabilityGateContext=createContext<ReadonlyMap<string,Gate>>(new Map());
export const useCapabilityGate=(id:string)=>useContext(CapabilityGateContext).get(id)??null;
