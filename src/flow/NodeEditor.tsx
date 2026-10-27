import { useState } from "react";
import { Plus, Trash2, Check, Copy, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { ACCENT, LABELS, makeNode, outputs, canConnect, edgeFor, PLATFORM_LABELS, TRIGGER_OPTIONS } from "./model";
import ButtonActionEditor from "./ButtonActionEditor";
import MessageBlocksEditor from "./MessageBlocksEditor";
import TriggerKeywordsEditor from "./TriggerKeywordsEditor";
import type { FlowData, FlowNode, Choice, Platform } from "./model";
import { useFlowStore } from "./store";
import { cardSize, findOpenPosition } from "./layout";
import { flowText, flowKindLabel } from "./uiLocale";
import type { FlowLanguage } from "./uiLocale";

const input="w-full rounded-xl border border-[#275443] bg-[#0F2E24] px-3 py-2.5 text-sm text-white outline-none focus:border-[#3DD189]";
const btn="inline-flex items-center gap-1.5 rounded-xl border border-[#275443] px-3 py-2 text-xs hover:bg-[#173D30]";
const section="mb-2 mt-4 block text-xs font-semibold text-[#B8D0C3]";
const units={seconds:"ثانية",minutes:"دقيقة",hours:"ساعة",days:"يوم"};
const operators={contains:"يحتوي",equals:"يساوي",not_equals:"لا يساوي",exists:"موجود"};
const actions={tag:"إضافة وسم",untag:"حذف وسم",set_field:"تعيين متغير",handoff:"تحويل إلى موظف",notify:"إشعار المسؤول",ai:"AI Step تجريبية"};
const modes={buttons:"أزرار سريعة",text:"نص",email:"بريد إلكتروني",phone:"هاتف",number:"رقم"};

export default function NodeEditor({node,onClose,language="ar"}:{node:FlowNode|null;onClose:()=>void;language?:FlowLanguage}){
  const store=useFlowStore();
  const [status,setStatus]=useState("");
  const [collapsed,setCollapsed]=useState(false);
  const t=(key:Parameters<typeof flowText>[0])=>flowText(key,language);
  if(!node)return <aside dir={language==="ar"?"rtl":"ltr"} className="flex w-[min(40vw,370px)] min-w-[210px] shrink-0 flex-col border-r border-[#173D30] bg-[#0B241C] p-5 text-[#8B9E96]"><h2 className="font-semibold text-white">{t("panel")}</h2><p className="mt-3 text-sm">{t("noNode")}</p></aside>;
  const d=node.data;
  const edit=(part:Partial<FlowData>)=>store.changeNode(node.id,part);
  const saveOptions=(options:Choice[])=>{
    const validIds=new Set(options.map(c=>c.id));
    store.replace({...store.doc,nodes:store.doc.nodes.map(n=>n.id===node.id?{...n,data:{...n.data,options}}:n),
      edges:store.doc.edges.filter(e=>e.source!==node.id||e.sourceHandle==="next"||validIds.has(e.sourceHandle||""))});
  };
  const setQuestionRoute=(port:"valid",target:string)=>{
    const current=useFlowStore.getState().doc;
    const edges=current.edges.filter(e=>e.source!==node?.id||e.sourceHandle!==port);
    if(!target){store.replace({...current,edges});return;}
    const connection={source:node!.id,sourceHandle:port,target,targetHandle:"in"};
    if(!canConnect(connection,{...current,edges})){
      setStatus("تعذر توصيل مسار الإجابة: الخطوة غير صالحة.");return;
    }
    store.replace({...current,edges:[...edges,edgeFor(connection,"التالي")]});
    setStatus("");
  };
  const addOption=()=>{
    if(d.options.length>=10)return;
    saveOptions([...d.options,{id:crypto.randomUUID(),label:d.kind==="randomizer"?"فرع "+(d.options.length+1):"زر جديد",weight:d.kind==="randomizer"?0:undefined}]);
  };
  const duplicate=()=>{if(store.doc.nodes.length>=100)return;const preferred={x:node.position.x+cardSize(node).width+80,y:node.position.y+80};const n=makeNode(d.kind,preferred,{...d,options:d.options.map(o=>({...o,id:crypto.randomUUID()})),title:d.title+" (نسخة)"});store.addNode({...n,position:findOpenPosition(store.doc.nodes,n,preferred)});};
  const remove=()=>{if(d.kind==="trigger"&&!window.confirm("حذف البداية سيجعل التدفق دون نقطة تشغيل. هل تريد المتابعة؟"))return;store.deleteNode(node.id);onClose();};

  return <aside dir={language==="ar"?"rtl":"ltr"} data-testid="step-settings-panel" role="complementary" aria-label={t("stepProps")} className={"fixed inset-x-0 bottom-0 z-40 flex w-full shrink-0 flex-col overflow-hidden rounded-t-2xl border-t border-[#173D30] bg-[#0B241C] text-white shadow-2xl md:relative md:inset-auto md:z-20 md:max-h-none md:w-[min(40vw,385px)] md:rounded-none md:border-r md:border-t-0 md:shadow-none "+(collapsed?"max-h-20 md:w-[240px]":"max-h-[min(78dvh,730px)]")}>
    <div className="sticky top-0 flex min-h-16 items-center justify-between gap-2 border-b border-[#173D30] bg-[#0B241C] px-3 py-3 md:px-4">
      <div><p className="text-[11px] text-[#8B9E96]">{t("stepProps")}</p><h2 className="text-base font-bold" style={{color:ACCENT[d.kind]}}>{flowKindLabel(d.kind,language,LABELS[d.kind])}</h2></div>
      <div className="flex items-center gap-2">
        <button type="button" aria-label={collapsed?t("expandStep"):t("collapseStep")} aria-expanded={!collapsed} className={btn} onClick={()=>setCollapsed(v=>!v)}>
          {collapsed?<ChevronDown size={16}/>:<ChevronUp size={16}/>} {collapsed?(language==="ar"?"إظهار":"Show"):(language==="ar"?"طي":"Collapse")}
        </button>
        <button type="button" aria-label={t("close")} className={btn} onClick={onClose}>{t("closeLabel")}</button>
      </div>
    </div>
    {!collapsed&&<div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
      {d.kind!=="trigger"&&<><label className={section}>{t("title")}</label><input className={input} value={d.title} maxLength={90} onChange={e=>edit({title:e.target.value})}/></>}
      {d.kind==="trigger"&&<>
        <label className={section}>{t("channel")}</label>
        <select className={input} aria-label="قناة بدء الأتمتة" value={d.platform} onChange={e=>{
          const platform=e.target.value as Platform;
          const first=TRIGGER_OPTIONS[platform][0].id;
          edit({platform,triggerMode:first});
        }}>
          {Object.entries(PLATFORM_LABELS).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
        <label className={section}>{t("event")}</label>
        <select className={input} aria-label={t("event")} value={d.triggerMode} onChange={e=>edit({triggerMode:e.target.value as FlowData["triggerMode"]})}>
          {TRIGGER_OPTIONS[d.platform].map(event=><option key={event.id} value={event.id}>{event.label}</option>)}
        </select>
        <TriggerKeywordsEditor key={node.id+":"+d.triggerMode} mode={d.triggerMode} value={d.keywords} onChange={keywords=>edit({keywords})}/>
        <p className="mt-2 text-[11px] leading-5 text-[#E5B54B]">هذه إعدادات التدفق فقط. اختيار WhatsApp أو Instagram أو Messenger لا يُنشئ ربط حساب جديدًا، ولا يمنح صلاحيات Meta تلقائيًا. الأحداث المسموح بها فعليًا تعتمد على القناة وحالة ربطها.</p>
      </>}
      {["message","question"].includes(d.kind)&&<>
        {d.kind==="question"&&<>
          <label className={section}>{t("answer")}</label>
          <select className={input} aria-label={t("answer")} value={d.inputMode} onChange={e=>{
            const inputMode=e.target.value as FlowData["inputMode"];
            const current=useFlowStore.getState().doc;
            const allowed=inputMode==="buttons"?new Set(d.options.map(o=>o.id)):new Set(["valid","invalid"]);
            store.replace({...current,nodes:current.nodes.map(n=>n.id===node.id?{...n,data:{...n.data,inputMode}}:n),
              edges:current.edges.filter(edge=>edge.source!==node.id||allowed.has(edge.sourceHandle||""))});
          }}>
            {Object.entries(modes).map(([v,label])=><option key={v} value={v}>{label}</option>)}
          </select>
          <label className={section}>اسم الحقل الذي يستقبل الإجابة</label>
          <input className={input} value={d.inputField} maxLength={100} onChange={e=>edit({inputField:e.target.value})}/>
          {d.inputMode!=="buttons"&&<section className="mt-4 rounded-xl border border-[#275443] bg-[#061A14]/60 p-3" data-testid="question-text-routes">
            <p className="mb-2 text-xs font-semibold text-[#B8D0C3]">بعد استلام إجابة صحيحة</p>
            <label className="mb-2 block text-xs">الخطوة التالية (اختياري)</label>
            <select className={input} aria-label={t("next")}
              value={store.doc.edges.find(e=>e.source===node.id&&e.sourceHandle==="valid")?.target||""}
              onChange={e=>setQuestionRoute("valid",e.target.value)}>
              <option value="">إنهاء التدفق بعد حفظ الإجابة</option>
              {store.doc.nodes.filter(n=>n.id!==node.id&&n.data.kind!=="trigger").map(n=>
                <option key={n.id} value={n.id}>{n.data.title}</option>)}
            </select>
            <p className="mt-2 text-[11px] leading-5 text-[#8B9E96]">عند إدخال بريد أو هاتف أو رقم غير صحيح، سيُطلب من العميل تصحيحه تلقائيًا، دون الحاجة لمسار منفصل.</p>
          </section>}
        </>}
        <MessageBlocksEditor node={node}/>
        {(d.kind==="message"||d.inputMode==="buttons")&&<ButtonActionEditor node={node}/>}
      </>}
      {d.kind==="condition"&&<>
        <label className={section}>الحقل</label><input className={input} value={d.conditionField} onChange={e=>edit({conditionField:e.target.value})} placeholder="message"/>
        <label className={section}>المقارنة</label><select className={input} value={d.operator} onChange={e=>edit({operator:e.target.value as FlowData["operator"]})}>{Object.entries(operators).map(([v,t])=><option value={v} key={v}>{t}</option>)}</select>
        <label className={section}>القيمة</label><input className={input} value={d.conditionValue} onChange={e=>edit({conditionValue:e.target.value})}/>
      </>}
      {d.kind==="delay"&&<>
        <label className={section}>مدة الانتظار</label>
        <div className="flex gap-2"><input type="number" min={1} className={input} value={d.delayValue} onChange={e=>edit({delayValue:Math.min(365,Math.max(1,Number(e.target.value)||1))})}/>
          <select className={input} value={d.delayUnit} onChange={e=>edit({delayUnit:e.target.value as FlowData["delayUnit"]})}>{Object.entries(units).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></div>
        <p className="mt-3 flex gap-2 rounded-xl border border-[#E5B54B]/40 bg-[#E5B54B]/10 p-3 text-xs text-[#E5B54B]"><AlertTriangle size={18} className="shrink-0"/>الانتظار لا يتجاوز نافذة مراسلة Meta المسموح بها. المحاكاة تتجاوز الوقت، ولا تُرسل أي رسائل فعلية.</p>
      </>}
      {d.kind==="action"&&<>
        <label className={section}>نوع الإجراء</label><select className={input} value={d.actionType} onChange={e=>edit({actionType:e.target.value as FlowData["actionType"]})}>{Object.entries(actions).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select>
        <label className={section}>القيمة / اسم الوسم</label><input className={input} value={d.actionValue} onChange={e=>edit({actionValue:e.target.value})}/>
        <p className="mt-2 text-[11px] text-[#8B9E96]">هذه إعدادات تصميمية، وليست أوامر مفعّلة في النظام الحقيقي.</p>
      </>}
      {d.kind==="randomizer"&&<>
        <label className={section}>نسب التوزيع (المجموع 100%)</label>
        {d.options.map((o,i)=><div key={o.id} className="mb-2 flex gap-2">
          <input aria-label={"اسم المسار "+(i+1)} className={input} value={o.label} onChange={e=>saveOptions(d.options.map(x=>x.id===o.id?{...x,label:e.target.value}:x))}/>
          <input aria-label={"النسبة "+(i+1)} type="number" min={0} max={100} className={input+" !w-20"} value={o.weight??0} onChange={e=>saveOptions(d.options.map(x=>x.id===o.id?{...x,weight:Math.max(0,Math.min(100,Number(e.target.value)||0))}:x))}/>
          <button className={btn} onClick={()=>saveOptions(d.options.filter(x=>x.id!==o.id))} aria-label="حذف المسار"><Trash2 size={14}/></button>
        </div>)}
        <div className="flex gap-2"><button className={btn} onClick={addOption} disabled={d.options.length>=10}><Plus size={15}/> مسار</button>
          <button className={btn} onClick={()=>{const base=Math.floor(100/d.options.length);saveOptions(d.options.map((o,i)=>({...o,weight:i===d.options.length-1?100-base*(d.options.length-1):base})));}}>توزيع متساوٍ</button></div>
      </>}
      {d.kind==="goto"&&<>
        <label className={section}>الانتقال إلى خطوة في هذا التدفق</label><select className={input} value={d.gotoNode} onChange={e=>edit({gotoNode:e.target.value})}><option value="">اختر خطوة</option>{store.doc.nodes.filter(n=>n.id!==node.id&&n.data.kind!=="trigger").map(n=><option key={n.id} value={n.id}>{n.data.title}</option>)}</select>
      </>}
      {d.kind==="request"&&<>
        <label className={section}>طريقة طلب HTTP</label><select className={input} value={d.requestMethod} onChange={e=>edit({requestMethod:e.target.value as FlowData["requestMethod"]})}><option>GET</option><option>POST</option></select>
        <label className={section}>عنوان HTTPS</label><input dir="ltr" className={input} value={d.requestUrl} onChange={e=>edit({requestUrl:e.target.value})} placeholder="https://api.example.com/..."/>
        <p className="mt-3 text-xs text-[#E5B54B]">لأسباب أمنية، لا ينفّذ المحرر طلبات خارجية من المتصفح. تحتاج هذه الميزة خادمًا آمنًا.</p>
      </>}
      {d.kind==="end"&&<p className="mt-4 text-sm text-[#8B9E96]">هذه الخطوة تنهي المسار ولا تحتاج إلى اتصال خارج منها.</p>}
      {!!status&&<p role="status" className="mt-3 text-xs text-[#3DD189]">{status}</p>}
      <div className="mt-5 border-t border-[#173D30] pt-4">
        <h3 className="mb-2 text-xs font-semibold">التوصيلات الخارجة</h3>
        {store.doc.edges.filter(e=>e.source===node.id).map(e=><div className="mb-2 flex items-center justify-between gap-2 text-xs" key={e.id}><span className="min-w-0 truncate">{outputs(node).find(x=>x.id===e.sourceHandle)?.label||"التالي"} ← {store.doc.nodes.find(n=>n.id===e.target)?.data.title}</span><button className={btn} onClick={()=>store.deleteEdge(e.id)} aria-label="حذف الخط"><Trash2 size={14}/></button></div>)}
      </div>
      <div className="mt-5 flex flex-wrap gap-2"><button className={btn} onClick={duplicate}><Copy size={14}/> نسخ</button><button className={btn+" text-red-300"} onClick={remove}><Trash2 size={14}/> حذف الخطوة</button>
      <button className={btn} onClick={()=>{const ok=store.deleteNode(node.id,true);if(ok)onClose();}} disabled={store.doc.edges.filter(e=>e.source===node.id).length!==1||store.doc.edges.filter(e=>e.target===node.id).length!==1}>حذف مع إعادة التوصيل</button></div>
    </div>}
    {!collapsed&&<div className="sticky bottom-0 border-t border-[#173D30] bg-[#0B241C] p-3"><button className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#3DD189] py-2.5 text-sm font-bold text-[#061A14]" onClick={onClose}><Check size={16}/> {t("done")}</button></div>}
  </aside>;
}
