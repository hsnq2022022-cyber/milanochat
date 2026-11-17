import {useEffect,useState} from "react";
import {invokeService} from "./useFlowActivation.ts";
import {classifyOperatorStatus,type OperatorStatus} from "./operatorStatus.ts";

export type {OperatorStatus};

/**
 * Asks the flow-publication server once per mount (`operator_status`) whether
 * the signed-in user may use the operator controls. "loading" until answered;
 * any error, HTTP failure or unexpected shape is "customer" (fail closed).
 *
 * The SERVER is authoritative: it refuses every operator-only action for
 * non-operators. Hiding controls here is NOT a security boundary; it only keeps
 * customers away from controls the server would refuse. Never derive this from
 * env flags, roles, metadata or localStorage.
 */
export function useOperatorStatus():OperatorStatus{
 const [status,setStatus]=useState<OperatorStatus>("loading");
 useEffect(()=>{
  let cancelled=false;
  invokeService<{ok?:boolean;error?:string;operator?:unknown}>({action:"operator_status"})
   .then(r=>{if(!cancelled)setStatus(classifyOperatorStatus(r));},
    ()=>{if(!cancelled)setStatus("customer");});
  return()=>{cancelled=true;};
 },[]);
 return status;
}
