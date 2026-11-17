/**
 * Plain-language texts for capability reason codes (server `capabilities`
 * action and requirements.ts unsupported reasons). Customer-facing Arabic:
 * simple words, no technical terms (see tests/flow-capability-gating.test.ts
 * for the forbidden-word check). English is for operators/support only.
 * Also the PURE editor gating rules used by the palette and the node editor.
 */
import {createContext,useContext} from "react";
import {nodeRequirements,type Availability,type Capability,type ProviderPlatform} from "./requirements.ts";

type Text={ar:string;en:string};
export const REASON_TEXT:Record<string,Text>={
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
 malformed_document:{ar:"تعذر قراءة التدفق. راجع الخطوات ثم أعد المحاولة.",en:"The flow document is malformed."},
 unknown_block:{ar:"هذه الخطوة غير معروفة ولن تعمل.",en:"Unknown step."},
 trigger_not_supported:{ar:"هذا النوع من بداية الأتمتة غير مدعوم بعد.",en:"This trigger type is not supported yet."},
 trigger_channel_mismatch:{ar:"بداية الأتمتة مضبوطة على قناة مختلفة عن الحساب المختار.",en:"The trigger targets another channel."},
 pdf_not_supported:{ar:"إرسال ملفات PDF غير مدعوم بعد.",en:"PDF sending is not supported."},
 number_question_not_supported:{ar:"سؤال الأرقام غير مدعوم بعد. استخدم سؤالًا نصيًا بدلًا منه.",en:"Number questions are not supported."},
 http_request_not_supported:{ar:"الطلب الخارجي غير مدعوم بعد.",en:"HTTP requests are not supported."},
 content_blocks_not_supported:{ar:"هذا النوع من المحتوى داخل الرسالة غير مدعوم بعد.",en:"This content block is not supported."},
 legacy_image_not_supported:{ar:"طريقة إضافة الصورة هذه غير مدعومة. أضف الصورة كمحتوى داخل الرسالة.",en:"Use an image content block."},
 button_action_not_supported:{ar:"نوع إجراء هذا الزر غير مدعوم بعد.",en:"This button action is not supported."},
 mixed_buttons_not_supported:{ar:"لا يمكن الجمع بين أزرار الروابط وأزرار الاختيار في رسالة واحدة.",en:"Website and reply buttons cannot be mixed."},
 inbound_message_condition:{ar:"الشرط على نص رسالة العميل يعمل فقط في تدفق قصير: بداية ثم شرط ثم رسالتان.",en:"Inbound-text conditions only work in the short shape."},
 action_not_supported:{ar:"هذا الإجراء غير مدعوم بعد.",en:"This action is not supported."},
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

/** Node id -> gate, for the canvas badges (AutomationNode). */
export const CapabilityGateContext=createContext<ReadonlyMap<string,Gate>>(new Map());
export const useCapabilityGate=(id:string)=>useContext(CapabilityGateContext).get(id)??null;
