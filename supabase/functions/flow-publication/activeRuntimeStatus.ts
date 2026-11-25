/**
 * Catalog honesty: an ACTIVE publication is only "live" if the runtime will really START it.
 *
 * automation_flow_activations.is_active says the operator/customer switched the flow on. The durable
 * runtime additionally needs (same questions the runtime asks, see flowDurableIngress.ts and
 * flow_claim_inbound_durable): the account in the FLOW_DURABLE_CANARY_ACCOUNT_ID allowlist AND, for
 * production tenants (not test_only), the operator registry row for exactly (tenant, account, platform).
 * Removing either one stops NEW durable claims (V2 / the AI answer instead) and HOLDS pending wakes /
 * Outbox / internal effects (they are not cancelled; the stale sweeps bound them).
 *
 * This module only ANNOTATES: it never changes an activation. Additive field per active flow:
 *   runtime:{status:"not_running",reason,message}   (absent = nothing to report, shape unchanged)
 * Only durable (and comment) documents are annotated; V2 text flows do not use the registry.
 * Arabic, customer-safe: no ids, env names, SQL names. A read failure returns null (caller: 503).
 */
import {durableRegistryStatus,registryRequired} from "../_shared/durableRegistry.ts";
import {supportedDurableDocument} from "../milan-api/flowDurableIngress.ts";
import {commentFlowPlan} from "../milan-api/commentTrigger.ts";

type Db={from:(table:string)=>any};
export type RuntimeReason="registry_missing"|"registry_other_account"|"not_allowlisted";
export type RuntimeNote={status:"not_running";reason:RuntimeReason;message:string};

export const RUNTIME_MESSAGES:Record<RuntimeReason,string>={
 registry_missing:"هذا التدفق مفعّل لكنه لا يعمل حالياً: الحساب غير مسجّل للمسارات المتقدمة، فلن يبدأ مع الرسائل الجديدة وتبقى خطواته المعلّقة متوقفة.",
 registry_other_account:"هذا التدفق مفعّل لكنه لا يعمل حالياً: المسارات المتقدمة مسجّلة لحساب آخر لديك، فلن يبدأ هنا وتبقى خطواته المعلّقة متوقفة.",
 not_allowlisted:"هذا التدفق مفعّل لكنه لا يعمل حالياً: الحساب غير مضمّن في التشغيل المتقدم، فلن يبدأ مع الرسائل الجديدة وتبقى خطواته المعلّقة متوقفة."
};

export async function activeFlowRuntimeNotes(client:Db,
 scope:{tenantId:string;accountId:string;platform:string},
 active:ReadonlyArray<{flowKey:string;revision:number}>,
 allowlisted:boolean):Promise<Map<string,RuntimeNote>|null>{
 const notes=new Map<string,RuntimeNote>();
 if(active.length===0)return notes;
 const sw=await client.from("automation_flow_tenant_switches").select("test_only")
  .eq("tenant_id",scope.tenantId).maybeSingle();
 if(sw.error)return null;
 let reason:RuntimeReason|null=null;
 if(!allowlisted)reason="not_allowlisted";
 else if(registryRequired(sw.data?.test_only)){
  const st=await durableRegistryStatus(client,scope);
  if(st==="unavailable")return null;
  if(st==="missing")reason="registry_missing";
  else if(st==="another_account")reason="registry_other_account";
 }
 if(reason===null)return notes;
 // Only flows the durable engine / comment engine would run are affected; read the exact active revisions.
 const docs=await client.from("automation_flow_publications").select("flow_key,revision,document")
  .eq("tenant_id",scope.tenantId).eq("channel_account_id",scope.accountId).eq("platform",scope.platform)
  .in("flow_key",active.map(a=>a.flowKey)).limit(500);
 if(docs.error||!Array.isArray(docs.data))return null;
 for(const a of active){
  const row=(docs.data as Array<{flow_key?:unknown;revision?:unknown;document?:unknown}>)
   .find(d=>d.flow_key===a.flowKey&&Number(d.revision)===a.revision);
  // A missing publication row is inconsistent data the runtime cannot run either: never claimed healthy.
  if(!row||supportedDurableDocument(row.document,scope.platform)||commentFlowPlan(row.document,scope.platform)!==null)
   notes.set(a.flowKey,{status:"not_running",reason,message:RUNTIME_MESSAGES[reason]});
 }
 return notes;
}
