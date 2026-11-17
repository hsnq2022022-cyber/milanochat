// Pure customer-facing classification of the `publish_live` server reply.
// Never exposes revision numbers, reason codes, flags, engine names or raw errors.
export type PublishLiveResult=
 |{kind:"live"}
 |{kind:"saved_not_live";message:string}
 |{kind:"unexpected"};

export const SAVED_NOT_LIVE_FALLBACK_AR="تم حفظ التدفق، لكنه غير مفعّل حالياً.";
export const SAVED_NOT_LIVE_FALLBACK_EN="The flow was saved, but it is not live right now.";
export const PUBLISH_LIVE_TEXT={
 live:{ar:"تم نشر التدفق وهو يعمل الآن.",en:"The flow was published and is live now."},
 failed:{ar:"تعذر إكمال النشر. لم نتمكن من التأكد من حالة التدفق، حاول مرة أخرى بعد قليل.",
  en:"Publishing could not be completed. We could not confirm the flow status; please try again shortly."},
 confirm:{ar:"نشر التدفق وتفعيله الآن؟",en:"Publish this flow and make it live now?"},
 button:{ar:"نشر",en:"Publish"},
} as const;

const ARABIC=/[؀-ۿ]/;
const FORBIDDEN=/[A-Za-z0-9٠-٩]|https?:|www\.|:\/\//;

export function isSafeArabicMessage(m:unknown):m is string{
 return typeof m==="string"&&m.trim().length>0&&m.length<=200&&ARABIC.test(m)&&!FORBIDDEN.test(m);
}

export function classifyPublishLive(response:unknown):PublishLiveResult{
 if(response===null||typeof response!=="object"||Array.isArray(response))return{kind:"unexpected"};
 const r=response as Record<string,unknown>;
 if(r.ok!==true)return{kind:"unexpected"};
 if(r.status==="live")return{kind:"live"};
 if(r.status==="saved_not_live")
  return{kind:"saved_not_live",message:isSafeArabicMessage(r.message)?r.message.trim():SAVED_NOT_LIVE_FALLBACK_AR};
 return{kind:"unexpected"};
}

// English UI shows the fixed English sentence (server text is Arabic only).
export const savedNotLiveText=(r:{message:string},en:boolean)=>en?SAVED_NOT_LIVE_FALLBACK_EN:r.message;
