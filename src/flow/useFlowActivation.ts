import {useCallback,useEffect,useRef,useState} from "react";
import {getSupabase} from "../lib/supabase";

/**
 * Real (server) activation state for one flow, via the existing `flow-publication`
 * Edge Function: accounts -> list (status) -> activate / deactivate.
 * Nothing here is local: the toggle only reflects what the server reports.
 */
export type ActivationPhase="loading"|"ready"|"unavailable";
export type ActivationState={
 phase:ActivationPhase;active:boolean;revision:number|null;busy:boolean;
 /** True when activation (not deactivation) is currently allowed for the account. */
 canActivate:boolean;
 /** Arabic explanation shown when the toggle is unavailable. */
 reason:string;
};
export type ToggleResult={ok:boolean;message:string};

type Account={id:string;platform:string;is_active:boolean|null;canActivate?:boolean};
type Reply={ok?:boolean;error?:string;accounts?:Account[];
 items?:Array<{revision:number}>;activation?:{revision:number;is_active:boolean}|null;
 active?:boolean;revision?:number};

class ServiceError extends Error{
 constructor(message:string,readonly status:number){super(message);}
}

async function invokeService(body:Record<string,unknown>):Promise<Reply>{
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
 const result=data as Reply|null;
 if(!result?.ok)throw new ServiceError(result?.error||"denied",200);
 return result;
}

/** Map real server error codes to Arabic. `verb` is «التفعيل» or «الإيقاف». */
export function activationErrorMessage(e:unknown,verb:"التفعيل"|"الإيقاف"):string{
 const prefix="تعذر "+verb;
 const code=e instanceof ServiceError?e.message:"";
 const status=e instanceof ServiceError?e.status:0;
 if(code==="No published revision")return prefix+": لا يوجد إصدار منشور، انشر التدفق أولًا";
 if(code==="This flow uses unsupported runtime features")return prefix+": الميزة غير مدعومة";
 if(code==="Publication activation is disabled"||code==="Global/tenant switch is OFF"||status===423)
  return prefix+": التفعيل غير مفعّل على حسابك بعد";
 if(code==="Account is paused")return prefix+": الحساب أو الرد التلقائي متوقف";
 if(code==="Account is disabled"||code==="Account not authorized"||code==="Tenant not authorized"||status===403)
  return prefix+": الحساب غير مصرّح له";
 if(code==="Publication revision not found"||code==="No active publication found"||status===404)
  return prefix+": الإصدار غير موجود أو غير نشط";
 if(code==="Not authenticated"||status===401)return prefix+": سجّل الدخول ثم أعد المحاولة";
 if(code==="Rate limit exceeded"||status===429)return prefix+": محاولات كثيرة، أعد المحاولة بعد قليل";
 if(status===503||status===0&&code==="unavailable")return prefix+": الخدمة غير متاحة مؤقتًا";
 return prefix;
}

const UNAVAILABLE_REASON="حالة التفعيل غير متاحة الآن: خدمة التدفقات السحابية غير متاحة أو غير مفعّلة.";

export function useFlowActivation(flowKey:string,refreshToken:unknown){
 const [state,setState]=useState<ActivationState>({phase:"loading",active:false,revision:null,busy:false,canActivate:false,reason:""});
 const account=useRef<Account|null>(null);
 const latest=useRef<number|null>(null);
 const seq=useRef(0);

 const load=useCallback(async()=>{
  const mine=++seq.current;
  setState(s=>({...s,phase:"loading",reason:""}));
  try{
   if(!account.current){
    const r=await invokeService({action:"accounts"});
    const list=(r.accounts??[]).filter(a=>a.is_active!==false);
    account.current=list.find(a=>a.canActivate===true)??list[0]??null;
    if(!account.current){
     if(mine===seq.current)setState(s=>({...s,phase:"unavailable",active:false,revision:null,canActivate:false,
      reason:"لا يوجد حساب قناة نشط مرتبط؛ اربط حسابًا لتتمكن من تفعيل التدفق."}));
     return;
    }
   }
   const r=await invokeService({action:"list",accountId:account.current.id,flowKey});
   if(mine!==seq.current)return;
   latest.current=r.items?.[0]?.revision??null;
   const on=r.activation?.is_active===true;
   setState(s=>({...s,phase:"ready",active:on,revision:on?r.activation!.revision:null,
    canActivate:account.current?.canActivate===true,
    reason:on||account.current?.canActivate===true?"":"التفعيل غير متاح لحسابك حاليًا؛ يلزم موافقة الخادم والإدارة."}));
  }catch{
   if(mine===seq.current)setState(s=>({...s,phase:"unavailable",active:false,revision:null,canActivate:false,reason:UNAVAILABLE_REASON}));
  }
 },[flowKey]);

 useEffect(()=>{void load();return()=>{seq.current++;};},[load,refreshToken]);

 const toggle=useCallback(async():Promise<ToggleResult>=>{
  const acc=account.current;
  if(!acc||state.busy||state.phase!=="ready")return {ok:false,message:"تعذر التفعيل"};
  const turningOn=!state.active;
  const verb=turningOn?"التفعيل":"الإيقاف";
  setState(s=>({...s,busy:true}));
  try{
   if(turningOn){
    if(latest.current===null)throw new ServiceError("No published revision",200);
    const r=await invokeService({action:"activate",accountId:acc.id,flowKey,revision:latest.current});
    setState(s=>({...s,busy:false,active:true,revision:r.revision??latest.current}));
    return {ok:true,message:"تم تفعيل التدفق (الإصدار "+(r.revision??latest.current)+")"};
   }
   await invokeService({action:"deactivate",accountId:acc.id,flowKey});
   setState(s=>({...s,busy:false,active:false,revision:null}));
   return {ok:true,message:"تم إيقاف التدفق"};
  }catch(e){
   setState(s=>({...s,busy:false}));
   return {ok:false,message:activationErrorMessage(e,verb)};
  }
 },[flowKey,state.active,state.busy,state.phase]);

 return {state,toggle};
}
