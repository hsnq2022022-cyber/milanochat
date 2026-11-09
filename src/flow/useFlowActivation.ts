import {useCallback,useEffect,useRef,useState} from "react";
import {getSupabase} from "../lib/supabase";
import {accountCanActivate,otherActiveFlowKey,pickActivationAccount,readinessBlockers,resolveServerFlowKey,
 type ActivationAccount,type CatalogActive,type CatalogFlow,type ReadinessReport} from "./activationAccount.ts";
import type {ProviderPlatform} from "./serverPublicationValidation.ts";

/**
 * Real (server) activation state for one flow, via the existing `flow-publication`
 * Edge Function: accounts -> catalog (resolve the server flow_key) -> list (status)
 * -> readiness + activate / deactivate.
 * Nothing here is local: the toggle only reflects what the server reports, and
 * every server gate (auth, tenant/account scope, approval, readiness) still applies.
 */
export type ActivationPhase="loading"|"ready"|"unavailable";
export type ActivationState={
 phase:ActivationPhase;active:boolean;revision:number|null;busy:boolean;
 /** True when activation (not deactivation) is currently allowed for the account. */
 canActivate:boolean;
 /** Arabic explanation shown when the toggle is unavailable (includes server codes). */
 reason:string;
 /** Server flow_key the toggle manages (catalog active key, else the local editor id). */
 serverKey:string;
 /** Newest published revision of serverKey (list items[0]), null = none published. */
 latestRevision:number|null;
 /** Live revision of serverKey (list activation when is_active), null = OFF. */
 activeRevision:number|null;
 /** Active and a newer published revision exists. */
 canUpdate:boolean;
};
export type ToggleResult={ok:boolean;message:string};

type Account=ActivationAccount;
type Reply={ok?:boolean;error?:string;accounts?:Account[];
 items?:Array<{revision:number}>;activation?:{revision:number;is_active:boolean}|null;
 /** activate: boolean; catalog: the account's active publication. */
 active?:unknown;revision?:number;flows?:unknown;truncated?:boolean;
 readiness?:ReadinessReport;candidateRevision?:number|null};

/** Server error: `message` is the server's error code text, `status` the HTTP status (0 = client side). */
export class ServiceError extends Error{
 constructor(message:string,readonly status:number){super(message);}
}

export async function invokeService<T extends {ok?:boolean;error?:string}=Reply>(body:Record<string,unknown>):Promise<T>{
 const client=getSupabase();
 if(!client)throw new ServiceError("not_configured",0);
 const {data,error}=await client.functions.invoke("flow-publication",{body});
 if(error){
  // FunctionsHttpError carries the Response; read the server error code safely.
  const ctx=(error as {context?:unknown}).context;
  let message="unavailable",status=0;
  if(ctx instanceof Response){
   status=ctx.status;
   try{const parsed=await ctx.json() as {error?:unknown};if(typeof parsed.error==="string")message=parsed.error;}catch{/* keep generic */}
  }
  throw new ServiceError(message,status);
 }
 const result=data as T|null;
 if(!result?.ok)throw new ServiceError(result?.error||"denied",200);
 return result;
}

/** Visible diagnostic code for support: server code text plus HTTP status. Never secrets. */
export function serviceErrorDetail(e:unknown):string{
 if(e instanceof ServiceError)return e.message.slice(0,160)+(e.status?" · HTTP "+e.status:"");
 if(e instanceof Error&&e.message)return e.message.slice(0,160);
 return "unknown";
}

type Verb="التفعيل"|"الإيقاف"|"التحديث";
const VERB_EN:Record<Verb,string>={"التفعيل":"Could not activate","الإيقاف":"Could not stop","التحديث":"Could not update"};

/** Map real server error codes to Arabic (or English); the raw code is always appended. */
export function activationErrorMessage(e:unknown,verb:Verb,en=false):string{
 const code=e instanceof ServiceError?e.message:"";
 const status=e instanceof ServiceError?e.status:0;
 let ar="",eng="";
 if(code==="No published revision"){ar="لا يوجد إصدار منشور، انشر التدفق أولًا";eng="no published revision, publish the flow first";}
 else if(code==="This flow uses unsupported runtime features"){ar="الميزة غير مدعومة";eng="unsupported feature";}
 else if(code==="Publication activation is disabled"||code==="Global/tenant switch is OFF"||status===423)
  {ar="التفعيل غير مفعّل على حسابك بعد";eng="activation is not enabled for your account yet";}
 else if(code==="Account is paused"){ar="الحساب أو الرد التلقائي متوقف";eng="the account or auto reply is paused";}
 else if(code==="Account is disabled"||code==="Account not authorized"||code==="Tenant not authorized"||status===403)
  {ar="الحساب غير مصرّح له";eng="the account is not authorized";}
 else if(code==="Publication revision not found"||code==="No active publication found"||status===404)
  {ar="الإصدار غير موجود أو غير نشط";eng="revision not found or not active";}
 else if(code==="Conflicting active revisions"||status===409)
  {ar="يوجد أكثر من إصدار نشط على الحساب";eng="more than one active revision on the account";}
 else if(code==="Not authenticated"||status===401){ar="سجّل الدخول ثم أعد المحاولة";eng="sign in and try again";}
 else if(code==="Rate limit exceeded"||status===429){ar="محاولات كثيرة، أعد المحاولة بعد قليل";eng="too many attempts, try again shortly";}
 else if(status===503||status===0&&code==="unavailable"){ar="الخدمة غير متاحة مؤقتًا";eng="service temporarily unavailable";}
 const detail=serviceErrorDetail(e);
 if(en)return VERB_EN[verb]+(eng?": "+eng:"")+" (code: "+detail+")";
 return "تعذر "+verb+(ar?": "+ar:"")+" (رمز: "+detail+")";
}

const UNAVAILABLE_REASON="حالة التفعيل غير متاحة الآن: خدمة التدفقات السحابية غير متاحة أو غير مفعّلة.";

function asCatalogActive(v:unknown):CatalogActive|null{
 if(!v||typeof v!=="object")return null;
 const a=v as {flow_key?:unknown;revision?:unknown};
 return typeof a.flow_key==="string"&&a.flow_key.length>0&&typeof a.revision==="number"
  ?{flow_key:a.flow_key,revision:a.revision}:null;
}
function asCatalogFlows(v:unknown):CatalogFlow[]{
 if(!Array.isArray(v))return [];
 return v.filter((f):f is CatalogFlow=>!!f&&typeof f==="object"&&
  typeof (f as CatalogFlow).flowKey==="string"&&typeof (f as CatalogFlow).latestRevision==="number");
}

type Preflight={refusal:string;reload:boolean}|null;

/**
 * Client-side guards before any activate call (never a substitute for the server's):
 * fresh catalog (exactly one active flow per account, unchanged live state, the
 * displayed latest revision is still the latest), then readiness for exactly `target`
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
 const active=asCatalogActive(catalog.active);
 const other=otherActiveFlowKey(active,key);
 if(other)return {reload:false,refusal:"يعمل تدفق آخر «"+other+"» على هذا الحساب؛ يسمح التشغيل بتدفق نشط واحد فقط لكل حساب. أوقفه أولًا. لم يتم أي تغيير."+
  " / Another flow \""+other+"\" is active on this account; the runtime allows exactly one active flow per account. Stop it first. Nothing was changed."};
 if(live===null?active!==null:active?.revision!==live)
  return {reload:true,refusal:"تغيّرت حالة التفعيل على الخادم؛ تم تحديث الحالة، راجعها ثم أعد المحاولة. لم يتم أي تغيير."+
   " / The live state changed on the server; status refreshed, review it and retry. Nothing was changed."};
 const listed=asCatalogFlows(catalog.flows).find(f=>f.flowKey===key);
 if(listed&&listed.latestRevision!==target)
  return {reload:true,refusal:"نُشر إصدار مختلف (v"+listed.latestRevision+") بدل v"+target+"؛ تم تحديث الحالة. لم يتم أي تغيير."+
   " / A different latest revision (v"+listed.latestRevision+") exists instead of v"+target+"; status refreshed. Nothing was changed."};
 let r:Reply;
 try{r=await invokeService({action:"readiness",accountId,flowKey:key,revision:target});}
 catch(e){return {reload:false,refusal:"تعذر فحص جاهزية الإصدار v"+target+"؛ لم يتم أي تغيير (رمز: "+serviceErrorDetail(e)+
  "). / Readiness check for v"+target+" failed; nothing was changed (code: "+serviceErrorDetail(e)+")."};}
 const checked=typeof r.candidateRevision==="number"?r.candidateRevision:null;
 const blockers=checked!==target?["candidateRevision"]:readinessBlockers(r.readiness,{currentlyActive:live!==null});
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
export function useFlowActivation(flowKey:string,refreshToken:unknown,commentPlatform:ProviderPlatform|null=null){
 const [state,setState]=useState<ActivationState>({phase:"loading",active:false,revision:null,busy:false,canActivate:false,reason:"",
  serverKey:flowKey,latestRevision:null,activeRevision:null,canUpdate:false});
 const account=useRef<Account|null>(null);
 const seq=useRef(0);

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
      serverKey:flowKey,latestRevision:null,activeRevision:null,canUpdate:false,
      reason:"لا يوجد حساب قناة نشط مرتبط؛ اربط حسابًا لتتمكن من تفعيل التدفق."}));
     return;
    }
   }
   const acc=account.current;
   // The editor id is local: find the server flow_key this account really runs.
   let serverKey=flowKey,catalogNote="";
   try{
    const c=await invokeService({action:"catalog",accountId:acc.id,flowKey});
    serverKey=resolveServerFlowKey({localKey:flowKey,catalog:asCatalogFlows(c.flows),active:asCatalogActive(c.active)});
   }catch(e){
    catalogNote="تعذر قراءة التدفقات المنشورة للحساب؛ تُعرض حالة التدفق المحلي فقط (رمز: "+serviceErrorDetail(e)+").";
   }
   if(mine!==seq.current)return;
   const r=await invokeService({action:"list",accountId:acc.id,flowKey:serverKey});
   if(mine!==seq.current)return;
   const latestRevision=typeof r.items?.[0]?.revision==="number"?r.items[0].revision:null;
   const on=r.activation?.is_active===true;
   const activeRevision=on?r.activation!.revision:null;
   const allowed=accountCanActivate(acc,serverKey===flowKey?commentPlatform:null);
   const reasons=[catalogNote,on||allowed?"":"التفعيل غير متاح لحسابك حاليًا؛ يلزم موافقة الخادم والإدارة."].filter(Boolean);
   setState(s=>({...s,phase:"ready",active:on,revision:activeRevision,
    canActivate:allowed,serverKey,latestRevision,activeRevision,
    canUpdate:on&&latestRevision!==null&&activeRevision!==null&&latestRevision>activeRevision,
    reason:reasons.join(" ")}));
  }catch(e){
   if(mine===seq.current)setState(s=>({...s,phase:"unavailable",active:false,revision:null,canActivate:false,
    serverKey:flowKey,latestRevision:null,activeRevision:null,canUpdate:false,
    reason:UNAVAILABLE_REASON+" (رمز: "+serviceErrorDetail(e)+")"}));
  }
 },[flowKey,commentPlatform]);

 // A different comment platform may need a different account: pick again.
 useEffect(()=>{account.current=null;},[commentPlatform]);
 useEffect(()=>{void load();return()=>{seq.current++;};},[load,refreshToken]);

 const toggle=useCallback(async():Promise<ToggleResult>=>{
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
 },[flowKey,load,state.active,state.busy,state.phase,state.serverKey,state.latestRevision,state.activeRevision]);

 /**
  * Move the live automation of serverKey to exactly the displayed latest revision:
  * readiness(latest) must pass, then a confirm naming key and from->to, then one
  * activate(serverKey, latest). Never another revision, never automatic.
  */
 const updateToLatest=useCallback(async():Promise<ToggleResult>=>{
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
 },[flowKey,load,state.active,state.busy,state.phase,state.serverKey,state.latestRevision,state.activeRevision]);

 return {state,toggle,updateToLatest};
}
