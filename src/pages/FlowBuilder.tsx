import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, MarkerType,
  useReactFlow,
} from "@xyflow/react";
import type { Connection, Edge, XYPosition } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowRight, Plus, Play, Save, Upload, Download, Undo2, Redo2, LayoutGrid, Trash2, AlertTriangle, CheckCircle2, X, Copy, ChevronUp, ChevronDown } from "lucide-react";
import AutomationNode from "../flow/AutomationNode";
import AutomationEdge from "../flow/AutomationEdge";
import NodeEditor from "../flow/NodeEditor";
import FlowSimulator from "../flow/FlowSimulator";
import { ACCENT, KIND_LIST, LABELS, SAVE_KEY, canConnect, edgeFor, importFlow, makeNode, outputs, validateDocument } from "../flow/model";
import { arrangeFlow, cardSize, findOpenPosition } from "../flow/layout";
import { useAddStepMenu } from "../flow/addMenu";
import type { FlowNode, FlowEdge, Kind } from "../flow/model";
import { useFlowStore } from "../flow/store";
import { getLibraryRecoveryReport, saveLibrary, snapshotLibrary } from "../flow/library";
import { flowText, flowKindLabel } from "../flow/uiLocale";
import type { FlowLanguage } from "../flow/uiLocale";

const nodeTypes={flowNode:AutomationNode};
const edgeTypes={flowEdge:AutomationEdge};
const btn="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[#275443] bg-[#0B241C] px-3 py-2.5 text-xs font-semibold hover:border-[#3DD189] hover:bg-[#173D30]";
type EdgeMenu={id:string;x:number;y:number}|null;

function Editor(){
  const doc=useFlowStore(s=>s.doc),selectedId=useFlowStore(s=>s.selectedId);
  const activeFlowId=useFlowStore(s=>s.activeFlowId),flows=useFlowStore(s=>s.flows);
  const activeEnabled=flows.find(flow=>flow.id===activeFlowId)?.enabled===true;
  const store=useFlowStore.getState;
  const nodesChanged=useFlowStore(s=>s.nodesChanged),edgesChanged=useFlowStore(s=>s.edgesChanged);
  const selected=doc.nodes.find(n=>n.id===selectedId)||null;
  const [showSimulator,setShowSimulator]=useState(false),[trail,setTrail]=useState<string[]>([]);
  const [toolbarCollapsed,setToolbarCollapsed]=useState(false);
  const [language,setLanguage]=useState<FlowLanguage>("ar");
  const t=(key:Parameters<typeof flowText>[0])=>flowText(key,language);
  const [isCompact,setIsCompact]=useState(()=>typeof window!=="undefined"&&window.innerWidth<768);
  useEffect(()=>{const media=window.matchMedia("(max-width: 767px)");const update=()=>setIsCompact(media.matches);update();media.addEventListener("change",update);return()=>media.removeEventListener("change",update);},[]);
  const [notice,setNotice]=useState(""),[edgeMenu,setEdgeMenu]=useState<EdgeMenu>(null),[showIssues,setShowIssues]=useState(false);
  const addRequest=useAddStepMenu(s=>s.request),openAdd=useAddStepMenu(s=>s.open),closeAdd=useAddStepMenu(s=>s.close);
  const input=useRef<HTMLInputElement>(null),clipboard=useRef<FlowNode|null>(null),reconnectOk=useRef(true),justReconnected=useRef(false);
  const instance=useReactFlow<FlowNode,FlowEdge>();
  const issues=useMemo(()=>validateDocument(doc,flows),[doc,flows]);
  const errors=useMemo(()=>issues.filter(issue=>issue.severity==="error"),[issues]);
  const warnings=useMemo(()=>issues.filter(issue=>issue.severity==="warning"),[issues]);
  const recovery=useMemo(()=>getLibraryRecoveryReport(),[]);
  const [protectStoredLibrary,setProtectStoredLibrary]=useState(recovery.messages.length>0);

  useEffect(()=>{
    const timer=window.setTimeout(()=>{if(protectStoredLibrary)return;try{localStorage.setItem(SAVE_KEY,JSON.stringify(doc));saveLibrary(snapshotLibrary(activeFlowId,doc,flows));}catch{setNotice("مساحة تخزين المتصفح غير كافية؛ استخدم تصدير لحفظ التدفق.");}},700);
    return()=>window.clearTimeout(timer);
  },[doc,activeFlowId,flows,protectStoredLibrary]);
  const addNode=(kind:Kind,point?:XYPosition,connectFrom?:{source:string;port:string})=>{
    const current=useFlowStore.getState().doc;
    if(current.nodes.length>=100){setNotice("الحد الأقصى 100 خطوة.");return;}
    if(kind==="trigger"&&current.nodes.some(n=>n.data.kind==="trigger")){setNotice("توجد بداية واحدة بالفعل.");return;}
    const source=connectFrom?current.nodes.find(n=>n.id===connectFrom.source):null;
    const pos=point||(source
      ? {x:source.position.x,y:source.position.y+cardSize(source).height+150}
      :instance.screenToFlowPosition({x:Math.round(window.innerWidth*.48),y:Math.round(window.innerHeight*.5)}));
    const candidateNode=makeNode(kind,pos);
    const node={...candidateNode,position:findOpenPosition(current.nodes,candidateNode,pos)};
    if(source&&connectFrom){
      const c:Connection={source:source.id,sourceHandle:connectFrom.port,target:node.id,targetHandle:"in"};
      const candidate={...current,nodes:[...current.nodes,node]};
      if(canConnect(c,candidate)){
        const previous=candidate.edges.find(e=>e.source===source.id&&e.sourceHandle===connectFrom.port);
        const nextPort=outputs(node).find(p=>p.id==="next");
        if(previous&&!nextPort){
          // Never silently orphan a previously connected step.
          store().addNode(node);
          setNotice("المخرج مرتبط بخطوة أخرى؛ أُضيفت العقدة منفصلة حفاظًا على الاتصال القديم. يمكنك إعادة توصيلها.");
        }else{
          const label=outputs(source).find(p=>p.id===connectFrom.port)?.label||"";
          const edges=[...candidate.edges.filter(e=>e.source!==source.id||e.sourceHandle!==connectFrom.port),edgeFor(c,label)];
          if(previous&&nextPort){
            edges.push(edgeFor({source:node.id,sourceHandle:nextPort.id,target:previous.target,targetHandle:previous.targetHandle||"in"},nextPort.label));
          }
          store().replace(arrangeFlow({...candidate,edges}));
          window.setTimeout(()=>instance.fitView({padding:.20,maxZoom:1,duration:300}),80);
        }
      }else{store().addNode(node);setNotice("أُضيفت الخطوة، لكن هذا الاتصال غير مسموح.");}
    }else{store().addNode(node);}
    store().setSelected(node.id);
    closeAdd();
  };
  useEffect(()=>{
    // Arrange each flow independently, preserving user data and retaining the original positions in undo history.
    try{
      const key="social_flow_dagre_arranged_v2_"+activeFlowId;
      if(!localStorage.getItem(key)){
        store().replace(arrangeFlow(store().doc));
        localStorage.setItem(key,"1");
        window.setTimeout(()=>instance.fitView({padding:.20,maxZoom:.85,duration:0}),350);
      }
    }catch{/* Browser may disable localStorage; manual layout stays available. */}
  },[activeFlowId,instance]);
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
    if(key==="v"&&clipboard.current){e.preventDefault();const n=clipboard.current;const draft=makeNode(n.data.kind,{x:n.position.x+cardSize(n).width+85,y:n.position.y+85},{...n.data,options:n.data.options.map(o=>({...o,id:crypto.randomUUID()}))});
      s.addNode({...draft,position:findOpenPosition(s.doc.nodes,draft,draft.position)});setNotice("تم لصق العقدة.");}
    if(key==="d"&&s.selectedId){e.preventDefault();const n=s.doc.nodes.find(n=>n.id===s.selectedId);if(n){const draft=makeNode(n.data.kind,{x:n.position.x+cardSize(n).width+85,y:n.position.y+85},{...n.data,options:n.data.options.map(o=>({...o,id:crypto.randomUUID()}))});
      s.addNode({...draft,position:findOpenPosition(s.doc.nodes,draft,draft.position)});}}
  },[]);
  useEffect(()=>{window.addEventListener("keydown",onKeyboard);return()=>window.removeEventListener("keydown",onKeyboard);},[onKeyboard]);
  const arrange=()=>{
    store().replace(arrangeFlow(useFlowStore.getState().doc));
    window.setTimeout(()=>instance.fitView({padding:.22,maxZoom:1,duration:350}),75);
    setNotice("تم ترتيب التدفق هرميًا، مع الحفاظ على جميع محتوياته.");
  };
  const insertOnEdge=(id:string)=>{
    const old=doc.edges.find(e=>e.id===id);
    if(!old)return;
    const a=doc.nodes.find(n=>n.id===old.source),b=doc.nodes.find(n=>n.id===old.target);
    if(!a||!b)return;
    const preferred={x:(a.position.x+b.position.x)/2+50,y:(a.position.y+b.position.y)/2+80};
    const draft=makeNode("message",preferred,{title:"خطوة جديدة",text:"اكتب رسالتك"});
    const fresh={...draft,position:findOpenPosition(doc.nodes,draft,preferred)};
    store().replace({...doc,nodes:[...doc.nodes,fresh],edges:[
      ...doc.edges.filter(e=>e.id!==id),
      {...old,id:crypto.randomUUID(),target:fresh.id,targetHandle:"in"},
      {id:crypto.randomUUID(),type:"flowEdge",source:fresh.id,sourceHandle:"next",target:old.target,targetHandle:old.targetHandle||"in",data:{label:"التالي"}}
    ]});
    setEdgeMenu(null);
  };
  const renderedNodes=useMemo(()=>doc.nodes.map(n=>({...n,className:trail.includes(n.id)?"flow-visited":""})),[doc.nodes,trail]);
  const renderedEdges=useMemo(()=>doc.edges.map(e=>({...e,animated:trail.includes(e.source)&&trail.includes(e.target)})),[doc.edges,trail]);

  return <div dir={language==="ar"?"rtl":"ltr"} className="flex h-[100dvh] flex-col bg-[#061A14] text-white" style={{fontFamily:"system-ui, sans-serif"}}>
    <header className="z-30 flex shrink-0 flex-col gap-2 border-b border-[#173D30] bg-[#0B241C] px-2 py-2 md:flex-row md:flex-wrap md:items-center md:justify-between md:px-5">
      <div className="flex min-w-0 w-full items-center gap-2 md:w-auto"><a className={btn} href="#/dashboard" aria-label={t("back")}><ArrowRight size={17}/></a>
        <div className="min-w-0"><p className="text-[11px] text-[#8B9E96]">{t("designer")}</p>
          <input className="max-w-36 bg-transparent text-sm font-bold outline-none md:max-w-64" aria-label={t("name")} maxLength={100} value={doc.name} onChange={e=>store().rename(e.target.value)}/></div>
        <span className="hidden rounded-lg border border-[#E5B54B]/40 px-2 py-1 text-[11px] text-[#E5B54B] sm:block">{t("draft")}</span>
        {<span data-testid="flow-preview-version" className="rounded-lg border border-[#3DD189]/60 bg-[#173D30] px-2 py-1 text-[11px] text-[#3DD189]">معاينة 5.3 — سؤال بخانة واحدة</span>}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-1 md:flex-none md:overflow-visible" data-testid="flow-toolbar-actions">
          <select className="max-w-36 rounded-lg border border-[#275443] bg-[#0F2E24] px-2 py-2 text-xs text-white md:max-w-52" aria-label={t("select")} value={activeFlowId} onChange={e=>{
            store().switchFlow(e.target.value);closeAdd();setNotice("تم فتح التدفق المحدد.");
            window.setTimeout(()=>instance.fitView({padding:.2,duration:200}),90);
          }}>
            {flows.map(f=><option key={f.id} value={f.id}>{f.id===activeFlowId?doc.name:f.doc.name}</option>)}
          </select>
          <button className={btn} title={t("create")} aria-label={t("create")} onClick={()=>{
            if(flows.length>=30){setNotice("الحد الأقصى 30 تدفقًا محليًا.");return;}
            const created=store().createFlow();if(!created){setNotice("تعذّر إنشاء التدفق: وصلت إلى الحد الأقصى (30).");return;}
            closeAdd();setNotice("أُنشئ تدفق جديد. اربط الأزرار من لوحة الخطوة.");
            window.setTimeout(()=>instance.fitView({padding:.25}),120);
          }}><Plus size={16}/></button>
          <button className={btn} title={t("blank")} aria-label={t("blank")} onClick={()=>{
            if(flows.length>=30){setNotice("الحد الأقصى 30 تدفقًا محليًا.");return;}
            const created=store().createFlow("تدفق فارغ "+(flows.length+1),true);
            if(!created){setNotice("تعذّر إنشاء التدفق: وصلت إلى الحد الأقصى (30).");return;}
            closeAdd();setNotice("تم إنشاء تدفق فارغ يحتوي على نقطة البداية فقط. التدفق القديم محفوظ.");
            window.setTimeout(()=>instance.fitView({padding:.25}),120);
          }}><LayoutGrid size={16}/> <span className="hidden sm:inline">{t("blank")}</span></button>
          <button className={btn} title={t("duplicate")} aria-label={t("duplicate")} onClick={()=>{store().duplicateFlow();setNotice("تم إنشاء نسخة مستقلة من التدفق.");}}><Copy size={15}/></button>
          <button className={btn+" text-red-300"} disabled={flows.length<2} title={t("delete")} aria-label={t("delete")} onClick={()=>{
            if(!window.confirm("سيُحذف هذا التدفق المحلي. قد تكون أزرار في تدفقات أخرى مرتبطة به. هل تريد المتابعة؟"))return;
            store().deleteFlow(activeFlowId);setNotice("حُذف التدفق المحلي.");
          }}><Trash2 size={15}/></button>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 md:justify-start">
        <label className="sr-only" htmlFor="flow-ui-language">{t("language")}</label>
        <select id="flow-ui-language" data-testid="flow-ui-language" dir="ltr" aria-label={t("language")}
          className="min-h-11 rounded-xl border border-[#275443] bg-[#0F2E24] px-2 text-xs text-white"
          value={language} onChange={e=>setLanguage(e.target.value as FlowLanguage)}>
          <option value="ar">العربية</option><option value="en">English</option>
        </select>
      <button type="button" className={btn+" self-end md:self-auto"} aria-label={toolbarCollapsed?t("expand"):t("collapse")} aria-expanded={!toolbarCollapsed} onClick={()=>setToolbarCollapsed(v=>!v)}>
        {toolbarCollapsed?<ChevronDown size={16}/>:<ChevronUp size={16}/>} <span className="hidden sm:inline">{toolbarCollapsed?t("showTools"):t("hideTools")}</span>
      </button>
      </div>
      {!toolbarCollapsed&&<div className="flex w-full items-center gap-1.5 overflow-x-auto whitespace-nowrap pb-1 md:w-auto md:flex-wrap md:overflow-visible" data-testid="flow-toolbar-secondary">
        <button data-testid="flow-enabled-toggle" type="button" aria-label={t("activate")} aria-pressed={activeEnabled}
          className={"inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold "+(activeEnabled?"border-[#3DD189] bg-[#173D30] text-[#3DD189]":"border-[#275443] bg-[#0F2E24] text-[#C1D2CA]")}
          onClick={()=>{
            if(!activeEnabled&&errors.length>0){setShowIssues(true);setNotice("راجع الأخطاء قبل تفعيل المسودة.");return;}
            store().setFlowEnabled(activeFlowId,!activeEnabled);
            setNotice(!activeEnabled?"تم تفعيل المسودة محليًا فقط. لم تُفعّل الأتمتة على الحساب المرتبط.":"تم تعطيل المسودة محليًا.");
          }}>
          <span className={"relative inline-flex h-4 w-8 shrink-0 rounded-full "+(activeEnabled?"bg-[#3DD189]":"bg-[#60766B]")}>
            <span className={"absolute top-0.5 h-3 w-3 rounded-full bg-[#061A14] transition-transform "+(activeEnabled?"translate-x-0.5":"translate-x-[18px]")}/>
          </span>
          {activeEnabled?t("enabled"):t("disabled")}
        </button>
        <button className={btn} onClick={()=>store().undo()} title={t("undo")}><Undo2 size={16}/></button>
        <button className={btn} onClick={()=>store().redo()} title={t("redo")}><Redo2 size={16}/></button>
        <button className={btn} onClick={e=>openAdd({x:e.clientX,y:e.clientY})} title={t("addStep")}><Plus size={16}/> <span className="hidden sm:inline">{t("addShort")}</span></button>
        <button className={btn} onClick={arrange} title={t("arrange")}><LayoutGrid size={16}/><span className="hidden md:inline">{t("arrangeShort")}</span></button>
        <button className={btn} onClick={()=>setShowIssues(v=>!v)} title={t("check")}>
          {errors.length?<AlertTriangle size={16} className="text-[#E5B54B]"/>:<CheckCircle2 size={16} className="text-[#3DD189]"/>}
          <span className="hidden md:inline">{t("checkShort")}</span><span>{errors.length}</span><span className="text-[#E5B54B]">⚠ {warnings.length}</span>
        </button>
        <button className={btn} onClick={()=>setShowSimulator(true)}><Play size={16}/> {t("preview")}</button>
        <button className={btn} onClick={exportFile}><Download size={16}/> {t("export")}</button>
        <button className={btn} onClick={()=>input.current?.click()}><Upload size={16}/> {t("import")}</button>
        <input ref={input} className="hidden" type="file" accept=".json,application/json" onChange={e=>{void importFile(e.target.files?.[0]);e.target.value="";}}/>
        <button className="flex items-center gap-1 rounded-xl bg-[#3DD189] px-3 py-2.5 text-xs font-bold text-[#061A14]" onClick={()=>{
          if(protectStoredLibrary&&!window.confirm("المكتبة المحلية تحتوي بيانات تالفـة أو غير قابلة للاسترجاع. الحفظ الآن سيستبدل الأصل؛ يُنصح بأخذ نسخة احتياطية أولًا. هل تريد المتابعة؟"))return;
          try{
            localStorage.setItem(SAVE_KEY,JSON.stringify(doc));
            saveLibrary(snapshotLibrary(activeFlowId,doc,flows));
            setProtectStoredLibrary(false);setNotice("حُفظت المسودة ومكتبة التدفقات في متصفحك.");
          }catch{setNotice("تعذر الحفظ؛ استخدم التصدير.");}
        }}><Save size={16}/> {t("save")}</button>
      </div>}
    </header>
    {recovery.messages.length>0&&<div role="alert" className="border-b border-[#E5B54B] bg-[#2C2414] px-4 py-3 text-xs text-[#F9E3A2]">
      <strong>تقرير استعادة التدفقات: </strong>{recovery.messages.join(" ")} تم استرجاع {recovery.recovered} وتجاهل {recovery.skipped}.
      {protectStoredLibrary&&<span className="mr-2 font-bold">الحفظ التلقائي متوقف لحماية بيانات المكتبة الأصلية؛ استخدم «تصدير» قبل تأكيد الحفظ اليدوي.</span>}
    </div>}
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <section className="relative min-w-0 flex-1" aria-label="مساحة التدفقات" data-touch-pan={isCompact} onClick={()=>{if(edgeMenu)setEdgeMenu(null);}}>
        <ReactFlow<FlowNode,FlowEdge>
          nodes={renderedNodes} edges={renderedEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={nodesChanged} onEdgesChange={edgesChanged}
          onNodeClick={(_,n)=>store().setSelected(n.id)}
          onPaneClick={()=>{store().setSelected(null);setEdgeMenu(null);closeAdd();setShowIssues(false);}}
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
          onBeforeDelete={async({nodes,edges})=>{
             if(nodes.some(n=>n.data.kind==="trigger")&&!window.confirm("حذف البداية سيجعل التدفق بلا Trigger. هل تريد المتابعة؟"))return false;
             const deletedNodes=new Set(nodes.map(n=>n.id)),deletedEdges=new Set(edges.map(e=>e.id));
             const state=useFlowStore.getState(),current=state.doc;
             const nextNodes=current.nodes.filter(n=>!deletedNodes.has(n.id));
             const nextEdges=current.edges.filter(e=>!deletedEdges.has(e.id)&&!deletedNodes.has(e.source)&&!deletedNodes.has(e.target));
             if(nextNodes.length!==current.nodes.length||nextEdges.length!==current.edges.length)
               state.replace({...current,nodes:nextNodes,edges:nextEdges});
             // React Flow's separate node/edge remove events would create two undo entries.
             // We applied the complete deletion atomically and cancel the default change events.
             return false;
           }}
          onEdgeContextMenu={(e,edge)=>{e.preventDefault();setEdgeMenu({id:edge.id,x:e.clientX,y:e.clientY});}}
          onConnectEnd={(e,state)=>{
            if(justReconnected.current||state.isValid||!state.fromNode||!state.fromHandle||state.toHandle)return;
            if(!("clientX" in e))return;
            const pos=instance.screenToFlowPosition({x:e.clientX,y:e.clientY});
            openAdd({source:state.fromNode.id,port:state.fromHandle.id||"next",position:pos,x:e.clientX,y:e.clientY});
          }}
          deleteKeyCode={["Delete","Backspace"]}
          defaultEdgeOptions={{type:"flowEdge",interactionWidth:24,markerEnd:{type:MarkerType.ArrowClosed,width:17,height:17,color:"#87A39A"}}}
          minZoom={.2} maxZoom={2} fitView fitViewOptions={{padding:.28,maxZoom:.8}}
          onInit={api=>{window.setTimeout(()=>{void api.fitView({padding:.20,maxZoom:.85,duration:0});},470);}}
          snapToGrid snapGrid={[20,20]}
          selectionOnDrag={!isCompact} panOnDrag={isCompact?true:[1,2]} multiSelectionKeyCode={["Shift","Control","Meta"]}
          colorMode="dark" connectionLineStyle={{stroke:"#3DD189",strokeWidth:2}}
          proOptions={{hideAttribution:true}}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#365849"/>
          <MiniMap nodeColor={n=>ACCENT[(n.data as FlowNode["data"]).kind]||"#3DD189"} className="!hidden md:!block !bg-[#0B241C] !border !border-[#275443]" maskColor="rgba(1,12,8,.65)" pannable zoomable />
          <Controls showInteractive={false} className="!bg-[#0B241C] !border !border-[#275443] !bottom-10 md:!bottom-3"/>
        </ReactFlow>

        <button className="nodrag absolute right-4 top-4 z-20 flex h-12 w-12 items-center justify-center rounded-full border border-[#9BF0BD] bg-[#3DD189] text-[#061A14] shadow-[0_8px_25px_rgba(17,110,64,.4)] transition-transform hover:scale-105" title={t("addStep")} aria-label={t("openAdd")} onClick={e=>openAdd({x:e.clientX,y:e.clientY})}><Plus size={25}/></button>
        {showIssues&&<div className="absolute left-3 top-3 z-20 w-[min(340px,90vw)] rounded-2xl border border-[#275443] bg-[#0B241C] p-4 shadow-xl">
          <div className="flex items-center justify-between gap-2"><h3 className="font-bold">{t("flowIssues")}</h3><button onClick={()=>setShowIssues(false)} aria-label={language==="ar"?"إغلاق الفحص":"Close validation"}><X size={18}/></button></div>
          {issues.length?<div className="mt-3 max-h-52 space-y-2 overflow-y-auto text-xs">{issues.slice(0,30).map((issue,i)=><button key={i} type="button" className={"block w-full rounded-md px-2 py-1 text-right hover:bg-[#173D30] "+(issue.severity==="warning"?"text-[#E5B54B]":"text-red-300")} onClick={()=>{
              if(issue.nodeId){
                const node=doc.nodes.find(n=>n.id===issue.nodeId);
                if(node){store().setSelected(node.id);void instance.setCenter(node.position.x+140,node.position.y+90,{zoom:1,duration:350});}
              }
              setShowIssues(false);
            }}>{issue.severity==="warning"?"⚠ تحذير: ":"● خطأ: "}{issue.message}{issue.nodeId?" (انتقل إلى العقدة)":""}</button>)}</div>:<p className="mt-3 flex items-center gap-2 text-sm text-[#3DD189]"><CheckCircle2 size={18}/> لا توجد أخطاء بنيوية مكتشفة.</p>}
        </div>}
        {edgeMenu&&<div className="fixed z-50 min-w-40 rounded-xl border border-[#275443] bg-[#0B241C] p-2 shadow-2xl" style={{left:Math.min(window.innerWidth-180,edgeMenu.x),top:Math.min(window.innerHeight-150,edgeMenu.y)}} onClick={e=>e.stopPropagation()}>
          <button className={btn+" mb-2 w-full"} onClick={()=>insertOnEdge(edgeMenu.id)}><Plus size={15}/> إدراج خطوة</button>
          <button className={btn+" w-full text-red-300"} onClick={()=>{store().deleteEdge(edgeMenu.id);setEdgeMenu(null);}}><Trash2 size={15}/> حذف الاتصال</button>
        </div>}

        {addRequest&&<div role="dialog" aria-label="إضافة خطوة" data-testid="add-step-menu"
          className="fixed z-50 w-[min(285px,90vw)] max-h-[min(440px,75vh)] overflow-y-auto rounded-2xl border border-[#2C6448] bg-[#0B241C] p-3 text-white shadow-[0_15px_60px_rgba(0,0,0,.45)]"
          style={{left:Math.max(8,Math.min(window.innerWidth-300,addRequest.x-24)),top:Math.max(55,Math.min(window.innerHeight-355,addRequest.y+8))}}
          onClick={e=>e.stopPropagation()}>
          <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-sm font-bold">{addRequest.source?t("addAfter"):t("addNew")}</h3>
            <button className="rounded-lg p-1 hover:bg-[#173D30]" aria-label={t("menuClose")} onClick={closeAdd}><X size={17}/></button></div>
          {addRequest.source&&!addRequest.port?
            <><p className="mb-2 text-xs text-[#8B9E96]">اختر أي فرع تريد توصيل الخطوة الجديدة به:</p>
              <div className="space-y-1.5">{outputs(doc.nodes.find(n=>n.id===addRequest.source)!).map(port=>
                <button key={port.id} className={btn+" w-full justify-between"} onClick={()=>openAdd({...addRequest,port:port.id})}>{port.label}<ArrowRight size={15}/></button>)}</div></>:
            <div className="grid grid-cols-2 gap-2">
              {KIND_LIST.filter(k=>k!=="trigger"||(!addRequest.source&&!doc.nodes.some(n=>n.data.kind==="trigger"))).map(kind=>
                <button key={kind} className="flex min-h-12 items-center justify-between gap-1 rounded-xl border border-[#275443] bg-[#0F2E24] px-2.5 py-2 text-right text-xs hover:border-[#3DD189] hover:bg-[#173D30]"
                  onClick={()=>addNode(kind,addRequest.position,addRequest.source&&addRequest.port?{source:addRequest.source,port:addRequest.port}:undefined)}>
                  <span>{flowKindLabel(kind,language,LABELS[kind])}</span><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{backgroundColor:ACCENT[kind]}}/>
                </button>)}
            </div>}
          <p className="mt-3 text-[11px] leading-5 text-[#8B9E96]">بعد الإضافة يمكنك تحريك العقدة بحرية وإعادة ترتيب المخطط.</p>
        </div>}
      </section>
      {selected&&<NodeEditor node={selected} language={language} onClose={()=>store().setSelected(null)}/>}
    </div>
    {notice&&<div role="status" className="fixed bottom-5 right-5 z-50 max-w-sm cursor-pointer rounded-xl border border-[#275443] bg-[#0B241C] px-4 py-3 text-xs text-[#3DD189] shadow-2xl" onClick={()=>setNotice("")}>{notice} ×</div>}
    <div className="pointer-events-none absolute bottom-1 left-1/2 z-10 hidden -translate-x-1/2 rounded-lg bg-[#0B241C]/80 px-2 py-1 text-[10px] text-[#8B9E96] sm:block">{t("localOnly")}</div>
    {showSimulator&&<FlowSimulator language={language} doc={doc} flowId={activeFlowId} flows={snapshotLibrary(activeFlowId,doc,flows).flows} onVisited={setTrail} onClose={()=>setShowSimulator(false)}/>}
  </div>;
}
export default function FlowBuilder(){
  return <ReactFlowProvider><Editor/></ReactFlowProvider>;
}
