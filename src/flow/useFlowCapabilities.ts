import {useEffect,useState} from "react";
import {invokeService} from "./useFlowActivation.ts";
import {parseCapabilities,type CapabilityState} from "./capabilityReasons.ts";

/**
 * Capabilities of ONE channel account from the flow-publication `capabilities`
 * action (server-authoritative; UI gating only). Cached per account id for the
 * page session; refreshed when the account changes. Loading / failure / no
 * backend = not ready (the editor then gates nothing and claims nothing).
 */
const cache=new Map<string,CapabilityState>();
type Reply={ok?:boolean;error?:string;platform?:unknown;capabilities?:unknown};
export {parseCapabilities};

export function useFlowCapabilities(accountId:string|null,flowKey:string):CapabilityState{
 const idle:CapabilityState={status:"idle",accountId,platform:null,capabilities:null};
 const [state,setState]=useState<CapabilityState>(()=>accountId&&cache.get(accountId)||idle);
 useEffect(()=>{
  if(!accountId){setState({status:"idle",accountId:null,platform:null,capabilities:null});return;}
  const hit=cache.get(accountId);
  if(hit){setState(hit);return;}
  let cancelled=false;
  setState({status:"loading",accountId,platform:null,capabilities:null});
  invokeService<Reply>({action:"capabilities",accountId,flowKey}).then(r=>{
   if(cancelled)return;
   const parsed=parseCapabilities(accountId,r);
   if(parsed)cache.set(accountId,parsed);
   setState(parsed??{status:"failed",accountId,platform:null,capabilities:null});
  }).catch(()=>{if(!cancelled)setState({status:"failed",accountId,platform:null,capabilities:null});});
  return()=>{cancelled=true;};
 // flowKey only satisfies the server's request shape; the result is per account.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[accountId]);
 // Never hand out another account's report while the effect catches up.
 return state.accountId===accountId?state:idle;
}
