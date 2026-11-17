/**
 * PURE customer-facing emergency stop ("deactivate", an owner action scoped by
 * the server to the caller's own tenant and account). Classifies the reply and
 * holds the plain texts: no revision numbers, codes, engine names or flags.
 * It never claims the flow stopped unless the server confirmed it.
 */
export type StopResult="stopped"|"not_running"|"failed";

export const STOP_TEXT={
 button:{ar:"إيقاف التدفق",en:"Stop this flow"},
 confirm:{ar:"إيقاف هذا التدفق الآن؟ ستتوقف ردوده التلقائية حتى تنشره من جديد.",
  en:"Stop this flow now? Its automatic replies will stop until you publish it again."},
 stopped:{ar:"تم إيقاف التدفق.",en:"The flow was stopped."},
 not_running:{ar:"هذا التدفق غير مفعّل حاليًا، فلا يوجد ما يلزم إيقافه.",
  en:"This flow is not running right now, so there is nothing to stop."},
 failed:{ar:"تعذر إيقاف التدفق. لم نتمكن من التأكد من إيقافه، حاول مرة أخرى بعد قليل.",
  en:"The flow could not be stopped. We could not confirm it stopped; please try again shortly."},
} as const;

/** Success only for the server's exact confirmation {ok:true, active:false}. */
export function classifyStopReply(reply:unknown):StopResult{
 if(reply===null||typeof reply!=="object"||Array.isArray(reply))return "failed";
 const r=reply as Record<string,unknown>;
 return r.ok===true&&r.active===false?"stopped":"failed";
}

/** The server's 404 "No active publication found" means nothing was running; anything else failed. */
export function classifyStopError(e:unknown):StopResult{
 if(!e||typeof e!=="object")return "failed";
 const x=e as {status?:unknown;message?:unknown};
 return x.status===404&&x.message==="No active publication found"?"not_running":"failed";
}
