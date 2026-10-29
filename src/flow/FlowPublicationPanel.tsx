import {useCallback,useEffect,useState} from "react";
import {getSupabase} from "../lib/supabase";
import type {FlowDocument} from "./model.ts";
import type {FlowLanguage} from "./uiLocale.ts";

type Account={id:string;platform:string;is_active:boolean|null;canActivate?:boolean};
type Version={revision:number;created_at:string};
type Activation={revision:number;is_active:boolean}|null;
type PublishedFlow={flowKey:string;latestRevision:number};
type ActiveFlow={flow_key:string;revision:number}|null;
type ReadinessChecks={
 instagram:boolean;tenant:boolean;account:boolean;globalSwitch:boolean;
 tenantSwitch:boolean;credits:boolean;activeRevision:boolean;supportedCandidate:boolean;ingress:boolean;activation:boolean;
 canary:boolean;operatorRelease:boolean;outbox:boolean;atomicDebit:boolean;
 encryption:boolean;scheduler:boolean;buttons:boolean;
};
type Readiness={checks:ReadinessChecks;candidateKind:"buttons"|"delay"|"unsupported";buttonsConfigured:boolean;delayConfigured:boolean};
const readinessLabels:Record<keyof ReadinessChecks,{ar:string;en:string}>={
 instagram:{ar:"قناة Instagram",en:"Instagram channel"},
 tenant:{ar:"نشاط المتجر",en:"Active store"},
 account:{ar:"نشاط حساب القناة والرد التلقائي",en:"Active channel and auto reply"},
 globalSwitch:{ar:"مفتاح التشغيل العام",en:"Global automation switch"},
 tenantSwitch:{ar:"موافقة تشغيل المتجر",en:"Store production approval"},
 credits:{ar:"توفر رصيد الردود",en:"Reply credits available"},
 activeRevision:{ar:"وجود إصدار نشط لهذا التدفق",en:"Active revision for selected flow"},
 supportedCandidate:{ar:"الإصدار المحدد متوافق مع الأزرار أو التأخير",en:"Selected revision supports buttons or delay"},
 ingress:{ar:"استقبال التدفقات المتقدمة",en:"Durable ingress enabled"},
 activation:{ar:"موافقة تفعيل التدفقات المتقدمة",en:"Advanced activation approval"},
 canary:{ar:"حصر التجربة بهذا الحساب",en:"Canary scoped to account"},
 operatorRelease:{ar:"موافقة تشغيل العمال",en:"Worker operator approval"},
 outbox:{ar:"إرسال Outbox",en:"Outbox sender enabled"},
 atomicDebit:{ar:"الخصم المحمي",en:"Atomic debit enabled"},
 encryption:{ar:"تشفير الرسائل",en:"Message encryption configured"},
 scheduler:{ar:"جدولة التأخير",en:"Delay scheduler enabled"},
 buttons:{ar:"إرسال الأزرار التفاعلية",en:"Rich buttons enabled"}
};
type Reply={ok?:boolean;error?:string;accounts?:Account[];
 items?:Version[];activation?:Activation;revision?:number;
 flows?:PublishedFlow[];active?:ActiveFlow;truncated?:boolean;document?:unknown;readiness?:Readiness;candidateRevision?:number|null};
type Props={flowKey:string;document:FlowDocument;language:FlowLanguage;onClose:()=>void;
 onImportRevision?:(document:unknown)=>boolean;onPreviewRevision?:(document:unknown)=>boolean};

const style="min-h-11 rounded-lg border border-[#275443] bg-[#0F2E24] px-3 py-2 text-sm text-white disabled:opacity-40";
const CANARY_UI=(import.meta as ImportMeta & {env?:Record<string,string|undefined>})
 .env?.VITE_ENABLE_FLOW_CANARY_CONTROLS==="true";

export default function FlowPublicationPanel({flowKey,document,language,onClose,onImportRevision,onPreviewRevision}:Props){
 const en=language==="en";
 const [accounts,setAccounts]=useState<Account[]>([]);
 const [accountId,setAccountId]=useState("");
 const [managedFlowKey,setManagedFlowKey]=useState(flowKey);
 const [catalog,setCatalog]=useState<PublishedFlow[]>([]);
 const [activeServerFlow,setActiveServerFlow]=useState<ActiveFlow>(null);
 const [catalogTruncated,setCatalogTruncated]=useState(false);
 const [versions,setVersions]=useState<Version[]>([]);
 const [activation,setActivation]=useState<Activation>(null);
 const [loaded,setLoaded]=useState(false);
 const [busy,setBusy]=useState(false);
 const [notice,setNotice]=useState("");
 const [readiness,setReadiness]=useState<Readiness|null>(null);
 const [checkedRevision,setCheckedRevision]=useState<number|null>(null);
 const productionReady=accounts.some(a=>a.id===accountId&&a.canActivate===true);
 const isEditingLocalFlow=managedFlowKey===flowKey;
 const showActivationControls=CANARY_UI||productionReady;

 const call=useCallback(async(body:Record<string,unknown>):Promise<Reply>=>{
  const client=getSupabase();
  if(!client)throw Error("Supabase not configured");
  const {data,error}=await client.functions.invoke("flow-publication",{body});
  if(error)throw Error("Publication service unavailable");
  const result=data as Reply|null;
  if(!result?.ok)throw Error(result?.error||"Request denied");
  return result;
 },[]);

 useEffect(()=>{
  let cancelled=false;
  void call({action:"accounts"}).then(r=>{
   if(!cancelled)setAccounts(r.accounts??[]);
  }).catch(()=>{
   if(!cancelled)setNotice(en?"Publication service unavailable.":"خدمة نشر التدفقات غير متاحة.");
  });
  return()=>{cancelled=true;};
 },[call,en]);

 // The editor ID is local; discover immutable publications for the
 // authenticated account instead of guessing the active server flow key.
 useEffect(()=>{
  if(!accountId){setCatalog([]);setActiveServerFlow(null);return;}
  let cancelled=false;
  void call({action:"catalog",accountId,flowKey}).then(r=>{
   if(cancelled)return;
   setCatalog(r.flows??[]);setActiveServerFlow(r.active??null);
   setCatalogTruncated(r.truncated===true);
   if(r.active?.flow_key){
    setManagedFlowKey(r.active.flow_key);
    setLoaded(false);setVersions([]);setActivation(null);
   }
  }).catch(()=>{
   if(!cancelled)setNotice(en?"Unable to list published flows.":"تعذر عرض التدفقات المنشورة.");
  });
  return()=>{cancelled=true;};
 },[accountId,flowKey,call,en]);

 // Read the immutable server revision without importing or writing to local storage.
 const previewRevision=async(revision:number)=>{
  if(!onPreviewRevision||busy||!accountId)return;
  setBusy(true);setNotice("");
  try{
   const r=await call({action:"read",accountId,flowKey:managedFlowKey,revision});
   if(!r.document||!onPreviewRevision(r.document))throw Error("Preview refused");
   onClose();
  }catch{
   setNotice(en?"Could not preview this revision; nothing was changed.":
    "تعذرت معاينة الإصدار؛ لم تتغير المسودة أو الرسائل المنشورة.");
  }finally{setBusy(false);}
 };

 const inspectReadiness=async(revision?:number)=>{
  if(!accountId||busy)return;
  setReadiness(null);setCheckedRevision(null);setBusy(true);setNotice("");
  try{
   const r=await call({action:"readiness",accountId,flowKey:managedFlowKey,...(revision?{revision}:{})});
   if(!r.readiness)throw Error("Missing readiness report");
   setReadiness(r.readiness);
   setCheckedRevision(r.candidateRevision??null);
  }catch{
   setNotice(en?"Unable to verify advanced flow configuration.":
    "تعذر التحقق من إعدادات التدفقات المتقدمة.");
  }finally{setBusy(false);}
 };

 const missingReadinessChecks=(report:Readiness)=>Object.entries(report.checks)
  .filter(([key,ready])=>ready!==true&&
   (key!=="scheduler"||report.candidateKind==="delay")&&
   (key!=="buttons"||report.candidateKind==="buttons"));
 const copyReadiness=async()=>{
  if(!readiness)return;
  const missing=missingReadinessChecks(readiness).map(([key])=>key);
  const configured=readiness.candidateKind==="buttons"?readiness.buttonsConfigured:
   readiness.candidateKind==="delay"?readiness.delayConfigured:false;
  // No token, account ID, customer identity, message or tenant information.
  const report={revision:checkedRevision,kind:readiness.candidateKind,configured,missing};
  try{
   await navigator.clipboard.writeText(JSON.stringify(report,null,2));
   setNotice(en?"Readiness report copied.":"تم نسخ تقرير الجاهزية.");
  }catch{
   setNotice(en?"Could not copy the readiness report.":"تعذر نسخ تقرير الجاهزية.");
  }
 };

 const importRevision=async(revision:number)=>{
  if(!onImportRevision||busy||!accountId)return;
  if(!window.confirm(en
   ?"Import this published version as a NEW local copy, keeping your current flow?"
   :"استيراد الإصدار المنشور كنسخة محلية جديدة مع الحفاظ على التدفق المفتوح؟"))return;
  setBusy(true);setNotice("");
  try{
   const r=await call({action:"read",accountId,flowKey:managedFlowKey,revision});
   if(!r.document||!onImportRevision(r.document))throw Error("Import refused");
   onClose();
  }catch{
   setNotice(en?"Could not import; no existing flow was overwritten."
    :"تعذر الاستيراد؛ لم يتم استبدال أي تدفق موجود.");
  }finally{setBusy(false);}
 };

 const refresh=async(id:string,key:string=managedFlowKey)=>{
  const r=await call({action:"list",accountId:id,flowKey:key});
  setVersions(r.items??[]);
  setActivation(r.activation??null);
  setLoaded(true);
 };
 const load=async()=>{
  if(!accountId||busy)return;
  setBusy(true);setNotice("");setLoaded(false);
  try{await refresh(accountId,managedFlowKey);}
  catch{setNotice(en?"Unable to load revisions.":"تعذر تحميل الإصدارات.");}
  finally{setBusy(false);}
 };
 const publish=async()=>{
  if(!accountId||busy||!isEditingLocalFlow||!window.confirm(en
   ?"Publish a new immutable revision? Messaging will NOT be activated."
   :"نشر إصدار جديد غير قابل للتعديل؟ لن يتم تفعيل إرسال الرسائل."))return;
  setBusy(true);setNotice("");
  try{
   const r=await call({action:"publish",accountId,flowKey,document});
   await refresh(accountId,flowKey);
   setNotice(en?"Published revision "+r.revision+" without activating messages.":
    "تم نشر الإصدار "+r.revision+" دون تفعيل الرسائل.");
  }catch{setNotice(en?"Publishing failed; your local draft is unchanged.":
   "فشل النشر؛ لم تتغير المسودة المحلية.");}
  finally{setBusy(false);}
 };
 const change=async(action:"activate"|"rollback"|"deactivate",revision?:number)=>{
  if(!loaded||!accountId||busy)return;
  if(!window.confirm(action==="deactivate"
   ?(en?"Stop this automation?":"هل تريد إيقاف التدفق؟")
   :(productionReady
     ?(en?"Activate a real incoming-message automation for this account?":
       "تفعيل الأتمتة الفعلية للرسائل الواردة على هذا الحساب؟")
     :(en?"Use a test-only activation? Server approval is required.":
       "تفعيل إصدار تجريبي؟ يتطلب موافقة الخادم."))))return;
  setBusy(true);setNotice("");
  try{
   await call({action,accountId,flowKey:managedFlowKey,...(revision?{revision}:{})});
   await refresh(accountId,managedFlowKey);
   setNotice(en?"Server confirmed the change.":"أكد الخادم التغيير.");
  }catch{setNotice(en?"The server rejected the change.":
   "رفض الخادم التغيير أو حسابك غير معتمد لتفعيل التدفقات.");}
  finally{setBusy(false);}
 };

 return <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 p-3"
  dir={en?"ltr":"rtl"}>
  <section role="dialog" aria-modal="true" aria-label={en?"Flow publications":"الإصدارات المنشورة"}
   className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[#275443] bg-[#0B241C] text-white shadow-2xl">
   <header className="flex items-center justify-between border-b border-[#275443] p-4">
    <h2 className="font-bold">{en?"Publish and revisions":"نشر وإدارة إصدارات التدفق"}</h2>
    <button type="button" className={style} onClick={onClose}
     aria-label={en?"Close":"إغلاق"}>✕</button>
   </header>
   <div className="space-y-4 overflow-y-auto p-4 text-sm">
    <p className="text-xs leading-6 text-[#BED4C9]">{en
     ?"Publishing an immutable revision does not enable messaging. Activating real automation requires explicit server and operator approval."
     :"نشر إصدار لا يفعّل الرسائل. تفعيل الأتمتة الفعلية يحتاج موافقة الخادم ومسؤول النظام."}</p>
    <label className="block space-y-1">
     <span>{en?"Channel account":"حساب القناة"}</span>
     <select className={style+" w-full"} value={accountId} disabled={busy}
      onChange={e=>{setAccountId(e.target.value);setManagedFlowKey(flowKey);setCatalog([]);setActiveServerFlow(null);setCatalogTruncated(false);setLoaded(false);setVersions([]);setActivation(null);setReadiness(null);setCheckedRevision(null);setNotice("");}}>
      <option value="">{en?"Select an account":"اختر الحساب"}</option>
      {accounts.map(a=><option key={a.id} value={a.id}>
       {a.platform+" · "+a.id.slice(0,8)+(a.is_active?"":" (غير نشط)")}
      </option>)}
     </select>
    </label>
    {accountId&&<label className="block space-y-1">
     <span>{en?"Published flow":"إدارة التدفقات المنشورة للحساب"}</span>
     <select className={style+" w-full"} value={managedFlowKey} disabled={busy}
      onChange={e=>{setManagedFlowKey(e.target.value);setLoaded(false);
       setVersions([]);setActivation(null);setReadiness(null);setCheckedRevision(null);setNotice("");}}>
      <option value={flowKey}>{en?"Current local flow":"التدفق المحلي المفتوح"}</option>
      {catalog.filter(item=>item.flowKey!==flowKey).map(item=><option
       key={item.flowKey} value={item.flowKey}>
       {(activeServerFlow?.flow_key===item.flowKey?(en?"Active · ":"نشط · "):"")+
        item.flowKey+" · v"+item.latestRevision}
      </option>)}
     </select>
     {catalogTruncated&&<p className="text-xs text-[#E5B54B]">{en
      ?"Older flows may be omitted after 500 revisions."
      :"قد لا تظهر التدفقات الأقدم من أول 500 إصدار."}</p>}
     {!isEditingLocalFlow&&<p className="text-xs text-[#BED4C9]">{en
      ?"Managing a server flow: view, stop or import a revision. Publishing local edits to another flow is disabled."
      :"إدارة تدفق منشور: يمكنك عرض الإصدارات أو إيقافه أو استيراد نسخة، ولا يمكن نشر مسودة محلية مختلفة عليه مباشرة."}</p>}
    </label>}
    {accountId&&activeServerFlow&&<div data-testid="flow-active-server-status"
     role="status" className="rounded-lg border border-[#3DD189]/50 bg-[#14392C] p-3">
      <strong>{en?"Active published automation":"التدفق المنشور النشط"}</strong>
      <p className="mt-1 break-all text-xs text-[#C9E8D9]">
       {activeServerFlow.flow_key+" · v"+activeServerFlow.revision}
      </p>
      <p className="mt-1 text-xs text-[#BED4C9]">{en
       ?"Select Load revisions to inspect or stop this live automation."
       :"اضغط «عرض الإصدارات» لفحص هذا التدفق أو إيقافه."}</p>
    </div>}
    <div className="flex flex-wrap gap-2">
     <button type="button" data-testid="flow-readiness-check"
      className={style} disabled={!accountId||busy}
      onClick={()=>void inspectReadiness()}>
      {en?"Check advanced readiness":"فحص جاهزية التدفقات المتقدمة"}
     </button>
     <button type="button" className={style} disabled={!accountId||busy}
      onClick={()=>void load()}>{en?"Load revisions":"عرض الإصدارات"}</button>
     <button type="button" className={style} disabled={!accountId||busy||!isEditingLocalFlow}
      onClick={()=>void publish()}>{en?"Publish new revision":"نشر إصدار جديد"}</button>
     {activation?.is_active&&<button type="button" className={style}
      disabled={busy||!loaded} onClick={()=>void change("deactivate")}>
      {en?"Stop automation":"إيقاف التدفق"}</button>}
    </div>
    {readiness&&<div data-testid="flow-readiness-report" role="status"
     className="rounded-lg border border-[#275443] bg-[#0F2E24] p-3 text-xs">
      <p className="font-semibold">{en?"Advanced configuration check":"فحص إعدادات التدفقات المتقدمة"}{checkedRevision?" · v"+checkedRevision:""}</p>
      {readiness.candidateKind==="buttons"&&<p className="mt-2">
       {en?"Interactive buttons: ":"الأزرار التفاعلية: "}
       {readiness.buttonsConfigured?(en?"Configured":"الإعدادات مكتملة"):(en?"Not configured":"الإعدادات غير مكتملة")}</p>}
      {readiness.candidateKind==="delay"&&<p className="mt-2">
       {en?"Delayed messages: ":"الرسائل المؤجلة: "}
       {readiness.delayConfigured?(en?"Configured":"الإعدادات مكتملة"):(en?"Not configured":"الإعدادات غير مكتملة")}</p>}
      {readiness.candidateKind==="unsupported"&&<p className="mt-2 text-[#F5D99C]">
       {en?"This revision is not an advanced buttons or delay candidate.":
        "هذا الإصدار ليس تدفق أزرار أو تأخير مدعومًا."}</p>}
      <p className="mt-2 text-[#BED4C9]">{en
       ?"This verifies configuration only. It does not send messages, change live revisions, or prove delivery."
       :"هذا فحص للإعدادات فقط؛ لا يرسل رسائل أو يغيّر الإصدار المنشور، ولا يثبت وصول الرسائل."}</p>
      {missingReadinessChecks(readiness)
       .map(([key])=><p key={key} className="mt-1 text-[#F5D99C]">
        {"• "+(readinessLabels[key as keyof ReadinessChecks]?.[en?"en":"ar"]??key)}
       </p>)}
      <button type="button" className={style+" mt-3"}
       data-testid="flow-copy-readiness" onClick={()=>void copyReadiness()}>
       {en?"Copy safe readiness report":"نسخ تقرير الجاهزية بدون معلومات سرية"}
      </button>
     </div>}
    {notice&&<p role="status" className="rounded-lg border border-[#275443] p-3 text-xs">{notice}</p>}
    {loaded&&<div className="space-y-2">
     <p className="text-xs text-[#BED4C9]">{activation?.is_active
      ?(en?"Active revision: ":"الإصدار النشط: ")+activation.revision
      :(en?"Activation OFF":"التفعيل معطّل")}</p>
     {versions.map(v=><div key={v.revision}
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#275443] p-3">
      <div><strong>{(en?"Revision ":"الإصدار ")+v.revision}</strong>
       <p className="text-xs text-[#A8BDB2]">{v.created_at}</p></div>
      <button type="button" data-testid={"readiness-published-revision-"+v.revision}
       className={style} disabled={busy} onClick={()=>void inspectReadiness(v.revision)}>
       {en?"Check readiness":"فحص جاهزية الإصدار"}
      </button>
      {onPreviewRevision&&<button type="button" className={style}
       data-testid={"preview-published-revision-"+v.revision}
       disabled={busy} onClick={()=>void previewRevision(v.revision)}>
       {en?"Preview without changing live flow":"معاينة دون تغيير التدفق المنشور"}</button>}
      {onImportRevision&&<button type="button" className={style}
       disabled={busy} onClick={()=>void importRevision(v.revision)}>
       {en?"Import as local copy":"استيراد كنسخة محلية"}</button>}
      {showActivationControls&&<button type="button" className={style}
       disabled={busy||(activation?.is_active===true&&activation.revision===v.revision)}
       onClick={()=>void change(activation?.is_active?"rollback":"activate",v.revision)}>
       {activation?.is_active?(en?"Rollback here":"الرجوع لهذا الإصدار"):
        (productionReady?(en?"Activate live":"تفعيل فعلي"):(en?"Activate test":"تفعيل تجريبي"))}</button>}
     </div>)}
     {!versions.length&&<p className="text-xs">{en?"No revisions yet.":"لا توجد إصدارات منشورة."}</p>}
    </div>}
   </div>
  </section>
 </div>;
}
