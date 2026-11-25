/**
 * Reads the ownership and delivery evidence for the supersession policy (skipPolicy.ts
 * supersessionVerdict). Read-only, tenant and conversation scoped. Any read error or malformed row is
 * "error": the caller HOLDS the effect, a read failure is never proof of delivery.
 */
import {supersessionVerdict,type NewerClaim,type SupersessionVerdict} from "./skipPolicy.ts";

// deno-lint-ignore no-explicit-any
type Db={from:(table:string)=>any};
export const NEWER_CLAIM_SCAN=50;

export async function readSupersession(db:Db,input:{
 tenantId:string;conversationId:string;effectCreatedAt:string;
}):Promise<SupersessionVerdict|"error">{
 const claimsRead=await db.from("automation_message_claims").select("id,outgoing_message_id")
  .eq("tenant_id",input.tenantId).eq("conversation_id",input.conversationId)
  .eq("route","legacy_ai").gt("claimed_at",input.effectCreatedAt)
  .order("claimed_at",{ascending:true}).limit(NEWER_CLAIM_SCAN);
 if(claimsRead.error||!Array.isArray(claimsRead.data))return "error";
 const claims:NewerClaim[]=[];
 for(const row of claimsRead.data as Array<{id?:unknown;outgoing_message_id?:unknown}>){
  if(typeof row?.id!=="string"||typeof row?.outgoing_message_id!=="string")return "error";
  claims.push({id:row.id,outgoingMessageId:row.outgoing_message_id});
 }
 if(claims.length===0)return "proceed";
 const [messages,attempts]=await Promise.all([
  db.from("messages").select("id").eq("tenant_id",input.tenantId)
   .eq("conversation_id",input.conversationId).eq("direction","out")
   .in("id",claims.map(c=>c.outgoingMessageId)).limit(NEWER_CLAIM_SCAN),
  db.from("automation_delivery_attempts").select("claim_id,status").eq("tenant_id",input.tenantId)
   .in("claim_id",claims.map(c=>c.id)).limit(NEWER_CLAIM_SCAN)
 ]);
 if(messages.error||!Array.isArray(messages.data)||attempts.error||!Array.isArray(attempts.data))return "error";
 const persisted=new Set<string>();
 for(const m of messages.data as Array<{id?:unknown}>){
  if(typeof m?.id!=="string")return "error";
  persisted.add(m.id);
 }
 const status=new Map<string,string>();
 for(const a of attempts.data as Array<{claim_id?:unknown;status?:unknown}>){
  if(typeof a?.claim_id!=="string"||typeof a?.status!=="string")return "error";
  status.set(a.claim_id,a.status);
 }
 return supersessionVerdict({claims,truncated:claims.length>=NEWER_CLAIM_SCAN,persistedOutIds:persisted,attempts:status});
}
