/** Service-owned guard: only an immutable, confirmed provider acknowledgement
 * can be settled again; this module never sends any provider message. */
export function confirmedOutboxMid(
 effect:{delivery_status:unknown;provider_message_id:unknown},
 attempt:{status:unknown;provider_message_id:unknown}|null
):string|null{
 const value=effect.provider_message_id;
 if(effect.delivery_status!=="charge_pending"||
    attempt?.status!=="confirmed"||
    typeof value!=="string"||!value.trim()||value.length>255||
    attempt.provider_message_id!==value)return null;
 return value;
}
/** A conflict is idempotent ONLY when the original persisted row is exactly
 * this outgoing message, tenant, conversation and provider MID. */
export function matchesPreviouslyPersistedReply(
 row:{id:unknown;tenant_id:unknown;conversation_id:unknown;
 direction:unknown;wa_message_id:unknown;external_message_id:unknown;is_auto:unknown}|null,
 input:{id:string;tenantId:string;conversationId:string;providerMid:string}
):boolean{
 return !!row&&row.id===input.id&&row.tenant_id===input.tenantId&&
   row.conversation_id===input.conversationId&&row.direction==="out"&&
   row.is_auto===true&&row.wa_message_id===input.providerMid&&
   row.external_message_id===input.providerMid;
}
