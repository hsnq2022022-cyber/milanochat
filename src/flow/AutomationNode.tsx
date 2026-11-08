import { Handle, Position, useStore, useUpdateNodeInternals } from "@xyflow/react";
import { useEffect } from "react";
import type { CSSProperties } from "react";
import type { NodeProps } from "@xyflow/react";
import { Plus, AlertTriangle } from "lucide-react";
import { LABELS, PLATFORM_LABELS, TRIGGER_OPTIONS, outputs } from "./model";
import type { FlowNode as FlowNodeType } from "./model";
import { useAddStepMenu } from "./addMenu";
import { useLayoutDirection } from "./direction";
import { PLATFORM_COLOR, SKIN_COLOR, SKIN_ICON, useNodeIssues } from "./skin";

export default function AutomationNode({id,data,selected}:NodeProps<FlowNodeType>){
  const updateInternals=useUpdateNodeInternals();
  const openMenu=useAddStepMenu(s=>s.open);
  const horizontal=useLayoutDirection(s=>s.direction)==="LR";
  const outPos=horizontal?Position.Right:Position.Bottom;
  const issue=useNodeIssues(id);
  const gotoTarget=data.kind==="goto"?data.gotoNode:"";
  const gotoName=useStore(s=>{
    if(!gotoTarget)return "";
    const target=s.nodeLookup.get(gotoTarget)?.data as {kind?:keyof typeof LABELS;title?:string}|undefined;
    if(!target)return "";
    return target.title||(target.kind?LABELS[target.kind]:"")||"";
  });
  const platform=useStore(s=>{
    for(const n of s.nodeLookup.values()){
      const d=n.data as {kind?:string;platform?:string};
      if(d.kind==="trigger")return d.platform||"";
    }
    return "";
  });
  const ports=outputs({id,position:{x:0,y:0},type:"flowNode",data});
  const allPorts=data.kind==="message"?data.options:
    data.kind==="question"&&data.inputMode==="buttons"?data.options:ports;
  const handleSignature=(horizontal?"LR":"TB")+":"+data.kind+":"+data.inputMode+":"+ports.map(p=>p.id).join(":");
  useEffect(()=>{updateInternals(id);},[id,handleSignature,updateInternals]);

  // Vertical keeps the V2 offsets; horizontal docks outputs on the right edge of their cell.
  const portStyle:CSSProperties=horizontal?{right:-12}:{left:"50%",bottom:-13};
  const nextStyle:CSSProperties=horizontal
    ?{right:-1,top:data.kind==="message"&&data.options.some(o=>!o.action||o.action==="step")?36:"50%"}
    :{left:data.kind==="message"&&data.options.some(o=>!o.action||o.action==="step")?14:"50%",bottom:-13};
  const Icon=SKIN_ICON[data.kind];
  // Per-kind colour for every node; only the Trigger takes its platform colour.
  const color=data.kind==="trigger"?(PLATFORM_COLOR[platform]||SKIN_COLOR.trigger):SKIN_COLOR[data.kind];
  const hasOptions=allPorts.length>0;
  const label=data.kind==="trigger"?LABELS.trigger:(data.title||LABELS[data.kind]);
  const message=["message","question"].includes(data.kind);
  const errorCount=issue?.errors||0,warningCount=issue?.warnings||0;
  return <div dir="rtl" data-kind={data.kind} style={{"--c":color} as CSSProperties}
    className={"fs-node group relative w-[280px] overflow-visible"+(selected?" is-selected":"")+(errorCount?" has-error":warningCount?" has-warning":"")}>
    {data.kind!=="trigger"&&
      <Handle id="in" type="target" position={horizontal?Position.Left:Position.Top} className="fs-port fs-port-in"/>}

    {(errorCount>0||warningCount>0)&&<span className={"fs-node-badge "+(errorCount?"is-error":"is-warning")}
      role="img" title={issue?.first||""}
      aria-label={(errorCount?"أخطاء: "+errorCount:"تحذيرات: "+warningCount)+(issue?.first?" — "+issue.first:"")}>
      <AlertTriangle size={13} strokeWidth={2.6} aria-hidden="true"/>
    </span>}

    <div className="fs-node-head">
      <span className="fs-node-ico" aria-hidden="true"><Icon size={20}/></span>
      <div className="fs-node-titles">
        <span className="fs-node-title">{label}</span>
        <span className="fs-node-type">{LABELS[data.kind]}</span>
      </div>
    </div>

    <div className="fs-node-body">
      {data.kind==="trigger"&&<>
        <p className="fs-pill fs-pill-accent">{PLATFORM_LABELS[data.platform]}</p>
        <p className="fs-node-desc">{TRIGGER_OPTIONS[data.platform]?.find(t=>t.id===data.triggerMode)?.label||"حدث وارد"}</p>
        {(data.triggerMode==="keyword"||(data.triggerMode==="comment"&&!!data.keywords.trim()))&&
          <div className="flex flex-wrap gap-1.5">{data.keywords.split(/[,،\n]+/).map(w=>w.trim()).filter(Boolean).map(word=>
            <span key={word} className="fs-pill">{word}</span>)}
          </div>}
        {data.triggerMode==="message"&&<p className="fs-node-chip">أي رسالة واردة</p>}
        {data.triggerMode==="comment"&&!data.keywords.trim()&&<p className="fs-node-chip">أي تعليق</p>}
        {data.triggerMode==="comment"&&data.commentScope==="specific"&&<p className="fs-node-chip">منشور محدد</p>}
      </>}
      {message&&<>
        <p className="fs-node-text line-clamp-4 whitespace-pre-wrap break-words">{data.text||"اضغط لتعديل الرسالة"}</p>
        {data.kind==="question"&&data.inputMode!=="buttons"&&<div data-testid="typed-question-preview" className="fs-node-typed">
          <p className="mb-2 text-[11px] font-semibold text-[var(--fs-muted)]">إجابة العميل المطلوبة: {({text:"نص",email:"بريد إلكتروني",phone:"رقم هاتف",number:"رقم"} as const)[data.inputMode]}</p>
          <div className="fs-node-typed-field">
            {({text:"يكتب العميل إجابته هنا…",email:"name@example.com",phone:"07XXXXXXXXX",number:"123"} as const)[data.inputMode]}
          </div>
          <p className="mt-2 text-[10px] text-[var(--fs-muted)]">حقل إدخال في معاينة العميل، وليس أزرارًا سريعة</p>
        </div>}
        {data.image&&<img alt="معاينة صورة الرسالة" src={data.image} className="max-h-36 w-full rounded-xl object-contain" loading="lazy"/>}
        {(data.contentBlocks||[]).filter(block=>block.type==="image"&&block.url).slice(0,1).map(block=><img key={block.id} alt="صورة إضافية" src={block.url} className="max-h-28 w-full rounded-xl object-contain" loading="lazy"/>)}
        {!!data.contentBlocks?.length&&<p className="fs-node-chip">{data.contentBlocks.length} مكونات إضافية: {data.contentBlocks.map(block=>block.type==="collection"?"جمع بيانات: "+(({text:"نص",email:"بريد إلكتروني",phone:"هاتف",number:"رقم"} as const)[block.inputMode||"text"]):({text:"نص",image:"صورة",pdf:"PDF",delay:"انتظار"} as const)[block.type]).join(" · ")}</p>}
      </>}
      {data.kind==="condition"&&<p className="fs-node-desc">إذا كان {data.conditionField} {data.operator==="contains"?"يحتوي":data.operator==="equals"?"يساوي":data.operator==="not_equals"?"لا يساوي":"موجود"}: {data.conditionValue||"—"}</p>}
      {data.kind==="delay"&&<p className="fs-node-desc">انتظار {data.delayValue} {({seconds:"ثانية",minutes:"دقيقة",hours:"ساعة",days:"يوم"} as const)[data.delayUnit]}</p>}
      {data.kind==="action"&&<p className="fs-node-desc">{data.actionType}: {data.actionValue||"—"}</p>}
      {data.kind==="randomizer"&&<p className="fs-node-desc">توزيع المسارات بالنسب المحددة</p>}
      {data.kind==="goto"&&<p data-testid="goto-target-name" className="fs-node-desc">انتقال إلى {gotoName||"خطوة غير محددة"}</p>}
      {data.kind==="request"&&<>
        <p className="fs-node-desc">طلب خارجي: {data.requestMethod}</p>
        <p dir="ltr" className="fs-node-desc truncate !text-[10px]">{data.requestUrl||"HTTPS URL"}</p>
      </>}
      {data.kind==="end"&&<p className="fs-node-desc">انتهاء هذا المسار.</p>}
    </div>

    {data.kind==="question"&&data.inputMode!=="buttons"&&<div data-testid="typed-question-next" className="fs-node-ports relative px-3 pb-5 pt-3 text-center text-xs font-semibold">
      التالي
      <Handle id="valid" type="source" position={outPos}
        aria-label="مخرج التالي بعد جمع البيانات"
        className="fs-port fs-port-out"
        style={portStyle}/>
      {/* Retain legacy connections by keeping their internal port without showing confusing buttons. */}
      <Handle id="invalid" type="source" position={outPos}
        className="!invisible !pointer-events-none" style={portStyle}/>
    </div>}
    {hasOptions&&!(data.kind==="question"&&data.inputMode!=="buttons")&&<div className="fs-node-ports px-3 pb-5 pt-3">
      <div className="grid gap-2" style={{gridTemplateColumns:`repeat(${horizontal?1:Math.min(allPorts.length,3)},minmax(0,1fr))`}}>
        {allPorts.map(port=><div key={port.id} className="fs-node-opt relative flex min-h-10 items-center justify-center px-1.5 py-2 text-center text-[11px] font-medium">
          <span className="w-full truncate" title={port.label}>{port.label}</span>
          {data.kind==="randomizer"&&<span className="fs-node-weight">{port.weight||0}%</span>}
          {ports.some(p=>p.id===port.id)&&<Handle id={port.id} type="source" position={outPos}
            className="fs-port fs-port-out"
            style={portStyle}/>}
        </div>)}
      </div>
    </div>}

    {data.kind==="message"&&<Handle id="next" type="source" position={outPos}
      aria-label="مخرج الخطوة التالية" className="fs-port fs-port-out"
      style={nextStyle}/>}

    {!!ports.length&&
      <button type="button"
        aria-label={"إضافة خطوة بعد "+label}
        title="أضف خطوة واربطها بهذا المسار"
        className={"fs-node-add nodrag nopan absolute z-30 flex h-14 w-14 items-center justify-center rounded-full "+(horizontal?"-right-14 top-1/2 -translate-y-1/2 ":"-bottom-14 left-1/2 -translate-x-1/2 ")+(selected?"opacity-100":"opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100")}
        onClick={e=>{e.stopPropagation();openMenu({source:id,port:ports.length===1?ports[0].id:undefined,x:e.clientX,y:e.clientY});}}>
        <Plus size={18}/>
      </button>
    }
  </div>;
}
