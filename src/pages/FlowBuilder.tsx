import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as RPointerEvent, WheelEvent as RWheelEvent } from "react";
import { ArrowRight, Plus, Minus, Maximize, Save, Download, Upload, Trash2, Play, X, MousePointer2, GitBranch, MessageSquare, Rocket, Clock3, CheckCircle2, Zap, Image as ImageIcon, RotateCcw, Undo2, Redo2, Search, LayoutGrid, Shuffle, Map as MapIcon } from "lucide-react";

type Kind = "trigger" | "message" | "question" | "condition" | "delay" | "action" | "randomizer" | "end";
type Choice = { id: string; text: string };
type Node = { id: string; type: Kind; x: number; y: number; title: string; text: string; keyword: string; image: string; delay: number; choices: Choice[] };
type Edge = { id: string; from: string; port: string; to: string };
type Flow = { version: 2; name: string; nodes: Node[]; edges: Edge[] };
const KEY = "social_flow_visual_v2";
const OLD = "social_flow_builder_draft_v1";
const SIZE = 270;
const names: Record<Kind,string> = {trigger:"بداية التدفق",message:"إرسال رسالة",question:"سؤال وأزرار",condition:"شرط",delay:"انتظار",action:"إجراء",randomizer:"توزيع عشوائي",end:"نهاية التدفق"};
const colors: Record<Kind,string> = {trigger:"#3DD189",message:"#60A5FA",question:"#A78BFA",condition:"#E5B54B",delay:"#F59E0B",action:"#2DD4BF",randomizer:"#FB923C",end:"#94A3B8"};
const make = (type:Kind,x:number,y:number,id=crypto.randomUUID()):Node=>({id,type,x,y,title:names[type],text:type==="message"?"أهلاً بيك! شلون نكدر نساعدك؟":type==="question"?"اختر أحد الخيارات":type==="condition"?"هل تحتوي الرسالة على الكلمة؟":"",keyword:"",image:"",delay:30,choices:type==="question"?[{id:crypto.randomUUID(),text:"الخيار الأول"},{id:crypto.randomUUID(),text:"الخيار الثاني"}]:type==="randomizer"?[{id:crypto.randomUUID(),text:"50"},{id:crypto.randomUUID(),text:"50"}]:[]});
const demo:Flow={version:2,name:"تدفق ترحيبي",nodes:[
  {...make("trigger",390,40,"a"),keyword:"اشتراكات"},
  {...make("message",390,305,"b"),text:"مرحباً بيك! اضغط على الزر لعرض الخيارات."},
  {...make("question",390,560,"c"),text:"اختر دولتك",choices:[{id:"iq",text:"العراق"},{id:"om",text:"عمان"},{id:"ae",text:"الإمارات"}]},
  {...make("message",20,985,"d"),title:"أسعار العراق",text:"تواصل معنا لمعرفة أسعار الاشتراكات في العراق."},
  {...make("message",390,985,"e"),title:"أسعار عمان",text:"تواصل معنا لمعرفة أسعار الاشتراكات في عمان."},
  {...make("message",760,985,"f"),title:"أسعار الإمارات",text:"تواصل معنا لمعرفة أسعار الاشتراكات في الإمارات."}
],edges:[{id:"ab",from:"a",port:"next",to:"b"},{id:"bc",from:"b",port:"next",to:"c"},{id:"ci",from:"c",port:"iq",to:"d"},{id:"co",from:"c",port:"om",to:"e"},{id:"ca",from:"c",port:"ae",to:"f"}]};
const ports=(n:Node):Choice[]=>n.type==="end"?[]:["question","randomizer"].includes(n.type)?n.choices:n.type==="condition"?[{id:"yes",text:"نعم"},{id:"no",text:"لا"}]:[{id:"next",text:"التالي"}];
const height=(n:Node)=>["question","randomizer"].includes(n.type)?154+n.choices.length*42:n.type==="condition"?235:n.type==="trigger"?180:n.type==="end"?112:n.type==="message"?(n.image?270:206):164;
function validFlow(value:unknown):value is Flow {
 if(!value||typeof value!=="object")return false;
 const v=value as Partial<Flow>;if(!Array.isArray(v.nodes)||!Array.isArray(v.edges)||typeof v.name!=="string"||v.nodes.length<1||v.nodes.length>100||v.edges.length>200)return false;
 if(!v.nodes.every(n=>n&&typeof n.id==="string"&&n.id.length<150&&Object.keys(names).includes(n.type)&&Number.isFinite(n.x)&&Number.isFinite(n.y)&&Math.abs(n.x)<100000&&Math.abs(n.y)<100000&&typeof n.text==="string"&&typeof n.title==="string"&&typeof n.keyword==="string"&&typeof n.image==="string"&&typeof n.delay==="number"&&Array.isArray(n.choices)&&n.choices.length<=10&&n.choices.every(c=>c&&typeof c.id==="string"&&typeof c.text==="string")))return false;
 const ids=new Set(v.nodes.map(n=>n.id));return ids.size===v.nodes.length&&v.nodes.filter(n=>n.type==="trigger").length===1&&v.edges.every(e=>e&&typeof e.id==="string"&&ids.has(e.from)&&ids.has(e.to)&&typeof e.port==="string");
}
function load():Flow{
 try{const data=localStorage.getItem(KEY);if(data){const f:unknown=JSON.parse(data);if(validFlow(f))return f;}
 const old=localStorage.getItem(OLD);if(old){const steps:unknown=JSON.parse(old);if(Array.isArray(steps)&&steps.length&&steps.length<=80&&steps.every(s=>s&&typeof s==="object"&&"text" in s&&typeof s.text==="string"&&"options" in s&&Array.isArray(s.options))){
 const ns:Node[]=[make("trigger",380,35,"old-start")];const es:Edge[]=[];steps.forEach((s,i)=>{const v=s as {type?:string;text:string;options:string[]};const type:Kind=v.type==="end"?"end":v.type==="question"?"question":"message";const n=make(type,380,300+i*300,"old-"+i);n.text=v.text;n.choices=type==="question"?v.options.slice(0,10).map((o,j)=>({id:"opt-"+i+"-"+j,text:String(o)})):[];ns.push(n);if(i===0)es.push({id:"old-link",from:"old-start",port:"next",to:n.id});else if(steps[i-1] && (steps[i-1] as {type?:string}).type!=="question" && (steps[i-1] as {type?:string}).type!=="end")es.push({id:"old-link-"+i,from:"old-"+(i-1),port:"next",to:n.id});});
 return {version:2,name:"مسودة سابقة",nodes:ns,edges:es};}}
 }catch{/* Invalid browser draft; use example. */}return demo;
}
const curve=(x1:number,y1:number,x2:number,y2:number)=>"M "+x1+" "+y1+" C "+(x1-Math.max(65,Math.abs(x2-x1)*.5))+" "+y1+", "+(x2+Math.max(65,Math.abs(x2-x1)*.5))+" "+y2+", "+x2+" "+y2;
function issues(f:Flow):string[]{
 const result:string[]=[];const ids=new Set(f.nodes.map(n=>n.id));const start=f.nodes.find(n=>n.type==="trigger");
 if(!start)result.push("تحتاج خطوة بداية.");if(f.nodes.filter(n=>n.type==="trigger").length>1)result.push("يُسمح ببداية واحدة فقط.");
 for(const n of f.nodes){if(["message","question"].includes(n.type)&&!n.text.trim())result.push("نص مفقود: "+n.title);
 if(n.type==="question"&&(!n.choices.length||n.choices.some(c=>!c.text.trim())))result.push("خيارات ناقصة: "+n.title);
 if(n.type==="randomizer"&& (n.choices.length<2||n.choices.some(c=>!/^\d+(?:\.\d+)?$/.test(c.text)||Number(c.text)<0)||Math.abs(n.choices.reduce((t,c)=>t+Number(c.text),0)-100)>.001))result.push("نسب التوزيع يجب أن يكون مجموعها 100% في "+n.title);
 if(n.type==="message"&&n.image&&!(/^https:\/\/\S+$/i.test(n.image)||/^data:image\/(?:png|jpeg|webp);base64,/i.test(n.image)))result.push("الصورة تتطلب رابط HTTPS أو صورة مرفوعة.");
 for(const p of ports(n))if(!f.edges.some(e=>e.from===n.id&&e.port===p.id)&&n.type!=="message")result.push("اتصال ناقص: "+n.title+" / "+p.text);
 }for(const e of f.edges)if(!ids.has(e.from)||!ids.has(e.to))result.push("اتصال بعقدة غير موجودة.");
 if(start){const seen=new Set<string>();const walk=(id:string,stack:Set<string>)=>{if(stack.has(id)){result.push("يوجد مسار دائري.");return;}if(seen.has(id))return;seen.add(id);const next=new Set(stack);next.add(id);for(const e of f.edges.filter(e=>e.from===id))walk(e.to,next);};walk(start.id,new Set());for(const n of f.nodes)if(!seen.has(n.id))result.push("خطوة غير متصلة: "+n.title);}
 return [...new Set(result)];
}
export default function FlowBuilder(){
 const [flow,setFlow]=useState<Flow>(load),[selected,setSelected]=useState<string|null>("b"),[link,setLink]=useState<{from:string;port:string}|null>(null),[zoom,setZoom]=useState(.75),[offset,setOffset]=useState({x:95,y:18}),[notice,setNotice]=useState(""),[test,setTest]=useState(false),[at,setAt]=useState("a"),[log,setLog]=useState<{who:"bot"|"user";text:string}[]>([]);
 const [query,setQuery]=useState(""),[showMap,setShowMap]=useState(true),[simInput,setSimInput]=useState("");
 const undoHistory=useRef<Flow[]>([]),redoHistory=useRef<Flow[]>([]),lastFlow=useRef(flow),skipHistory=useRef(false),clipboard=useRef<Node|null>(null);
 useEffect(()=>{const timer=window.setTimeout(()=>{try{localStorage.setItem(KEY,JSON.stringify(flow));}catch{/* Browser storage unavailable: manual export remains available. */}},800);return()=>window.clearTimeout(timer);},[flow]);
 useEffect(()=>{if(skipHistory.current){skipHistory.current=false;lastFlow.current=flow;return;}if(flow!==lastFlow.current){undoHistory.current.push(lastFlow.current);if(undoHistory.current.length>45)undoHistory.current.shift();redoHistory.current=[];lastFlow.current=flow;}},[flow]);
 const undo=()=>{const prev=undoHistory.current.pop();if(!prev)return;redoHistory.current.push(flow);skipHistory.current=true;setFlow(prev);setNotice("تم التراجع عن آخر تعديل.");};
 const redo=()=>{const next=redoHistory.current.pop();if(!next)return;undoHistory.current.push(flow);skipHistory.current=true;setFlow(next);setNotice("تمت إعادة التعديل.");};
 const autoArrange=()=>{
  const start=flow.nodes.find(n=>n.type==="trigger");if(!start)return;
  const depth=new Map<string,number>([[start.id,0]]),queue=[start.id];
  for(let i=0;i<queue.length;i++){const id=queue[i],current=depth.get(id)!;for(const e of flow.edges.filter(e=>e.from===id)){if(!depth.has(e.to)){depth.set(e.to,current+1);queue.push(e.to);}}}
  const levels=new Map<number,Node[]>();for(const n of flow.nodes){const d=depth.get(n.id)??99;levels.set(d,[...(levels.get(d)||[]),n]);}
  const arranged=flow.nodes.map(n=>{const d=depth.get(n.id)??Math.max(1,...depth.values())+1;const group=levels.get(d)||[];const index=group.findIndex(v=>v.id===n.id);return {...n,x:Math.round(90+(index-(group.length-1)/2)*355+750),y:Math.round(60+d*345)};});
  setFlow(f=>({...f,nodes:arranged}));setNotice("تم ترتيب الخطوات تلقائيًا.");
 };
 const canvas=useRef<HTMLDivElement>(null),drag=useRef<{id:string;px:number;py:number;x:number;y:number}|null>(null),pan=useRef<{px:number;py:number;x:number;y:number}|null>(null);
 const node=flow.nodes.find(n=>n.id===selected),errors=useMemo(()=>issues(flow),[flow]);
 const update=(id:string,delta:Partial<Node>)=>setFlow(f=>({...f,nodes:f.nodes.map(n=>n.id===id?{...n,...delta}:n)}));
 const add=(type:Kind)=>{if(flow.nodes.length>=100){setNotice("وصلت الحد الأقصى للعقد.");return;}if(type==="trigger"&&flow.nodes.some(n=>n.type==="trigger")){setNotice("توجد بداية واحدة بالفعل.");return;}const n=make(type,Math.round((390-offset.x)/zoom),Math.round((230-offset.y)/zoom));setFlow(f=>({...f,nodes:[...f.nodes,n]}));setSelected(n.id);};
 const connect=(to:string)=>{if(!link)return;if(link.from===to){setNotice("لا يمكن وصل العقدة بنفسها.");return;}setFlow(f=>({...f,edges:[...f.edges.filter(e=>e.from!==link.from||e.port!==link.port),{id:crypto.randomUUID(),from:link.from,port:link.port,to}]}));setLink(null);setNotice("تم توصيل العقدتين.");};
 const remove=(id:string)=>{setFlow(f=>({...f,nodes:f.nodes.filter(n=>n.id!==id),edges:f.edges.filter(e=>e.from!==id&&e.to!==id)}));setSelected(null);};
 const fit=()=>{if(!canvas.current)return;const w=canvas.current.clientWidth,h=canvas.current.clientHeight;const minX=Math.min(...flow.nodes.map(n=>n.x)),minY=Math.min(...flow.nodes.map(n=>n.y)),maxX=Math.max(...flow.nodes.map(n=>n.x+SIZE)),maxY=Math.max(...flow.nodes.map(n=>n.y+height(n)));const z=Math.max(.2,Math.min(1.15,(w-90)/(maxX-minX+30),(h-90)/(maxY-minY+30)));setZoom(z);setOffset({x:(w-(maxX-minX)*z)/2-minX*z,y:(h-(maxY-minY)*z)/2-minY*z});};
 const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(flow));setNotice("حُفظت المسودة في هذا المتصفح (ويتم الحفظ تلقائيًا أيضًا).");}catch{setNotice("تعذر التخزين، استخدم تصدير.");}};
 const download=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(flow,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="social-flow.json";a.click();URL.revokeObjectURL(url);};
 const upload=async(file?:File)=>{if(!file||file.size>2500000){setNotice("حجم ملف التدفق كبير جدًا.");return;}try{const value:unknown=JSON.parse(await file.text());if(!validFlow(value))throw Error();setFlow(value);setSelected(value.nodes[0].id);setNotice("تم استيراد التدفق، اضغط حفظ.");}catch{setNotice("صيغة الملف غير صالحة.");}};

 const imageUpload=async(id:string,file?:File)=>{
  if(!file)return;
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>5000000){setNotice("اختر صورة JPG أو PNG أو WebP بحجم لا يتجاوز 5MB.");return;}
  const src=URL.createObjectURL(file);
  try{
   const img=new Image();
   await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error("image load"));img.src=src;});
   const scale=Math.min(1,1100/Math.max(img.naturalWidth,img.naturalHeight));
   const el=document.createElement("canvas");el.width=Math.max(1,Math.round(img.naturalWidth*scale));el.height=Math.max(1,Math.round(img.naturalHeight*scale));
   const ctx=el.getContext("2d");if(!ctx)throw Error("canvas");
   ctx.drawImage(img,0,0,el.width,el.height);
   const data=el.toDataURL("image/webp",0.72);
   if(!/^data:image\/(?:webp|png);base64,/.test(data)||data.length>400000){setNotice("الصورة أكبر من حجم المسودة المسموح. اختر صورة أصغر.");return;}
   update(id,{image:data});
   setNotice("أضيفت الصورة إلى الرسالة. احفظ المسودة للاحتفاظ بها.");
  }catch{setNotice("تعذر قراءة الصورة. اختر صورة أخرى.");}finally{URL.revokeObjectURL(src);}
 };
 const duplicate=(n:Node)=>{
  if(flow.nodes.length>=100){setNotice("وصلت الحد الأقصى للعقد.");return;}
  const copy={...n,id:crypto.randomUUID(),title:n.title+" (نسخة)",x:n.x+55,y:n.y+65,choices:n.choices.map(c=>({...c,id:crypto.randomUUID()}))};
  setFlow(f=>({...f,nodes:[...f.nodes,copy]}));setSelected(copy.id);setNotice("تم نسخ الخطوة. اربطها بالتدفق.");
 };
 const nodeDown=(e:RPointerEvent<HTMLDivElement>,n:Node)=>{if((e.target as HTMLElement).closest("button,input,textarea"))return;e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);drag.current={id:n.id,px:e.clientX,py:e.clientY,x:n.x,y:n.y};setSelected(n.id);};
 const nodeMove=(e:RPointerEvent<HTMLDivElement>)=>{const d=drag.current;if(d)update(d.id,{x:Math.round(d.x+(e.clientX-d.px)/zoom),y:Math.round(d.y+(e.clientY-d.py)/zoom)});};
 const startPan=(e:RPointerEvent<HTMLDivElement>)=>{if(e.target!==e.currentTarget&&!(e.target as HTMLElement).classList.contains("flow-grid"))return;e.currentTarget.setPointerCapture(e.pointerId);pan.current={px:e.clientX,py:e.clientY,x:offset.x,y:offset.y};setSelected(null);};
 const panMove=(e:RPointerEvent<HTMLDivElement>)=>{if(pan.current){const p=pan.current;setOffset({x:p.x+e.clientX-p.px,y:p.y+e.clientY-p.py});}};
 const wheel=(e:RWheelEvent<HTMLDivElement>)=>{if(e.ctrlKey||e.altKey)setZoom(z=>Math.min(1.6,Math.max(.25,z+(e.deltaY>0?-.08:.08))));};
 const step=(id:string,history:{who:"bot"|"user";text:string}[],count=0):void=>{if(count>25){setLog([...history,{who:"bot",text:"تم إيقاف المحاكاة بسبب مسار متكرر."}]);return;}const n=flow.nodes.find(n=>n.id===id);if(!n){setLog(history);return;}if(["trigger","action","delay","condition","randomizer"].includes(n.type)){const out=n.type==="condition"?(simInput.toLocaleLowerCase().includes(n.keyword.trim().toLocaleLowerCase())&&!!n.keyword.trim()?"yes":"no"):n.type==="randomizer"?"next":"next";
 const output=n.type==="randomizer"?(()=>{const r=Math.random()*100;let total=0;for(const p of n.choices){total+=Number(p.text)||0;if(r<total)return p.id;}return n.choices[n.choices.length-1]?.id??"next";})():out;
 const edge=flow.edges.find(e=>e.from===n.id&&e.port===output);if(edge)step(edge.to,history,count+1);else setLog([...history,{who:"bot",text:"المسار غير متصل."}]);return;}setAt(id);setLog([...history,{who:"bot",text:n.type==="end"?"انتهت المحادثة.":n.text}]);};
 const simulate=()=>{setSimInput("");setTest(true);const n=flow.nodes.find(n=>n.type==="trigger");if(n)step(n.id,[]);};
 const advance=(choice?:Choice)=>{const n=flow.nodes.find(n=>n.id===at);if(!n)return;const history=choice?[...log,{who:"user" as const,text:choice.text}]:log;const edge=flow.edges.find(e=>e.from===n.id&&e.port===(choice?.id??"next"));if(edge)step(edge.to,history);else setLog([...history,{who:"bot",text:n.type==="message"?"انتهى هذا المسار.":"هذا الخيار غير متصل بخطوة أخرى."}]);};
 useEffect(()=>{const fn=(e:KeyboardEvent)=>{if(e.key==="Escape")setLink(null);
  const target=e.target as HTMLElement|null;if(target?.closest("input,textarea,[contenteditable='true']"))return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){e.preventDefault();if(e.shiftKey)redo();else undo();}
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="y"){e.preventDefault();redo();}
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="d"&&node){e.preventDefault();duplicate(node);}
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="c"&&node){e.preventDefault();clipboard.current=node;setNotice("تم نسخ العقدة إلى الحافظة الداخلية للمحرر.");}
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="v"&&clipboard.current){e.preventDefault();duplicate(clipboard.current);}
 };window.addEventListener("keydown",fn);return()=>window.removeEventListener("keydown",fn);},[flow,selected]);
 const btn="inline-flex items-center justify-center gap-1.5 rounded-xl border border-[#275443] px-3 py-2 text-xs hover:bg-[#173D30]";
 const field="w-full rounded-xl border border-[#275443] bg-[#0F2E24] p-3 text-sm text-white outline-none focus:border-[#3DD189]";
 return <div className="flex h-[100dvh] flex-col bg-[#061A14] text-white" dir="rtl" style={{fontFamily:"system-ui"}}>
  <header className="z-20 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#173D30] bg-[#0B241C] px-4 py-3">
   <div className="flex items-center gap-3"><a href="#/dashboard" className={btn} title="رجوع"><ArrowRight size={17}/></a><div><p className="text-[11px] text-[#8B9E96]">إدارة سوشيال / الأتمتة</p><input aria-label="اسم التدفق" className="w-40 bg-transparent font-bold outline-none md:w-60" maxLength={100} value={flow.name} onChange={e=>setFlow(f=>({...f,name:e.target.value}))}/></div><span className="rounded-lg border border-[#E5B54B]/40 px-2 py-1 text-[10px] text-[#E5B54B]">مسودة</span></div>
   <div className="flex flex-wrap items-center gap-2"><button className={btn} onClick={undo} title="تراجع Ctrl+Z"><Undo2 size={15}/> <span className="hidden sm:inline">تراجع</span></button><button className={btn} onClick={redo} title="إعادة Ctrl+Y"><Redo2 size={15}/></button><button className={btn} onClick={autoArrange} title="ترتيب آلي"><LayoutGrid size={15}/></button><button className={btn} onClick={simulate}><Play size={15}/> محاكاة</button><button className={btn} onClick={download}><Download size={15}/> تصدير</button><label className={btn+" cursor-pointer"}><Upload size={15}/> استيراد<input className="hidden" type="file" accept=".json,application/json" onChange={e=>{void upload(e.target.files?.[0]);e.target.value="";}}/></label><button className="flex items-center gap-1.5 rounded-xl bg-[#3DD189] px-4 py-2 text-xs font-bold text-[#061A14]" onClick={save}><Save size={15}/> حفظ المسودة</button></div>
  </header>
  <div className="relative flex min-h-0 flex-1 overflow-hidden">
   <aside className="hidden w-52 shrink-0 overflow-y-auto border-l border-[#173D30] bg-[#0B241C] p-3 md:block"><h2 className="mb-1 font-bold">إضافة خطوة</h2><label className="mb-3 block"><span className="mb-1 block text-xs text-[#8B9E96]">بحث عن عقدة</span><span className="flex items-center gap-1 rounded-lg border border-[#275443] px-2"><Search size={15}/><input className="w-full bg-transparent p-2 text-xs outline-none" value={query} onChange={e=>setQuery(e.target.value)} placeholder="ابحث بالاسم أو النص"/></span></label>{query&&<div className="mb-3 max-h-40 space-y-1 overflow-y-auto">{flow.nodes.filter(n=>(n.title+" "+n.text).toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(n=><button key={n.id} className="block w-full rounded-lg px-2 py-1.5 text-right text-xs hover:bg-[#173D30]" onClick={()=>{setSelected(n.id);setZoom(.8);setOffset({x:360-n.x*.8,y:210-n.y*.8});}}>{n.title}</button>)}</div>}<p className="mb-4 text-xs text-[#8B9E96]">أضف العقد ثم صِل المخارج بالعقد التالية.</p>{(Object.keys(names) as Kind[]).map(type=><button key={type} onClick={()=>add(type)} className="mb-2 flex w-full items-center gap-2 rounded-xl border border-[#244B3D] bg-[#0F2E24] p-3 text-right text-sm hover:border-[#3DD189]"><span style={{color:colors[type]}}>{type==="trigger"?<Rocket size={18}/>:type==="message"?<MessageSquare size={18}/>:type==="question"?<GitBranch size={18}/>:type==="delay"?<Clock3 size={18}/>:type==="end"?<CheckCircle2 size={18}/>:type==="randomizer"?<Shuffle size={18}/>:<Zap size={18}/>}</span>{names[type]}<Plus size={14} className="mr-auto"/></button>)}</aside>
   <section ref={canvas} className="relative min-w-0 flex-1 overflow-hidden bg-[#081710]" aria-label="مساحة محرر التدفقات" onPointerDown={startPan} onPointerMove={panMove} onPointerUp={()=>{pan.current=null;}} onPointerCancel={()=>{pan.current=null;}} onWheel={wheel}>
    <div className="flow-grid absolute inset-0" style={{backgroundImage:"radial-gradient(#355144 1px, transparent 1px)",backgroundSize:(20*zoom)+"px "+(20*zoom)+"px",backgroundPosition:offset.x+"px "+offset.y+"px",touchAction:"none"}}/>
    <div className="pointer-events-none absolute inset-0" style={{transform:"translate("+offset.x+"px, "+offset.y+"px) scale("+zoom+")",transformOrigin:"0 0"}}>
     <svg className="absolute left-0 top-0 overflow-visible" width="1" height="1"><g fill="none" stroke="#8B9E96" strokeWidth="2.5">{flow.edges.map(e=>{const from=flow.nodes.find(n=>n.id===e.from),to=flow.nodes.find(n=>n.id===e.to);if(!from||!to)return null;const ps=ports(from),index=ps.findIndex(p=>p.id===e.port);const y1=from.y+height(from)-24-Math.max(0,ps.length-index-1)*38;return <g key={e.id}><path d={curve(from.x,y1,to.x+SIZE,to.y+43)} stroke={selected===from.id||selected===to.id?"#3DD189":"#80998F"}/><text x={(from.x+to.x+SIZE)/2} y={(y1+to.y+43)/2-8} textAnchor="middle" fontSize="13" stroke="none" fill="#C4D8CE" fontWeight="600">{ps.find(p=>p.id===e.port)?.text??""}</text></g>;})}</g></svg>
    </div>
    <div className="absolute inset-0" style={{transform:"translate("+offset.x+"px, "+offset.y+"px) scale("+zoom+")",transformOrigin:"0 0",pointerEvents:"none"}}>
     {flow.nodes.map(n=><div key={n.id} className={"absolute overflow-visible rounded-2xl border bg-[#F8FAFC] text-[#17251E] shadow-[0_12px_35px_rgba(0,0,0,.4)] "+(selected===n.id?"border-[#3DD189] ring-2 ring-[#3DD189]":"border-[#C5D4CD]")} style={{left:n.x,top:n.y,width:SIZE,minHeight:height(n),pointerEvents:"auto",touchAction:"none"}} onPointerDown={e=>nodeDown(e,n)} onPointerMove={nodeMove} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onClick={()=>setSelected(n.id)}>
       <button title="اربط مخرجًا بهذه العقدة" aria-label={"توصيل إلى "+n.title} onClick={e=>{e.stopPropagation();connect(n.id);}} className={"absolute -right-[7px] top-9 h-3.5 w-3.5 rounded-full border-2 border-white "+(link?"bg-[#3DD189] animate-pulse":"bg-[#64748B]")}/>
       <div className="flex items-center gap-2 rounded-t-2xl px-4 py-3 text-sm font-bold text-white" style={{background:colors[n.type],color:n.type==="trigger"?"#061A14":"white"}}><MousePointer2 size={15}/><span className="truncate">{n.title||names[n.type]}</span></div>
       <div className="px-4 py-3 text-xs"><p className="whitespace-pre-wrap break-words text-[#374151]">{n.type==="trigger"?"عندما يرسل العميل رسالة":n.type==="end"?"نهاية الأتمتة":n.type==="delay"?"انتظار "+n.delay+" ثانية":n.type==="condition"?"فحص شرط الرسالة":n.type==="action"?"تنفيذ إجراء":n.type==="randomizer"?"توزيع نسب الزيارات بين المسارات":n.text||"أضف المحتوى من لوحة التعديل"}</p>{n.type==="trigger"&&<span className="mt-2 inline-block rounded-lg bg-[#D1FAE5] px-2 py-1 text-[11px] text-[#065F46]">الكلمات: {n.keyword||"أي رسالة"}</span>}{n.type==="randomizer"&&<span className="mt-1 block text-[#92400E]">النسب: {n.choices.map(c=>c.text+"%").join(" / ")}</span>}{n.type==="message"&&n.image&&<img alt="صورة الرسالة" src={n.image} className="mt-2 h-28 w-full rounded-lg border border-[#E2E8F0] object-contain bg-white" loading="lazy"/>}</div>
       <div className="space-y-1 px-3 pb-3">{ports(n).map(p=><div key={p.id} className="relative flex h-8 items-center justify-between rounded-lg border border-[#E2E8F0] bg-[#F1F5F9] px-2 text-xs"><span className="truncate">{p.text}</span><button title={"توصيل "+p.text} aria-label={"توصيل "+p.text} className="absolute -left-[18px] h-3.5 w-3.5 rounded-full border-2 border-white bg-[#60A5FA]" onClick={e=>{e.stopPropagation();setLink({from:n.id,port:p.id});setNotice("اختر الدائرة أعلى العقدة التالية لربط "+p.text);}}/></div>)}</div>
      </div>)}
    </div>
    <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-xl border border-[#275443] bg-[#0B241C]/95 p-2"><button className={btn} onClick={()=>setZoom(z=>Math.min(1.6,z+.1))} aria-label="تكبير"><Plus size={17}/></button><span className="w-12 text-center text-xs">{Math.round(zoom*100)}%</span><button className={btn} onClick={()=>setZoom(z=>Math.max(.25,z-.1))} aria-label="تصغير"><Minus size={17}/></button><button className={btn} onClick={fit} title="إظهار جميع العقد"><Maximize size={17}/></button><button className={btn} title="إظهار/إخفاء الخريطة" onClick={()=>setShowMap(v=>!v)}><MapIcon size={17}/></button></div>
    <div className="absolute right-3 top-3 flex flex-wrap gap-2 md:hidden">{(["message","question","condition","end"] as Kind[]).map(t=><button key={t} onClick={()=>add(t)} className="rounded-lg border border-[#275443] bg-[#0B241C] px-2 py-1.5 text-[11px]">+ {names[t]}</button>)}</div>
    {showMap&&<div className="absolute bottom-20 left-4 hidden h-32 w-44 overflow-hidden rounded-xl border border-[#275443] bg-[#0B241C]/95 sm:block" aria-label="خريطة التدفق المصغرة">
      <div className="absolute inset-0 text-[10px] text-[#8B9E96]"><span className="absolute right-2 top-1 z-10">خريطة</span>
      <svg width="100%" height="100%" viewBox={(()=>{const xs=flow.nodes.map(n=>n.x),ys=flow.nodes.map(n=>n.y);return [Math.min(...xs)-30,Math.min(...ys)-30,Math.max(...xs)-Math.min(...xs)+SIZE+60,Math.max(...ys)-Math.min(...ys)+340].join(" ");})()} preserveAspectRatio="xMidYMid meet">
      {flow.edges.map(e=>{const a=flow.nodes.find(n=>n.id===e.from),b=flow.nodes.find(n=>n.id===e.to);return a&&b?<line key={e.id} x1={a.x+SIZE/2} y1={a.y+height(a)/2} x2={b.x+SIZE/2} y2={b.y+height(b)/2} stroke="#8B9E96" strokeWidth={7}/>:null;})}
      {flow.nodes.map(n=><rect key={n.id} x={n.x} y={n.y} width={SIZE} height={height(n)} rx={20} fill={colors[n.type]} opacity={selected===n.id?1:.8}/>)}
      </svg></div></div>}
    {link&&<div className="absolute left-3 top-3 rounded-xl bg-[#173D30] px-3 py-2 text-xs text-[#3DD189]">اختر دائرة الإدخال في العقدة المطلوبة <button className="mr-3 underline" onClick={()=>setLink(null)}>إلغاء</button></div>}
   </section>
   <aside className="z-10 w-[min(38vw,330px)] min-w-[200px] shrink-0 overflow-y-auto border-r border-[#173D30] bg-[#0B241C] p-3 md:p-5">
    {node?<><div className="mb-4 flex items-center justify-between"><div><p className="text-xs text-[#8B9E96]">تحرير الخطوة</p><h2 className="font-bold">{names[node.type]}</h2></div><button onClick={()=>setSelected(null)} aria-label="إغلاق"><X size={18}/></button></div>
     <label className="mb-2 block text-xs">الاسم</label><input className={field} value={node.title} maxLength={80} onChange={e=>update(node.id,{title:e.target.value})}/>
     {["message","question"].includes(node.type)&&<><label className="mb-2 mt-4 block text-xs">نص الرسالة</label><textarea className={field+" min-h-32"} maxLength={2000} value={node.text} onChange={e=>update(node.id,{text:e.target.value})}/></>}
     {node.type==="trigger"&&<><label className="mb-2 mt-4 block text-xs">كلمة مفتاحية (اتركها فارغة للعرض فقط)</label><input className={field} value={node.keyword} maxLength={100} onChange={e=>update(node.id,{keyword:e.target.value})}/></>}
     {node.type==="message"&&<div className="mt-4 space-y-3">
       <label className="block text-xs font-bold">صورة الرسالة</label>
       <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-[#3DD189]/60 bg-[#0F2E24] px-3 py-4 text-xs text-[#3DD189] hover:bg-[#173D30]"><ImageIcon size={20}/> اختر صورة من جهازك (JPG / PNG / WebP)<input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={e=>{void imageUpload(node.id,e.target.files?.[0]);e.target.value="";}}/></label>
       <p className="text-[11px] leading-5 text-[#8B9E96]">تُضغط الصورة وتُضاف إلى مسودة المتصفح فقط. الحد الأقصى للملف الأصلي 5MB. لا تُرفع إلى Supabase ولا تُرسل للعميل.</p>
       <label className="block text-xs">أو ألصق رابط صورة HTTPS</label>
       <input className={field} dir="ltr" value={node.image.startsWith("data:")?"":node.image} placeholder="https://example.com/image.jpg" onChange={e=>update(node.id,{image:e.target.value})}/>
       {node.image&&<div className="relative rounded-xl border border-[#275443] bg-[#061A14] p-2"><img src={node.image} alt="معاينة الصورة" className="h-44 w-full rounded-lg object-contain"/><button className="mt-2 flex items-center gap-1 text-xs text-red-300" onClick={()=>update(node.id,{image:""})}><Trash2 size={14}/> حذف الصورة</button></div>}
     </div>}
     {node.type==="condition"&&<><label className="mb-2 mt-4 block text-xs">شرط: تحتوي رسالة الاختبار على</label><input className={field} value={node.keyword} onChange={e=>update(node.id,{keyword:e.target.value})} placeholder="مثلاً: السعر"/><p className="mt-2 text-[11px] text-[#8B9E96]">المحاكاة فقط: نعم عندما تحتوي الرسالة التجريبية على الكلمة، وإلا فلا.</p></>}{node.type==="delay"&&<><label className="mb-2 mt-4 block text-xs">الانتظار بالثواني (للمحاكاة فقط)</label><input type="number" min="1" max="86400" className={field} value={node.delay} onChange={e=>update(node.id,{delay:Math.max(1,Math.min(86400,Number(e.target.value)||1))})}/></>}
     {["question","randomizer"].includes(node.type)&&<div className="mt-4"><label className="mb-2 block text-xs">{node.type==="randomizer"?"نسب المسارات (المجموع 100%)":"الأزرار والمخارج المستقلة"}</label>{node.choices.map((p,i)=><div className="mb-2 flex gap-1" key={p.id}><input className={field} value={p.text} maxLength={60} onChange={e=>update(node.id,{choices:node.choices.map(q=>q.id===p.id?{...q,text:e.target.value}:q)})}/><button className={btn} aria-label="حذف زر" onClick={()=>{setFlow(f=>({...f,edges:f.edges.filter(e=>!(e.from===node.id&&e.port===p.id))}));update(node.id,{choices:node.choices.filter(q=>q.id!==p.id)});}}><Trash2 size={14}/></button><span className="sr-only">{i+1}</span></div>)}<button className={btn} disabled={node.choices.length>=10} onClick={()=>update(node.id,{choices:[...node.choices,{id:crypto.randomUUID(),text:node.type==="randomizer"?"0":"زر جديد"}]})}><Plus size={15}/> إضافة زر</button></div>}
     <div className="mt-6 border-t border-[#275443] pt-4"><p className="mb-2 text-xs text-[#8B9E96]">التوصيلات الخارجة</p>{flow.edges.filter(e=>e.from===node.id).map(e=><div key={e.id} className="mb-2 flex items-center justify-between gap-1 text-xs"><span className="truncate">{ports(node).find(p=>p.id===e.port)?.text} ← {flow.nodes.find(n=>n.id===e.to)?.title}</span><button aria-label="إزالة اتصال" onClick={()=>setFlow(f=>({...f,edges:f.edges.filter(w=>w.id!==e.id)}))}><X size={14}/></button></div>)}</div>
     <div className="mt-5 flex flex-wrap gap-3"><button className="flex items-center gap-2 text-sm text-[#3DD189]" onClick={()=>duplicate(node)}><Plus size={16}/> نسخ الخطوة</button>{node.type!=="trigger"&&<button className="flex items-center gap-2 text-sm text-red-300" onClick={()=>remove(node.id)}><Trash2 size={16}/> حذف الخطوة</button>}</div>
     </>:<div className="text-sm text-[#8B9E96]">اختر عقدة لتعديلها، أو اسحب مساحة العمل للتنقل.</div>}
    <div className="mt-6 border-t border-[#275443] pt-4"><h3 className="mb-2 text-sm font-bold">فحص التدفق</h3>{errors.length?<div className="space-y-1 text-xs text-[#E5B54B]">{errors.slice(0,8).map((error,i)=><p key={i}>• {error}</p>)}</div>:<p className="text-xs text-[#3DD189]">جميع التوصيلات والنصوص صحيحة مبدئيًا.</p>}<p className="mt-3 text-xs leading-5 text-[#8B9E96]">المحرر تجريبي؛ لا يرسل رسائل ولا يستهلك رصيدًا. تحفظ التغييرات تلقائيًا في هذا المتصفح فقط. اختصارات: Ctrl+Z للتراجع، Ctrl+C/V لنسخ العقدة ولصقها.</p></div>
   </aside>
  </div>
  {notice&&<div role="status" className="absolute bottom-6 right-5 z-40 max-w-sm rounded-xl border border-[#275443] bg-[#0B241C] px-4 py-3 text-sm text-[#3DD189] shadow-xl" onClick={()=>setNotice("")}>{notice} ×</div>}
  {test&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={()=>setTest(false)}><div className="flex h-[min(640px,90vh)] w-full max-w-md flex-col rounded-2xl border border-[#275443] bg-[#0B241C] p-4" onClick={e=>e.stopPropagation()}><header className="mb-3 flex items-center justify-between"><h2 className="font-bold">تجربة المحادثة</h2><button aria-label="إغلاق" onClick={()=>setTest(false)}><X size={19}/></button></header><div className="flex-1 space-y-3 overflow-y-auto rounded-xl bg-[#061A14] p-3">{log.map((m,i)=><div key={i} className={"max-w-[90%] rounded-xl p-3 text-sm "+(m.who==="bot"?"bg-[#173D30]":"mr-auto bg-[#245A42]")}>{m.who==="bot"&&i===log.length-1&&flow.nodes.find(n=>n.id===at)?.image&&<img src={flow.nodes.find(n=>n.id===at)?.image} alt="صورة المحادثة" className="mb-2 max-h-44 w-full rounded-lg object-contain"/>}<p>{m.text}</p></div>)}</div><div className="mt-2"><label className="text-xs text-[#8B9E96]">رسالة العميل لتجربة الشروط</label><input className={field} placeholder="اكتب كلمة تجريبية" value={simInput} onChange={e=>setSimInput(e.target.value)}/></div><div className="mt-3 flex flex-wrap gap-2">{flow.nodes.find(n=>n.id===at)?.type==="question"?flow.nodes.find(n=>n.id===at)!.choices.map(c=><button key={c.id} className={btn} onClick={()=>advance(c)}>{c.text}</button>):flow.nodes.find(n=>n.id===at)?.type!=="end"?<button className={btn} onClick={()=>advance()}>التالي</button>:null}<button className={btn} onClick={()=>{const n=flow.nodes.find(n=>n.type==="trigger");if(n)step(n.id,[]);}}><RotateCcw size={15}/> من البداية</button></div></div></div>}
 </div>;
}
