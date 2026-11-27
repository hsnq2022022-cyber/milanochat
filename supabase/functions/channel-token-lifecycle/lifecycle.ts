/**
 * Daily channel-token lifecycle for Instagram and Facebook (pure of Deno globals; dependencies injected).
 *
 * Instagram (Instagram Login): refreshed server-side while valid, inside the last 21 days, via
 *   GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<token>
 *   (Meta: token >= 24 h old, unexpired, instagram_business_basic granted; returns a new 60-day token).
 *   An already-expired token cannot be refreshed -> needs_reauth. Meta rejecting the token (code 190) -> needs_reauth.
 * Facebook: Page tokens from a long-lived user token have no fixed expiry and CANNOT be refreshed. They are
 *   verified with debug_token (app access token): invalid -> needs_reauth; the stored expiry is corrected to what
 *   Meta reports (never expires = null; data-access expiry = the earliest real deadline), so the dashboard warns
 *   about a real deadline only.
 * Never: marks an expired / invalid connection healthy, refreshes outside the window, overwrites a token that
 * changed meanwhile (compare-and-swap), logs a token / URL / Meta message, or touches another tenant's row
 * (every write is filtered by id AND tenant_id).
 */
import {instagramRefreshDecision} from "../../../src/lib/channelTokenState.ts";
import {markNeedsReauth,classifyMetaTokenError,type ReauthReason} from "../_shared/channelReauth.ts";

// deno-lint-ignore no-explicit-any
type Db={from:(table:string)=>any};
export type AccountRow={id:string;tenant_id:string;channel:string;external_id:string|null;status:string|null;
 token_expires_at:string|null;access_token_encrypted:string|null};
export type Deps={db:Db;fetch:typeof fetch;nowMs:()=>number;fieldKey:string;
 appId:string;appSecret:string;
 decrypt:(v:string,key:string)=>Promise<string>;encrypt:(v:string,key:string)=>Promise<string>};
export type Outcome="refreshed"|"verified"|"corrected"|"needs_reauth"|"raced"|"transient"|"config_error"|"skipped"|"error";
export type Summary=Record<Outcome,number>&{checked:number};

const IG_REFRESH="https://graph.instagram.com/refresh_access_token";
const FB_DEBUG="https://graph.facebook.com/v21.0/debug_token";
const MIN_LIFETIME_S=86_400,MAX_LIFETIME_S=90*86_400;
const rec=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);

async function getJson(f:typeof fetch,url:string):Promise<{status:number;body:unknown}|null>{
 try{
  const r=await f(url,{method:"GET",headers:{accept:"application/json"}});
  let body:unknown=null;
  try{body=await r.json();}catch{/* non-JSON body */}
  return {status:r.status,body};
 }catch{return null;} // network / timeout: no detail is logged (the URL carries the token)
}
const int=(v:unknown):number|null=>typeof v==="number"&&Number.isInteger(v)?v:null;
/** Meta error {code, error_subcode} from a response body (numbers only, nothing else is ever read or kept). */
const metaError=(b:unknown):{code:number|null;subcode:number|null}=>
 // Graph errors use error_subcode; the debug_token "error" object uses subcode.
 rec(b)&&rec(b.error)?{code:int(b.error.code),subcode:int(b.error.error_subcode)??int(b.error.subcode)}:{code:null,subcode:null};

async function casUpdate(db:Db,row:AccountRow,patch:Record<string,unknown>):Promise<boolean>{
 try{
  const {data,error}=await db.from("channel_accounts").update(patch)
   .eq("id",row.id).eq("tenant_id",row.tenant_id).eq("status","active")
   .eq("access_token_encrypted",row.access_token_encrypted).select("id");
  if(error){console.error("[channel-token] write failed",{code:String(error.code??"")});return false;}
  return Array.isArray(data)&&data.length===1;
 }catch{return false;}
}
const reauth=async(d:Deps,row:AccountRow,reason:ReauthReason):Promise<Outcome>=>
 (await markNeedsReauth(d.db,{id:row.id,tenant_id:row.tenant_id,access_token_encrypted:row.access_token_encrypted},reason,
  new Date(d.nowMs()).toISOString()))?"needs_reauth":"raced";

async function instagram(d:Deps,row:AccountRow):Promise<Outcome>{
 const decision=instagramRefreshDecision(row.token_expires_at,d.nowMs());
 if(decision==="unknown"||decision==="not_due"||decision==="too_new")return "skipped";
 if(decision==="expired")return reauth(d,row,"token_expired"); // an expired token cannot be refreshed
 let token:string;
 try{token=await d.decrypt(row.access_token_encrypted!,d.fieldKey);}catch{return "error";}
 const r=await getJson(d.fetch,`${IG_REFRESH}?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
 if(r===null||r.status>=500||r.status===429)return "transient";
 const b=r.body;
 if(r.status===200&&rec(b)&&typeof b.access_token==="string"&&b.access_token.length>0&&
    typeof b.expires_in==="number"&&Number.isFinite(b.expires_in)&&b.expires_in>=MIN_LIFETIME_S&&b.expires_in<=MAX_LIFETIME_S){
  let enc:string;
  try{enc=await d.encrypt(b.access_token,d.fieldKey);}catch{return "error";}
  const now=d.nowMs();
  const ok=await casUpdate(d.db,row,{access_token_encrypted:enc,
   token_expires_at:new Date(now+Math.floor(b.expires_in)*1000).toISOString(),error_message:null,updated_at:new Date(now).toISOString()});
  return ok?"refreshed":"raced"; // raced: the owner reconnected or another run already refreshed; nothing was overwritten
 }
 // Meta's own verdict on THIS token decides; temporary / unknown failures never change the status.
 const e=metaError(b),v=classifyMetaTokenError(r.status,e.code,e.subcode);
 if(v.kind==="reauth")return reauth(d,row,v.reason==="token_invalid"?"refresh_rejected":v.reason);
 if(v.kind==="config")return "config_error"; // permission / parameter problem of the app: reconnecting would not fix it
 return "transient"; // retry on the next run
}

async function facebook(d:Deps,row:AccountRow):Promise<Outcome>{
 if(!d.appId||!d.appSecret)return "skipped";
 let token:string;
 try{token=await d.decrypt(row.access_token_encrypted!,d.fieldKey);}catch{return "error";}
 const app=encodeURIComponent(`${d.appId}|${d.appSecret}`);
 const r=await getJson(d.fetch,`${FB_DEBUG}?input_token=${encodeURIComponent(token)}&access_token=${app}`);
 if(r===null||r.status>=500||r.status===429)return "transient";
 const data=rec(r.body)&&rec(r.body.data)?r.body.data:null;
 if(r.status!==200||!data||typeof data.is_valid!=="boolean"){
  // An error answer here is about OUR app credentials / request (the customer token is only the input), so even
  // code 190 never marks the account: it is an operator-visible configuration error, not a reconnect request.
  const e=metaError(r.body);
  return classifyMetaTokenError(r.status,e.code,e.subcode).kind==="temporary"||e.code===null?"transient":"config_error";
 }
 // Never trust a verdict about some other asset than this account's Page.
 if(typeof data.profile_id==="string"&&row.external_id&&data.profile_id!==row.external_id)return "error";
 if(data.is_valid===false){
  // data.error carries Meta's reason for THIS token (expired / password changed / permission removed / checkpoint).
  const e=metaError(data),v=classifyMetaTokenError(400,e.code??190,e.subcode);
  return reauth(d,row,v.kind==="reauth"?v.reason:"token_invalid");
 }
 const sec=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)&&v>0?v*1000:null;
 const deadlines=[sec(data.expires_at),sec(data.data_access_expires_at)].filter((x):x is number=>x!==null);
 const effective=deadlines.length?Math.min(...deadlines):null;
 const now=d.nowMs();
 if(effective!==null&&effective<=now)return reauth(d,row,sec(data.expires_at)!==null&&sec(data.expires_at)!<=now?"token_expired":"data_access_expired");
 const newIso=effective===null?null:new Date(effective).toISOString();
 const same=(row.token_expires_at===null&&newIso===null)||
  (row.token_expires_at!==null&&newIso!==null&&Date.parse(row.token_expires_at)===Date.parse(newIso));
 if(same)return "verified";
 const ok=await casUpdate(d.db,row,{token_expires_at:newIso,updated_at:new Date(now).toISOString()});
 return ok?"corrected":"raced";
}

export async function processAccount(d:Deps,row:AccountRow):Promise<Outcome>{
 try{
  if(row.status!=="active"&&row.status!==null)return "skipped";
  if(row.channel!=="instagram"&&row.channel!=="facebook")return "skipped";
  if(!row.access_token_encrypted)return reauth(d,row,"token_missing"); // an "active" account without a token cannot send
  return row.channel==="instagram"?await instagram(d,row):await facebook(d,row);
 }catch{return "error";}
}

export const MAX_ACCOUNTS_PER_RUN=200;
export const RUN_BUDGET_MS=100_000;
export async function runLifecycle(d:Deps):Promise<Summary|{error:string}>{
 const {data,error}=await d.db.from("channel_accounts")
  .select("id,tenant_id,channel,external_id,status,token_expires_at,access_token_encrypted")
  .in("channel",["instagram","facebook"]).or("status.is.null,status.eq.active")
  .order("token_expires_at",{ascending:true,nullsFirst:false}).limit(MAX_ACCOUNTS_PER_RUN);
 if(error||!Array.isArray(data))return {error:"lookup_failed"};
 const s:Summary={checked:0,refreshed:0,verified:0,corrected:0,needs_reauth:0,raced:0,transient:0,config_error:0,skipped:0,error:0};
 const started=d.nowMs();
 for(const row of data as AccountRow[]){
  if(d.nowMs()-started>RUN_BUDGET_MS)break; // the rest is picked up by the next run (earliest expiry first)
  s.checked++;s[await processAccount(d,row)]++;
 }
 return s;
}
