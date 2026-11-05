/**
 * Pure per-run dispatch order for Outbox effects. No IO, no sends, no billing.
 *
 * A chained durable step commits up to 5 effects in ONE transaction, so they
 * share created_at; payload.seq (0..4, set by src/flow/runtimeChain.ts) is
 * their order. An effect may be dispatched only when every earlier provider
 * effect (message/question/message_image) of the SAME tenant and run is out of the way:
 *  - same commit (equal created_at), lower seq: must be sent (settled /
 *    charge_pending = provider 2xx) or terminally cancelled/dead_letter/
 *    billing_blocked (e.g. a legacy knowledge_ai charge_pending row without a
 *    stored answer, ended by knowledgeRetry.ts recoverKnowledgeCharge). A
 *    pending, leased, retry_wait or uncertain earlier effect HOLDS it;
 *  - earlier commit (smaller created_at): holds it only while not yet
 *    attempted (pending / retry_wait / leased). An older uncertain effect does
 *    not hold a later commit (the customer already moved on, e.g. tapped).
 * Unknown statuses hold (fail closed). Rows without seq count as seq 0.
 */
export type OrderRow={
 id:string;tenant_id:string;run_id:string;delivery_status:string;
 effect_kind:string;payload:unknown;created_at:string;
};
const SENT_OR_TERMINAL=new Set(["settled","charge_pending","cancelled","dead_letter","billing_blocked"]);
export const ORDERED_KINDS=["message","question","message_image"];
export const ORDER_SIBLING_LIMIT=1000;

export function effectSeq(payload:unknown):number{
 const seq=payload&&typeof payload==="object"?(payload as Record<string,unknown>).seq:undefined;
 return typeof seq==="number"&&Number.isSafeInteger(seq)&&seq>=0&&seq<=4?seq:0;
}
/** Candidate order: (created_at, run id, seq, id). */
export function compareOutbox(a:OrderRow,b:OrderRow):number{
 return String(a.created_at).localeCompare(String(b.created_at))||
  String(a.run_id).localeCompare(String(b.run_id))||
  effectSeq(a.payload)-effectSeq(b.payload)||
  String(a.id).localeCompare(String(b.id));
}
/**
 * True when an earlier effect of the same tenant/run must go first.
 * `siblings` = the tenant-scoped rows of the candidate runs; `local` = status
 * changes made during this tick (sent, cancelled, uncertain), which win.
 */
export function heldByEarlierEffect(candidate:OrderRow,siblings:readonly OrderRow[],
 local:ReadonlyMap<string,string>=new Map()):boolean{
 const seq=effectSeq(candidate.payload);
 const at=String(candidate.created_at);
 for(const row of siblings){
  if(row.id===candidate.id||row.tenant_id!==candidate.tenant_id||
     row.run_id!==candidate.run_id||!ORDERED_KINDS.includes(row.effect_kind))continue;
  const status=local.get(row.id)??row.delivery_status;
  const rowAt=String(row.created_at);
  if(rowAt===at){
   if(effectSeq(row.payload)<seq&&!SENT_OR_TERMINAL.has(status))return true;
  }else if(rowAt.localeCompare(at)<0){
   // pending/retry_wait/leased (or anything unknown) still holds.
   if(!SENT_OR_TERMINAL.has(status)&&status!=="uncertain")return true;
  }
 }
 return false;
}
/** Local status implied by a dispatch outcome of this tick (undefined = unchanged). */
export function statusAfterOutcome(outcome:string):string|undefined{
 if(outcome==="settled")return "settled";
 if(outcome==="billing_pending")return "charge_pending";
 if(outcome==="uncertain")return "uncertain";
 if(outcome.startsWith("skipped_"))return "cancelled";
 if(outcome.startsWith("billing_blocked_"))return "billing_blocked";
 return undefined;
}
