/**
 * SERVER ONLY. Image (message_image) guard for the scheduled wake path.
 *
 * The planner (src/flow/runtimeChain.ts planUntilWait) emits message_image
 * effects regardless of FLOW_MEDIA_SEND_ENABLED, so a delay -> image flow must
 * not reach flow_commit_run_step from this worker unless the same rule as the
 * ingress (milan-api/flowDurableIngress.ts liveEffectKinds/safePlan) holds:
 * message_image only while FLOW_MEDIA_SEND_ENABLED is exactly "true" (read
 * fail-closed), with a safe node id and a URL re-validated server-side by
 * isAllowedFlowImageUrl against SUPABASE_URL. Every other kind is unaffected.
 *
 * A disallowed image ENDS the run (nothing is committed) via the existing
 * flow_cancel_run with the already-allowed reason 'ineligible', tenant-scoped
 * and only while the run is still 'sleeping'; a blocked run is never leased
 * again, so the same run is not re-woken every tick.
 */
import {isAllowedFlowImageUrl} from "../flow-outbox-worker/mediaPolicy.ts";

export const WAKE_IMAGE_EFFECT_KIND="message_image";
/** Must stay in the flow_cancel_run / automation_flow_runs_ended_reason_chk list. */
export const WAKE_MEDIA_END_REASON="ineligible";

const safeId=(s:unknown):s is string=>typeof s==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(s);

/** Fail-closed flag read: anything but exactly "true" (or a throwing reader) is OFF. */
export function wakeMediaSendEnabled(read:()=>string|undefined|null):boolean{
 try{return read()==="true";}catch{return false;}
}

/**
 * true when every message_image effect is committable now. Plans without any
 * message_image always pass (flag OFF + text-only behaves exactly as before).
 */
export function wakeEffectsMediaAllowed(
 effects:ReadonlyArray<{kind:string;nodeId?:unknown;url?:unknown}>,
 flagEnabled:boolean,supabaseUrl:string|null|undefined):boolean{
 return effects.every(e=>e.kind!==WAKE_IMAGE_EFFECT_KIND||
  (flagEnabled===true&&typeof supabaseUrl==="string"&&supabaseUrl.length>0&&
   safeId(e.nodeId)&&isAllowedFlowImageUrl(e.url,supabaseUrl)));
}

export type WakeRpc=(fn:string,args:Record<string,unknown>)=>
 PromiseLike<{data:unknown;error:{code?:string}|null}>;

/**
 * Ends the sleeping run (tenant-scoped) because its next steps contain an
 * image that may not be committed. Returns true only when the run was ended.
 */
export async function endWakeForDisallowedMedia(rpc:WakeRpc,tenantId:string,
 runId:string):Promise<boolean>{
 const {data,error}=await rpc("flow_cancel_run",{
  p_tenant:tenantId,p_run:runId,p_reason:WAKE_MEDIA_END_REASON,p_expect_status:"sleeping"
 });
 return !error&&data===true;
}
