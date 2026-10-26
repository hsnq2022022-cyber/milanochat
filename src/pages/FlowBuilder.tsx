import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, MarkerType,
  useReactFlow,
} from "@xyflow/react";
import type { Connection, Edge, Node as RFNode, XYPosition } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowRight, Plus, Play, Save, Upload, Download, Undo2, Redo2, Search, LayoutGrid, Trash2, AlertTriangle, CheckCircle2 } from "lucide-react";
import AutomationNode from "../flow/AutomationNode";
import AutomationEdge from "../flow/AutomationEdge";
import NodeEditor from "../flow/NodeEditor";
import FlowSimulator from "../flow/FlowSimulator";
import { ACCENT, KIND_LIST, LABELS, SAVE_KEY, canConnect, exampleFlow, importFlow, makeNode, outputs, validateDocument } from "../flow/model";
import type { FlowNode, FlowEdge, Kind } from "../flow/model";
import { useFlowStore } from "../flow/store";

const nodeTypes={flowNode:AutomationNode};
const edgeTypes={flowEdge:AutomationEdge};
const btn="inline-flex items-center justify-center gap-1.5 rounded-xl border border-[#275443] bg-[#0B241C] px-3 py-2.5 text-xs font-semibold hover:border-[#3DD189] hover:bg-[#173D30]";
type EdgeMenu={id:string;x:number;y:number}|null;
type AddMenu={source:string;port:string;position:XYPosition;x:number;y:number}|null;

function Editor(){
  const doc=useFlowStore(s=>s.doc),selectedId=useFlowStore(s=>s.selectedId);
  const store=useFlowStore.getState;
  const nodesChanged=useFlowStore(s=>s.nodesChanged),edgesChanged=useFlowStore(s=>s.edgesChanged);
  const selected=doc.nodes.find(n=>n.id===selectedId)||null;
  const [showSimulator,setShowSimulator]=useState(false),[trail,setTrail]=useState<string[]>([]);
  const [notice,setNotice]=useState(""),[search,setSearch]=useState(""),[edgeMenu,setEdgeMenu]=useState<EdgeMenu>(null),[addMenu,setAddMenu]=useState<AddMenu>(null);
  const [showAdd,setShowAdd]=useState(false);
  const input=useRef<HTMLInputElement>(null),clipboard=useRef<FlowNode|null>(null),reconnectOk=useRef(true),justReconnected=useRef(false);
  const instance=useReactFlow<FlowNode,FlowEdge>();
  const errors=useMemo(()=>validateDocument(doc),[doc]);

  useEffect(()=>{
    const timer=window.setTimeout(()=>{try{localStorage.setItem(SAVE_KEY,JSON.stringify(doc));}catch{setNotice("مساحة تخزين المتصفح غير كافية؛ استخدم تصدير لحفظ التدفق.");}},700);
    return()=>window.clearTimeout(timer);
  },[doc]);
  const addNode=(kind:Kind,point?:XYPosition,connectFrom?:{source:string;port:string})=>{
    if(doc.nodes.length>=100){setNotice("الحد الأقصى 100 خطوة.");return;}
    if(kind==="trigger"&&doc.nodes.some(n=>n.data.kind==="trigger")){setNotice("يوجد حدث بداية بالفعل.");return;}
    const pos=point||instance.screenToFlowPosition({x:Math.round(window.innerWidth*.48),y:Math.round(window.innerHeight*.45)});
    const node=makeNode(kind,pos);
    store().addNode(node);
    if(connectFrom)store().connect({source:connectFrom.source,sourceHandle:connectFrom.port,target:node.id,targetHandle:"in"});
    store().setSelected(node.id);
    setShowAdd(false);setAddMenu(null);
  };
  const exportFile=()=>{
    const blob=new Blob([JSON.stringify(doc,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob),anchor=document.createElement("a");
    anchor.href=url;anchor.download="social-flow-v3.json";anchor.click();URL.revokeObjectURL(url);
  };
  const importFile=async(file?:File)=>{
    if(!file)return;
    if(file.size>4*1024*1024){setNotice("الملف كبير جدًا؛ الحد الأقصى 4MB.");return;}
    try{
      const value:unknown=JSON.parse(await file.text()),parsed=importFlow(value);
      if(!parsed)throw Error("invalid");
      if(!window.confirm("استيراد التدفق سيستبدل التدفق المفتوح، ويمكنك التراجع. هل تريد المتابعة؟"))return;
      store().replace(parsed);setNotice("تم استيراد التدفق بنجاح.");
      window.setTimeout(()=>instance.fitView({padding:.24,duration:350}),60);
    }catch{setNotice("الملف غير صالح أو لا يتوافق مع صيغة المحرر.");}
  };
  const validConnection=useCallback((c:Connection|Edge)=>canConnect(c as Connection,useFlowStore.getState().doc),[]);
  const reconnect=useCallback((old:FlowEdge,c:Connection)=>{
    if(!canConnect(c,useFlowStore.getState().doc,old.id)){reconnectOk.current=false;return;}
    useFlowStore.getState().reconnect(old,c);reconnectOk.current=true;
  },[]);
  const onKeyboard=useCallback((e:KeyboardEvent)=>{
    const target=e.target as HTMLElement|null;
    if(target?.closest("input,textarea,select,[contenteditable='true']"))return;
    if(!(e.ctrlKey||e.metaKey))return;
    const key=e.key.toLowerCase(),s=useFlowStore.getState();
    if(key==="z"){e.preventDefault();if(e.shiftKey)s.redo();else s.undo();}
    if(key==="y"){e.preventDefault();s.redo();}
    if(key==="c"&&s.selectedId){const n=s.doc.nodes.find(n=>n.id===s.selectedId);if(n){e.preventDefault();clipboard.current=n;setNotice("تم نسخ العقدة.");}}
    if(key==="v"&&clipboard.current){e.preventDefault();const n=clipboard.current;const duplicated=makeNode(n.data.kind,{x:n.position.x+85,y:n.position.y+85},{...n.data,options:n.data.options.map(o=>({...o,id:crypto.randomUUID()}))});s.addNode(duplicated);setNotice("تم لصق العقدة.");}
    if(key==="d"&&s.selectedId){e.preventDefault();const n=s.doc.nodes.find(n=>n.id===s.selectedId);if(n)s.addNode(makeNode(n.data.kind,{x:n.position.x+85,y:n.position.y+85},{...n.data,options:n.data.options.map(o=>({...o,id:crypto.randomUUID()}))}));}
  },[]);
  useEffect(()=>{window.addEventListener("keydown",onKeyboard);return()=>window.removeEventListener("keydown",onKeyboard);},[onKeyboard]);
  const arrange=()=>{
    const root=doc.nodes.find(n=>n.data.kind==="trigger");if(!root)return;
    const dist=new Map<string,number>([[root.id,0]]),queue=[root.id];
    for(let i=0;i<queue.length;i++){
      const n=queue[i];for(const e of doc.edges.filter(e=>e.source===n)){
        if(!dist.has(e.target)){dist.set(e.target,(dist.get(n)||0)+1);queue.push(e.target);}
      }
    }
    const levels=new Map<number,FlowNode[]>();
    for(const n of doc.nodes){const depth=dist.get(n.id)??Math.max(0,...dist.values())+1;levels.set(depth,[...(levels.get(depth)||[]),n]);}
    store().replace({...doc,nodes:doc.nodes.map(n=>{
      const depth=dist.get(n.id)??Math.max(0,...dist.values())+1;
      const group=levels.get(depth)||[],idx=group.findIndex(x=>x.id===n.id);
      return {...n,position:{x:250+(idx-(group.length-1)/2)*375,y:depth*320}};
    })});
    window.setTimeout(()=>instance.fitView({padding:.2,duration:400}),60);
  };
  const deleteWithBridge=(id:string)=>{
    const n=doc.nodes.find(n=>n.id===id);
    if(n?.data.kind==="trigger"&&!window.confirm("سيصبح التدفق دون نقطة بداية. حذف؟"))return;
    store().deleteNode(id,true);setEdgeMenu(null);
  };
  const insertOnEdge=(id:string)=>{
    const old=doc.edges.find(e=>e.id===id);
    if(!old)return;
    const a=doc.nodes.find(n=>n.id===old.source),b=doc.nodes.find(n=>n.id===old.target);
    if(!a||!b)return;
    const fresh=makeNode("message",{x:(a.position.x+b.position.x)/2+50,y:(a.position.y+b.position.y)/2+80},{title:"خطوة جديدة",text:"اكتب رسالتك"});
    store().replace({...doc,nodes:[...doc.nodes,fresh],edges:[
      ...doc.edges.filter(e=>e.id!==id),
      {...old,id:crypto.randomUUID(),target:fresh.id,targetHandle:"in"},
      {id:crypto.randomUUID(),type:"flowEdge",source:fresh.id,sourceHandle:"next",target:old.target,targetHandle:old.targetHandle||"in",data:{label:"التالي"}}
    ]});
    setEdgeMenu(null);
  };
  const renderedNodes=useMemo(()=>doc.nodes.map(n=>({...n,className:trail.includes(n.id)?"flow-visited":""})),[doc.nodes,trail]);
  const renderedEdges=useMemo(()=>doc.edges.map(e=>({...e,animated:trail.includes(e.source)&&trail.includes(e.target)})),[doc.edges,trail]);

  return <div dir="rtl" className="flex h-[100dvh] flex-col bg-[#061A14] text-white" style={{fontFamily:"system-ui, sans-serif"}}>
    <header className="z-30 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#173D30] bg-[#0B241C] px-3 py-3 md:px-5">
      <div className="flex min-w-0 items-center gap-2"><a className={btn} href="#/dashboard" aria-label="الرجوع إلى لوحة التحكم"><ArrowRight size={17}/></a>
        <div className="min-w-0"><p className="text-[11px] text-[#8B9E96]">إدارة سوشيال / مصمم الأتمتة</p>
          <input className="max-w-36 bg-transparent text-sm font-bold outline-none md:max-w-64" aria-label="اسم التدفق" maxLength={100} value={doc.name} onChange={e=>store().rename(e.target.value)}/></div>
        <span className="hidden rounded-lg border border-[#E5B54B]/40 px-2 py-1 text-[11px] text-[#E5B54B] sm:block">مسودة</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button className={btn} onClick={()=>store().undo()} title="تراجع Ctrl+Z"><Undo2 size={16}/></button>
        <button className={btn} onClick={()=>store().redo()} title="إعادة Ctrl+Shift+Z"><Redo2 size={16}/></button>
        <button className={btn} onClick={arrange} title="ترتيب تلقائي"><LayoutGrid size={16}/></button>
        <button className={btn} onClick={()=>setShowSimulator(true)}><Play size={16}/> تجربة</button>
        <button className={btn} onClick={exportFile}><Download size={16}/> تصدير</button>
        <button className={btn} onClick={()=>input.current?.click()}><Upload size={16}/> استيراد</button>
        <input ref={input} className="hidden" type="file" accept=".json,application/json" onChange={e=>{void importFile(e.target.files?.[0]);e.target.value="";}}/>
        <button className="flex items-center gap-1 rounded-xl bg-[#3DD189] px-3 py-2.5 text-xs font-bold text-[#061A14]" onClick={()=>{try{localStorage.setItem(SAVE_KEY,JSON.stringify(doc));setNotice("حُفظت المسودة في متصفحك.");}catch{setNotice("تعذر الحفظ؛ استخدم التصدير.");}}}><Save size={16}/> حفظ</button>
      </div>
    </header>
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <aside className="hidden w-52 shrink-0 overflow-y-auto border-l border-[#173D30] bg-[#0B241C] p-3 lg:block">
        <h2 className="mb-2 font-semibold">مكتبة الخطوات</h2>
        <label className="mb-3 flex items-center gap-2 rounded-xl border border-[#275443] px-2"><Search size={15}/><input className="w-full bg-transparent p-2 text-xs outline-none" placeholder="البحث في الخطوات" value={search} onChange={e=>setSearch(e.target.value)}/></label>
        {KIND_LIST.filter(k=>LABELS[k].includes(search)).map(kind=><button className="mb-2 flex w-full items-center justify-between rounded-xl border border-[#275443] bg-[#0F2E24] p-3 text-right text-sm hover:border-[#3DD189]" key={kind} onClick={()=>addNode(kind)}><span style={{color:ACCENT[kind]}}>{LABELS[kind]}</span><Plus size={15}/></button>)}
        <p className="mt-5 text-xs leading-6 text-[#8B9E96]">اسحب الخط من الدائرة الملونة إلى الخطوة التالية. اضغط أي خط لاختيار نقله أو حذفه.</p>
        <div className="mt-5 rounded-xl border border-[#244A3A] bg-[#0F2E24] p-3 text-xs">
          <h3 className="mb-1 font-semibold">فحص التدفق</h3>
          {errors.length?errors.slice(0,8).map((e,i)=><p className="mt-1 text-[#E5B54B]" key={i}>• {e}</p>):<p className="flex gap-2 text-[#3DD189]"><CheckCircle2 size={15}/> لا توجد أخطاء بنيوية مكتشفة.</p>}
        </div>
      </aside>
      <section className="relative min-w-0 flex-1" aria-label="مساحة التدفقات" onClick={()=>{if(edgeMenu)setEdgeMenu(null);}}>
        <ReactFlow<FlowNode,FlowEdge>
          nodes={renderedNodes} edges={renderedEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={nodesChanged} onEdgesChange={edgesChanged}
          onNodeClick={(_,n)=>store().setSelected(n.id)}
          onPaneClick={()=>{store().setSelected(null);setEdgeMenu(null);}}
          onNodeDragStart={()=>store().pushHistory()}
          onConnect={c=>store().connect(c)}
          isValidConnection={validConnection}
          edgesReconnectable
          reconnectRadius={16}
          onReconnectStart={()=>{reconnectOk.current=false;justReconnected.current=true;}}
          onReconnect={reconnect}
          onReconnectEnd={(_,edge,__,connectionState)=>{
            if(!reconnectOk.current&&connectionState.toHandle===null)store().deleteEdge(edge.id);
            reconnectOk.current=true;
            window.setTimeout(()=>{justReconnected.current=false;},60);
          }}
          onBeforeDelete={async({nodes})=>nodes.some(n=>n.data.kind==="trigger")?window.confirm("حذف البداية سيجعل التدفق بلا Trigger. هل تريد المتابعة؟"):true}
          onEdgeContextMenu={(e,edge)=>{e.preventDefault();setEdgeMenu({id:edge.id,x:e.clientX,y:e.clientY});}}
          onConnectEnd={(e,state)=>{
            if(justReconnected.current||state.isValid||!state.fromNode||!state.fromHandle||state.toHandle)return;
            const event=e as MouseEvent; if(!("clientX" in event))return;
            const pos=instance.screenToFlowPosition({x:event.clientX,y:event.clientY});
            setAddMenu({source:state.fromNode.id,port:state.fromHandle.id||"next",position:pos,x:event.clientX,y:event.clientY});
          }}
          deleteKeyCode={["Delete","Backspace"]}
          defaultEdgeOptions={{type:"flowEdge",interactionWidth:24,markerEnd:{type:MarkerType.ArrowClosed,width:17,height:17,color:"#87A39A"}}}
          minZoom={.2} maxZoom={2} fitView fitViewOptions={{padding:.28,maxZoom:.8}}
          onInit={api=>{window.setTimeout(()=>{void api.fitView({padding:.18,maxZoom:.75,duration:200});},250);}}
          snapToGrid snapGrid={[20,20]}
          selectionOnDrag panOnDrag={[1,2]} multiSelectionKeyCode={["Shift","Control","Meta"]}
          colorMode="dark" connectionLineStyle={{stroke:"#3DD189",strokeWidth:2}}
          proOptions={{hideAttribution:true}}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#365849"/>
          <MiniMap nodeColor={n=>ACCENT[(n.data as FlowNode["data"]).kind]||"#3DD189"} className="!bg-[#0B241C] !border !border-[#275443]" maskColor="rgba(1,12,8,.65)" pannable zoomable />
          <Controls showInteractive={false} className="!bg-[#0B241C] !border !border-[#275443]"/>
        </ReactFlow>
        <div className="absolute right-3 top-3 z-10 flex gap-2 lg:hidden"><button className="rounded-xl bg-[#3DD189] px-3 py-2 text-xs font-bold text-[#061A14]" onClick={()=>setShowAdd(v=>!v)}><Plus size={15} className="inline"/> إضافة خطوة</button></div>
        {showAdd&&<div className="absolute right-3 top-14 z-20 grid max-h-72 grid-cols-2 gap-2 overflow-auto rounded-xl border border-[#275443] bg-[#0B241C] p-3 lg:hidden">{KIND_LIST.map(k=><button key={k} className={btn} onClick={()=>addNode(k)}>{LABELS[k]}</button>)}</div>}
        {edgeMenu&&<div className="fixed z-50 min-w-40 rounded-xl border border-[#275443] bg-[#0B241C] p-2 shadow-2xl" style={{left:Math.min(window.innerWidth-180,edgeMenu.x),top:Math.min(window.innerHeight-150,edgeMenu.y)}} onClick={e=>e.stopPropagation()}>
          <button className={btn+" mb-2 w-full"} onClick={()=>insertOnEdge(edgeMenu.id)}><Plus size={15}/> إدراج خطوة</button>
          <button className={btn+" w-full text-red-300"} onClick={()=>{store().deleteEdge(edgeMenu.id);setEdgeMenu(null);}}><Trash2 size={15}/> حذف الاتصال</button>
        </div>}
        {addMenu&&<div className="fixed z-50 rounded-xl border border-[#275443] bg-[#0B241C] p-3 shadow-xl" style={{left:Math.min(window.innerWidth-230,addMenu.x),top:Math.min(window.innerHeight-260,addMenu.y)}}><p className="mb-2 text-xs">اختر عقدة لإضافتها وربطها تلقائيًا</p>
          <div className="grid grid-cols-2 gap-1">{KIND_LIST.filter(k=>k!=="trigger").map(k=><button className={btn} key={k} onClick={()=>addNode(k,addMenu.position,{source:addMenu.source,port:addMenu.port})}>{LABELS[k]}</button>)}</div>
          <button className="mt-2 text-xs text-[#8B9E96]" onClick={()=>setAddMenu(null)}>إلغاء</button>
        </div>}
      </section>
      {selected&&<NodeEditor node={selected} onClose={()=>store().setSelected(null)}/>}
    </div>
    {notice&&<div role="status" className="fixed bottom-5 right-5 z-50 max-w-sm cursor-pointer rounded-xl border border-[#275443] bg-[#0B241C] px-4 py-3 text-xs text-[#3DD189] shadow-2xl" onClick={()=>setNotice("")}>{notice} ×</div>}
    <div className="pointer-events-none absolute bottom-1 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-[#0B241C]/80 px-2 py-1 text-[10px] text-[#8B9E96]">معاينة محلية فقط — إرسال الرسائل وإجراءات API غير مفعّلة</div>
    {showSimulator&&<FlowSimulator doc={doc} onVisited={setTrail} onClose={()=>setShowSimulator(false)}/>}
  </div>;
}
export default function FlowBuilder(){
  return <ReactFlowProvider><Editor/></ReactFlowProvider>;
}
