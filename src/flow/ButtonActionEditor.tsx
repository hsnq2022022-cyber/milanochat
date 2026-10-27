import { useState } from "react";
import { ArrowRight, Plus, Trash2, Link2, Globe2, Bot, Zap, GitBranch, Shuffle, Copy } from "lucide-react";
import { canConnect, edgeFor, makeNode } from "./model";
import type { Choice, ButtonAction, FlowNode, FlowData, Kind } from "./model";
import { useFlowStore } from "./store";
import { cardSize, findOpenPosition } from "./layout";

const input="w-full rounded-xl border border-[#275443] bg-[#0F2E24] px-3 py-2.5 text-sm text-white outline-none focus:border-[#3DD189]";
const btn="inline-flex items-center gap-1.5 rounded-xl border border-[#275443] px-3 py-2 text-xs hover:bg-[#173D30]";
const ACTIONS: Array<{id:ButtonAction;label:string;description:string}>=[
  {id:"step",label:"إرسال رسالة أو الانتقال لخطوة",description:"ربط الزر بأي خطوة في التدفق الحالي"},
  {id:"flow",label:"الانتقال إلى تدفق آخر",description:"فتح تدفق محفوظ آخر عند الضغط"},
  {id:"website",label:"فتح موقع",description:"رابط HTTPS خارجي"},
  {id:"ai",label:"AI Step",description:"إنشاء خطوة للذكاء الاصطناعي (تجريبية)"},
  {id:"actions",label:"تنفيذ إجراء",description:"إنشاء خطوة تغيير وسم أو حالة"},
  {id:"condition",label:"شرط",description:"إنشاء خطوة بشرطي نعم/لا"},
  {id:"randomizer",label:"توزيع عشوائي",description:"إنشاء خطوة توزيع بين مسارات"}
];
export default function ButtonActionEditor({node}:{node:FlowNode}){
  const store=useFlowStore();
  const d=node.data;
  const [active,setActive]=useState<string|null>(null);
  const [connectionError,setConnectionError]=useState("");
  const option=d.options.find(o=>o.id===active);
  const persist=(options:Choice[],dropIds:string[]=[])=>{
    const valid=new Set(options.filter(o=>!o.action||o.action==="step").map(o=>o.id));
    store.replace({...store.doc,nodes:store.doc.nodes.map(n=>n.id===node.id?{...n,data:{...n.data,options}}:n),
      edges:store.doc.edges.filter(e=>e.source!==node.id||e.sourceHandle==="next"||valid.has(e.sourceHandle||"")&&!dropIds.includes(e.sourceHandle||""))});
  };
  const patch=(id:string,change:Partial<Choice>)=>{
    persist(d.options.map(o=>o.id===id?{...o,...change}:o));
  };
  const add=(type:Choice["buttonType"])=>{
    if(d.options.length>=10)return;
    const id=crypto.randomUUID();
    persist([...d.options,{id,label:type==="quick_reply"?"رد سريع جديد":"زر جديد",buttonType:type,action:"step"}]);
    setActive(id);
  };
  const setAction=(choice:Choice,action:ButtonAction)=>{
    if(action==="ai"||action==="actions"||action==="condition"||action==="randomizer"){
      const kind:Kind=action==="condition"?"condition":action==="randomizer"?"randomizer":"action";
      if(store.doc.nodes.length>=100)return;
      const preferred={x:node.position.x+cardSize(node).width+90,y:node.position.y+265};
      const draft=makeNode(kind,preferred,
        action==="ai"?{title:"AI Step (تجريبي)",actionType:"ai",actionValue:""}:{});
      const n={...draft,position:findOpenPosition(store.doc.nodes,draft,preferred)};
      const options=d.options.map(o=>o.id===choice.id?{...o,action:"step" as const,targetFlowId:undefined,url:undefined}:o);
      const edge=edgeFor({source:node.id,sourceHandle:choice.id,target:n.id,targetHandle:"in"},choice.label);
      store.replace({...store.doc,nodes:[...store.doc.nodes.map(x=>x.id===node.id?{...x,data:{...x.data,options}}:x),n],
        edges:[...store.doc.edges.filter(e=>e.source!==node.id||e.sourceHandle!==choice.id),edge]});
      setActive(null);
      store.setSelected(n.id);
      return;
    }
    if(action!=="step"&&store.doc.edges.some(e=>e.source===node.id&&e.sourceHandle===choice.id)&&
      !window.confirm("سيُستبدل الاتصال الحالي لهذا الزر. هل تريد المتابعة؟"))return;
    const options=d.options.map(o=>o.id===choice.id?{...o,action,targetFlowId:undefined,url:undefined}:o);
    persist(options,action==="step"?[]:[choice.id]);
  };
  const linkStep=(choice:Choice,target:string)=>{
    if(!target){
      persist(d.options,[choice.id]);return;
    }
    if(target===node.id)return;
    const candidate=store.doc.nodes.find(n=>n.id===target);
    if(!candidate||candidate.data.kind==="trigger")return;
    const connection={source:node.id,sourceHandle:choice.id,target,targetHandle:"in"};
    const existing=store.doc.edges.find(e=>e.source===node.id&&e.sourceHandle===choice.id);
    if(!canConnect(connection,store.doc,existing?.id)){
      setConnectionError("لا يمكن ربط الزر بهذه الخطوة: اتصال غير صالح.");
      return;
    }
    setConnectionError("");
    const options=d.options.map(o=>o.id===choice.id?{...o,action:"step" as const}:o);
    const edge=edgeFor(connection,choice.label);
    store.replace({...store.doc,nodes:store.doc.nodes.map(n=>n.id===node.id?{...n,data:{...n.data,options}}:n),
      edges:[...store.doc.edges.filter(e=>e.source!==node.id||e.sourceHandle!==choice.id),edge]});
  };
  const currentTarget=(choice:Choice)=>store.doc.edges.find(e=>e.source===node.id&&e.sourceHandle===choice.id)?.target||"";
  const labelFor=(choice:Choice)=>{
    if(choice.action==="flow")return store.flows.find(f=>f.id===choice.targetFlowId)?.doc.name||"اختر التدفق";
    if(choice.action==="website")return "فتح موقع";
    return store.doc.nodes.find(n=>n.id===currentTarget(choice))?.data.title||"غير مرتبط";
  };
  return <section className="mt-5 rounded-2xl border border-[#275443] bg-[#061A14]/50 p-3" dir="rtl">
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-sm font-bold">الأزرار والردود السريعة</h3><span className="text-[11px] text-[#8B9E96]">{d.options.length} / 10</span>
    </div>
    <p className="mb-3 text-[11px] leading-5 text-[#8B9E96]">اضغط على أي زر لتحديد ما يحدث عندما يضغط عليه العميل، بما في ذلك الانتقال إلى تدفق آخر.</p>
    <div className="space-y-2">
      {d.options.map(o=><button key={o.id} type="button" data-testid={"flow-button-"+o.id}
        className={"flex w-full items-center gap-2 rounded-xl border px-3 py-3 text-right "+(active===o.id?"border-[#3DD189] bg-[#173D30]":"border-[#275443] bg-[#0F2E24]")}
        onClick={()=>setActive(o.id)}>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{o.label||"زر بدون عنوان"}</span>
        <span className="max-w-28 truncate text-[10px] text-[#8B9E96]">{o.buttonType==="quick_reply"?"رد سريع":"زر"} · {labelFor(o)}</span>
        <ArrowRight size={15}/></button>)}
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <button className={btn} disabled={d.options.length>=10} onClick={()=>add("button")}><Plus size={14}/> إضافة زر</button>
      <button className={btn} disabled={d.options.length>=10} onClick={()=>add("quick_reply")}><Plus size={14}/> إضافة رد سريع</button>
    </div>
    {option&&<div className="mt-4 rounded-xl border border-[#3DD189]/50 bg-[#0F2E24] p-3" data-testid="button-action-editor">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-sm font-bold text-[#3DD189]">إعداد الزر</h4>
        <button className={btn} onClick={()=>setActive(null)}>تم</button>
      </div>
      <label className="mb-1 block text-xs">عنوان الزر</label>
      <input className={input} aria-label="عنوان الزر" maxLength={60} value={option.label}
        onChange={e=>patch(option.id,{label:e.target.value})}/>
      <label className="mb-1 mt-3 block text-xs">نوع الزر</label>
      <select className={input} value={option.buttonType||"button"}
        onChange={e=>patch(option.id,{buttonType:e.target.value as Choice["buttonType"]})}>
        <option value="button">زر</option><option value="quick_reply">رد سريع</option>
      </select>
      <p className="mb-2 mt-4 text-xs font-semibold">عند الضغط على هذا الزر</p>
      <div className="grid grid-cols-2 gap-2">
        {ACTIONS.map(a=><button key={a.id} type="button" title={a.description}
          className={"rounded-lg border p-2 text-right text-[11px] "+((option.action||"step")===a.id?"border-[#3DD189] bg-[#173D30]":"border-[#275443] bg-[#0B241C]")}
          onClick={()=>setAction(option,a.id)}>{a.label}</button>)}
      </div>
      {!!connectionError&&<p role="alert" className="mt-2 text-xs text-[#E5B54B]">{connectionError}</p>}
      {(option.action==="step"||!option.action)&&<>
        <label className="mb-1 mt-3 block text-xs">الخطوة التي يتوجه إليها هذا الزر</label>
        <select className={input} aria-label="ربط الزر بخطوة" value={currentTarget(option)} onChange={e=>linkStep(option,e.target.value)}>
          <option value="">غير مرتبط — اختر خطوة</option>
          {store.doc.nodes.filter(n=>n.id!==node.id&&n.data.kind!=="trigger").map(n=><option value={n.id} key={n.id}>{n.data.title}</option>)}
        </select>
        <p className="mt-1 text-[11px] text-[#8B9E96]">يمكنك كذلك توصيل الدائرة الموجودة تحت الزر على لوحة التدفقات.</p>
      </>}
      {option.action==="flow"&&<>
        <label className="mb-1 mt-3 block text-xs">التدفق المستهدف</label>
        <select className={input} aria-label="اختر تدفقًا آخر" value={option.targetFlowId||""} onChange={e=>patch(option.id,{targetFlowId:e.target.value})}>
          <option value="">اختر تدفقًا آخر</option>
          {store.flows.filter(f=>f.id!==store.activeFlowId).map(f=><option key={f.id} value={f.id}>{f.doc.name}</option>)}
        </select>
        <p className="mt-2 text-[11px] text-[#E5B54B]">يمكنك إنشاء تدفقات إضافية من قائمة التدفقات أعلى المحرر. الربط يعمل في المعاينة المحلية فقط.</p>
      </>}
      {option.action==="website"&&<>
        <label className="mb-1 mt-3 block text-xs">الرابط الذي سيفتحه الزر</label>
        <input dir="ltr" className={input} placeholder="https://example.com" aria-label="رابط الموقع" value={option.url||""}
          onChange={e=>patch(option.id,{url:e.target.value})}/>
      </>}
      <button className="mt-4 flex items-center gap-2 text-xs text-red-300" onClick={()=>{
        persist(d.options.filter(o=>o.id!==option.id),[option.id]);setActive(null);
      }}><Trash2 size={15}/> حذف الزر</button>
    </div>}
    <p className="mt-3 text-[11px] text-[#8B9E96]">القيود الفعلية لعدد الأزرار والردود تختلف حسب القناة. هذا محرر تجريبي، ولا يعرض إحصاءات CTR حقيقية.</p>
  </section>;
}
