import {useCallback,useEffect,useRef,useState} from "react";
import {getSupabase} from "../lib/supabase";
import {accountCanActivate,activeRevisionOf,catalogActiveFlows,catalogRuntimeNote,pickActivationAccount,readinessBlockers,resolveServerFlowKey,
 type ActivationAccount,type CatalogFlow,type ReadinessReport} from "./activationAccount.ts";
import type {ProviderPlatform} from "./serverPublicationValidation.ts";
import {activationConfirmText,classifyRevision,listedActive,listedRevisions,REFUSAL_TEXT,
 selectionRefusal} from "./revisionSelection.ts";

/**
 * Real (server) activation state for one flow, via the existing `flow-publication`
 * Edge Function: accounts -> catalog (resolve the server flow_key) -> list (status)
 * -> readiness + activate / deactivate.
 * Several flows may be active on one account at the same time, each with its own
 * revision: this hook only ever reads and changes ITS server flow_key, and never
 * refuses or affects another active flow (the server keeps them independent).
 * Nothing here is local: the toggle only reflects what the server reports, and
 * every server gate (auth, tenant/account scope, approval, readiness) still applies.
 * catalog/list/readiness/activate are OPERATOR-only on the server: for customers
 * (see ActivationAccess) the hook only resolves the account via `accounts`.
 */
export type ActivationPhase="loading"|"ready"|"unavailable";
export type ActivationState={
 phase:ActivationPhase;active:boolean;revision:number|null;busy:boolean;
 /** True when activation (not deactivation) is currently allowed for the account. */
 canActivate:boolean;
 /** Arabic explanation shown when the toggle is unavailable (includes server codes). */
 reason:string;
 /** Server flow_key the toggle manages (see resolveServerFlowKey). */
 serverKey:string;
 /** Newest published revision of serverKey (list items[0]), null = none published. */
 latestRevision:number|null;
 /** Live revision of serverKey (list activation when is_active), null = OFF. */
 activeRevision:number|null;
 /** Active and a newer published revision exists. */
 canUpdate:boolean;
 /** ALL published revisions of serverKey from the server `list` (newest first). */
 revisions:number[];
 /** Channel account the toggle uses (server `accounts`), null until known. */
 accountId:string|null;
};
export type ToggleResult={ok:boolean;message:string};

type Account=ActivationAccount;
type Reply={ok?:boolean;error?:string;accounts?:Account[];
 items?:Array<{revision:number}>;activation?:{revision:number;is_active:boolean}|null;
 /** activate: boolean; catalog: legacy single active publication (older servers). */
 active?:unknown;
 /** catalog: ALL active flows of the account, each {flow_key,revision} (current server). */
 activeFlows?:unknown;revision?:number;flows?:unknown;truncated?:boolean;
 readiness?:ReadinessReport;candidateRevision?:number|null};

// Pure error classification lives in activationErrors.ts (importable without React/Supabase).
export {ServiceError,serviceErrorDetail,activationErrorMessage} from "./activationErrors.ts";
import {ServiceError,serviceErrorDetail,activationErrorMessage} from "./activationErrors.ts";

export async function invokeService<T extends {ok?:boolean;error?:string}=Reply>(body:Record<string,unknown>):Promise<T>{
 const client=getSupabase();
 if(!client)throw new ServiceError("not_configured",0);
 const {data,error}=await client.functions.invoke("flow-publication",{body});
 if(error){
  // FunctionsHttpError carries the Response; read the server error code safely.
  const ctx=(error as {context?:unknown}).context;
  let message="unavailable",status=0,code:unknown;
  if(ctx instanceof Response){
   status=ctx.status;
   try{const parsed=await ctx.json() as {error?:unknown;code?:unknown};
    if(typeof parsed.error==="string")message=parsed.error;code=parsed.code;}catch{/* keep generic */}
  }
  throw new ServiceError(message,status,code);
 }
 const result=data as T|null;
 if(!result?.ok)throw new ServiceError(result?.error||"denied",200,(result as {code?:unknown}|null)?.code);
 return result;
}

const UNAVAILABLE_REASON="حالة التفعيل غير متاحة الآن: خدمة التدفقات السحابية غير متاحة أو غير مفعّلة.";
const NO_ACCOUNT_REASON="لا يوجد حساب قناة نشط مرتبط؛ اربط حسابًا لتتمكن من تفعيل التدفق.";
/** Customer text: no server codes, HTTP statuses, revisions or engine words. */
const CUSTOMER_UNAVAILABLE_REASON="خدمة التدفقات غير متاحة الآن، حاول مرة أخرى بعد قليل.";
const OPERATOR_ONLY:ToggleResult={ok:false,message:"تعذر التنفيذ"};

/**
 * Who uses the hook (from useOperatorStatus; the server stays authoritative).
 * "operator": full activation state (catalog -> list, toggle, update, revision
 * selection). "customer"/"loading": ONLY the `accounts` action; the account id
 * (and so the editor's capability gating) never depends on operator actions.
 */
export type ActivationAccess="loading"|"operator"|"customer";

function asCatalogFlows(v:unknown):CatalogFlow[]{
 if(!Array.isArray(v))return [];
 return v.filter((f):f is CatalogFlow=>!!f&&typeof f==="object"&&
  typeof (f as CatalogFlow).flowKey==="string"&&typeof (f as CatalogFlow).latestRevision==="number");
}

type Preflight={refusal:string;reload:boolean}|null;

/**
 * Client-side guards before any activate call (never a substitute for the server's):
 * fresh catalog (THIS flow's live state unchanged, the displayed latest revision is
 * still the latest; other active flows of the account are independent and never
 * block or change), then readiness for exactly `target`
 * (the report must be for that revision). Readiness blocks only ADVANCED targets
 * (buttons/delay/internal actions/media/comment); simple text-only revisions keep
 * the server's legacy activation path (see readinessBlockers). Unclassifiable
 * reports fail closed.
 */
async function preflight(accountId:string,localKey:string,key:string,target:number,live:number|null):Promise<Preflight>{
 let catalog:Reply;
 try{catalog=await invokeService({action:"catalog",accountId,flowKey:localKey});}
 catch(e){return {reload:false,refusal:"تعذر التحقق من التدفق النشط على الحساب؛ لم يتم أي تغيير (رمز: "+serviceErrorDetail(e)+
  "). / Could not verify the account's active flow; nothing was changed (code: "+serviceErrorDetail(e)+")."};}
 // Only THIS flow's own entry matters (null = OFF); other active flows are ignored.
 const mine=activeRevisionOf(catalogActiveFlows(catalog),key);
 if(mine!==live)
  return {reload:true,refusal:"تغيّرت حالة التفعيل على الخادم؛ تم تحديث الحالة، راجعها ثم أعد المحاولة. لم يتم أي تغيير."+
   " / The live state changed on the server; status refreshed, review it and retry. Nothing was changed."};
 const listed=asCatalogFlows(catalog.flows).find(f=>f.flowKey===key);
 if(listed&&listed.latestRevision!==target)
  return {reload:true,refusal:"نُشر إصدار مختلف (v"+listed.latestRevision+") بدل v"+target+"؛ تم تحديث الحالة. لم يتم أي تغيير."+
   " / A different latest revision (v"+listed.latestRevision+") exists instead of v"+target+"; status refreshed. Nothing was changed."};
 return readinessGuard(accountId,key,target,live);
}

/** Readiness for exactly `target` must be the server's report for that revision and pass. */
async function readinessGuard(accountId:string,key:string,target:number,live:number|null):Promise<Preflight>{
 let r:Reply;
 try{r=await invokeService({action:"readiness",accountId,flowKey:key,revision:target});}
 catch(e){return {reload:false,refusal:"تعذر فحص جاهزية الإصدار v"+target+"؛ لم يتم أي تغيير (رمز: "+serviceErrorDetail(e)+
  "). / Readiness check for v"+target+" failed; nothing was changed (code: "+serviceErrorDetail(e)+")."};}
 const checked=typeof r.candidateRevision==="number"?r.candidateRevision:null;
 // Unsupported documents (readiness.candidate reasons) are refused too, never only "simple".
 const row=checked===target?classifyRevision({revision:target,activeRevision:live,report:r.readiness,reportRevision:checked}):null;
 const blockers=checked!==target?["candidateRevision"]:
  row&&(row.status==="unsupported"||row.status==="missing")?row.reasons:readinessBlockers(r.readiness,{currentlyActive:live!==null});
 if(blockers.length)return {reload:false,refusal:"الإصدار v"+target+" غير جاهز للتفعيل؛ لم يتم أي تغيير. النواقص: "+blockers.join(", ")+
  " / Revision v"+target+" is not ready; nothing was changed. Missing: "+blockers.join(", ")};
 return null;
}

/**
 * `flowKey`: the LOCAL editor id. The managed server key is resolved from the
 * account catalog (see resolveServerFlowKey) and exposed as `state.serverKey`.
 * `commentPlatform`: provider platform of the open (local) flow's comment trigger
 * (commentTriggerProviderPlatform), null for other flows. A hint for picking the
 * account; it is applied to `canActivate` only when serverKey===flowKey (the
 * local document describes that flow). The server decides on activate.
 */
export function useFlowActivation(flowKey:string,refreshToken:unknown,commentPlatform:ProviderPlatform|null=null,
 access:ActivationAccess="customer"){
 const [state,setState]=useState<ActivationState>({phase:"loading",active:false,revision:null,busy:false,canActivate:false,reason:"",
  serverKey:flowKey,latestRevision:null,activeRevision:null,canUpdate:false,revisions:[],accountId:null});
 const account=useRef<Account|null>(null);
 const seq=useRef(0);
 const operator=access==="operator";

 const load=useCallback(async()=>{
  const mine=++seq.current;
  setState(s=>({...s,phase:"loading",reason:""}));
  try{
   if(!account.current){
    const r=await invokeService({action:"accounts"});
    const list=(r.accounts??[]).filter(a=>a.is_active!==false);
    account.current=pickActivationAccount(list,commentPlatform);
    if(!account.current){
     if(mine===seq.current)setState(s=>({...s,phase:"unavailable",active:false,revision:null,canActivate:false,
      serverKey:flowKey,latestRevision:null,activeRevision:null,canUpdate:false,revisions:[],accountId:null,
      reason:NO_ACCOUNT_REASON}));
     return;
    }
   }
   const acc=account.current;
   if(!operator){
    // Customer (or operator status still unknown): the account id comes from
    // `accounts` ALONE, right away, so capability gating never depends on
    // catalog/list. No operator-only action is ever called on this path.
    if(mine===seq.current)setState(s=>({...s,phase:access==="loading"?"loading":"ready",active:false,revision:null,
     canActivate:accountCanActivate(acc,commentPlatform),serverKey:flowKey,latestRevision:null,activeRevision:null,
     canUpdate:false,revisions:[],accountId:acc.id,reason:""}));
    return;
   }
   // The editor id is local: find the server flow_key this account really runs.
   let serverKey=flowKey,catalogNote="",runtimeNote="";
   try{
    const c=await invokeService({action:"catalog",accountId:acc.id,flowKey});
    serverKey=resolveServerFlowKey({localKey:flowKey,catalog:asCatalogFlows(c.flows),activeFlows:catalogActiveFlows(c)});
    // Active but not started by the runtime (e.g. registry row removed): never presented as fully live.
    runtimeNote=catalogRuntimeNote(c,serverKey)??"";
   }catch(e){
    catalogNote="تعذر قراءة التدفقات المنشورة للحساب؛ تُعرض حالة التدفق المحلي فقط (رمز: "+serviceErrorDetail(e)+").";
   }
   if(mine!==seq.current)return;
   const r=await invokeService({action:"list",accountId:acc.id,flowKey:serverKey});
   if(mine!==seq.current)return;
   const latestRevision=typeof r.items?.[0]?.revision==="number"?r.items[0].revision:null;
   const revisions=listedRevisions(r.items);
   const on=r.activation?.is_active===true;
   const activeRevision=on?r.activation!.revision:null;
   const allowed=accountCanActivate(acc,serverKey===flowKey?commentPlatform:null);
   const reasons=[catalogNote,on?runtimeNote:"",on||allowed?"":"التفعيل غير متاح لحسابك حاليًا؛ يلزم موافقة الخادم والإدارة."].filter(Boolean);
   setState(s=>({...s,phase:"ready",active:on,revision:activeRevision,
    canActivate:allowed,serverKey,latestRevision,activeRevision,
    canUpdate:on&&latestRevision!==null&&activeRevision!==null&&latestRevision>activeRevision,
    revisions,accountId:acc.id,reason:reasons.join(" ")}));
  }catch(e){
   if(mine===seq.current)setState(s=>({...s,phase:"unavailable",active:false,revision:null,canActivate:false,
    serverKey:flowKey,latestRevision:null,activeRevision:null,canUpdate:false,revisions:[],accountId:null,
    reason:operator?UNAVAILABLE_REASON+" (رمز: "+serviceErrorDetail(e)+")":CUSTOMER_UNAVAILABLE_REASON}));
  }
 },[flowKey,commentPlatform,operator,access]);

 // A different comment platform may need a different account: pick again.
 useEffect(()=>{account.current=null;},[commentPlatform]);
 useEffect(()=>{void load();return()=>{seq.current++;};},[load,refreshToken]);

 const toggle=useCallback(async():Promise<ToggleResult>=>{
  if(!operator)return OPERATOR_ONLY; // operator-only (the server refuses it for customers too)
  const acc=account.current;
  if(!acc||state.busy||state.phase!=="ready")return {ok:false,message:"تعذر التفعيل"};
  const key=state.serverKey;
  if(state.active){
   const live=state.activeRevision;
   if(!window.confirm("إيقاف الأتمتة الفعلية للتدفق «"+key+"» (الإصدار المباشر v"+live+")؟ ستتوقف الردود التلقائية لهذا التدفق."+
    "\nStop the live automation for flow \""+key+"\" (live revision v"+live+")? Automatic replies from this flow will stop."))
    return {ok:false,message:"أُلغي الإيقاف؛ لم يتغير شيء. / Stop cancelled; nothing changed."};
   setState(s=>({...s,busy:true}));
   try{
    await invokeService({action:"deactivate",accountId:acc.id,flowKey:key});
    setState(s=>({...s,busy:false,active:false,revision:null,activeRevision:null,canUpdate:false}));
    return {ok:true,message:"تم إيقاف التدفق"};
   }catch(e){
    setState(s=>({...s,busy:false}));
    return {ok:false,message:activationErrorMessage(e,"الإيقاف")};
   }
  }
  const target=state.latestRevision;
  if(target===null)return {ok:false,message:activationErrorMessage(new ServiceError("No published revision",0),"التفعيل")};
  setState(s=>({...s,busy:true}));
  try{
   const guard=await preflight(acc.id,flowKey,key,target,null);
   if(guard){
    setState(s=>({...s,busy:false}));
    if(guard.reload)void load();
    return {ok:false,message:guard.refusal};
   }
   if(!window.confirm("تفعيل الأتمتة الفعلية للتدفق «"+key+"» بالإصدار v"+target+"؟ سيبدأ الرد التلقائي على الرسائل الواردة."+
    "\nActivate live automation for flow \""+key+"\" at revision v"+target+"? Incoming messages will be answered automatically.")){
    setState(s=>({...s,busy:false}));
    return {ok:false,message:"أُلغي التفعيل؛ لم يتغير شيء. / Activation cancelled; nothing changed."};
   }
   const r=await invokeService({action:"activate",accountId:acc.id,flowKey:key,revision:target});
   const rev=typeof r.revision==="number"?r.revision:target;
   setState(s=>({...s,busy:false,active:true,revision:rev,activeRevision:rev,
    canUpdate:s.latestRevision!==null&&s.latestRevision>rev}));
   return {ok:true,message:"تم تفعيل التدفق (الإصدار "+rev+")"};
  }catch(e){
   setState(s=>({...s,busy:false}));
   return {ok:false,message:activationErrorMessage(e,"التفعيل")};
  }
 },[flowKey,load,operator,state.active,state.busy,state.phase,state.serverKey,state.latestRevision,state.activeRevision]);

 /**
  * Move the live automation of serverKey to exactly the displayed latest revision:
  * readiness(latest) must pass, then a confirm naming key and from->to, then one
  * activate(serverKey, latest). Never another revision, never automatic.
  */
 const updateToLatest=useCallback(async():Promise<ToggleResult>=>{
  if(!operator)return OPERATOR_ONLY;
  const acc=account.current;
  const from=state.activeRevision,to=state.latestRevision;
  if(!acc||state.busy||state.phase!=="ready"||!state.active||from===null||to===null||to<=from)
   return {ok:false,message:"لا يوجد إصدار أحدث للتحديث. / No newer revision to update to."};
  const key=state.serverKey;
  setState(s=>({...s,busy:true}));
  try{
   const guard=await preflight(acc.id,flowKey,key,to,from);
   if(guard){
    setState(s=>({...s,busy:false}));
    if(guard.reload)void load();
    return {ok:false,message:guard.refusal};
   }
   if(!window.confirm("تحديث الأتمتة الفعلية للتدفق «"+key+"» من الإصدار v"+from+" إلى v"+to+"؟"+
    "\nUpdate the live automation for flow \""+key+"\" from revision v"+from+" to v"+to+"?")){
    setState(s=>({...s,busy:false}));
    return {ok:false,message:"أُلغي التحديث؛ لم يتغير شيء. / Update cancelled; nothing changed."};
   }
   const r=await invokeService({action:"activate",accountId:acc.id,flowKey:key,revision:to});
   const rev=typeof r.revision==="number"?r.revision:to;
   setState(s=>({...s,busy:false,active:true,revision:rev,activeRevision:rev,
    canUpdate:s.latestRevision!==null&&s.latestRevision>rev}));
   return {ok:true,message:"تم تحديث التدفق إلى الإصدار v"+rev+" / Updated to revision v"+rev};
  }catch(e){
   setState(s=>({...s,busy:false}));
   return {ok:false,message:activationErrorMessage(e,"التحديث")};
  }
 },[flowKey,load,operator,state.active,state.busy,state.phase,state.serverKey,state.latestRevision,state.activeRevision]);

 /**
  * Activate EXACTLY the revision the user selected (`selected`), replacing this
  * flow's current active revision (other flows/accounts untouched). Re-reads the
  * flow's revisions and active state first and refuses a missing/stale/already
  * active selection; readiness(selected) must pass; the confirm names the flow,
  * the selected revision and the one it replaces. No selection = refusal, never
  * the latest. The state is then reloaded from the server.
  */
 const activateRevision=useCallback(async(selected:number|null):Promise<ToggleResult>=>{
  if(!operator)return OPERATOR_ONLY;
  const acc=account.current;
  if(!acc||state.busy||state.phase!=="ready")return {ok:false,message:"تعذر التفعيل"};
  const key=state.serverKey,loaded=state.activeRevision;
  const refuse=(code:keyof typeof REFUSAL_TEXT)=>({ok:false,message:REFUSAL_TEXT[code].ar+" / "+REFUSAL_TEXT[code].en});
  if(typeof selected!=="number")return refuse("no_selection");
  setState(s=>({...s,busy:true}));
  try{
   let fresh:Reply;
   try{fresh=await invokeService({action:"list",accountId:acc.id,flowKey:key});}
   catch(e){setState(s=>({...s,busy:false}));
    return {ok:false,message:"تعذر إعادة قراءة إصدارات التدفق؛ لم يتم أي تغيير (رمز: "+serviceErrorDetail(e)+
     "). / Could not re-read the flow's revisions; nothing was changed (code: "+serviceErrorDetail(e)+")."};}
   const refusal=selectionRefusal({selected,freshRevisions:listedRevisions(fresh.items),
    freshActive:listedActive(fresh.activation),loadedActive:loaded});
   if(refusal){setState(s=>({...s,busy:false}));if(refusal!=="already_active")void load();return refuse(refusal);}
   const guard=await readinessGuard(acc.id,key,selected,loaded);
   if(guard){setState(s=>({...s,busy:false}));return {ok:false,message:guard.refusal};}
   if(!window.confirm(activationConfirmText(key,loaded,selected))){
    setState(s=>({...s,busy:false}));
    return {ok:false,message:"أُلغي التفعيل؛ لم يتغير شيء. / Activation cancelled; nothing changed."};
   }
   await invokeService({action:"activate",accountId:acc.id,flowKey:key,revision:selected});
   setState(s=>({...s,busy:false}));
   await load();
   return {ok:true,message:"تم تفعيل الإصدار v"+selected+" للتدفق «"+key+"»"+(loaded!==null&&loaded!==selected?" بدل v"+loaded:"")+
    " / Revision v"+selected+" of \""+key+"\" is active"+(loaded!==null&&loaded!==selected?" (replaced v"+loaded+")":"")};
  }catch(e){
   setState(s=>({...s,busy:false}));
   return {ok:false,message:activationErrorMessage(e,"التفعيل")};
  }
 },[load,operator,state.busy,state.phase,state.serverKey,state.activeRevision]);

 return {state,toggle,updateToLatest,activateRevision};
}
