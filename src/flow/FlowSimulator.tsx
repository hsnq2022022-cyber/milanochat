import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Send, X, Smartphone, FileText } from "lucide-react";
import type { Choice, FlowDocument, FlowNode } from "./model";
import { PLATFORM_LABELS } from "./model";
import type { SavedFlow } from "./library";

type Bubble = {id:string;side:"bot"|"user"|"system";text:string;image?:string;pdf?:string};
type SimState = {
  activeFlowId:string; at:string|null; history:Bubble[];
  variables:Record<string,string>; visited:string[]; waiting:boolean;
  pendingBlockIndex?:number;
};
const btn="rounded-xl border border-[#275443] bg-[#0F2E24] px-3 py-2 text-xs hover:bg-[#173D30]";
const bubble=(side:Bubble["side"],text:string,extra?:Partial<Bubble>):Bubble=>({id:crypto.randomUUID(),side,text,...extra});
const interpolate=(s:string,vars:Record<string,string>)=>s.replace(/\{\{(\w+)\}\}/g,(_,key:string)=>vars[key]||"");
function validInput(mode:string,value:string){
  if(mode==="email")return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if(mode==="phone")return /^\+?[\d\s-]{7,18}$/.test(value);
  if(mode==="number")return value.trim()!==""&&Number.isFinite(Number(value));
  return !!value.trim();
}
function evaluate(n:FlowNode,vars:Record<string,string>){
  const value=vars[n.data.conditionField]||"",test=n.data.conditionValue;
  if(n.data.operator==="exists")return !!value;
  if(n.data.operator==="equals")return value.trim().toLocaleLowerCase()===test.trim().toLocaleLowerCase();
  if(n.data.operator==="not_equals")return value.trim().toLocaleLowerCase()!==test.trim().toLocaleLowerCase();
  return !!test&&value.toLocaleLowerCase().includes(test.toLocaleLowerCase());
}
export default function FlowSimulator({
  doc,flowId,flows,onClose,onVisited
}:{
  doc:FlowDocument;flowId:string;flows:SavedFlow[];onClose:()=>void;onVisited?:(ids:string[])=>void
}){
  const [sim,setSim]=useState<SimState>({
    activeFlowId:flowId,at:null,history:[],
    variables:{message:"اشتراكات",first_name:"عميل"},visited:[],waiting:false
  });
  const [input,setInput]=useState(""),[note,setNote]=useState("");
  const getDoc=(id:string)=>id===flowId?doc:flows.find(f=>f.id===id)?.doc||null;
  const currentDoc=getDoc(sim.activeFlowId)||doc;
  const find=(id:string)=>currentDoc.nodes.find(n=>n.id===id);
  const nextFor=(document:FlowDocument,source:string,port:string)=>
    document.edges.find(e=>e.source===source&&e.sourceHandle===port)?.target;
  const walk=useCallback((start:string|undefined,seed:SimState,targetFlowId=seed.activeFlowId,resumeIndex?:number)=>{
    const document=targetFlowId===flowId?doc:flows.find(f=>f.id===targetFlowId)?.doc;
    if(!document){
      setSim({...seed,at:null,waiting:false,history:[...seed.history,bubble("system","التدفق المستهدف غير موجود.")]});
      return;
    }
    const history=[...seed.history],visited=[...seed.visited],variables={...seed.variables};
    let at=start||null,waiting=false,pendingBlockIndex: number|undefined;
    let steps=0;
    while(at&&steps++<40){
      const n=document.nodes.find(item=>item.id===at);
      if(!n){history.push(bubble("system","خطوة غير موجودة في هذا التدفق."));at=null;break;}
      visited.push(n.id);
      if(n.data.kind==="trigger"){at=nextFor(document,n.id,"next")||null;continue;}
      if(n.data.kind==="action"){
        if(n.data.actionType==="set_field"){
          const [name,...rest]=n.data.actionValue.split("=");
          if(name.trim())variables[name.trim()]=rest.join("=").trim();
        }
        history.push(bubble("system",n.data.actionType==="ai"?"AI Step يتطلب ربط الذكاء الاصطناعي بالخادم. لم يُستدعَ نموذج حقيقي.":"إجراء تجريبي: "+n.data.title));
        at=nextFor(document,n.id,"next")||null;continue;
      }
      if(n.data.kind==="condition"){at=nextFor(document,n.id,evaluate(n,variables)?"yes":"no")||null;continue;}
      if(n.data.kind==="delay"){
        history.push(bubble("system","تم تخطي انتظار "+n.data.delayValue+" "+n.data.delayUnit+" في المعاينة."));
        at=nextFor(document,n.id,"next")||null;continue;
      }
      if(n.data.kind==="request"){
        history.push(bubble("system","لم يُنفذ HTTP من المتصفح. اختير مسار الخطأ التجريبي."));
        at=nextFor(document,n.id,"error")||null;continue;
      }
      if(n.data.kind==="randomizer"){
        let remaining=Math.random()*100,out=n.data.options[n.data.options.length-1]?.id||"next";
        for(const item of n.data.options){remaining-=item.weight||0;if(remaining<=0){out=item.id;break;}}
        at=nextFor(document,n.id,out)||null;continue;
      }
      if(n.data.kind==="goto"){at=n.data.gotoNode||null;continue;}
      if(n.data.kind==="end"){history.push(bubble("system","انتهى التدفق."));at=null;break;}
      if(n.data.kind==="message"||n.data.kind==="question"){
        if(resumeIndex===undefined&&(n.data.text||n.data.image)){
          history.push(bubble("bot",interpolate(n.data.text,variables),{image:n.data.image||undefined}));
        }
        const blocks=n.data.contentBlocks||[];
        for(let i=resumeIndex??0;i<blocks.length;i++){
          const block=blocks[i];
          if(block.type==="text"&&block.text)history.push(bubble("bot",interpolate(block.text,variables)));
          else if(block.type==="image"&&block.url)history.push(bubble("bot","",{image:block.url}));
          else if(block.type==="pdf"&&block.url)history.push(bubble("bot","ملف PDF مرفق",{pdf:block.url}));
          else if(block.type==="delay")history.push(bubble("system","فاصل "+(block.seconds||3)+" ثوانٍ — تخطته المحاكاة."));
          else if(block.type==="collection"){
            history.push(bubble("bot",interpolate(block.text||"أرسل البيانات المطلوبة",variables)));
            waiting=true;pendingBlockIndex=i;break;
          }
        }
        if(pendingBlockIndex!==undefined)break;
        resumeIndex=undefined;
        waiting=n.data.kind==="question"||n.data.options.length>0||!!nextFor(document,n.id,"next");
        if(!waiting)at=null;
        break;
      }
      at=null;
    }
    if(steps>=40){history.push(bubble("system","توقف التنفيذ لمنع حلقة لا نهائية."));at=null;waiting=false;}
    setSim({at,activeFlowId:targetFlowId,history,variables,visited,waiting,pendingBlockIndex});
    onVisited?.(visited);
  },[doc,flowId,flows,onVisited]);
  const restart=()=>{
    setInput("");setNote("");
    const vars={message:"اشتراكات",first_name:"عميل"};
    const start=doc.nodes.find(n=>n.data.kind==="trigger");
    const platform=start?.data.platform||"instagram";
    const initial:SimState={activeFlowId:flowId,at:null,history:[bubble("system","معاينة "+PLATFORM_LABELS[platform]+" — لا يجري إرسال رسائل فعلية")],variables:vars,visited:[],waiting:false};
    walk(start?.id,initial,flowId);
  };
  useEffect(()=>{restart();},[]);
  const current=find(sim.at||"");
  const end=(history:Bubble[],text="انتهى هذا المسار.")=>setSim({...sim,history:[...history,bubble("system",text)],at:null,waiting:false});
  const respondChoice=(choice:Choice)=>{
    if(!current)return;
    setNote("");
    const history=[...sim.history,bubble("user",choice.label)];
    const vars={...sim.variables};
    if(current.data.kind==="question"){
      vars[current.data.inputField]=choice.label;
      vars.message=choice.label;
    }
    if(choice.action==="flow"){
      const target=flows.find(x=>x.id===choice.targetFlowId);
      const targetTrigger=target?.doc.nodes.find(n=>n.data.kind==="trigger");
      if(!target||!targetTrigger){end(history,"التدفق المستهدف غير موجود. اختر تدفقًا صالحًا في إعداد الزر.");return;}
      walk(targetTrigger.id,{...sim,history:[...history,bubble("system","انتقال إلى التدفق: "+target.doc.name)],variables:vars,activeFlowId:target.id},target.id);
      return;
    }
    if(choice.action==="website"){
      const url=choice.url||"";
      if(!/^https:\/\/\S+$/i.test(url)){end(history,"رابط الموقع غير صالح.");return;}
      setSim({...sim,history:[...history,bubble("system","اضغط الرابط لفتح الموقع:",{pdf:url})],at:null,waiting:false});
      return;
    }
    if(choice.action&&choice.action!=="step"){
      end(history,"إجراء "+choice.action+" يحتاج تنفيذ الخادم؛ لا يُنفذ داخل المحاكاة.");
      return;
    }
    const next=nextFor(currentDoc,current.id,choice.id);
    if(next)walk(next,{...sim,history,variables:vars});
    else end(history,"هذا الزر غير مرتبط بخطوة. اختر وجهته من إعداد الزر.");
  };
  const next=()=>{
    if(!current)return;
    const id=nextFor(currentDoc,current.id,"next");
    if(id)walk(id,sim);
    else end(sim.history);
  };
  const submit=()=>{
    if(!current)return;
    const answer=input.trim();if(!answer){setNote("أدخل إجابة أولًا.");return;}
    if(sim.pendingBlockIndex!==undefined){
      const block=current.data.contentBlocks[sim.pendingBlockIndex];
      if(!validInput(block.inputMode||"text",answer)){setNote("الإجابة غير صالحة لنوع البيانات المطلوب.");return;}
      const vars={...sim.variables,[block.field||"response"]:answer,message:answer};
      setInput("");setNote("");
      walk(current.id,{...sim,history:[...sim.history,bubble("user",answer)],variables:vars},sim.activeFlowId,sim.pendingBlockIndex+1);
      return;
    }
    const valid=validInput(current.data.inputMode,answer);
    const vars={...sim.variables,[current.data.inputField]:answer,message:answer};
    const dest=nextFor(currentDoc,current.id,valid?"valid":"invalid");
    const history=[...sim.history,bubble("user",answer)];
    setInput("");setNote("");
    if(dest)walk(dest,{...sim,history,variables:vars});
    else end(history,valid?"انتهى المسار.":"الإجابة غير صالحة ولا يوجد مسار بديل.");
  };
  const collection=current&&sim.pendingBlockIndex!==undefined?current.data.contentBlocks[sim.pendingBlockIndex]:null;
  const showTextInput=!!collection||current?.data.kind==="question"&&current.data.inputMode!=="buttons";
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3" dir="rtl" onClick={onClose}>
    <div className="flex h-[min(770px,95vh)] w-full max-w-md flex-col overflow-hidden rounded-[28px] border border-[#305D49] bg-[#0B241C] text-white shadow-2xl" onClick={e=>e.stopPropagation()}>
      <header className="flex items-center justify-between border-b border-[#275443] px-4 py-4">
        <div className="flex items-center gap-2"><Smartphone size={20} className="text-[#3DD189]"/>
          <div><h2 className="font-semibold">تجربة: {currentDoc.name}</h2><p className="text-[11px] text-[#8B9E96]">رسائل وهمية فقط — دون Meta أو خصم رصيد</p></div>
        </div><button aria-label="إغلاق المعاينة" onClick={onClose}><X size={20}/></button>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto bg-[#061A14] p-4">
        {sim.history.map(m=><div key={m.id} className={"max-w-[90%] rounded-2xl px-3 py-2.5 text-sm "+(m.side==="user"?"mr-auto bg-[#235740]":m.side==="bot"?"ml-auto bg-[#173D30]":"mx-auto bg-[#25382D] text-center text-xs text-[#C7D5C9]")}>
          {m.image&&<img className="mb-2 max-h-52 w-full rounded-xl object-contain" src={m.image} alt="صورة الرسالة"/>}
          {m.text&&<p className="whitespace-pre-wrap break-words">{m.text}</p>}
          {m.pdf&&<a className="mt-2 inline-flex items-center gap-2 text-[#6FE6A8] underline" href={m.pdf} target="_blank" rel="noopener noreferrer" download={m.pdf.startsWith("data:")?"attachment.pdf":undefined}><FileText size={15}/> {m.pdf.startsWith("data:")?"عرض أو حفظ الملف":"فتح الرابط"}</a>}
        </div>)}
        {!sim.waiting&&!sim.at&&<p className="mt-4 text-center text-xs text-[#8B9E96]">اكتملت المحاكاة.</p>}
      </div>
      {current&&sim.waiting&&<div className="space-y-2 border-t border-[#275443] p-3">
        {!collection&&(current.data.kind==="message"||current.data.kind==="question"&&current.data.inputMode==="buttons")&&
          <div className="flex flex-wrap gap-2">{current.data.options.map(option=><button className={btn} key={option.id} onClick={()=>respondChoice(option)}>{option.label}</button>)}</div>}
        {showTextInput&&<div className="flex gap-2"><input className="min-w-0 flex-1 rounded-xl border border-[#275443] bg-[#0F2E24] px-3 py-2 text-sm"
          aria-label="إجابة العميل" placeholder={collection?"اكتب البيانات المطلوبة...":"اكتب الإجابة..."} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")submit();}}/>
          <button className={btn} onClick={submit}><Send size={16}/></button></div>}
        {!collection&&current.data.kind==="message"&&nextFor(currentDoc,current.id,"next")&&<button className={btn+" w-full"} onClick={next}>الخطوة التالية</button>}
        {!!note&&<p role="alert" className="text-xs text-[#E5B54B]">{note}</p>}
      </div>}
      <footer className="flex items-center justify-between border-t border-[#275443] px-4 py-3">
        <button className={btn} onClick={restart}><RotateCcw size={15}/> إعادة</button>
        <span className="text-[11px] text-[#8B9E96]">المسارات المجربة: {sim.visited.length}</span>
      </footer>
    </div>
  </div>;
}
