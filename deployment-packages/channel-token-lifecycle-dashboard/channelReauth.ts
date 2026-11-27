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
export type ReauthReason="token_expired"|"token_invalid"|"refresh_rejected"|"data_access_expired"|"token_missing";
export type ReauthTarget={id:string;tenant_id:string;access_token_encrypted:string|null};
// deno-lint-ignore no-explicit-any
type Db={from:(table:string)=>any};

/** Meta OAuthException code 190 (invalid / expired / revoked token) is the only confirmation from a send. */
export function isConfirmedTokenFailure(r:{failureClass:string;errorCode:number|null}|null|undefined):boolean{
 return !!r&&r.failureClass==="auth"&&r.errorCode===190;
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
