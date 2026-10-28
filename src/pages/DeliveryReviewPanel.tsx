import {useCallback,useEffect,useState} from "react";
import {apiAuthFetch} from "../lib/api";

type ReviewItem={
 claim_id:string; platform:string; status:"attempting"|"uncertain"|"confirmed";
 provider_message_id:string|null;attempted_at:string;uncertain_at:string|null;
 review_status:string;review_requested_at:string|null;
};
type Inbox={items:ReviewItem[];readOnly:true};
type Totals={events:Record<string,number>;periodDays:number;truncated:boolean};
const metricNames:Record<string,string>={
 started:"بدأت",transition:"انتقالات",button:"أزرار",
 delivered:"تسليم مؤكد",completed:"اكتملت",handoff:"تحويل بشري",failed:"فشلت"
};
/** Operations UI — view-only; operator identity must be authorized on server. */
export default function DeliveryReviewPanel({token}:{token:string|null}){
 const [items,setItems]=useState<ReviewItem[]>([]);
 const [totals,setTotals]=useState<Totals|null>(null);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState("");
 const refresh=useCallback(async()=>{
  if(!token){setError("سجّل الدخول للوصول إلى قائمة المراجعة");return;}
  setLoading(true);setError("");
  try{
   const [inbox,metrics]=await Promise.all([
    apiAuthFetch<Inbox>(token,"/api/dashboard/delivery-review"),
    apiAuthFetch<Totals>(token,"/api/dashboard/flow-metrics")
   ]);
   if(!Array.isArray(inbox.items))throw new Error("صيغة قائمة المراجعة غير صالحة");
   setItems(inbox.items);setTotals(metrics);
  }catch(e){
   setError(e instanceof Error?e.message:"تعذر تحميل البيانات");
  }finally{setLoading(false);}
 },[token]);
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
  {items.length===0&&!loading&&!error&&<p className={container}>لا توجد رسائل تحتاج مراجعة الآن.</p>}
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
