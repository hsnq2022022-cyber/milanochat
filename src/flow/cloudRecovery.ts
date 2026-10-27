import type { CloudDraft, DecodeResult } from "./cloudDraft";
import { MAX_CLOUD_DRAFTS, prepareCloudDraft } from "./cloudDraft.ts";
import type { FlowLibrary, SavedFlow } from "./library";
import { importFlow } from "./model.ts";
import type { FlowDocument } from "./model";

export type RecoveryDecision = "already_local" | "conflict" | "new" | "capacity_exceeded";
export type RecoveryEntry = {
  id: string;
  decision: RecoveryDecision;
  cloud: CloudDraft;
};
export type RecoveryPreview = {
  entries: RecoveryEntry[];
  skippedCloudRows: number;
  safeToSelect: boolean;
  /** This function never writes to localStorage or Supabase. */
  localFlowCount: number;
  localOnlyIds: string[];
};
export type RecoveryApplyResult =
  | {status:"ready";library:FlowLibrary;importedIds:string[]}
  | {status:"blocked";reason:"invalid_cloud_rows"|"unknown_selection"|"local_conflict"|"capacity_exceeded"};

/** Read-only comparison. Existing browser flows always take precedence. */
export function previewCloudRecovery(local:FlowLibrary,cloud:DecodeResult):RecoveryPreview {
  const byId=new Map(local.flows.map(flow=>[flow.id,flow]));
  const entries:RecoveryEntry[]=[];
  const remaining=Math.max(0,MAX_CLOUD_DRAFTS-local.flows.length);
  for(const candidate of cloud.drafts){
    const existing=byId.get(candidate.flow.id);
    let decision:RecoveryDecision;
    if(existing){
      // Compare canonicalized importer representations, not optional UI-only fields.
      // Both versions retain persistent port/node IDs and meaningful content.
      const localCanonical=importFlow(existing.doc);
      const cloudCanonical=importFlow(candidate.flow.doc);
      decision=localCanonical&&cloudCanonical&&
        JSON.stringify(localCanonical)===JSON.stringify(cloudCanonical)?"already_local":"conflict";
    }else if(remaining>0){
      decision="new";
    }else decision="capacity_exceeded";
    entries.push({id:candidate.flow.id,decision,cloud:candidate});
  }
  const cloudIds=new Set(cloud.drafts.map(d=>d.flow.id));
  return {entries,skippedCloudRows:cloud.skipped,safeToSelect:cloud.skipped===0,
    localFlowCount:local.flows.length,localOnlyIds:local.flows.filter(f=>!cloudIds.has(f.id)).map(f=>f.id)};
}

/**
 * Creates an in-memory candidate only after explicit flow IDs are selected.
 * Nothing is written, overwritten, deleted, or enabled. The caller must offer a
 * separate backup/review step before persisting the returned library.
 */
export function prepareSelectedCloudRecovery(
  local:FlowLibrary,cloud:DecodeResult,selectedIds:readonly string[]
):RecoveryApplyResult {
  if(cloud.skipped>0)return {status:"blocked",reason:"invalid_cloud_rows"};
  const preview=previewCloudRecovery(local,cloud);
  const selected=new Set(selectedIds);
  if(selected.size!==selectedIds.length)
    return {status:"blocked",reason:"unknown_selection"};
  const lookup=new Map(preview.entries.map(entry=>[entry.id,entry]));
  for(const id of selected){
    const entry=lookup.get(id);
    if(!entry)return {status:"blocked",reason:"unknown_selection"};
    if(entry.decision==="conflict"||entry.decision==="already_local")
      return {status:"blocked",reason:"local_conflict"};
    if(entry.decision==="capacity_exceeded")
      return {status:"blocked",reason:"capacity_exceeded"};
  }
  if(local.flows.length+selected.size>MAX_CLOUD_DRAFTS)
    return {status:"blocked",reason:"capacity_exceeded"};
  const imported:SavedFlow[]=[];
  for(const id of selected){
    const candidate=lookup.get(id)!.cloud.flow;
    // Deep copy only accepted data; never mutate the decoded cloud object.
    const doc=JSON.parse(JSON.stringify(candidate.doc)) as FlowDocument;
    imported.push({id,doc,enabled:false});
  }
  return {status:"ready",importedIds:[...selected],
    library:{activeFlowId:local.activeFlowId,flows:[...local.flows,...imported]}};
}

/** Manual conflict recovery: stage a cloud flow as an INACTIVE copy, never overwrite. */
export type RecoveryCopyResult =
  | {status:"ready";library:FlowLibrary;copyId:string}
  | {status:"blocked";reason:"invalid_copy_id"|"already_exists"|"capacity_exceeded"|"invalid_document"};
export function prepareIndependentCloudCopy(
  local:FlowLibrary,source:CloudDraft,copyId:string
):RecoveryCopyResult {
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(copyId))
    return {status:"blocked",reason:"invalid_copy_id"};
  if(local.flows.some(flow=>flow.id===copyId))
    return {status:"blocked",reason:"already_exists"};
  if(local.flows.length>=MAX_CLOUD_DRAFTS)
    return {status:"blocked",reason:"capacity_exceeded"};
  let doc:FlowDocument;
  try{doc=prepareCloudDraft({id:copyId,doc:source.flow.doc,enabled:false}).document;}
  catch{return {status:"blocked",reason:"invalid_document"};}
  return {status:"ready",copyId,
    library:{activeFlowId:local.activeFlowId,
      flows:[...local.flows,{id:copyId,doc,enabled:false}]}};
}
