import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, MarkerType,
  useReactFlow,
} from "@xyflow/react";
import type { Connection, Edge, XYPosition } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "../flow/flowSkin.css";
import { ArrowRight, Plus, Play, Save, Upload, Download, Undo2, Redo2, LayoutGrid, Trash2, AlertTriangle, CheckCircle2, X, Copy, ChevronUp, ChevronDown, Send } from "lucide-react";
import AutomationNode from "../flow/AutomationNode";
import AutomationEdge from "../flow/AutomationEdge";
import NodeEditor from "../flow/NodeEditor";
import FlowSimulator from "../flow/FlowSimulator";
import CloudDraftPanel from "../flow/CloudDraftPanel";
import FlowPublicationPanel from "../flow/FlowPublicationPanel";
import FlowSwitcher from "../flow/FlowSwitcher";
import WorkspaceTools from "../flow/WorkspaceTools";
import { FlowIssuesContext, SKIN_COLOR, SKIN_ICON, skinHint } from "../flow/skin";
import type { NodeIssueSummary } from "../flow/skin";
import { SHEET_HALF } from "../flow/useBottomSheet";
import { KIND_LIST, LABELS, SAVE_KEY, canConnect, edgeFor, importFlow, makeNode, outputs, validateDocument } from "../flow/model";
import { arrangeFlow, cardSize, findOpenPosition } from "../flow/layout";
import { useAddStepMenu } from "../flow/addMenu";
import type { FlowNode, FlowEdge, Kind, FlowDocument, FlowData } from "../flow/model";

/* The Action node covers AI / tag / notify / handoff. These palette shortcuts create an Action node
   already set to that type (no new node kind, no model change), so the logic steps are listed by name. */
const ACTION_PRESETS:Array<{id:string;ar:string;en:string;hintAr:string;hintEn:string;preset:Partial<FlowData>}>=[
  {id:"ai",ar:"خطوة ذكاء اصطناعي",en:"AI step",hintAr:"معاينة فقط حاليًا",hintEn:"Preview only for now",preset:{actionType:"ai"}},
  {id:"tag",ar:"وسم العميل",en:"Tag customer",hintAr:"إجراء داخلي",hintEn:"Internal action",preset:{actionType:"tag"}},
  {id:"notify",ar:"إشعار الفريق",en:"Notify team",hintAr:"إجراء داخلي",hintEn:"Internal action",preset:{actionType:"notify"}},
  {id:"handoff",ar:"تحويل إلى موظف",en:"Hand off to agent",hintAr:"إجراء داخلي",hintEn:"Internal action",preset:{actionType:"handoff"}},
];
import { useFlowStore } from "../flow/store";
import { getLibraryRecoveryReport, saveLibrary, snapshotLibrary } from "../flow/library";
import { flowText, flowKindLabel } from "../flow/uiLocale";
import type { FlowLanguage } from "../flow/uiLocale";
import { uuid } from "../lib/uuid.ts";

// لا تعرض أدوات الحفظ السحابي في الإنتاج قبل تجهيز الجدول والموافقة على النشر.
const CLOUD_DRAFT_UI_ENABLED=(import.meta as ImportMeta & {env?:Record<string,string|undefined>}).env?.VITE_ENABLE_CLOUD_FLOW_DRAFTS==="true";
// Publishing revisions is safe to expose: the API never activates messaging on publish.
// Keep the runtime activation controls independently disabled until the server is verified.
const PUBLICATION_UI_ENABLED=(import.meta as ImportMeta & {env?:Record<string,string|undefined>}).env?.VITE_ENABLE_FLOW_PUBLICATION_PREVIEW!=="false";
const nodeTypes={flowNode:AutomationNode};
const edgeTypes={flowEdge:AutomationEdge};
const btn="fs-btn fs-btn-ghost";
type EdgeMenu={id:string;x:number;y:number}|null;

function Editor(){
  const doc=useFlowStore(s=>s.doc),selectedId=useFlowStore(s=>s.selectedId);
  const activeFlowId=useFlowStore(s=>s.activeFlowId),flows=useFlowStore(s=>s.flows);
  const activeEnabled=flows.find(flow=>flow.id===activeFlowId)?.enabled===true;
  const store=useFlowStore.getState;
  const nodesChanged=useFlowStore(s=>s.nodesChanged),edgesChanged=useFlowStore(s=>s.edgesChanged);
  const selected=doc.nodes.find(n=>n.id===selectedId)||null;
  const [showSimulator,setShowSimulator]=useState(false),[trail,setTrail]=useState<string[]>([]);
  const [publishedPreview,setPublishedPreview]=useState<FlowDocument|null>(null);
  const [showCloudDrafts,setShowCloudDrafts]=useState(false);
  const [showPublications,setShowPublications]=useState(false);
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
  const addNode=(kind:Kind,point?:XYPosition,connectFrom?:{source:string;port:string},preset?:Partial<FlowData>)=>{
    const current=useFlowStore.getState().doc;
    if(current.nodes.length>=100){setNotice("الحد الأقصى 100 خطوة.");return;}
    if(kind==="trigger"&&current.nodes.some(n=>n.data.kind==="trigger")){setNotice("توجد بداية واحدة بالفعل.");return;}
    const source=connectFrom?current.nodes.find(n=>n.id===connectFrom.source):null;
    const pos=point||(source
      ? {x:source.position.x,y:source.position.y+cardSize(source).height+150}
      :instance.screenToFlowPosition({x:Math.round(window.innerWidth*.48),y:Math.round(window.innerHeight*.5)}));
    const candidateNode=makeNode(kind,pos,preset);
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
  // Previewing an immutable version never calls createFlow/replace/saveLibrary,
  // nor any production activate, deactivate or publish endpoint.
  const previewPublishedRevision=(raw:unknown):boolean=>{
    const parsed=importFlow(raw);
    if(!parsed)return false;
    setPublishedPreview(parsed);
    setShowSimulator(true);
    return true;
  };
  const importPublishedRevision=(raw:unknown):boolean=>{
    if(protectStoredLibrary){
      setNotice("الحفظ المحلي متوقف لحماية بيانات المكتبة. صدّر نسخة احتياطية وأصلح بيانات التخزين قبل الاستيراد.");
      return false;
    }
    const parsed=importFlow(raw);
    if(!parsed)return false;
    const newId=store().createFlow(parsed.name,true);
    if(!newId){setNotice("وصلت إلى الحد الأقصى للتدفقات المحلية (30).");return false;}
    store().replace(parsed);
    setNotice("تم استيراد الإصدار المنشور كنسخة محلية جديدة دون تغيير التدفق الأصلي.");
    window.setTimeout(()=>instance.fitView({padding:.24,duration:350}),60);
    return true;
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
    if(key==="v"&&clipboard.current){e.preventDefault();const n=clipboard.current;const draft=makeNode(n.data.kind,{x:n.position.x+cardSize(n).width+85,y:n.position.y+85},{...n.data,options:n.data.options.map(o=>({...o,id:uuid()}))});
      s.addNode({...draft,position:findOpenPosition(s.doc.nodes,draft,draft.position)});setNotice("تم لصق العقدة.");}
    if(key==="d"&&s.selectedId){e.preventDefault();const n=s.doc.nodes.find(n=>n.id===s.selectedId);if(n){const draft=makeNode(n.data.kind,{x:n.position.x+cardSize(n).width+85,y:n.position.y+85},{...n.data,options:n.data.options.map(o=>({...o,id:uuid()}))});
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
      {...old,id:uuid(),target:fresh.id,targetHandle:"in"},
      {id:uuid(),type:"flowEdge",source:fresh.id,sourceHandle:"next",target:old.target,targetHandle:old.targetHandle||"in",data:{label:"التالي"}}
    ]});
    setEdgeMenu(null);
  };
  const renderedNodes=useMemo(()=>doc.nodes.map(n=>({...n,className:trail.includes(n.id)?"flow-visited":""})),[doc.nodes,trail]);
  const renderedEdges=useMemo(()=>doc.edges.map(e=>({...e,animated:trail.includes(e.source)&&trail.includes(e.target)})),[doc.edges,trail]);
  // Skin-only: per-node summary of the existing validation findings (badges on cards).
  const nodeIssues=useMemo(()=>{
    const map=new Map<string,NodeIssueSummary>();
    for(const issue of issues){
      if(!issue.nodeId)continue;
      const current=map.get(issue.nodeId)||{errors:0,warnings:0,first:""};
      if(issue.severity==="error"){if(!current.errors)current.first=issue.message;current.errors++;}
      else{if(!current.first)current.first=issue.message;current.warnings++;}
      map.set(issue.nodeId,current);
    }
    return map;
  },[issues]);
  // Skin-only save indicator: observes the existing 700ms browser autosave without changing it.
  const [saveState,setSaveState]=useState<"saved"|"saving"|"paused"|"failed">("saving");
  useEffect(()=>{
    if(protectStoredLibrary){setSaveState("paused");return;}
    setSaveState("saving");
    const timer=window.setTimeout(()=>{
      try{setSaveState(localStorage.getItem(SAVE_KEY)===JSON.stringify(doc)?"saved":"failed");}catch{setSaveState("failed");}
    },820);
    return()=>window.clearTimeout(timer);
  },[doc,protectStoredLibrary]);
  // Phones: keep the selected card visible above the half-height step sheet (viewport pan only).
  useEffect(()=>{
    if(!isCompact||!selectedId)return;
    const timer=window.setTimeout(()=>{
      const node=instance.getInternalNode(selectedId),pane=document.querySelector(".flow-skin .react-flow")?.getBoundingClientRect();
      if(!node||!pane)return;
      const {x:vx,y:vy,zoom}=instance.getViewport(),abs=node.internals.positionAbsolute;
      const w=(node.measured.width??280)*zoom,h=(node.measured.height??160)*zoom;
      const sx=abs.x*zoom+vx,sy=abs.y*zoom+vy;
      const top=72,bottom=Math.min(pane.height,window.innerHeight*(1-SHEET_HALF)-pane.top)-16; // 72: below the workspace tools pill
      if(bottom-top<60)return;
      const fitsY=sy>=top&&sy+h<=bottom,fitsX=sx>=8&&sx+w<=pane.width-8;
      if(fitsY&&fitsX)return;
      const ty=fitsY?sy:(h>bottom-top?top:top+(bottom-top-h)/2),tx=fitsX?sx:(pane.width-w)/2;
      const reduce=window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      void instance.setViewport({x:vx+(tx-sx),y:vy+(ty-sy),zoom},{duration:reduce?0:320});
    },60);
    return()=>window.clearTimeout(timer);
  },[isCompact,selectedId,instance]);
  const switchTo=(id:string)=>{
    store().switchFlow(id);closeAdd();setNotice("تم فتح التدفق المحدد.");
    window.setTimeout(()=>instance.fitView({padding:.2,duration:200}),90);
  };
  const createNewFlow=()=>{
    if(flows.length>=30){setNotice("الحد الأقصى 30 تدفقًا محليًا.");return;}
    const created=store().createFlow();if(!created){setNotice("تعذّر إنشاء التدفق: وصلت إلى الحد الأقصى (30).");return;}
    closeAdd();setNotice("أُنشئ تدفق جديد. اربط الأزرار من لوحة الخطوة.");
    window.setTimeout(()=>instance.fitView({padding:.25}),120);
  };
  const createBlankFlow=()=>{
    if(flows.length>=30){setNotice("الحد الأقصى 30 تدفقًا محليًا.");return;}
    const created=store().createFlow("تدفق فارغ "+(flows.length+1),true);
    if(!created){setNotice("تعذّر إنشاء التدفق: وصلت إلى الحد الأقصى (30).");return;}
    closeAdd();setNotice("تم إنشاء تدفق فارغ يحتوي على نقطة البداية فقط. التدفق القديم محفوظ.");
    window.setTimeout(()=>instance.fitView({padding:.25}),120);
  };
  const saveLabel=language==="ar"
    ?{saved:"محفوظ في المتصفح",saving:"جارٍ الحفظ…",paused:"الحفظ التلقائي متوقف",failed:"تعذّر الحفظ — استخدم التصدير"}[saveState]
    :{saved:"Saved in browser",saving:"Saving…",paused:"Autosave paused",failed:"Save failed — use Export"}[saveState];
  const paletteAnchored=!!addRequest&&!addRequest.source;

  return <div dir={language==="ar"?"rtl":"ltr"} className="flow-skin flex h-[100dvh] flex-col">
    <header className={"fs-topbar"+(toolbarCollapsed?" is-collapsed":"")}>
      <div className="fs-tb-main">
        <a className="fs-ibtn" href="#/dashboard" aria-label={t("back")}><ArrowRight size={20}/></a>
        <div className="fs-tb-name">
          <p className="fs-tb-cap"><span className="truncate">{t("designer")}</span></p>
          <input className="fs-name-input" aria-label={t("name")} maxLength={100} value={doc.name} onChange={e=>store().rename(e.target.value)}/>
        </div>
        <FlowSwitcher flows={flows} activeFlowId={activeFlowId} activeName={doc.name} liveDoc={doc} language={language} onSwitch={switchTo} onCreate={createNewFlow} onBlank={createBlankFlow}/>
        {PUBLICATION_UI_ENABLED&&<button type="button" data-testid="flow-publications" className="fs-btn fs-btn-primary fs-publish" onClick={()=>setShowPublications(true)}>
          <Send size={16}/><span className="sm:hidden">{t("publish")}</span><span className="hidden sm:inline">{language==="en"?"Published revisions":"الإصدارات المنشورة"}</span></button>}
        <button type="button" className="fs-ibtn fs-tb-toggle" aria-label={toolbarCollapsed?t("expand"):t("collapse")} aria-expanded={!toolbarCollapsed} onClick={()=>setToolbarCollapsed(v=>!v)}>
          {toolbarCollapsed?<ChevronDown size={18}/>:<ChevronUp size={18}/>} <span className="hidden lg:inline">{toolbarCollapsed?t("showTools"):t("hideTools")}</span>
        </button>
      </div>
      <div className="fs-tb-sub" aria-hidden={toolbarCollapsed||undefined}><div className="fs-tb-sub-in">
        <div className="fs-tb-row fs-scroll-row">
          <span className={"fs-status is-"+saveState} role="status" aria-live="polite"><i className="fs-dot" aria-hidden="true"/>{saveLabel}</span>
          <label className="sr-only" htmlFor="flow-ui-language">{t("language")}</label>
          <select id="flow-ui-language" data-testid="flow-ui-language" dir="ltr" aria-label={t("language")}
            className="fs-select fs-lang"
            value={language} onChange={e=>setLanguage(e.target.value as FlowLanguage)}>
            <option value="ar">العربية</option><option value="en">English</option>
          </select>
        </div>
        <div className="fs-tb-row fs-scroll-row" data-testid="flow-toolbar-actions">
          <select className="fs-select fs-flow-select" aria-label={t("select")} value={activeFlowId} onChange={e=>switchTo(e.target.value)}>
            {flows.map(f=><option key={f.id} value={f.id}>{f.id===activeFlowId?doc.name:f.doc.name}</option>)}
          </select>
          <button className={btn} title={t("create")} aria-label={t("create")} onClick={createNewFlow}><Plus size={16}/></button>
          <button className={btn} title={t("blank")} aria-label={t("blank")} onClick={createBlankFlow}><LayoutGrid size={16}/> <span className="hidden sm:inline">{t("blank")}</span></button>
          <button className={btn} title={t("duplicate")} aria-label={t("duplicate")} onClick={()=>{store().duplicateFlow();setNotice("تم إنشاء نسخة مستقلة من التدفق.");}}><Copy size={15}/></button>
          <button className={btn+" fs-btn-danger"} disabled={flows.length<2} title={t("delete")} aria-label={t("delete")} onClick={()=>{
            if(!window.confirm("سيُحذف هذا التدفق المحلي. قد تكون أزرار في تدفقات أخرى مرتبطة به. هل تريد المتابعة؟"))return;
            store().deleteFlow(activeFlowId);setNotice("حُذف التدفق المحلي.");
          }}><Trash2 size={15}/></button>
        </div>
      {!toolbarCollapsed&&<div className="fs-tb-row fs-scroll-row" data-testid="flow-toolbar-secondary">
        <button data-testid="flow-enabled-toggle" type="button" aria-label={t("activate")} aria-pressed={activeEnabled}
          className={"fs-toggle"+(activeEnabled?" is-on":"")}
          onClick={()=>{
            if(!activeEnabled&&errors.length>0){setShowIssues(true);setNotice("راجع الأخطاء قبل تفعيل المسودة.");return;}
            store().setFlowEnabled(activeFlowId,!activeEnabled);
            setNotice(!activeEnabled?"تم تفعيل المسودة محليًا فقط. لم تُفعّل الأتمتة على الحساب المرتبط.":"تم تعطيل المسودة محليًا.");
          }}>
          <span className="fs-toggle-track"><span className="fs-toggle-thumb"/></span>
          {activeEnabled?t("enabled"):t("disabled")}
        </button>
        <div className="fs-grp">
          <button className="fs-ibtn" onClick={()=>store().undo()} title={t("undo")}><Undo2 size={17}/></button>
          <button className="fs-ibtn" onClick={()=>store().redo()} title={t("redo")}><Redo2 size={17}/></button>
        </div>
        <button className={btn} onClick={e=>openAdd({x:e.clientX,y:e.clientY})} title={t("add")}><Plus size={16}/> <span className="hidden sm:inline">{t("addShort")}</span></button>
        <button className={btn} onClick={arrange} title={t("arrange")}><LayoutGrid size={16}/><span className="hidden md:inline">{t("arrangeShort")}</span></button>
        <button className={"fs-chip-btn "+(errors.length?"is-error":warnings.length?"is-warning":"is-ok")} onClick={()=>setShowIssues(v=>!v)} title={t("check")} aria-expanded={showIssues}>
          {errors.length?<AlertTriangle size={15}/>:<CheckCircle2 size={15}/>}
          <span className="hidden md:inline">{t("checkShort")}</span><span>{errors.length}</span><span className="fs-chip-warn">⚠ {warnings.length}</span>
        </button>
        <button className={btn} onClick={()=>setShowSimulator(true)}><Play size={16}/> {t("preview")}</button>
        {CLOUD_DRAFT_UI_ENABLED&&<button data-testid="flow-cloud-drafts" className={btn} onClick={()=>setShowCloudDrafts(true)}>{language==="en"?"Cloud drafts":"مسودات سحابية"}</button>}
        <button className={btn} onClick={exportFile}><Download size={16}/> {t("export")}</button>
        <button className={btn} onClick={()=>input.current?.click()}><Upload size={16}/> {t("import")}</button>
        <input ref={input} className="hidden" type="file" accept=".json,application/json" onChange={e=>{void importFile(e.target.files?.[0]);e.target.value="";}}/>
        <button className="fs-btn fs-btn-gold" onClick={()=>{
          if(protectStoredLibrary&&!window.confirm("المكتبة المحلية تحتوي بيانات تالفـة أو غير قابلة للاسترجاع. الحفظ الآن سيستبدل الأصل؛ يُنصح بأخذ نسخة احتياطية أولًا. هل تريد المتابعة؟"))return;
          try{
            localStorage.setItem(SAVE_KEY,JSON.stringify(doc));
            saveLibrary(snapshotLibrary(activeFlowId,doc,flows));
            setProtectStoredLibrary(false);setNotice("حُفظت المسودة ومكتبة التدفقات في متصفحك.");
          }catch{setNotice("تعذر الحفظ؛ استخدم التصدير.");}
        }}><Save size={16}/> {t("save")}</button>
      </div>}
      </div></div>
    </header>
    {CLOUD_DRAFT_UI_ENABLED&&showCloudDrafts&&<CloudDraftPanel language={language} onClose={()=>setShowCloudDrafts(false)}/>}
    {PUBLICATION_UI_ENABLED&&showPublications&&<FlowPublicationPanel key={activeFlowId} flowKey={activeFlowId} document={doc} language={language} onImportRevision={importPublishedRevision} onPreviewRevision={previewPublishedRevision} onClose={()=>setShowPublications(false)}/>}
    {recovery.messages.length>0&&<div role="alert" className="fs-recovery">
      <strong>تقرير استعادة التدفقات: </strong>{recovery.messages.join(" ")} تم استرجاع {recovery.recovered} وتجاهل {recovery.skipped}.
      {protectStoredLibrary&&<span className="mr-2 font-bold">الحفظ التلقائي متوقف لحماية بيانات المكتبة الأصلية؛ استخدم «تصدير» قبل تأكيد الحفظ اليدوي.</span>}
    </div>}
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <section className="fs-stage relative min-w-0 flex-1" aria-label="مساحة التدفقات" data-touch-pan={isCompact} onClick={()=>{if(edgeMenu)setEdgeMenu(null);}}>
        <FlowIssuesContext.Provider value={nodeIssues}>
        <ReactFlow<FlowNode,FlowEdge>
          nodes={renderedNodes} edges={renderedEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={nodesChanged} onEdgesChange={edgesChanged}
          onNodeClick={(_,n)=>store().setSelected(n.id)}
          onPaneClick={()=>{store().setSelected(null);setEdgeMenu(null);closeAdd();setShowIssues(false);}}
          onNodeDragStart={()=>store().pushHistory()}
          onConnect={c=>store().connect(c)}
          isValidConnection={validConnection}
          edgesReconnectable
          connectionRadius={40}
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
          colorMode="dark" connectionLineStyle={{stroke:"#3DD189",strokeWidth:2.4,strokeDasharray:"6 6"}}
          proOptions={{hideAttribution:true}}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="#173D30"/>
          <MiniMap nodeColor={n=>SKIN_COLOR[(n.data as FlowNode["data"]).kind]||"#3DD189"} nodeBorderRadius={8} className="fs-minimap !hidden md:!block" maskColor="rgba(2,12,8,.7)" pannable zoomable />
        </ReactFlow>
        </FlowIssuesContext.Provider>
        <WorkspaceTools language={language}/>

        <button className="fs-fab nodrag" title={t("add")} aria-label={t("openAdd")} aria-expanded={paletteAnchored} onClick={e=>{if(paletteAnchored){closeAdd();return;}openAdd({x:e.clientX,y:e.clientY});}}><Plus size={28}/></button>
        {showIssues&&<div className="fs-popover fs-issues">
          <div className="flex items-center justify-between gap-2"><h3 className="fs-display text-lg">{t("flowIssues")}</h3><button className="fs-ibtn fs-ibtn-sm" onClick={()=>setShowIssues(false)} aria-label={language==="ar"?"إغلاق الفحص":"Close validation"}><X size={18}/></button></div>
          {issues.length?<div className="mt-3 max-h-52 space-y-1.5 overflow-y-auto text-xs">{issues.slice(0,30).map((issue,i)=><button key={i} type="button" className={"fs-issue "+(issue.severity==="warning"?"is-warning":"is-error")} onClick={()=>{
              if(issue.nodeId){
                const node=doc.nodes.find(n=>n.id===issue.nodeId);
                if(node){store().setSelected(node.id);void instance.setCenter(node.position.x+140,node.position.y+90,{zoom:1,duration:350});}
              }
              setShowIssues(false);
            }}>{issue.severity==="warning"?"⚠ تحذير: ":"● خطأ: "}{issue.message}{issue.nodeId?" (انتقل إلى العقدة)":""}</button>)}</div>:<p className="mt-3 flex items-center gap-2 text-sm text-[#3DD189]"><CheckCircle2 size={18}/> لا توجد أخطاء بنيوية مكتشفة.</p>}
        </div>}
        {edgeMenu&&<div className="fs-popover fixed z-50 min-w-40 p-2" style={{left:Math.min(window.innerWidth-180,edgeMenu.x),top:Math.min(window.innerHeight-150,edgeMenu.y)}} onClick={e=>e.stopPropagation()}>
          <button className={btn+" mb-2 w-full"} onClick={()=>insertOnEdge(edgeMenu.id)}><Plus size={15}/> إدراج خطوة</button>
          <button className={btn+" fs-btn-danger w-full"} onClick={()=>{store().deleteEdge(edgeMenu.id);setEdgeMenu(null);}}><Trash2 size={15}/> حذف الاتصال</button>
        </div>}

        {addRequest&&<div role="dialog" aria-label="إضافة خطوة" data-testid="add-step-menu"
          className={"fs-palette"+(paletteAnchored?" is-anchored":"")}
          style={paletteAnchored?undefined:{left:Math.max(8,Math.min(window.innerWidth-300,addRequest.x-24)),top:Math.max(55,Math.min(window.innerHeight-355,addRequest.y+8))}}
          onClick={e=>e.stopPropagation()}>
          <div className="mb-3 flex items-center justify-between gap-2"><h3 className="fs-display text-lg">{addRequest.source?t("addAfter"):t("addNew")}</h3>
            <button className="fs-ibtn fs-ibtn-sm" aria-label={t("menuClose")} onClick={closeAdd}><X size={17}/></button></div>
          {addRequest.source&&!addRequest.port?
            <><p className="mb-2 text-xs text-[var(--fs-muted)]">اختر أي فرع تريد توصيل الخطوة الجديدة به:</p>
              <div className="space-y-1.5">{outputs(doc.nodes.find(n=>n.id===addRequest.source)!).map(port=>
                <button key={port.id} className={btn+" w-full justify-between"} onClick={()=>openAdd({...addRequest,port:port.id})}>{port.label}<ArrowRight size={15}/></button>)}</div></>:
            <div className="fs-pal-grid">
              {KIND_LIST.filter(k=>k!=="trigger"||(!addRequest.source&&!doc.nodes.some(n=>n.data.kind==="trigger"))).map(kind=>{
                const KindIcon=SKIN_ICON[kind],name=flowKindLabel(kind,language,LABELS[kind]);
                return <button key={kind} type="button" aria-label={name} className="fs-pal-item" style={{"--c":SKIN_COLOR[kind]} as CSSProperties}
                  onClick={()=>addNode(kind,addRequest.position,addRequest.source&&addRequest.port?{source:addRequest.source,port:addRequest.port}:undefined)}>
                  <span className="fs-node-ico" aria-hidden="true"><KindIcon size={17}/></span>
                  <span className="min-w-0"><b>{name}</b><small aria-hidden="true">{skinHint(kind,language)}</small></span>
                </button>;})}
              {ACTION_PRESETS.map(p=>{
                const ActIcon=SKIN_ICON.action,name=language==="ar"?p.ar:p.en;
                return <button key={p.id} type="button" aria-label={name} data-testid={"pal-preset-"+p.id} className="fs-pal-item" style={{"--c":SKIN_COLOR.action} as CSSProperties}
                  onClick={()=>addNode("action",addRequest.position,addRequest.source&&addRequest.port?{source:addRequest.source,port:addRequest.port}:undefined,p.preset)}>
                  <span className="fs-node-ico" aria-hidden="true"><ActIcon size={17}/></span>
                  <span className="min-w-0"><b>{name}</b><small aria-hidden="true">{language==="ar"?p.hintAr:p.hintEn}</small></span>
                </button>;})}
            </div>}
          <p className="mt-3 text-[11px] leading-5 text-[var(--fs-muted)]">بعد الإضافة يمكنك تحريك العقدة بحرية وإعادة ترتيب المخطط.</p>
        </div>}
      </section>
      {selected&&<NodeEditor node={selected} language={language} onClose={()=>store().setSelected(null)}/>}
    </div>
    {notice&&<div role="status" className="fs-toast" onClick={()=>setNotice("")}>{notice} ×</div>}
    <div className="fs-local-hint pointer-events-none hidden sm:block">{t("localOnly")}</div>
    {showSimulator&&<FlowSimulator language={language} doc={publishedPreview??doc} flowId={publishedPreview?"published-preview":activeFlowId} flows={publishedPreview?[{id:"published-preview",doc:publishedPreview,enabled:false}]:snapshotLibrary(activeFlowId,doc,flows).flows} onVisited={publishedPreview?undefined:setTrail} onClose={()=>{setShowSimulator(false);setPublishedPreview(null);}}/>}
  </div>;
}
export default function FlowBuilder(){
  return <ReactFlowProvider><Editor/></ReactFlowProvider>;
}
