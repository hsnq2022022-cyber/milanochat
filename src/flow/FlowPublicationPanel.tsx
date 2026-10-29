import {useCallback,useEffect,useState} from "react";
import {getSupabase} from "../lib/supabase";
import type {FlowDocument} from "./model.ts";
import type {FlowLanguage} from "./uiLocale.ts";

type Account={id:string;platform:string;is_active:boolean|null;canActivate?:boolean};
type Version={revision:number;created_at:string};
type Activation={revision:number;is_active:boolean}|null;
type PublishedFlow={flowKey:string;latestRevision:number};
type ActiveFlow={flow_key:string;revision:number}|null;
type Reply={ok?:boolean;error?:string;accounts?:Account[];
 items?:Version[];activation?:Activation;revision?:number;
 flows?:PublishedFlow[];active?:ActiveFlow;truncated?:boolean;document?:unknown};
type Props={flowKey:string;document:FlowDocument;language:FlowLanguage;onClose:()=>void;
 onImportRevision?:(document:unknown)=>boolean};

const style="min-h-11 rounded-lg border border-[#275443] bg-[#0F2E24] px-3 py-2 text-sm text-white disabled:opacity-40";
const CANARY_UI=(import.meta as ImportMeta & {env?:Record<string,string|undefined>})
 .env?.VITE_ENABLE_FLOW_CANARY_CONTROLS==="true";

export default function FlowPublicationPanel({flowKey,document,language,onClose,onImportRevision}:Props){
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
      onChange={e=>{setAccountId(e.target.value);setManagedFlowKey(flowKey);setCatalog([]);setActiveServerFlow(null);setCatalogTruncated(false);setLoaded(false);setVersions([]);setActivation(null);setNotice("");}}>
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
       setVersions([]);setActivation(null);setNotice("");}}>
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
     <button type="button" className={style} disabled={!accountId||busy}
      onClick={()=>void load()}>{en?"Load revisions":"عرض الإصدارات"}</button>
     <button type="button" className={style} disabled={!accountId||busy||!isEditingLocalFlow}
      onClick={()=>void publish()}>{en?"Publish new revision":"نشر إصدار جديد"}</button>
     {activation?.is_active&&<button type="button" className={style}
      disabled={busy||!loaded} onClick={()=>void change("deactivate")}>
      {en?"Stop automation":"إيقاف التدفق"}</button>}
    </div>
    {notice&&<p role="status" className="rounded-lg border border-[#275443] p-3 text-xs">{notice}</p>}
    {loaded&&<div className="space-y-2">
     <p className="text-xs text-[#BED4C9]">{activation?.is_active
      ?(en?"Active revision: ":"الإصدار النشط: ")+activation.revision
      :(en?"Activation OFF":"التفعيل معطّل")}</p>
     {versions.map(v=><div key={v.revision}
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#275443] p-3">
      <div><strong>{(en?"Revision ":"الإصدار ")+v.revision}</strong>
       <p className="text-xs text-[#A8BDB2]">{v.created_at}</p></div>
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
