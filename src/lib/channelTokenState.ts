/**
 * Connection health of an Instagram / Facebook channel account, derived ONLY from the persisted
 * `status` and `token_expires_at` (never from a token). PURE: no IO, shared by the dashboard and the
 * channel-token-lifecycle Edge Function so both always agree.
 *
 * Meta facts this encodes (developers.facebook.com):
 *  - Instagram (Instagram Login): a long-lived token lasts 60 days and CAN be refreshed server-side
 *    (GET graph.instagram.com/refresh_access_token) once it is at least 24 hours old and not yet expired.
 *    An expired token CANNOT be refreshed: the owner must reconnect.
 *  - Facebook: Page tokens obtained through a long-lived user token carry no fixed expiry and CANNOT be
 *    refreshed; they can be invalidated (password change, revoked permission, data-access expiry).
 *    The only remedy is to reconnect.
 */
export const TOKEN_WARN_DAYS=14;
export const IG_REFRESH_WINDOW_DAYS=21;
export const IG_MIN_TOKEN_AGE_MS=24*3600_000;
export const IG_TOKEN_LIFETIME_MS=60*86_400_000;
const DAY=86_400_000;

export type TokenState="healthy"|"expiring"|"expired"|"needs_reauth"|"disconnected";
export type TokenStateInfo={state:TokenState;daysLeft:number|null};

const ms=(v:unknown):number|null=>{
 if(typeof v!=="string"||v.length===0)return null;
 const t=Date.parse(v);
 return Number.isFinite(t)?t:null;
};

/** `needs_reauth` and `disconnected` always win: an expired or invalid connection is never "healthy". */
export function channelTokenState(
 a:{status?:string|null;tokenExpiresAt?:string|null},nowMs:number):TokenStateInfo{
 if(a.status==="disconnected")return {state:"disconnected",daysLeft:null};
 const exp=ms(a.tokenExpiresAt);
 const daysLeft=exp===null?null:Math.floor((exp-nowMs)/DAY);
 if(a.status==="needs_reauth")return {state:"needs_reauth",daysLeft};
 if(exp===null)return {state:"healthy",daysLeft:null}; // no known expiry (e.g. Facebook Page token): nothing to warn about
 if(exp<=nowMs)return {state:"expired",daysLeft:Math.min(daysLeft!,0)};
 if(exp-nowMs<=TOKEN_WARN_DAYS*DAY)return {state:"expiring",daysLeft};
 return {state:"healthy",daysLeft};
}

export type InstagramRefreshDecision="not_due"|"too_new"|"due"|"expired"|"unknown";
/** Whether an Instagram token should be refreshed now. Refresh only inside the window, never twice a day. */
export function instagramRefreshDecision(tokenExpiresAt:string|null|undefined,nowMs:number):InstagramRefreshDecision{
 const exp=ms(tokenExpiresAt);
 if(exp===null)return "unknown";
 if(exp<=nowMs)return "expired";
 if(exp-nowMs>IG_REFRESH_WINDOW_DAYS*DAY)return "not_due";
 // issued ~ expiry - 60 days; a token younger than 24 h is rejected by Meta
 if(nowMs-(exp-IG_TOKEN_LIFETIME_MS)<IG_MIN_TOKEN_AGE_MS)return "too_new";
 return "due";
}

/** Short Arabic notice for the dashboard; null = nothing to show. */
export function channelTokenNotice(i:TokenStateInfo):{text:string;severity:"warn"|"error"}|null{
 if(i.state==="needs_reauth")return {severity:"error",text:"انتهى تفويض الربط أو أُلغي. أعد ربط الحساب لاستئناف الردود."};
 if(i.state==="expired")return {severity:"error",text:"انتهت صلاحية ربط الحساب. أعد الربط لاستئناف الردود."};
 if(i.state==="expiring"){
  const d=Math.max(0,i.daysLeft??0);
  return {severity:"warn",text:d===0?"ينتهي ربط الحساب اليوم. أعد الربط الآن.":`ينتهي ربط الحساب خلال ${d} ${d===1?"يوم":"أيام"}. أعد الربط قبل ذلك.`};
 }
 return null;
}
