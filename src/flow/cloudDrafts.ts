import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase.ts";
import { importFlow } from "./model.ts";
import type { FlowDocument } from "./model";

/**
 * A REVIEW-ONLY adapter for a future cloud-draft release.
 * It is NOT connected to the editor or invoked on page load.
 * No Supabase tables/functions are created or modified by this module.
 */
export const CLOUD_DRAFT_MAX_BYTES=1048576;
export type CloudDraft={
  id:string; flow_key:string; name:string; document:FlowDocument;
  revision:number; updated_at:string;
};

export class CloudDraftError extends Error {
  readonly code:"not_configured"|"unauthenticated"|"no_tenant"|
    "invalid_document"|"oversized"|"conflict"|"storage_failure";
  constructor(code:CloudDraftError["code"],message:string) {
    super(message);this.name="CloudDraftError";this.code=code;
  }
}

export function prepareCloudDocument(input:unknown):FlowDocument {
  const valid=importFlow(input);
  if(!valid||valid.version!==3)
    throw new CloudDraftError("invalid_document","صيغة التدفق غير صالحة للحفظ السحابي.");
  if(valid.nodes.length>100||valid.edges.length>350)
    throw new CloudDraftError("invalid_document","تجاوز التدفق حدود العقد أو التوصيلات.");
  if(new TextEncoder().encode(JSON.stringify(valid)).length>CLOUD_DRAFT_MAX_BYTES)
    throw new CloudDraftError("oversized","حجم التدفق أكبر من الحد السحابي 1MB. قلّل الصور المضمنة.");
  return valid;
}

function requireClient():SupabaseClient {
  const client=getSupabase();
  if(!client)throw new CloudDraftError("not_configured","الاتصال بقاعدة البيانات غير مُجهز لهذه المعاينة.");
  return client;
}

async function tenantForSignedInUser(client:SupabaseClient):Promise<string> {
  const {data:{user},error:authError}=await client.auth.getUser();
  if(authError||!user)
    throw new CloudDraftError("unauthenticated","سجّل الدخول قبل استخدام التخزين السحابي.");
  const {data,error}=await client.from("tenants").select("id").eq("user_id",user.id).maybeSingle();
  if(error)throw new CloudDraftError("storage_failure","تعذر قراءة ملكية المشروع.");
  if(!data?.id)throw new CloudDraftError("no_tenant","لا يوجد متجر مرتبط بهذا المستخدم.");
  return data.id as string;
}

/** READ-ONLY cloud listing. Does NOT replace localStorage or the open draft. */
export async function listCloudDrafts():Promise<CloudDraft[]> {
  const client=requireClient(),tenantId=await tenantForSignedInUser(client);
  const {data,error}=await client.from("automation_flow_drafts")
    .select("id,flow_key,name,document,revision,updated_at")
    .eq("tenant_id",tenantId).order("updated_at",{ascending:false}).limit(30);
  if(error)throw new CloudDraftError("storage_failure","تعذر تحميل المسودات السحابية؛ تأكد من تجهيز الجداول والصلاحيات.");
  const result:CloudDraft[]=[];
  for(const row of data||[]){
    const document=importFlow(row.document);
    if(document&&typeof row.flow_key==="string"&&Number.isSafeInteger(row.revision))
      result.push({
        id:String(row.id),flow_key:row.flow_key,name:String(row.name),
        document,revision:row.revision,updated_at:String(row.updated_at)
      });
  }
  return result;
}

/**
 * Explicit optimistic write. null revision creates ONLY a new record.
 * Existing cloud drafts require the precise expected revision to avoid
 * overwriting edits made in another browser.
 */
export async function saveCloudDraft(
  flowKey:string,rawDoc:unknown,expectedRevision:number|null
):Promise<{id:string;revision:number}> {
  if(!flowKey||flowKey.length>128)
    throw new CloudDraftError("invalid_document","معرّف التدفق غير صالح.");
  const document=prepareCloudDocument(rawDoc);
  const client=requireClient(),tenantId=await tenantForSignedInUser(client);
  if(expectedRevision===null){
    const {data,error}=await client.from("automation_flow_drafts")
      .insert({tenant_id:tenantId,flow_key:flowKey,name:document.name,document,revision:1})
      .select("id,revision").single();
    if(error?.code==="23505")throw new CloudDraftError("conflict","المسودة موجودة في السحابة؛ استرجع نسختها أولًا.");
    if(error||!data)throw new CloudDraftError("storage_failure","فشل إنشاء المسودة السحابية.");
    return {id:String(data.id),revision:Number(data.revision)};
  }
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)
    throw new CloudDraftError("invalid_document","رقم مراجعة السحابة غير صالح.");
  const {data,error}=await client.from("automation_flow_drafts")
    .update({name:document.name,document,revision:expectedRevision+1})
    .eq("tenant_id",tenantId).eq("flow_key",flowKey).eq("revision",expectedRevision)
    .select("id,revision").maybeSingle();
  if(error)throw new CloudDraftError("storage_failure","فشل تحديث المسودة السحابية.");
  if(!data)throw new CloudDraftError("conflict","تعدّلت المسودة على جهاز آخر. قارن النسختين قبل الحفظ مجددًا.");
  return {id:String(data.id),revision:Number(data.revision)};
}
