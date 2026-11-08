/**
 * I4: a Flow AI step (knowledge_ai effect under FLOW_AI_STEP_ENABLED) that
 * ends WITHOUT an answer must never disappear silently. Before the terminal
 * transition (flow_finish_outbox_ai, under the live AI claim) the worker
 * escalates with the SAME two mechanisms the live bot already uses when it
 * cannot answer (server/src/rag/reply.ts):
 *  1. an open row in public.unresolved_questions (dashboard "unresolved"
 *     list; question encrypted with the field key, like milan-api), and
 *  2. the automatic human handoff on the conversation: transferred=true,
 *     auto_paused_reason='ai_handoff', human_agent_expires_at=now+15 min
 *     (identical patch to flow-internal-worker/internalEffects.ts).
 *
 * Idempotent (a retried / re-claimed attempt never duplicates anything):
 *  - the unresolved question is inserted only when this tenant conversation
 *    has no OPEN unresolved question created since the effect was created;
 *    the check and insert run under the exclusive AI claim lease of the effect;
 *  - the handoff only switches a conversation that is not transferred yet
 *    (an existing takeover and its expiry are never overwritten).
 * Every statement carries tenant_id (service role bypasses RLS). Never
 * touches credits / billing, never sends, never logs customer text: callers
 * get true/false only. Pure: no Deno / npm imports (node --experimental-strip-types).
 */

// deno-lint-ignore no-explicit-any
type Query=any;
export type EscalationDb={from(table:string):Query};
type Row=Record<string,unknown>;
const record=(v:unknown):v is Row=>!!v&&typeof v==="object"&&!Array.isArray(v);

/** Same expiry the existing automatic handoff writes (reply.ts, internalEffects.ts). */
export const AI_ESCALATION_HANDOFF_MINUTES=15;

export type AiEscalationContext={
 tenantId:string;
 conversationId:string;
 accountId:string;
 /** automation_flow_outbox.created_at of the AI effect (dedupe window start). */
 since:string;
 /** Customer question (plain, in memory only). Encrypted before it is stored. */
 question:string;
 nowMs:number;
};

const nonEmpty=(v:unknown):v is string=>typeof v==="string"&&v.length>0;

/** Ensure ONE open unresolved question for this effect window. */
async function ensureUnresolvedQuestion(db:EscalationDb,ctx:AiEscalationContext,
 encrypt:(plain:string)=>Promise<string>):Promise<boolean>{
 const existing=await db.from("unresolved_questions").select("id,tenant_id,conversation_id")
  .eq("tenant_id",ctx.tenantId).eq("conversation_id",ctx.conversationId)
  .eq("status","open").gte("created_at",ctx.since).limit(1);
 if(existing.error||!Array.isArray(existing.data))return false;
 if((existing.data as unknown[]).some(r=>record(r)&&r.tenant_id===ctx.tenantId&&
    r.conversation_id===ctx.conversationId))return true;
 let questionEncrypted="";
 try{questionEncrypted=await encrypt(ctx.question);}catch{return false;}
 if(!questionEncrypted.startsWith("enc:v1:"))return false;
 const inserted=await db.from("unresolved_questions").insert({
  tenant_id:ctx.tenantId,conversation_id:ctx.conversationId,
  question_encrypted:questionEncrypted,status:"open",best_similarity:null
 });
 return !inserted.error;
}

/** Human handoff with the existing 'ai_handoff' takeover fields. */
async function ensureHandoff(db:EscalationDb,ctx:AiEscalationContext):Promise<boolean>{
 const patch={transferred:true,auto_paused_reason:"ai_handoff",
  human_agent_expires_at:new Date(ctx.nowMs+AI_ESCALATION_HANDOFF_MINUTES*60000).toISOString()};
 const scoped=(q:Query)=>q.eq("tenant_id",ctx.tenantId).eq("id",ctx.conversationId)
  .eq("account_id",ctx.accountId);
 const u=await scoped(db.from("conversations").update(patch)).eq("transferred",false).select("id");
 if(u.error)return false;
 if(Array.isArray(u.data)&&u.data.length===1)return true;
 const n=await scoped(db.from("conversations").update(patch)).is("transferred",null).select("id");
 if(n.error)return false;
 if(Array.isArray(n.data)&&n.data.length===1)return true;
 // Already transferred (staff or an earlier attempt took over): done.
 const cur=await scoped(db.from("conversations").select("id,tenant_id,transferred")).maybeSingle();
 if(cur.error)return false;
 return record(cur.data)&&cur.data.tenant_id===ctx.tenantId&&cur.data.transferred===true;
}

/**
 * Escalate one AI failure. true only when BOTH the unresolved question and
 * the handoff are in place (freshly or from an earlier attempt). The question
 * is recorded first: if the handoff then fails, a retry finds the question
 * and does not duplicate it. Never throws.
 */
export async function escalateAiFailure(db:EscalationDb,ctx:AiEscalationContext,
 encrypt:(plain:string)=>Promise<string>):Promise<boolean>{
 if(!ctx||!nonEmpty(ctx.tenantId)||!nonEmpty(ctx.conversationId)||!nonEmpty(ctx.accountId)||
    !nonEmpty(ctx.since)||!nonEmpty(ctx.question?.trim?.())||!Number.isFinite(ctx.nowMs))return false;
 try{
  if(!await ensureUnresolvedQuestion(db,ctx,encrypt))return false;
  return await ensureHandoff(db,ctx);
 }catch{return false;}
}
