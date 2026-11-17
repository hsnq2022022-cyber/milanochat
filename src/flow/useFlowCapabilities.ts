import {useEffect,useState} from "react";
import {invokeService} from "./useFlowActivation.ts";
import {CAPABILITIES,type Availability,type ProviderPlatform} from "./requirements.ts";
import type {CapabilityState} from "./capabilityReasons.ts";

/**
 * Capabilities of ONE channel account from the flow-publication `capabilities`
 * action (server-authoritative; UI gating only). Cached per account id for the
 * page session; refreshed when the account changes. Loading / failure / no
 * backend = not ready (the editor then gates nothing and claims nothing).
 */
const cache=new Map<string,CapabilityState>();
type Reply={ok?:boolean;error?:string;platform?:unknown;capabilities?:unknown};

/** Validated report, or null (malformed = treated as a failure, fail closed). */
export function parseCapabilities(accountId:string,reply:Reply|null|undefined):CapabilityState|null{
 if(!reply||reply.ok!==true)return null;
 const p=reply.platform;
 if(p!=="instagram"&&p!=="facebook"&&p!=="whatsapp")return null;
 const raw=reply.capabilities;
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const caps:Availability={};
 for(const c of CAPABILITIES){
  const e=(raw as Record<string,unknown>)[c];
  if(!e||typeof e!=="object")continue;
  const {available,reason}=e as {available?:unknown;reason?:unknown};
  caps[c]={available:available===true,reason:typeof reason==="string"&&/^[a-z_]{1,40}$/.test(reason)?reason:null};
 }
 return {status:"ready",accountId,platform:p as ProviderPlatform,capabilities:caps};
}

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
