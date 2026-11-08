/**
 * SERVER ONLY. Signed Meta comment events -> comment automation run.
 * FLOW_COMMENT_AUTOMATION_ENABLED (default OFF, read fail-closed). OFF: the
 * webhook never calls into this module, so nothing is parsed or stored.
 *
 * Call ONLY after X-Hub-Signature-256 verification (milan-api/index.ts).
 * Never sends: flow_begin_comment_run (20261029300000) commits, in ONE
 * transaction, the durable dedupe row (automation_comment_replies, unique per
 * tenant/account/comment id), the claim, the receipt, the run and the effects
 * [reply_comment (seq 0), DM message (seq 1)]. flow-outbox-worker posts the
 * public reply first; the DM is not even reservable before it is 'sent'.
 *
 * Same operator gates as the durable DM path: FLOW_DURABLE_INGRESS_ENABLED and
 * the operator-selected FLOW_DURABLE_CANARY_ACCOUNT_ID; Facebook Page comments
 * additionally need FLOW_MULTICHANNEL_ENABLED. The SQL side re-verifies the
 * canary registration, switches, activation, trigger mode and reply text.
 * Logs carry codes only (never comment text, names or tokens).
 */
import type {SupabaseClient} from "npm:@supabase/supabase-js@2";
import {normalizeMetaComments,commentFlowPlan,commentMatches,type NormalizedComment,type CommentFlowPlan}
 from "./commentTrigger.ts";
import {persistInboundOnce} from "./persistInboundOnce.ts";

type Db=Pick<SupabaseClient,"from"|"rpc">;
type Rec=Record<string,unknown>;
const rec=(v:unknown):v is Rec=>!!v&&typeof v==="object"&&!Array.isArray(v);
export type CommentIngressDeps={env:(k:string)=>string;encrypt:(plain:string)=>Promise<string>};
/** Fail closed: no Deno runtime or any error = OFF. */
export const commentAutomationEnabled=()=>{
 try{return Deno.env.get("FLOW_COMMENT_AUTOMATION_ENABLED")==="true";}catch{return false;}
};
/** Max active activations read per account (a comment must match exactly one flow). */
export const COMMENT_FLOW_SCAN=10;
export type CommentOutcome="started"|"duplicate"|"no_match"|"ambiguous"|"ineligible"|"refused"|"error";

/** Effects in the shape flowDurableIngress.ts commits (kind, idempotencyKey, payload). */
export function commentEffects(flowKey:string,revision:number,c:NormalizedComment,plan:CommentFlowPlan){
 const base=[flowKey,revision,"comment:"+c.commentId];
 const rk=JSON.stringify([...base,"reply"]),mk=JSON.stringify([...base,"dm",plan.messageId]);
 return [
  {kind:"reply_comment",idempotencyKey:rk,payload:{kind:"reply_comment",idempotencyKey:rk,
   nodeId:plan.triggerId,commentId:c.commentId,postId:c.postId,text:plan.config.public_reply_text,seq:0}},
  {kind:"message",idempotencyKey:mk,payload:{kind:"message",idempotencyKey:mk,
   nodeId:plan.messageId,text:plan.dmText,seq:1}}
 ];
}

type Account={id:string;tenant_id:string;platform:string;external_id:string};
async function accountFor(db:Db,object:string,entryId:string):Promise<Account|null>{
 const platform=object==="page"?"facebook":"instagram";
 const {data,error}=await db.from("channel_accounts")
  .select("id,tenant_id,platform,external_id,status")
  .eq("external_id",entryId).eq("platform",platform).limit(2);
 // A shared or unknown id is never assigned to one tenant.
 if(error||!Array.isArray(data)||data.length!==1)return null;
 const a=data[0] as Rec;
 if(a.status!==undefined&&a.status!=="active")return null;
 return typeof a.id==="string"&&typeof a.tenant_id==="string"&&a.platform===platform?
  {id:a.id,tenant_id:a.tenant_id,platform,external_id:String(a.external_id??"")}:null;
}
type Candidate={flowKey:string;revision:number;plan:CommentFlowPlan};
async function activeCommentFlows(db:Db,a:Account):Promise<Candidate[]|null>{
 const act=await db.from("automation_flow_activations").select("flow_key,revision,is_active")
  .eq("tenant_id",a.tenant_id).eq("channel_account_id",a.id).eq("platform",a.platform)
  .eq("is_active",true).limit(COMMENT_FLOW_SCAN);
 if(act.error||!Array.isArray(act.data)||act.data.length>=COMMENT_FLOW_SCAN)return null;
 const out:Candidate[]=[];
 for(const s of act.data as Rec[]){
  if(!rec(s)||s.is_active!==true||typeof s.flow_key!=="string"||!Number.isSafeInteger(Number(s.revision)))continue;
  const pub=await db.from("automation_flow_publications").select("document")
   .eq("tenant_id",a.tenant_id).eq("channel_account_id",a.id).eq("platform",a.platform)
   .eq("flow_key",s.flow_key).eq("revision",s.revision).maybeSingle();
  if(pub.error)return null;
  const plan=commentFlowPlan(pub.data?.document,a.platform);
  if(plan)out.push({flowKey:s.flow_key,revision:Number(s.revision),plan});
 }
 return out;
}

async function startOne(db:Db,a:Account,c:NormalizedComment,flows:Candidate[],deps:CommentIngressDeps):Promise<CommentOutcome>{
 // Durable dedupe, read first (the RPC re-checks it under the unique key).
 const seen=await db.from("automation_comment_replies").select("id")
  .eq("tenant_id",a.tenant_id).eq("channel_account_id",a.id).eq("comment_id",c.commentId).limit(1);
 if(seen.error||!Array.isArray(seen.data))return "error";
 if(seen.data.length>0)return "duplicate";
 const matches=flows.filter(f=>commentMatches(f.plan.config,c));
 if(matches.length===0)return "no_match";
 if(matches.length>1)return "ambiguous";
 const f=matches[0];
 // Commenter conversation (same chat id shape as the DM path).
 const chatId=`${a.platform}:${c.fromId}`;
 const found=await db.from("conversations").select("id,tenant_id,account_id")
  .eq("tenant_id",a.tenant_id).eq("wa_chat_id",chatId).maybeSingle();
 if(found.error)return "error";
 let conv=found.data as Rec|null;
 if(!conv){
  const created=await db.from("conversations").insert({
   tenant_id:a.tenant_id,wa_chat_id:chatId,customer_phone_encrypted:await deps.encrypt(chatId),
   channel:a.platform,account_id:a.id,last_message_at:new Date().toISOString(),
   ...(c.fromName?{customer_name:c.fromName}:{})
  }).select("id,tenant_id,account_id").single();
  if(created.error||!created.data)return "error";
  conv=created.data as Rec;
 }
 if(conv.tenant_id!==a.tenant_id||conv.account_id!==a.id||typeof conv.id!=="string")return "ineligible";
 const event="comment:"+c.commentId;
 const encryptedText=await deps.encrypt(c.text);
 let inboundId:string|null=null;
 const stored=await persistInboundOnce(async()=>{
  const r=await db.from("messages").insert({
   conversation_id:conv!.id,tenant_id:a.tenant_id,direction:"in",
   body_encrypted:encryptedText,kind:"customer",is_auto:false,wa_message_id:event
  }).select("id").single();
  if(!r.error&&typeof r.data?.id==="string")inboundId=r.data.id;
  return r;
 });
 if(stored==="duplicate")return "duplicate";
 if(stored!=="saved"||!inboundId)return "error";
 const begin=await db.rpc("flow_begin_comment_run",{
  p_tenant:a.tenant_id,p_account:a.id,p_conversation:conv.id,p_inbound:inboundId,
  p_comment_id:c.commentId,p_post_id:c.postId,p_from_id:c.fromId,p_from_name:c.fromName,
  p_comment_encrypted:encryptedText,p_flow:f.flowKey,p_revision:f.revision,
  p_start:f.plan.triggerId,p_next:f.plan.endId??f.plan.messageId,p_next_step:f.plan.endId?2:1,
  p_effects:commentEffects(f.flowKey,f.revision,c,f.plan)
 });
 if(begin.error){
  console.warn("[comment-ingress] begin failed",{code:begin.error.code??"rpc"});
  return "error";
 }
 return typeof begin.data==="string"?"started":"refused";
}

/**
 * One signed webhook entry. Never throws; returns per-outcome counts.
 * `object` = body.object ("instagram" | "page").
 */
export async function ingestSignedComments(db:Db,object:unknown,entry:unknown,deps:CommentIngressDeps):
 Promise<Partial<Record<CommentOutcome,number>>>{
 const out:Partial<Record<CommentOutcome,number>>={};
 const count=(k:CommentOutcome)=>{out[k]=(out[k]??0)+1;};
 try{
  if(deps.env("FLOW_COMMENT_AUTOMATION_ENABLED")!=="true"||
     deps.env("FLOW_DURABLE_INGRESS_ENABLED")!=="true")return out;
  if(object!=="instagram"&&object!=="page")return out;
  if(object==="page"&&deps.env("FLOW_MULTICHANNEL_ENABLED")!=="true")return out;
  if(!rec(entry)||!Array.isArray(entry.changes)||
     !entry.changes.some(ch=>rec(ch)&&(ch.field==="comments"||ch.field==="feed")))return out;
  const entryId=typeof entry.id==="string"||typeof entry.id==="number"?String(entry.id):"";
  if(!/^[0-9]{1,32}$/.test(entryId))return out;
  const account=await accountFor(db,object,entryId);
  if(!account){count("ineligible");return out;}
  // Same operator-selected canary as the durable DM path.
  if(account.id!==deps.env("FLOW_DURABLE_CANARY_ACCOUNT_ID")){count("ineligible");return out;}
  const own=[entryId,...(account.external_id?[account.external_id]:[])];
  const comments=normalizeMetaComments({object,entry:[entry]},own);
  if(comments.length===0)return out;
  const flows=await activeCommentFlows(db,account);
  if(!flows){count("error");return out;}
  for(const c of comments){
   try{count(await startOne(db,account,c,flows,deps));}
   catch(e){
    count("error");
    console.error("[comment-ingress] comment failed",{type:e instanceof Error?e.name:"unknown"});
   }
  }
 }catch(e){
  count("error");
  console.error("[comment-ingress] entry failed",{type:e instanceof Error?e.name:"unknown"});
 }
 if(Object.keys(out).length)console.info("[comment-ingress] outcomes",out);
 return out;
}
