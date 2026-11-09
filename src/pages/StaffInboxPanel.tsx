import {useCallback,useEffect,useState} from "react";
import {apiAuthFetch} from "../lib/api";

type StaffNotification={outbox_id:string;conversation_id:string|null;body:string|null;
 status:string|null;created_at:string|null};
type StaffInbox={items:StaffNotification[];readOnly?:boolean};
type State="loading"|"ready"|"disabled"|"forbidden"|"error";
const statusNames:Record<string,string>={
 pending:"بانتظار التسليم",leased:"قيد التسليم",retry_wait:"بانتظار إعادة المحاولة",
 settled:"تم التسليم",delivered:"تم التسليم",dead_letter:"فشل التسليم",cancelled:"أُلغي"
};
const fmt=(v:string|null)=>v?new Date(v).toLocaleString("ar-IQ"):"—";
/** Read-only staff notifications inbox (tag/notify/handoff internal actions). */
export default function StaffInboxPanel({token,tenantId}:{token:string|null;tenantId:string}){
 const [items,setItems]=useState<StaffNotification[]>([]);
 const [state,setState]=useState<State>("loading");
 const refresh=useCallback(async()=>{
  if(!token){setItems([]);setState("forbidden");return;}
  setState("loading");
  try{
   const r=await apiAuthFetch<StaffInbox>(token,"/api/dashboard/staff-inbox",{method:"POST",body:JSON.stringify({tenantId})});
   if(!r||!Array.isArray(r.items))throw new Error("bad shape");
   setItems(r.items);setState("ready");
  }catch(e){
   const m=e instanceof Error?e.message:"";
   setItems([]);
   setState(m==="STAFF_INBOX_DISABLED"?"disabled":m==="STAFF_INBOX_FORBIDDEN"?"forbidden":"error");
  }
 },[token,tenantId]);
 useEffect(()=>{void refresh();},[refresh]);
 const container="rounded-xl border border-emerald-700/40 bg-[#102A22] p-4";
 return <section dir="rtl" data-testid="staff-inbox-panel" className="min-w-0 space-y-3 text-white">
  <header className="flex flex-wrap items-center justify-between gap-3">
   <div>
    <h2 className="sr-only">إشعارات الموظفين</h2>
    <p className="mt-1 text-xs text-white/70">عرض فقط — إشعارات أنشأتها إجراءات التدفقات الداخلية لك.</p>
   </div>
   <button type="button" onClick={()=>void refresh()} disabled={state==="loading"}
    className="rounded-lg border border-emerald-500 px-3 py-2 text-sm disabled:opacity-50">
    {state==="loading"?"جارٍ التحديث…":"تحديث الإشعارات"}
   </button>
  </header>
  {state==="disabled"&&<p data-testid="staff-inbox-disabled" role="status" className={container+" text-sm text-amber-100"}>صندوق إشعارات الموظفين غير مفعّل حاليًا.</p>}
  {state==="forbidden"&&<p data-testid="staff-inbox-forbidden" role="alert" className="rounded-lg border border-red-500/50 p-3 text-sm text-red-200">ليس لديك صلاحية عرض إشعارات الموظفين لهذا المتجر.</p>}
  {state==="error"&&<p data-testid="staff-inbox-error" role="alert" className="rounded-lg border border-red-500/50 p-3 text-sm text-red-200">تعذر تحميل إشعارات الموظفين. حاول مرة أخرى لاحقًا.</p>}
  {state==="ready"&&items.length===0&&<p data-testid="staff-inbox-empty" className={container+" text-sm"}>لا توجد إشعارات للموظفين الآن.</p>}
  {state==="ready"&&items.length>0&&<ul aria-label="قائمة إشعارات الموظفين" className="space-y-2">
   {items.map(n=><li key={n.outbox_id} data-testid="staff-inbox-item" className={container}>
    <div className="flex flex-wrap items-center justify-between gap-2">
     <span className="rounded-md bg-sky-500/15 px-2 py-1 text-xs text-sky-100">إشعار للموظف</span>
     {n.status&&<span className="rounded-md bg-white/10 px-2 py-1 text-xs">{Object.prototype.hasOwnProperty.call(statusNames,n.status)?statusNames[n.status]:"حالة غير معروفة"}</span>}
    </div>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{n.body||"—"}</p>
    <p className="mt-1 text-xs text-white/65">الوقت: {fmt(n.created_at)}{n.conversation_id?" — المحادثة: "+n.conversation_id.slice(0,8):""}</p>
   </li>)}
  </ul>}
 </section>;
}
