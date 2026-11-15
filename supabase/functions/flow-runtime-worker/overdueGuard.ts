/**
 * SERVER ONLY. Bounded "flow owed a reply but never produced one" rule for the
 * scheduled wake path.
 *
 * Problem: a sleeping run is woken by this worker only. When the worker could
 * not run for a while (cron bearer rejected with 401, release/scheduler gate
 * closed, deployment problem), every due run stays 'sleeping' with a past
 * wake_at; the day the worker works again flow_lease_due_runs leases ALL of
 * them and their delayed messages are sent hours or days late, long after
 * the conversation moved on (flow_end_stale_paused_runs only ends runs of a
 * PAUSED channel/tenant, never a run that was simply not served).
 *
 * Rule (operator opt-in, default OFF = behaviour unchanged):
 * FLOW_WAKE_MAX_OVERDUE_MINUTES = N (integer 5..10080). A leased run whose
 * wake_at is more than N minutes in the past is ENDED instead of continued:
 * the existing tenant-scoped flow_cancel_run(..., 'stale', 'sleeping') sets
 * run_status 'blocked', ended_reason 'stale', ended_at and cancels its pending
 * effects. Nothing is planned, committed or sent, and no AI reply is produced
 * (a late competing answer is never generated). The ended run is observable:
 * automation_flow_runs.ended_reason/ended_at, the worker log code
 * "wake_overdue" (ids only) and flow-delivery-review, which already lists
 * 'blocked' runs with their ended_reason for the owner.
 *
 * Read fail-closed in the SAFE direction: a missing, malformed or
 * out-of-range value is OFF (no run is ever ended because of a typo).
 * Note: a run paused by auto_reply/agent_enabled and re-enabled later than N
 * minutes after its wake time is ended too once this is set (the documented
 * trade-off of choosing N).
 */
/** Must stay in the flow_cancel_run / automation_flow_runs_ended_reason_chk list. */
export const WAKE_OVERDUE_END_REASON="stale";
export const WAKE_OVERDUE_MIN_MINUTES=5;
export const WAKE_OVERDUE_MAX_MINUTES=10080;

/** Configured bound in minutes, or null (OFF). */
export function wakeMaxOverdueMinutes(read:()=>string|undefined|null):number|null{
 let raw:string|undefined|null;
 try{raw=read();}catch{return null;}
 if(typeof raw!=="string"||!/^[0-9]{1,5}$/.test(raw))return null;
 const n=Number(raw);
 return Number.isSafeInteger(n)&&n>=WAKE_OVERDUE_MIN_MINUTES&&n<=WAKE_OVERDUE_MAX_MINUTES?n:null;
}

/** true only for a parsable wake time more than `maxMinutes` in the past. */
export function wakeOverdue(wakeAt:unknown,nowMs:number,maxMinutes:number|null):boolean{
 if(maxMinutes===null||!Number.isFinite(nowMs)||typeof wakeAt!=="string")return false;
 const t=Date.parse(wakeAt);
 return Number.isFinite(t)&&nowMs-t>maxMinutes*60000;
}

export type OverdueRpc=(fn:string,args:Record<string,unknown>)=>
 PromiseLike<{data:unknown;error:{code?:string}|null}>;

/** Ends the still-sleeping run (tenant-scoped). true only when it was ended. */
export async function endOverdueWake(rpc:OverdueRpc,tenantId:string,runId:string):Promise<boolean>{
 const {data,error}=await rpc("flow_cancel_run",{
  p_tenant:tenantId,p_run:runId,p_reason:WAKE_OVERDUE_END_REASON,p_expect_status:"sleeping"
 });
 return !error&&data===true;
}
