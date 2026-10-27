import type { SupabaseClient } from "@supabase/supabase-js";
import { importFlow } from "./model.ts";
import type { FlowDocument } from "./model";
import type { SavedFlow } from "./library.ts";

export const MAX_CLOUD_DRAFT_BYTES=4*1024*1024;
export const MAX_CLOUD_DRAFTS=30;
export type CloudDraft={flow:SavedFlow;revision:number;updatedAt:string};
export type DecodeResult={drafts:CloudDraft[];skipped:number};
/** Require a full RFC3339 timestamp rather than Date.parse accepting date-only strings. */
export function validCloudTimestamp(value:unknown):value is string {
 if(typeof value!=="string")return false;
 const m=/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
 if(!m)return false;
 const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
 if(month<1||month>12||day<1||day>31)return false;
 const calendar=new Date(Date.UTC(year,month-1,day));
 if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day)return false;
 if(m[7]!== "Z"&&m[7].startsWith("+14:")&&m[7]!="+14:00")return false;
 if(m[7]!== "Z"&&m[7].startsWith("-14:")&&m[7]!="-14:00")return false;
 return Number.isFinite(Date.parse(value));
}
export type SaveResult=
 | {status:"saved";revision:number}
 | {status:"conflict"}
 | {status:"not_provisioned"}
 | {status:"permission_denied"}
 | {status:"error";code:string};

/** Draft-only transport; never claims to publish or activate a flow. */
export function prepareCloudDraft(flow:SavedFlow):{flow_key:string;name:string;document:FlowDocument}{
 if(!flow.id||!flow.id.trim()||flow.id.length>128)throw new Error("invalid flow identifier");
 const raw=JSON.stringify(flow.doc);
 if(!raw||new TextEncoder().encode(raw).length>MAX_CLOUD_DRAFT_BYTES)throw new Error("cloud draft exceeds 4 MiB");
 const document=JSON.parse(raw) as FlowDocument;
 if(!importFlow(document)||document.version!==3)throw new Error("invalid draft document");
 const name=document.name.trim();
 if(!name||name.length>100)throw new Error("invalid draft name");
 return {flow_key:flow.id,name,document};
}

/** Read-only decode. Never writes damaged documents back or drops local copies. */
export function decodeCloudDraftRows(rows:unknown):DecodeResult{
 if(!Array.isArray(rows))return {drafts:[],skipped:0};
 const drafts:CloudDraft[]=[];
 let skipped=0;
 const seen=new Set<string>();
 for(const raw of rows){
  if(!raw||typeof raw!=="object"){skipped++;continue;}
  const r=raw as Record<string,unknown>;
  if(typeof r.flow_key!=="string"||!r.flow_key.trim()||r.flow_key.length>128||seen.has(r.flow_key)||
    typeof r.draft_revision!=="number"||!Number.isSafeInteger(r.draft_revision)||r.draft_revision<1||
    !validCloudTimestamp(r.updated_at)){skipped++;continue;}
  // Reject oversized or malformed server rows before importing; never overwrite a local draft.
  let serialized:string;
  try{serialized=JSON.stringify(r.document);}catch{skipped++;continue;}
  if(!serialized||new TextEncoder().encode(serialized).length>MAX_CLOUD_DRAFT_BYTES){skipped++;continue;}
  const doc=importFlow(r.document);
  if(!doc){skipped++;continue;}
  if(drafts.length===MAX_CLOUD_DRAFTS){skipped++;continue;}
  seen.add(r.flow_key);
  drafts.push({flow:{id:r.flow_key,doc,enabled:false},revision:r.draft_revision,updatedAt:r.updated_at});
 }
 return {drafts,skipped};
}

function classifyPostgrest(error:{code?:string}|null):SaveResult{
 if(error?.code==="23505")return {status:"conflict"};
 if(["42P01","PGRST205","PGRST116"].includes(error?.code||""))return {status:"not_provisioned"};
 if(["42501","PGRST301"].includes(error?.code||""))return {status:"permission_denied"};
 return {status:"error",code:error?.code||"unknown"};
}

/** Fetch tenant identity through authenticated RLS, never by caller-supplied ownership claims. */
export async function resolveCloudTenant(client:SupabaseClient):Promise<string|null>{
 const {data:{user},error}=await client.auth.getUser();
 if(error||!user)return null;
 const result=await client.from("tenants").select("id").eq("user_id",user.id).maybeSingle();
 return result.error?null:typeof result.data?.id==="string"?result.data.id:null;
}

/** Explicit pull, never auto-overwrite user's browser localStorage. */
export async function fetchCloudDrafts(client:SupabaseClient,tenantId:string):Promise<DecodeResult>{
 const {data,error}=await client.from("automation_flow_drafts")
   .select("flow_key,name,document,draft_revision,updated_at")
   .eq("tenant_id",tenantId).order("updated_at",{ascending:false}).limit(MAX_CLOUD_DRAFTS+1);
 if(error)throw new Error("Cloud draft read unavailable ("+(error.code||"unknown")+")");
 if(Array.isArray(data)&&data.length>MAX_CLOUD_DRAFTS)
   throw new Error("Cloud draft count exceeds supported limit; existing browser drafts are unchanged");
 return decodeCloudDraftRows(data);
}

/** Optimistic locking: insert at revision null, otherwise update only matching revision. */
export async function saveCloudDraft(
 client:SupabaseClient,tenantId:string,flow:SavedFlow,expectedRevision:number|null
):Promise<SaveResult>{
 const draft=prepareCloudDraft(flow);
 if(expectedRevision!==null&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision>=2147483647))
   throw new Error("invalid expected revision");
 if(expectedRevision===null){
  const {data,error}=await client.from("automation_flow_drafts")
    .insert({tenant_id:tenantId,...draft}).select("draft_revision").maybeSingle();
  if(error)return classifyPostgrest(error);
  return typeof data?.draft_revision==="number"?{status:"saved",revision:data.draft_revision}:{status:"error",code:"empty_insert"};
 }
 const {data,error}=await client.from("automation_flow_drafts")
  .update({name:draft.name,document:draft.document,draft_revision:expectedRevision+1})
  .eq("tenant_id",tenantId).eq("flow_key",flow.id).eq("draft_revision",expectedRevision)
  .select("draft_revision").maybeSingle();
 if(error)return classifyPostgrest(error);
 if(!data)return {status:"conflict"}; // Never overwrite edits made on another device.
 return {status:"saved",revision:data.draft_revision};
}
