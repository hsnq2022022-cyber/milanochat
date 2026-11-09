import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown, Check, Plus, LayoutGrid } from "lucide-react";
import type { SavedFlow } from "./library";
import type { FlowDocument } from "./model";
import { flowText } from "./uiLocale";
import type { FlowLanguage } from "./uiLocale";

const CHANNELS:Record<string,{label:string;color:string}>={
  instagram:{label:"Instagram",color:"#F45B69"},
  whatsapp:{label:"WhatsApp",color:"#3DD189"},
  messenger:{label:"Messenger",color:"#4FC3F7"},
};
/** Trigger channel read from the document's trigger node (never a cached summary). */
export function flowChannel(doc:FlowDocument):string{
  const p=doc.nodes.find(n=>n.data.kind==="trigger")?.data.platform;
  return p&&CHANNELS[p]?p:"other";
}

/**
 * Presentation wrapper over the builder's existing local flow library:
 * lists `flows` from the store and calls the same switch/create handlers as the toolbar.
 */
export default function FlowSwitcher({flows,activeFlowId,activeName,liveDoc,language,onSwitch,onCreate,onBlank}:{
  flows:SavedFlow[];activeFlowId:string;activeName:string;liveDoc?:FlowDocument;language:FlowLanguage;
  onSwitch:(id:string)=>void;onCreate:()=>void;onBlank:()=>void;
}){
  const [open,setOpen]=useState(false);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),list=useRef<HTMLUListElement>(null);
  const t=(key:Parameters<typeof flowText>[0])=>flowText(key,language);
  useEffect(()=>{
    if(!open)return;
    const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
    document.addEventListener("pointerdown",outside);
    const first=list.current?.querySelector<HTMLButtonElement>("[aria-current='true']")||list.current?.querySelector<HTMLButtonElement>("button");
    first?.focus({preventScroll:true});
    return()=>document.removeEventListener("pointerdown",outside);
  },[open]);
  const close=(restore=true)=>{setOpen(false);if(restore)trigger.current?.focus({preventScroll:true});};
  const onKey=(e:React.KeyboardEvent)=>{
    if(e.key==="Escape"){e.stopPropagation();close();return;}
    if(e.key!=="ArrowDown"&&e.key!=="ArrowUp")return;
    const items=[...(root.current?.querySelectorAll<HTMLButtonElement>(".fs-switcher-pop button")||[])];
    const index=items.indexOf(document.activeElement as HTMLButtonElement);
    if(!items.length)return;
    e.preventDefault();
    items[(index+(e.key==="ArrowDown"?1:-1)+items.length)%items.length]?.focus();
  };
  return <div ref={root} className="fs-switcher" onKeyDown={onKey}>
    <button ref={trigger} type="button" data-testid="flow-switcher" className="fs-ibtn fs-switcher-btn"
      aria-label={t("switchFlow")} title={t("switchFlow")} aria-haspopup="dialog" aria-expanded={open}
      onClick={()=>setOpen(v=>!v)}>
      <ChevronsUpDown size={19}/>
    </button>
    {open&&<div className="fs-switcher-pop" role="dialog" aria-label={t("myFlows")} data-testid="flow-switcher-list">
      <div className="fs-switcher-head">
        <h3 className="fs-display">{t("myFlows")}</h3>
        <span>{flows.length} {t("flowCount")}</span>
      </div>
      <ul ref={list} className="fs-switcher-list">
        {flows.map(flow=>{
          const current=flow.id===activeFlowId;
          // The active flow is edited live in the store; flow.doc is only snapshotted on switch/save, so read the live doc.
          const doc=current&&liveDoc?liveDoc:flow.doc;
          const name=current?activeName:doc.name;
          const channel=flowChannel(doc),ch=CHANNELS[channel];
          return <li key={flow.id}>
            <button type="button" data-testid="flow-card" data-channel={channel} data-flow-id={flow.id} data-nodes={doc.nodes.length}
              style={ch?{["--fs-ch" as string]:ch.color}:undefined}
              className={"fs-switcher-item"+(current?" is-current":"")} aria-current={current?"true":undefined}
              onClick={()=>{close(false);if(!current)onSwitch(flow.id);}}>
              <span className="fs-switcher-dot" data-on={flow.enabled===true} aria-hidden="true"/>
              <span className="fs-switcher-name">{name||"—"}</span>
              <span className="fs-switcher-meta">{doc.nodes.length} · {flow.enabled===true?t("enabled"):t("disabled")}</span>
              {ch&&<span className="fs-switcher-ch" data-testid="flow-card-channel">{ch.label}</span>}
              {current&&<Check size={16} className="fs-switcher-check" aria-label={t("currentFlow")}/>}
            </button>
          </li>;
        })}
      </ul>
      <div className="fs-switcher-foot">
        <button type="button" className="fs-btn fs-btn-ghost" onClick={()=>{close(false);onCreate();}}><Plus size={15}/>{language==="ar"?"تدفق جديد":"New flow"}</button>
        <button type="button" className="fs-btn fs-btn-ghost" onClick={()=>{close(false);onBlank();}}><LayoutGrid size={15}/>{language==="ar"?"من الصفر":"From scratch"}</button>
      </div>
    </div>}
  </div>;
}
