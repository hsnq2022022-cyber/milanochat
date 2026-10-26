import { useCallback, useEffect, useState } from "react";
import { Play, RotateCcw, Send, X, Smartphone, AlertTriangle } from "lucide-react";
import type { FlowDocument, FlowNode } from "./model";

type Bubble = {id:string;side:"bot"|"user"|"system";text:string;image?:string};
type Simulation = {at:string|null;history:Bubble[];variables:Record<string,string>;visited:string[];waiting:boolean};
const btn="rounded-xl border border-[#275443] bg-[#0F2E24] px-3 py-2 text-xs hover:bg-[#173D30]";
function checkInput(node:FlowNode,value:string):boolean {
  const mode=node.data.inputMode;
  if(mode==="email")return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if(mode==="number")return value.trim()!==""&&Number.isFinite(Number(value));
  if(mode==="phone")return /^\+?[\d\s-]{7,18}$/.test(value);
  return value.trim().length>0;
}
function condition(n:FlowNode,vars:Record<string,string>){
  const value=vars[n.data.conditionField]||"",test=n.data.conditionValue;
  if(n.data.operator==="exists")return !!value;
  if(n.data.operator==="equals")return value.trim().toLocaleLowerCase()===test.trim().toLocaleLowerCase();
  if(n.data.operator==="not_equals")return value.trim().toLocaleLowerCase()!==test.trim().toLocaleLowerCase();
  return value.toLocaleLowerCase().includes(test.toLocaleLowerCase())&&!!test;
}
export default function FlowSimulator({doc,onClose,onVisited}:{doc:FlowDocument;onClose:()=>void;onVisited?:(ids:string[])=>void}){
  const [simulation,setSimulation]=useState<Simulation>({at:null,history:[],variables:{message:"اشتراكات",first_name:"عميل"},visited:[],waiting:false});
  const [input,setInput]=useState("");
  const [note,setNote]=useState("");
  const find=(id:string)=>doc.nodes.find(n=>n.id===id);
  const nextFor=(source:string,port:string)=>doc.edges.find(e=>e.source===source&&e.sourceHandle===port)?.target;
  const walk=useCallback((start:string|undefined,seed:Simulation)=>{
    const history=[...seed.history],visited=[...seed.visited],variables={...seed.variables};
    let at=start||null,waiting=false,steps=0;
    while(at&&steps++<35){
      const n=doc.nodes.find(node=>node.id===at);
      if(!n)break;visited.push(at);
      if(n.data.kind==="trigger"){at=nextFor(n.id,"next")||null;continue;}
      if(n.data.kind==="action"){
        if(n.data.actionType==="set_field"){const [key,...rest]=n.data.actionValue.split("=");if(key)variables[key.trim()]=rest.join("=").trim();}
        history.push({id:crypto.randomUUID(),side:"system",text:"إجراء محاكاة: "+n.data.title});
        at=nextFor(n.id,"next")||null;continue;
      }
      if(n.data.kind==="condition"){at=nextFor(n.id,condition(n,variables)?"yes":"no")||null;continue;}
      if(n.data.kind==="delay"){history.push({id:crypto.randomUUID(),side:"system",text:"تخطي انتظار "+n.data.delayValue+" "+n.data.delayUnit+" في المعاينة"});at=nextFor(n.id,"next")||null;continue;}
      if(n.data.kind==="request"){history.push({id:crypto.randomUUID(),side:"system",text:"لم يُنفّذ طلب HTTP من المحاكاة لأسباب أمنية؛ تم اختيار مسار الخطأ."});at=nextFor(n.id,"error")||null;continue;}
      if(n.data.kind==="randomizer"){
        let roll=Math.random()*100,out=n.data.options[n.data.options.length-1]?.id||"next";
        for(const o of n.data.options){roll-=o.weight||0;if(roll<=0){out=o.id;break;}}
        history.push({id:crypto.randomUUID(),side:"system",text:"مسار عشوائي: "+(n.data.options.find(o=>o.id===out)?.label||out)});
        at=nextFor(n.id,out)||null;continue;
      }
      if(n.data.kind==="goto"){at=n.data.gotoNode||null;continue;}
      if(n.data.kind==="end"){history.push({id:crypto.randomUUID(),side:"system",text:"نهاية التدفق"});at=null;break;}
      if(n.data.kind==="message"||n.data.kind==="question"){
        history.push({id:crypto.randomUUID(),side:"bot",text:n.data.text,image:n.data.image||undefined});
        waiting=n.data.kind==="question"||n.data.options.length>0||!!nextFor(n.id,"next");
        break;
      }
      at=null;
    }
    if(steps>=35){history.push({id:crypto.randomUUID(),side:"system",text:"أُوقفت المحاكاة لمنع حلقة لا نهائية."});at=null;waiting=false;}
    const result={at,history,variables,visited,waiting};setSimulation(result);onVisited?.(visited);
  },[doc,onVisited]);
  const restart=()=>{
    const init:Simulation={at:null,history:[],variables:{message:"اشتراكات",first_name:"عميل"},visited:[],waiting:false};
    setNote("");setInput("");walk(doc.nodes.find(n=>n.data.kind==="trigger")?.id,init);
  };
  useEffect(()=>{restart();},[]);
  const current=find(simulation.at||"");
  const respond=(label:string,port:string,valid=true)=>{
    if(!current)return;
    const variables={...simulation.variables};
    if(current.data.kind==="question"){variables[current.data.inputField]=label;variables.message=label;}
    const history=[...simulation.history,{id:crypto.randomUUID(),side:"user" as const,text:label}];
    const next=nextFor(current.id,port);
    if(next)walk(next,{...simulation,variables,history});
    else {
      setSimulation({...simulation,variables,history:[...history,{id:crypto.randomUUID(),side:"system",text:valid?"انتهى هذا المسار.":"لا يوجد مسار بديل."}],at:null,waiting:false});
    }
  };
  const submit=()=>{
    if(!current)return;const ok=checkInput(current,input);
    respond(input,ok?"valid":"invalid",ok);setInput("");
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3" dir="rtl" onClick={onClose}>
    <div className="flex h-[min(770px,95vh)] w-full max-w-md flex-col overflow-hidden rounded-[28px] border border-[#305D49] bg-[#0B241C] text-white shadow-2xl" onClick={e=>e.stopPropagation()}>
      <header className="flex items-center justify-between border-b border-[#275443] px-4 py-4"><div className="flex items-center gap-2"><Smartphone size={20} className="text-[#3DD189]"/><div><h2 className="font-semibold">معاينة التدفق</h2><p className="text-[11px] text-[#8B9E96]">محاكاة دون إرسال رسائل أو استهلاك رصيد</p></div></div><button aria-label="إغلاق المعاينة" onClick={onClose}><X size={20}/></button></header>
      <div className="flex-1 space-y-3 overflow-y-auto bg-[#061A14] p-4">
        {simulation.history.map(m=><div key={m.id} className={"max-w-[90%] rounded-2xl px-3 py-2.5 text-sm "+(m.side==="user"?"mr-auto bg-[#235740]":m.side==="bot"?"ml-auto bg-[#173D30]":"mx-auto bg-[#25382D] text-center text-xs text-[#C7D5C9]")}>
          {m.image&&<img className="mb-2 max-h-48 w-full rounded-xl object-contain" src={m.image} alt="صورة الرسالة"/>}
          <p className="whitespace-pre-wrap break-words">{m.text}</p>
        </div>)}
        {!simulation.waiting&&!simulation.at&&<p className="mt-5 text-center text-xs text-[#8B9E96]">اكتملت المحاكاة.</p>}
      </div>
      {current&&simulation.waiting&&<div className="space-y-2 border-t border-[#275443] p-3">
        {current.data.kind==="question"&&current.data.inputMode==="buttons"||current.data.kind==="message"&&current.data.options.length>0?
          <div className="flex flex-wrap gap-2">{current.data.options.map(o=><button className={btn} key={o.id} onClick={()=>respond(o.label,o.id)}>{o.label}</button>)}</div>:null}
        {current.data.kind==="question"&&current.data.inputMode!=="buttons"&&<div className="flex gap-2">
          <input className="min-w-0 flex-1 rounded-xl border border-[#275443] bg-[#0F2E24] px-3 py-2 text-sm" placeholder="اكتب الإجابة..." value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")submit();}}/>
          <button className={btn} onClick={submit}><Send size={17}/></button>
        </div>}
        {current.data.kind==="message"&&nextFor(current.id,"next")&&<button className={btn+" w-full justify-center"} onClick={()=>{walk(nextFor(current.id,"next"),simulation);}}>التالي</button>}
      </div>}
      <footer className="flex items-center justify-between gap-2 border-t border-[#275443] px-4 py-3">
        <button className={btn} onClick={restart}><RotateCcw size={15}/> إعادة التشغيل</button>
        <span className="text-[11px] text-[#8B9E96]">الخطوات المارة: {simulation.visited.length}</span>
      </footer>
      {note&&<p role="alert" className="p-2 text-xs text-[#E5B54B]"><AlertTriangle size={14}/>{note}</p>}
    </div>
  </div>;
}
