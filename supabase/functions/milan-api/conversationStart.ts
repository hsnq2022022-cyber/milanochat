/**
 * SERVER ONLY. "Is this inbound DM the first customer message of the
 * conversation?" — the signal a trigger's messageScope "conversation_start"
 * needs (flowMessageScope.ts messageScopeAllowsFlow).
 *
 * milan-api/index.ts calls it BEFORE the inbound row is persisted, so a
 * history read failure leaves nothing stored and the event is answered as
 * retryable (unknown state). A re-drive (inbound row already stored) excludes
 * its own row by id.
 *
 * History = earlier CUSTOMER DMs of the same tenant + conversation:
 *  - direction "in", kind "customer";
 *  - comment ingress rows (commentIngress.ts stores wa_message_id
 *    "comment:<id>" in the same messages table) are NOT DMs and never count;
 *  - rows with a NULL wa_message_id (legacy) DO count (fail closed: never a
 *    start);
 *  - business/outbound rows never count.
 * One row is enough (limit 1). Returns true ONLY on a successful read that
 * proves an empty history. A read error or a malformed reply throws
 * ConversationStartUnavailableError (never treated as a start). A
 * conversation already bound to another channel account is never a start
 * for this one (fail closed: false, no read).
 */

export class ConversationStartUnavailableError extends Error{
 constructor(){super("conversation start unavailable");this.name="ConversationStartUnavailableError";}
}

type Db={from:(table:string)=>any};
export type ConversationStartInput={
 tenantId:string;
 /** Verified channel_accounts id of the inbound (index.ts `account.id`). */
 accountId:string;
 conversation:{id:unknown;account_id?:unknown};
 /** Re-drive only: the already persisted inbound row of THIS event. */
 excludeInboundId?:string|null;
};

export async function readConversationStart(db:Db,input:ConversationStartInput):Promise<boolean>{
 const conv=input.conversation;
 if(typeof input.tenantId!=="string"||!input.tenantId||
    !conv||typeof conv.id!=="string"||!conv.id)throw new ConversationStartUnavailableError();
 if(conv.account_id!==null&&conv.account_id!==undefined&&conv.account_id!==input.accountId)return false;
 let r:{data?:unknown;error?:unknown}|null|undefined;
 try{
  let q=db.from("messages").select("id")
   .eq("tenant_id",input.tenantId).eq("conversation_id",conv.id)
   .eq("direction","in").eq("kind","customer")
   .or("wa_message_id.is.null,wa_message_id.not.like.comment:*");
  if(typeof input.excludeInboundId==="string"&&input.excludeInboundId)
   q=q.neq("id",input.excludeInboundId);
  r=await q.limit(1);
 }catch{
  throw new ConversationStartUnavailableError();
 }
 if(!r||r.error||!Array.isArray(r.data))throw new ConversationStartUnavailableError();
 return r.data.length===0;
}
