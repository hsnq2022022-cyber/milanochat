import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { MessageSquare, Rocket, HelpCircle, GitBranch, Clock3, Zap, Shuffle, CornerDownRight, Globe, Flag } from "lucide-react";
import { ACCENT, LABELS, outputs } from "./model";
import type { FlowNode as FlowNodeType, Kind } from "./model";

const glyph:Record<Kind,typeof Rocket>={
  trigger:Rocket,message:MessageSquare,question:HelpCircle,condition:GitBranch,delay:Clock3,
  action:Zap,randomizer:Shuffle,goto:CornerDownRight,request:Globe,end:Flag,
};
export default function AutomationNode({data,selected}:NodeProps<FlowNodeType>){
  const Icon=glyph[data.kind];
  const color=ACCENT[data.kind],options=outputs({id:"preview",position:{x:0,y:0},type:"flowNode",data});
  return <div dir="rtl" className={"w-[275px] overflow-visible rounded-2xl border bg-[#FCFEFD] text-[#17251E] shadow-[0_14px_35px_rgba(0,0,0,.30)] transition-shadow "+(selected?"border-[#3DD189] ring-[3px] ring-[#3DD189]/40":"border-[#D7E1DC] hover:shadow-[0_18px_40px_rgba(0,0,0,.38)]")}>
    {data.kind!=="trigger"&&<Handle id="in" type="target" position={Position.Left} className="!h-4 !w-4 !border-[3px] !border-white !bg-[#6C8A7B]" />}
    <div className="flex items-center gap-2 rounded-t-2xl px-3 py-3 text-[13px] font-bold" style={{backgroundColor:color,color:data.kind==="trigger"?"#061A14":"#FFFFFF"}}>
      <span className="rounded-lg bg-white/20 p-1.5"><Icon size={17}/></span><span className="min-w-0 flex-1 truncate">{data.title||LABELS[data.kind]}</span>
      <span className="rounded-full bg-black/10 px-2 py-1 text-[10px]">{LABELS[data.kind]}</span>
    </div>
    <div className="space-y-2 px-3 py-3">
      {data.kind==="trigger"&&<><p className="text-xs">بدء الأتمتة عند: {data.triggerMode==="keyword"?"كلمة مفتاحية":data.triggerMode==="message"?"رسالة واردة":data.triggerMode==="comment"?"تعليق": "رد على القصة"}</p><p className="rounded-lg bg-[#E6F7ED] px-2 py-1.5 text-xs text-[#176043]">{data.keywords||"أي رسالة"}</p></>}
      {["message","question"].includes(data.kind)&&<><p className="line-clamp-4 whitespace-pre-wrap break-words text-[12px] leading-5">{data.text||"أضف نص الرسالة"}</p>{data.image&&<img alt="صورة الرسالة" src={data.image} className="max-h-40 w-full rounded-lg object-contain" loading="lazy"/>}</>}
      {data.kind==="condition"&&<p className="text-xs">إذا كان {data.conditionField} {data.operator==="contains"?"يحتوي":data.operator==="equals"?"يساوي":data.operator==="not_equals"?"لا يساوي":"موجود"}: {data.conditionValue}</p>}
      {data.kind==="delay"&&<p className="text-xs">انتظار {data.delayValue} {({seconds:"ثانية",minutes:"دقيقة",hours:"ساعة",days:"يوم"} as const)[data.delayUnit]}</p>}
      {data.kind==="action"&&<p className="text-xs">{data.actionType}: {data.actionValue}</p>}
      {data.kind==="randomizer"&&<p className="text-xs text-[#9A4A09]">توزيع التجربة حسب النسب</p>}
      {data.kind==="goto"&&<p className="text-xs">انتقال إلى {data.gotoNode||"خطوة غير محددة"}</p>}
      {data.kind==="request"&&<><p className="text-xs">طلب خارجي: {data.requestMethod}</p><p dir="ltr" className="truncate text-[10px]">{data.requestUrl||"HTTPS URL"}</p></>}
      {data.kind==="end"&&<p className="text-xs text-[#64748B]">ينتهي هذا المسار هنا.</p>}
    </div>
    {!!options.length&&<div className="space-y-1.5 rounded-b-2xl border-t border-[#E6EBE8] bg-[#F4F8F6] px-3 py-3">{options.map(p=><div key={p.id} className="relative flex min-h-9 items-center justify-between rounded-lg border border-[#DAE4DE] bg-white px-2.5 py-2 text-xs" style={{position:"relative"}}>
      <span className="truncate">{p.label}</span>{data.kind==="randomizer"&&<span className="text-[#7C521C]">{p.weight??0}%</span>}
      <Handle type="source" id={p.id} position={Position.Right} className="!h-4 !w-4 !border-[3px] !border-white !bg-[#60A5FA] hover:!bg-[#3DD189]" style={{top:"50%",right:-21}}/>
    </div>)}</div>}
  </div>;
}
