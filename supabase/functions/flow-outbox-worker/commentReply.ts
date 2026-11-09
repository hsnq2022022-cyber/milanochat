/**
 * Comment automation: public reply BEFORE the DM. Server-only, no env.
 *
 * Wired in flow-outbox-worker/index.ts behind FLOW_COMMENT_AUTOMATION_ENABLED
 * (default OFF) on top of migration 20261029300000_comment_replies
 * (flow_claim_comment_reply / flow_finish_comment_reply; the DM of a comment
 * run is refused by flow_reserve_outbox_delivery until the reply is 'sent').
 *
 * Order is structural: commentAutomationStep never returns "send_dm" unless
 * the public reply is recorded as "sent"; a permanent reply failure ends the
 * automation with the DM "skipped". Idempotency: a reply attempt whose outcome
 * is unknown (timeout, network, 5xx, 2xx without id) is NEVER re-posted
 * blindly; it is reconciled first by reading the comment's replies
 * (findExistingReply) for one authored by this account with the same text.
 * Retries use the same exponential backoff as knowledge_ai (aiRetryDelaySeconds).
 */
import {aiRetryDelaySeconds} from "./knowledgeRetry.ts";

export type CommentPlatform="instagram"|"facebook";
export type ReplyStatus="pending"|"attempting"|"uncertain"|"sent"|"failed";
export type DmStatus="pending"|"sent"|"failed"|"skipped";
export type CommentAutomationState={
 replyStatus:ReplyStatus;
 /** Reply POSTs made so far (reconciliation reads do not count). */
 replyAttempts:number;
 dmStatus:DmStatus;
};
export type CommentStep=
 |{action:"post_reply"}
 |{action:"reconcile_reply"}
 |{action:"send_dm"}
 |{action:"stop";replyStatus:"failed";dmStatus:"skipped"}
 |{action:"none"};
/** Same attempt bound as knowledge_ai (knowledgeRetry.ts AI_MAX_ATTEMPTS). */
export const COMMENT_REPLY_MAX_ATTEMPTS=5;
const GRAPH_FB="https://graph.facebook.com/v21.0/";
const GRAPH_IG="https://graph.instagram.com/v21.0/";
/** Digits, or Facebook postId_commentId. Never a path, query or host. */
const COMMENT_ID=/^[0-9]{1,32}(_[0-9]{1,32})?$/;
const ACCOUNT_ID=/^[0-9]{5,32}$/;
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const PUBLIC_REPLY_MAX=2200;

/**
 * Next action. The DM is reachable ONLY from replyStatus "sent"; "failed"
 * stops with the DM skipped; "uncertain" is reconciled before any re-post;
 * "attempting" (an in-flight lease) does nothing.
 */
export function commentAutomationStep(s:CommentAutomationState):CommentStep{
 if(!s||typeof s!=="object")return {action:"none"};
 const attempts=Number.isSafeInteger(s.replyAttempts)&&s.replyAttempts>=0?s.replyAttempts:COMMENT_REPLY_MAX_ATTEMPTS;
 switch(s.replyStatus){
  case "sent":return s.dmStatus==="pending"?{action:"send_dm"}:{action:"none"};
  case "failed":return s.dmStatus==="pending"||s.dmStatus==="skipped"?
   {action:"stop",replyStatus:"failed",dmStatus:"skipped"}:{action:"none"};
  case "uncertain":return s.dmStatus==="pending"?{action:"reconcile_reply"}:{action:"none"};
  case "pending":
   if(s.dmStatus!=="pending")return {action:"none"};
   return attempts<COMMENT_REPLY_MAX_ATTEMPTS?{action:"post_reply"}:
    {action:"stop",replyStatus:"failed",dmStatus:"skipped"};
  default:return {action:"none"};
 }
}
/** True only when a DM effect of a comment run may be claimed/sent. */
export const dmClaimable=(replyStatus:unknown)=>replyStatus==="sent";

export type ReplyFailureClass="permanent"|"retryable"|"uncertain";
export class CommentReplyError extends Error{
 failure:ReplyFailureClass;status:number|null;metaCode:number|null;
 constructor(failure:ReplyFailureClass,status:number|null=null,metaCode:number|null=null){
  super("Comment reply "+failure+(status?" HTTP "+status:""));
  this.failure=failure;this.status=status;this.metaCode=metaCode;
 }
}
/** Meta throttling codes: the call is refused before processing (safe to retry). */
const THROTTLE_CODES=new Set([4,17,32,613]);
/**
 * HTTP outcome -> class. 429 / throttling codes: retryable (not processed).
 * 5xx: uncertain (Meta may have posted it). Other 4xx (deleted comment,
 * missing permission, invalid token): permanent.
 */
export function classifyReplyFailure(status:number,metaCode:number|null):ReplyFailureClass{
 if(status===429||(metaCode!==null&&THROTTLE_CODES.has(metaCode)))return "retryable";
 if(status>=500)return "uncertain";
 return "permanent";
}

export type CommentReplyRequest={
 platform:CommentPlatform;token:string;
 /** channel_accounts.external_id (Instagram account id / Facebook Page id). */
 externalId:string;commentId:string;text:string;
};
export function commentReplyProblem(r:CommentReplyRequest):string|null{
 if(!r||(r.platform!=="instagram"&&r.platform!=="facebook"))return "platform";
 if(typeof r.token!=="string"||r.token.length<1||r.token.length>4096)return "token";
 if(typeof r.commentId!=="string"||!COMMENT_ID.test(r.commentId))return "comment_id";
 if(typeof r.externalId!=="string"||!ACCOUNT_ID.test(r.externalId))return "account";
 if(typeof r.text!=="string"||!r.text.trim()||r.text.length>PUBLIC_REPLY_MAX||CONTROL.test(r.text))return "text";
 return null;
}
/**
 * Fixed Graph hosts only; the only variable path segment is the validated
 * comment id. Instagram: /{ig-comment-id}/replies (graph.instagram.com for
 * Instagram-Login "IG" tokens, as deliveryCore.ts); Facebook Page comment:
 * /{comment-id}/comments.
 */
function endpoint(r:CommentReplyRequest){
 const ig=r.platform==="instagram";
 const igLogin=ig&&r.token.startsWith("IG");
 const url=(igLogin?GRAPH_IG:GRAPH_FB)+r.commentId+(ig?"/replies":"/comments");
 return {url,igLogin};
}
const metaCodeOf=async(res:Response)=>{
 const body:unknown=await res.json().catch(()=>null);
 const err=body&&typeof body==="object"?(body as Record<string,unknown>).error:null;
 const code=err&&typeof err==="object"?(err as Record<string,unknown>).code:null;
 return typeof code==="number"?code:null;
};
/** POST the public reply once. Returns the new reply id; throws CommentReplyError. */
export async function sendCommentReply(r:CommentReplyRequest,perform:typeof fetch=fetch):Promise<string>{
 const problem=commentReplyProblem(r);
 if(problem)throw new CommentReplyError("permanent");
 const {url,igLogin}=endpoint(r);
 const message=r.text.trim();
 let res:Response;
 try{
  res=await perform(url,{method:"POST",
   headers:igLogin?{"content-type":"application/json",authorization:"Bearer "+r.token}:
    {"content-type":"application/json"},
   body:JSON.stringify(igLogin?{message}:{message,access_token:r.token}),
   signal:AbortSignal.timeout(15000)});
 }catch{throw new CommentReplyError("uncertain");}
 if(!res.ok){
  const code=await metaCodeOf(res);
  throw new CommentReplyError(classifyReplyFailure(res.status,code),res.status,code);
 }
 const data:unknown=await res.json().catch(()=>null);
 const id=data&&typeof data==="object"?(data as Record<string,unknown>).id:null;
 // 2xx without an id: posted or not is unknown -> reconcile, never re-post.
 if(typeof id!=="string"||!id.trim()||id.length>255)throw new CommentReplyError("uncertain",res.status);
 return id;
}
/**
 * Reconciliation read for an uncertain attempt: the id of a reply to this
 * comment authored by this account (from.id === externalId) with exactly the
 * same text, else null. Throws CommentReplyError("uncertain") when the read
 * itself fails (the state stays uncertain; no re-post).
 */
export async function findExistingReply(r:CommentReplyRequest,perform:typeof fetch=fetch):Promise<string|null>{
 if(commentReplyProblem(r))throw new CommentReplyError("permanent");
 const {url,igLogin}=endpoint(r);
 const fields=r.platform==="instagram"?"id,text,from":"id,message,from";
 const q=new URLSearchParams({fields,limit:"100"});
 if(!igLogin)q.set("access_token",r.token);
 let res:Response;
 try{
  res=await perform(url+"?"+q.toString(),{method:"GET",
   headers:igLogin?{authorization:"Bearer "+r.token}:{},signal:AbortSignal.timeout(15000)});
 }catch{throw new CommentReplyError("uncertain");}
 if(!res.ok)throw new CommentReplyError("uncertain",res.status);
 const data:unknown=await res.json().catch(()=>null);
 const list=data&&typeof data==="object"?(data as Record<string,unknown>).data:null;
 if(!Array.isArray(list))throw new CommentReplyError("uncertain",res.status);
 const want=r.text.trim();
 for(const item of list){
  if(!item||typeof item!=="object")continue;
  const it=item as Record<string,unknown>;
  const from=it.from&&typeof it.from==="object"?(it.from as Record<string,unknown>).id:null;
  const body=r.platform==="instagram"?it.text:it.message;
  if(String(from)===r.externalId&&typeof body==="string"&&body.trim()===want&&
     typeof it.id==="string"&&it.id)return it.id;
 }
 return null;
}
export type ReplyAttemptResult=
 {state:CommentAutomationState;replyId:string|null;retryDelaySeconds:number|null;errorCode:string|null};
/**
 * One step of the reply phase (post or reconcile), already ordered by
 * commentAutomationStep. The caller persists `state` (and replyId/errorCode)
 * under its lease BEFORE acting on the next step. Never sends a DM.
 */
export async function runReplyPhase(state:CommentAutomationState,r:CommentReplyRequest,
 perform:typeof fetch=fetch,random:()=>number=Math.random):Promise<ReplyAttemptResult|null>{
 const step=commentAutomationStep(state);
 const failed=(code:string):ReplyAttemptResult=>({state:{...state,replyStatus:"failed",dmStatus:"skipped"},
  replyId:null,retryDelaySeconds:null,errorCode:code});
 if(step.action==="stop")return failed("reply_attempts_exhausted");
 if(step.action==="reconcile_reply"){
  try{
   const found=await findExistingReply(r,perform);
   if(found)return {state:{...state,replyStatus:"sent"},replyId:found,retryDelaySeconds:null,errorCode:null};
   // Confirmed absent: a new POST cannot duplicate it.
   return {state:{...state,replyStatus:"pending"},replyId:null,
    retryDelaySeconds:null,errorCode:"reply_absent_after_uncertain"};
  }catch(e){
   if(e instanceof CommentReplyError&&e.failure==="permanent")return failed("reply_invalid_request");
   return {state,replyId:null,retryDelaySeconds:aiRetryDelaySeconds(Math.max(1,state.replyAttempts),random),
    errorCode:"reply_reconcile_unavailable"};
  }
 }
 if(step.action!=="post_reply")return null;
 const attempts=state.replyAttempts+1;
 try{
  const id=await sendCommentReply(r,perform);
  return {state:{...state,replyStatus:"sent",replyAttempts:attempts},replyId:id,retryDelaySeconds:null,errorCode:null};
 }catch(e){
  const failure=e instanceof CommentReplyError?e.failure:"uncertain";
  const code=e instanceof CommentReplyError&&e.metaCode!==null?"meta_"+e.metaCode:
   e instanceof CommentReplyError&&e.status?"http_"+e.status:"reply_"+failure;
  if(failure==="permanent")return {...failed(code),state:{...state,replyStatus:"failed",dmStatus:"skipped",replyAttempts:attempts}};
  if(failure==="retryable"&&attempts>=COMMENT_REPLY_MAX_ATTEMPTS)
   return {...failed("reply_attempts_exhausted"),state:{...state,replyStatus:"failed",dmStatus:"skipped",replyAttempts:attempts}};
  return {state:{...state,replyStatus:failure==="retryable"?"pending":"uncertain",replyAttempts:attempts},
   replyId:null,retryDelaySeconds:aiRetryDelaySeconds(attempts,random),errorCode:code};
 }
}

export type CommentClaim={outcome:"claimed";token:string;commentId:string;replyText:string;
 prior:"pending"|"uncertain";attempts:number}|{outcome:"not_claimable"};
export type CommentFinishResult="sent"|"failed"|"retry"|"uncertain"|"absent";
export type CommentReplyDeps={
 /** flow_claim_comment_reply (lease); null = RPC error. */
 claim():Promise<CommentClaim|null>;
 /** flow_finish_comment_reply under the lease token; null = refused/RPC error. */
 finish(token:string,result:CommentFinishResult,replyId:string|null,code:string|null,
  delaySeconds:number,posted:boolean):Promise<string|null>;
 request(commentId:string,text:string):CommentReplyRequest;
 perform?:typeof fetch;random?:()=>number;
};
/**
 * One reply_comment effect: claim -> (reconcile | post once) -> finish.
 * Returns an outcome key for the worker report. Never sends a DM; the DM
 * becomes reservable only through the finished 'sent' state in SQL.
 */
export async function executeCommentReply(d:CommentReplyDeps):Promise<string>{
 let c:CommentClaim|null;
 try{c=await d.claim();}catch{return "comment_reply_claim_error";}
 if(!c)return "comment_reply_claim_error";
 if(c.outcome!=="claimed")return "comment_reply_not_claimable";
 const state:CommentAutomationState={replyStatus:c.prior,replyAttempts:c.attempts,dmStatus:"pending"};
 const r=await runReplyPhase(state,d.request(c.commentId,c.replyText),d.perform,d.random);
 if(!r)return "comment_reply_noop";
 const posted=r.state.replyAttempts>state.replyAttempts;
 const code=r.errorCode&&/^[a-z0-9_]{1,48}$/.test(r.errorCode)?r.errorCode:r.errorCode?"reply_error":null;
 const delay=Math.max(0,Math.min(3600,r.retryDelaySeconds??0));
 let result:CommentFinishResult;
 if(r.state.replyStatus==="sent")result="sent";
 else if(r.state.replyStatus==="failed")result="failed";
 else if(r.state.replyStatus==="uncertain")result="uncertain";
 else result=posted?"retry":"absent";
 let finished:string|null=null;
 try{
  finished=await d.finish(c.token,result,result==="sent"?r.replyId:null,result==="sent"?null:code,
   result==="absent"?0:delay,posted);
 }catch{finished=null;}
 // Lease lost after a post: the next claim reports 'uncertain' -> reconcile.
 return finished?"comment_reply_"+finished:"comment_reply_finish_unconfirmed";
}
