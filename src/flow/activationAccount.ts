/**
 * PURE client helpers: which channel account the activation toggle targets and
 * whether the server said activation is possible there. UI hints only; the
 * flow-publication Edge Function re-checks everything on activate. The client
 * never reads server flags: `canActivateComments` comes from the server's
 * `accounts` reply (FLOW_COMMENT_AUTOMATION_ENABLED / FLOW_MULTICHANNEL_ENABLED).
 */
import type {ProviderPlatform} from "./serverPublicationValidation.ts";

export type ActivationAccount={id:string;platform:string;is_active:boolean|null;
 canActivate?:boolean;canActivateComments?:boolean};

/** Activation allowed for this account and flow (commentPlatform: null = not a comment flow). */
export function accountCanActivate(a:ActivationAccount|null|undefined,commentPlatform:ProviderPlatform|null):boolean{
 if(!a)return false;
 return a.canActivate===true||
  (commentPlatform!==null&&a.platform===commentPlatform&&a.canActivateComments===true);
}

/**
 * Non-comment flows: exactly the previous choice (first canActivate, else first).
 * Comment flows: prefer an account of the trigger's own platform that may activate it.
 */
export function pickActivationAccount(list:ActivationAccount[],commentPlatform:ProviderPlatform|null):ActivationAccount|null{
 if(commentPlatform!==null){
  const own=list.find(a=>a.platform===commentPlatform&&accountCanActivate(a,commentPlatform));
  if(own)return own;
 }
 return list.find(a=>a.canActivate===true)??list[0]??null;
}
