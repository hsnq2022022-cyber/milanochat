import {useCallback,useEffect,useState} from "react";
import {apiAuthFetch} from "../lib/api";

type ReviewItem={
 claim_id:string; platform:string; status:"attempting"|"uncertain"|"confirmed";
 provider_message_id:string|null;attempted_at:string;uncertain_at:string|null;
 review_status:string;review_requested_at:string|null;
};
type FlowAttempt={outbox_id:string;claim_id:string|null;status:"attempting"|"uncertain"|"confirmed";
 provider_message_id:string|null;attempted_at:string|null;review_status:string};
type FlowFailure={id:string;effect_kind:string|null;delivery_status:string;attempts:number;
 created_at:string|null;cancel_reason:string|null};
type FlowRun={id:string;flow_key:string|null;platform:string;run_status:string;
 wake_at:string|null;updated_at:string|null;ended_reason:string|null};
type Inbox={items:ReviewItem[];readOnly:true;flowItems?:FlowAttempt[];flowFailures?:FlowFailure[];
 flowRuns?:FlowRun[];runCounts?:Record<string,number>;flowAvailable?:boolean};
type Totals={events:Record<string,number>;periodDays:number;truncated:boolean};
const runStatusNames:Record<string,string>={
 awaiting_input:"بانتظار رد العميل",sleeping:"مؤجلة (انتظار)",handoff:"محوّلة لموظف",
 blocked:"متوقفة",completed:"مكتملة",ready:"جاهزة للتنفيذ"
};
const failureNames:Record<string,string>={
 uncertain:"إرسال غير مؤكد",dead_letter:"فشل الإرسال",billing_blocked:"موقوف بسبب الرصيد"
};
const cancelReasonNames:Record<string,string>={
 no_knowledge:"لا توجد معرفة كافية للإجابة",ai_unavailable:"خدمة الرد الآلي لم تكن متاحة",
 ai_retries_exhausted:"تعذّر إنتاج رد آلي بعد عدة محاولات",input_timeout:"انتهت مهلة انتظار رد العميل",
 stale:"انتظرت الرسالة طويلًا ولم تُرسل",free_text:"كتب العميل نصًا بدل اختيار زر",
 revision_inactive:"نسخة التدفق لم تعد مفعّلة",superseded:"حلّت محلها رسالة أحدث",
 ineligible:"الرسالة غير مؤهلة للإرسال",human_takeover:"تولّى موظف المحادثة",
 lease_exhausted:"انتهت مهلة معالجة الرسالة",duplicate_active:"توجد رسالة مماثلة قيد المعالجة",manual:"أُلغيت يدويًا"
};
const UNKNOWN_REASON="سبب غير معروف";
const cancelReasonLabel=(r:string|null|undefined)=>r?(Object.prototype.hasOwnProperty.call(cancelReasonNames,r)?cancelReasonNames[r]:UNKNOWN_REASON):"";
const fmt=(v:string|null)=>v?new Date(v).toLocaleString("ar-IQ"):"—";
const metricNames:Record<string,string>={
 started:"بدأت",transition:"انتقالات",button:"أزرار",
 delivered:"تسليم مؤكد",completed:"اكتملت",handoff:"تحويل بشري",failed:"فشلت"
};
/** Operations UI — view-only; operator identity must be authorized on server. */
export default function DeliveryReviewPanel({token,tenantId}:{token:string|null;tenantId:string}){
 const [items,setItems]=useState<ReviewItem[]>([]);
 const [totals,setTotals]=useState<Totals|null>(null);
 const [flow,setFlow]=useState<Inbox|null>(null);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState("");
 const refresh=useCallback(async()=>{
  if(!token){setError("سجّل الدخول للوصول إلى قائمة المراجعة");return;}
  setLoading(true);setError("");
  try{
   const [inbox,metrics]=await Promise.all([
    apiAuthFetch<Inbox>(token,"/api/dashboard/delivery-review",{method:"POST",body:JSON.stringify({tenantId})}),
    apiAuthFetch<Totals>(token,"/api/dashboard/flow-metrics",{method:"POST",body:JSON.stringify({tenantId})})
   ]);
   if(!Array.isArray(inbox.items))throw new Error("صيغة قائمة المراجعة غير صالحة");
   setItems(inbox.items);setTotals(metrics);setFlow(inbox);
  }catch(e){
   setError(e instanceof Error?e.message:"تعذر تحميل البيانات");
  }finally{setLoading(false);}
 },[token,tenantId]);
 useEffect(()=>{void refresh();},[refresh]);
 const container="rounded-xl border border-emerald-700/40 bg-[#102A22] p-4";
 return <section dir="rtl" data-testid="delivery-review-panel" className="min-w-0 space-y-4 text-white">
  <header className="flex flex-wrap items-center justify-between gap-3">
   <div>
    <h2 className="text-lg font-bold">مراجعة الرسائل غير المؤكدة</h2>
    <p className="mt-1 text-xs text-white/70">عرض فقط — لا إعادة إرسال ولا خصم تلقائي. يتطلب إذن مالك المتجر.</p>
   </div>
   <button type="button" onClick={()=>void refresh()} disabled={loading}
    className="rounded-lg border border-emerald-500 px-3 py-2 text-sm disabled:opacity-50">
    {loading?"جارٍ التحديث…":"تحديث القائمة"}
   </button>
  </header>
  {error&&<p role="alert" className="rounded-lg border border-red-500/50 p-3 text-sm text-red-200">{error}</p>}
  {totals&&<section aria-label="إحصائيات التدفقات خلال 30 يومًا" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
   {Object.entries(metricNames).map(([key,label])=><div className={container} key={key}>
    <div className="text-xs text-white/70">{label}</div>
    <p className="mt-2 text-lg font-semibold tabular-nums">{totals.events?.[key]??0}</p>
   </div>)}
   {totals.truncated&&<p className="col-span-full text-xs text-amber-200">الإحصائيات جزئية بسبب حد 1000 حدث.</p>}
  </section>}
  {flow?.runCounts&&<section aria-label="حالة تشغيلات التدفقات" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
   {Object.entries(runStatusNames).map(([key,label])=><div className={container} key={key}>
    <div className="text-xs text-white/70">{label}</div>
    <p className="mt-2 text-lg font-semibold tabular-nums">{flow.runCounts?.[key]??0}</p>
   </div>)}
   {flow.flowAvailable===false&&<p className="col-span-full text-xs text-amber-200">بيانات التدفقات المتقدمة غير متاحة كاملة حاليًا.</p>}
  </section>}
  {(flow?.flowFailures?.length??0)>0&&<section aria-label="رسائل التدفقات الفاشلة أو غير المؤكدة" className="space-y-2">
   <h3 className="text-sm font-bold">رسائل تدفقات فاشلة أو غير مؤكدة</h3>
   <ul className="space-y-2">{flow!.flowFailures!.map(f=><li key={f.id} className={container}>
    <span className="rounded-md bg-red-500/15 px-2 py-1 text-xs text-red-100">{failureNames[f.delivery_status]??f.delivery_status}</span>
    <p className="mt-2 break-all text-xs text-white/65">مرجع الرسالة: {f.id}</p>
    <p className="mt-1 text-xs text-white/65">المحاولات: {f.attempts} — الوقت: {fmt(f.created_at)}</p>
    {f.delivery_status!=="billing_blocked"&&(f.cancel_reason||f.delivery_status==="dead_letter")&&<p data-testid="flow-cancel-reason" data-reason-code={f.cancel_reason??""} className="mt-1 text-xs text-amber-100">{f.delivery_status==="dead_letter"?"سبب الفشل":"سبب الإلغاء"}: {f.cancel_reason?cancelReasonLabel(f.cancel_reason):"السبب غير محدد"}</p>}
   </li>)}</ul>
  </section>}
  {(flow?.flowItems?.length??0)>0&&<section aria-label="محاولات إرسال التدفقات بانتظار المراجعة" className="space-y-2">
   <h3 className="text-sm font-bold">محاولات إرسال تدفقات تحتاج مراجعة</h3>
   <ul className="space-y-2">{flow!.flowItems!.map(a=><li key={a.outbox_id} className={container}>
    <span className="rounded-md bg-amber-500/15 px-2 py-1 text-xs text-amber-100">{a.status==="uncertain"?"غير مؤكد":"تحتاج مراجعة بشرية"}</span>
    <p className="mt-2 break-all text-xs text-white/65">مرجع الرسالة: {a.outbox_id}</p>
    <p className="mt-1 text-xs text-white/65">معرّف المزود: {a.provider_message_id||"لم يصل تأكيد"} — {fmt(a.attempted_at)}</p>
   </li>)}</ul>
  </section>}
  {(flow?.flowRuns?.length??0)>0&&<section aria-label="تشغيلات تدفقات تحتاج متابعة" className="space-y-2">
   <h3 className="text-sm font-bold">تشغيلات تحتاج متابعة</h3>
   <ul className="space-y-2">{flow!.flowRuns!.map(r=><li key={r.id} className={container}>
    <span className="font-semibold">{r.flow_key??"—"}</span>
    <span className="ms-2 rounded-md bg-white/10 px-2 py-1 text-xs">{runStatusNames[r.run_status]??r.run_status}</span>
    <p className="mt-1 text-xs text-white/65">آخر تحديث: {fmt(r.updated_at)}{r.wake_at?` — الاستئناف: ${fmt(r.wake_at)}`:""}</p>
    {r.ended_reason&&<p data-testid="flow-run-ended-reason" data-reason-code={r.ended_reason} className="mt-1 text-xs text-white/65">سبب التوقف: {cancelReasonLabel(r.ended_reason)}</p>}
   </li>)}</ul>
  </section>}
  {items.length===0&&!(flow?.flowItems?.length)&&!(flow?.flowFailures?.length)&&!loading&&!error&&<p className={container}>لا توجد رسائل تحتاج مراجعة الآن.</p>}
  <ul className="space-y-3">
   {items.map(item=><li key={item.claim_id} className={container}>
    <div className="flex flex-wrap justify-between gap-2">
     <span className="font-semibold">{item.platform==="instagram"?"Instagram":
      item.platform==="facebook"?"Messenger":item.platform==="whatsapp"?"WhatsApp":"قناة غير معروفة"}</span>
     <span className="rounded-md bg-amber-500/15 px-2 py-1 text-xs text-amber-100">تحتاج مراجعة بشرية</span>
    </div>
    <p className="mt-2 break-all text-xs text-white/65">مرجع الحالة: {item.claim_id}</p>
    <p className="mt-1 text-xs text-white/65">معرّف المزود: {item.provider_message_id||"لم يصل تأكيد"}</p>
    <p className="mt-1 text-xs text-white/65">وقت المحاولة: {new Date(item.attempted_at).toLocaleString("ar-IQ")}</p>
    <p className="mt-2 text-xs text-amber-100">تحقق من صندوق القناة قبل اتخاذ أي إجراء. هذه الواجهة لا ترسل.</p>
   </li>)}
  </ul>
 </section>;
}
