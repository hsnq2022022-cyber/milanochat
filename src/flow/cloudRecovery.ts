import type { CloudDraft, DecodeResult } from "./cloudDraft";
import { MAX_CLOUD_DRAFTS } from "./cloudDraft";
import type { FlowLibrary, SavedFlow } from "./library";
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
};
export type RecoveryApplyResult =
  | {status:"ready";library:FlowLibrary;importedIds:string[]}
  | {status:"blocked";reason:"invalid_cloud_rows"|"unknown_selection"|"local_conflict"|"capacity_exceeded"};

/** Read-only comparison. Existing browser flows always take precedence. */
export function previewCloudRecovery(local:FlowLibrary,cloud:DecodeResult):RecoveryPreview {
  const byId=new Map(local.flows.map(flow=>[flow.id,flow]));
  const entries:RecoveryEntry[]=[];
  let remaining=Math.max(0,MAX_CLOUD_DRAFTS-local.flows.length);
  for(const candidate of cloud.drafts){
    const existing=byId.get(candidate.flow.id);
    let decision:RecoveryDecision;
    if(existing){
      decision=JSON.stringify(existing.doc)===JSON.stringify(candidate.flow.doc)?"already_local":"conflict";
    }else if(remaining>0){
      decision="new";
      remaining--;
    }else decision="capacity_exceeded";
    entries.push({id:candidate.flow.id,decision,cloud:candidate});
  }
  return {entries,skippedCloudRows:cloud.skipped,safeToSelect:cloud.skipped===0,
    localFlowCount:local.flows.length};
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
  if(selected.size!==selectedIds.length||selected.size===0&&selectedIds.length!==0)
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
