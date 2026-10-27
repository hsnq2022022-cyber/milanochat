import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import { useEffect } from "react";
import type { NodeProps } from "@xyflow/react";
import {
  MessageSquare, Rocket, HelpCircle, GitBranch, Clock3, Zap,
  Shuffle, CornerDownRight, Globe, Flag, Plus,
} from "lucide-react";
import { ACCENT, LABELS, PLATFORM_LABELS, TRIGGER_OPTIONS, outputs } from "./model";
import type { FlowNode as FlowNodeType, Kind } from "./model";
import { useAddStepMenu } from "./addMenu";

const glyph:Record<Kind,typeof Rocket>={
  trigger:Rocket,message:MessageSquare,question:HelpCircle,condition:GitBranch,delay:Clock3,
  action:Zap,randomizer:Shuffle,goto:CornerDownRight,request:Globe,end:Flag,
};

export default function AutomationNode({id,data,selected}:NodeProps<FlowNodeType>){
  const updateInternals=useUpdateNodeInternals();
  const openMenu=useAddStepMenu(s=>s.open);
  const ports=outputs({id,position:{x:0,y:0},type:"flowNode",data});
  const allPorts=data.kind==="message"?[{id:"next",label:"التالي"},...data.options]:
    data.kind==="question"&&data.inputMode==="buttons"?data.options:ports;
  const handleSignature=data.kind+":"+data.inputMode+":"+ports.map(p=>p.id).join(":");
  useEffect(()=>{updateInternals(id);},[id,handleSignature,updateInternals]);

  const Icon=glyph[data.kind];
  const color=ACCENT[data.kind];
  const hasOptions=allPorts.length>0;
  const label=data.kind==="trigger"?LABELS.trigger:(data.title||LABELS[data.kind]);
  const message=["message","question"].includes(data.kind);
  return <div dir="rtl" className={"group relative w-[280px] overflow-visible rounded-2xl border bg-[#FCFEFD] text-[#17251E] shadow-[0_7px_22px_rgba(0,0,0,.20)] transition-[box-shadow,transform] duration-150 "+(selected?"border-[#3DD189] ring-[3px] ring-[#3DD189]/35":"border-[#D7E1DC] hover:shadow-[0_12px_30px_rgba(0,0,0,.30)]")}>
    {data.kind!=="trigger"&&
      <Handle id="in" type="target" position={Position.Top}
        className="!h-3.5 !w-3.5 !border-[3px] !border-white !bg-[#94A3B8] hover:!bg-[#3DD189]"/>}

    <div className="flex items-center gap-2 rounded-t-2xl px-3 py-3 text-[13px] font-bold"
      style={{background:`linear-gradient(135deg, ${color}, ${color}D8)`,color:data.kind==="trigger"?"#061A14":"#FFFFFF"}}>
      <span className="rounded-lg bg-white/20 p-1.5"><Icon size={17}/></span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="max-w-20 truncate rounded-full bg-black/10 px-2 py-1 text-[10px]">{LABELS[data.kind]}</span>
    </div>

    <div className="space-y-2 px-3 py-3">
      {data.kind==="trigger"&&<>
        <p className="mb-1 inline-flex rounded-lg bg-[#D1FAE5] px-2 py-1 text-[11px] font-bold text-[#065F46]">{PLATFORM_LABELS[data.platform]}</p>
        <p className="text-xs text-[#506257]">{TRIGGER_OPTIONS[data.platform]?.find(t=>t.id===data.triggerMode)?.label||"حدث وارد"}</p>
        {(data.triggerMode==="keyword"||(data.triggerMode==="comment"&&!!data.keywords.trim()))&&
          <div className="flex flex-wrap gap-1.5">{data.keywords.split(/[,،\n]+/).map(w=>w.trim()).filter(Boolean).map(word=>
            <span key={word} className="rounded-full bg-[#E6F7ED] px-2 py-1 text-[11px] font-semibold text-[#176043]">{word}</span>)}
          </div>}
        {data.triggerMode==="message"&&<p className="rounded-lg bg-[#E6F7ED] px-2 py-1.5 text-xs font-semibold text-[#176043]">أي رسالة واردة</p>}
        {data.triggerMode==="comment"&&!data.keywords.trim()&&<p className="rounded-lg bg-[#E6F7ED] px-2 py-1.5 text-xs font-semibold text-[#176043]">أي تعليق</p>}
      </>}
      {message&&<>
        <p className="line-clamp-4 whitespace-pre-wrap break-words rounded-xl bg-[#F3F7F5] px-3 py-2.5 text-[12px] leading-5">{data.text||"اضغط لتعديل الرسالة"}</p>
        {data.kind==="question"&&data.inputMode!=="buttons"&&<div data-testid="typed-question-preview" className="rounded-xl border border-[#D7E1DC] bg-[#F3F7F5] p-2.5">
          <p className="mb-2 text-[11px] font-semibold text-[#506257]">إجابة العميل المطلوبة: {({text:"نص",email:"بريد إلكتروني",phone:"رقم هاتف",number:"رقم"} as const)[data.inputMode]}</p>
          <div className="rounded-lg border border-dashed border-[#B7C9C0] bg-white px-3 py-2 text-xs text-[#74877E]">
            {({text:"يكتب العميل إجابته هنا…",email:"name@example.com",phone:"07XXXXXXXXX",number:"123"} as const)[data.inputMode]}
          </div>
          <p className="mt-2 text-[10px] text-[#60766B]">حقل إدخال في معاينة العميل، وليس أزرارًا سريعة</p>
        </div>}
        {data.image&&<img alt="معاينة صورة الرسالة" src={data.image} className="max-h-36 w-full rounded-xl object-contain" loading="lazy"/>}
        {(data.contentBlocks||[]).filter(block=>block.type==="image"&&block.url).slice(0,1).map(block=><img key={block.id} alt="صورة إضافية" src={block.url} className="max-h-28 w-full rounded-xl object-contain" loading="lazy"/>)}
        {!!data.contentBlocks?.length&&<p className="rounded-lg border border-[#D7E1DC] bg-[#EAF5F0] px-2 py-1.5 text-[11px] text-[#35604D]">{data.contentBlocks.length} مكونات إضافية: {data.contentBlocks.map(block=>({text:"نص",image:"صورة",pdf:"PDF",delay:"انتظار",collection:"جمع بيانات"}[block.type])).join(" · ")}</p>}
      </>}
      {data.kind==="condition"&&<p className="text-xs leading-5">إذا كان {data.conditionField} {data.operator==="contains"?"يحتوي":data.operator==="equals"?"يساوي":data.operator==="not_equals"?"لا يساوي":"موجود"}: {data.conditionValue||"—"}</p>}
      {data.kind==="delay"&&<p className="text-xs">انتظار {data.delayValue} {({seconds:"ثانية",minutes:"دقيقة",hours:"ساعة",days:"يوم"} as const)[data.delayUnit]}</p>}
      {data.kind==="action"&&<p className="text-xs">{data.actionType}: {data.actionValue||"—"}</p>}
      {data.kind==="randomizer"&&<p className="text-xs text-[#9A4A09]">توزيع المسارات بالنسب المحددة</p>}
      {data.kind==="goto"&&<p className="text-xs">انتقال إلى {data.gotoNode||"خطوة غير محددة"}</p>}
      {data.kind==="request"&&<>
        <p className="text-xs">طلب خارجي: {data.requestMethod}</p>
        <p dir="ltr" className="truncate text-[10px] text-[#6B7280]">{data.requestUrl||"HTTPS URL"}</p>
      </>}
      {data.kind==="end"&&<p className="text-xs text-[#64748B]">انتهاء هذا المسار.</p>}
    </div>

    {data.kind==="question"&&data.inputMode!=="buttons"&&<div data-testid="typed-question-next" className="relative rounded-b-2xl border-t border-[#E6EBE8] bg-[#EFF7F2] px-3 pb-5 pt-3 text-center text-xs font-semibold text-[#176043]">
      التالي
      <Handle id="valid" type="source" position={Position.Bottom}
        aria-label="مخرج التالي بعد جمع البيانات"
        className="!h-4 !w-4 !border-[3px] !border-white !bg-[#3DD189]"
        style={{left:"50%",bottom:-9}}/>
      {/* Retain legacy connections by keeping their internal port without showing confusing buttons. */}
      <Handle id="invalid" type="source" position={Position.Bottom}
        className="!invisible !pointer-events-none" style={{left:"50%",bottom:-9}}/>
    </div>}
    {hasOptions&&!(data.kind==="question"&&data.inputMode!=="buttons")&&<div className="rounded-b-2xl border-t border-[#E6EBE8] bg-[#F4F8F6] px-3 pb-5 pt-3">
      <div className="grid gap-2" style={{gridTemplateColumns:`repeat(${Math.min(allPorts.length,3)},minmax(0,1fr))`}}>
        {allPorts.map(port=><div key={port.id} className="relative flex min-h-10 items-center justify-center rounded-lg border border-[#DAE4DE] bg-white px-1.5 py-2 text-center text-[11px] font-medium">
          <span className="w-full truncate" title={port.label}>{port.label}</span>
          {data.kind==="randomizer"&&<span className="text-[#9A4A09]">{port.weight||0}%</span>}
          {ports.some(p=>p.id===port.id)&&<Handle id={port.id} type="source" position={Position.Bottom}
            className="!h-3.5 !w-3.5 !border-[3px] !border-white !bg-[#60A5FA] hover:!h-4 hover:!w-4 hover:!bg-[#3DD189]"
            style={{left:"50%",bottom:-9}}/>}
        </div>)}
      </div>
    </div>}

    {!!ports.length&&
      <button type="button"
        aria-label={"إضافة خطوة بعد "+label}
        title="أضف خطوة واربطها بهذا المسار"
        className={"nodrag nopan absolute -bottom-14 left-1/2 z-30 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full border-2 border-[#3DD189] bg-[#0B241C] text-[#3DD189] shadow-lg transition-opacity hover:scale-110 hover:bg-[#173D30] "+(selected?"opacity-100":"opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100")}
        onClick={e=>{e.stopPropagation();openMenu({source:id,port:ports.length===1?ports[0].id:undefined,x:e.clientX,y:e.clientY});}}>
        <Plus size={18}/>
      </button>
    }
  </div>;
}
