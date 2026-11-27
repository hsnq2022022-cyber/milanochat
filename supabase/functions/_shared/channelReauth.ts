/**
 * Persisting "this connection needs the owner to reconnect" (channel_accounts.status = 'needs_reauth').
 *
 * Rules (never weaken):
 *  - Only CONFIRMED authentication failures are written: Meta OAuth error code 190, a token the refresh
 *    endpoint / debug_token reports invalid, or a stored expiry in the past. A bare 401/403 without code 190,
 *    a network error, a 5xx or a throttle is NOT confirmation and never changes the status.
 *  - Compare-and-swap on (id, tenant_id, current encrypted token, status active): if the owner reconnected
 *    (new token) or another worker already changed the row, nothing is written and `false` is returned.
 *  - Only a fixed reason code is stored in error_message (never a Meta message, token, URL or id).
 *  - Best effort: never throws, never alters delivery semantics of the caller.
 */
export const REAUTH_REASONS=["token_expired","token_invalid","refresh_rejected","data_access_expired","token_missing",
 "password_changed","permission_revoked","checkpoint_required"] as const;
export type ReauthReason=typeof REAUTH_REASONS[number];
/** Only a member of the closed list ever leaves the server (never arbitrary error_message text). */
export const safeReauthReason=(v:unknown):ReauthReason|null=>
 typeof v==="string"&&(REAUTH_REASONS as readonly string[]).includes(v)?v as ReauthReason:null;

/**
 * How a Meta error about an access token must be treated. Only "reauth" verdicts change a connection's status.
 *  - Meta OAuthException code 190 is the single CONFIRMATION that the token itself is unusable; its documented
 *    subcodes refine the customer guidance (463 expired, 460 password changed, 458 permission removed,
 *    459/464 Facebook checkpoint / unconfirmed account). Anything else with 190 is a generic invalid token.
 *  - Permission / parameter / app-configuration errors (10, 100, 200-299) say something about the APP or the
 *    request, not about the customer's connection: reconnecting would not fix them, so they are "config".
 *  - Network failures, 5xx, 429, rate limits and transient API codes are "temporary": never a state change.
 *  - Everything else is "unknown" and is treated like temporary (never marks a channel).
 */
export type MetaTokenVerdict=
 {kind:"reauth";reason:ReauthReason}|{kind:"config"}|{kind:"temporary"}|{kind:"unknown"};
const TEMPORARY_CODES=new Set([1,2,4,17,32,341,368,613]);
export function classifyMetaTokenError(status:number|null,code:number|null,subcode:number|null):MetaTokenVerdict{
 if(code===190){
  if(subcode===463)return {kind:"reauth",reason:"token_expired"};
  if(subcode===460)return {kind:"reauth",reason:"password_changed"};
  if(subcode===458)return {kind:"reauth",reason:"permission_revoked"};
  if(subcode===459||subcode===464)return {kind:"reauth",reason:"checkpoint_required"};
  return {kind:"reauth",reason:"token_invalid"};
 }
 if(status===null||status>=500||status===429)return {kind:"temporary"};
 if(code!==null&&TEMPORARY_CODES.has(code))return {kind:"temporary"};
 if(code!==null&&(code===10||code===100||(code>=200&&code<=299)))return {kind:"config"};
 return {kind:"unknown"};
}
export type ReauthTarget={id:string;tenant_id:string;access_token_encrypted:string|null};
// deno-lint-ignore no-explicit-any
type Db={from:(table:string)=>any};

/** Meta OAuthException code 190 (invalid / expired / revoked token) is the only confirmation from a send. */
export function isConfirmedTokenFailure(r:{failureClass:string;errorCode:number|null}|null|undefined):boolean{
 return !!r&&r.failureClass==="auth"&&r.errorCode===190;
}
/** The reconnect reason for a failed SEND, or null when the failure is not a confirmed token failure. */
export function reauthReasonForFailure(
 r:{failureClass:string;errorCode:number|null;errorSubcode?:number|null}|null|undefined):ReauthReason|null{
 if(!isConfirmedTokenFailure(r))return null;
 const v=classifyMetaTokenError(400,190,r!.errorSubcode??null);
 return v.kind==="reauth"?v.reason:null;
}

export async function markNeedsReauth(db:Db,row:ReauthTarget,reason:ReauthReason,nowIso=new Date().toISOString()):Promise<boolean>{
 try{
  let q=db.from("channel_accounts")
   .update({status:"needs_reauth",error_message:reason,updated_at:nowIso})
   .eq("id",row.id).eq("tenant_id",row.tenant_id).eq("status","active");
  q=row.access_token_encrypted===null?q.is("access_token_encrypted",null):q.eq("access_token_encrypted",row.access_token_encrypted);
  const {data,error}=await q.select("id");
  if(error){console.error("[channel-reauth] write failed",{code:String(error.code??"")});return false;}
  return Array.isArray(data)&&data.length===1;
 }catch{return false;}
}

/** Spread into the OAuth reconnect upsert: a successful reconnect clears any stored needs_reauth reason. */
export const RECONNECT_CLEARS={error_message:null};
