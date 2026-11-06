import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown, Check, Plus, LayoutGrid } from "lucide-react";
import type { SavedFlow } from "./library";
import { flowText } from "./uiLocale";
import type { FlowLanguage } from "./uiLocale";

/**
 * Presentation wrapper over the builder's existing local flow library:
 * lists `flows` from the store and calls the same switch/create handlers as the toolbar.
 */
export default function FlowSwitcher({flows,activeFlowId,activeName,language,onSwitch,onCreate,onBlank}:{
  flows:SavedFlow[];activeFlowId:string;activeName:string;language:FlowLanguage;
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
          const name=current?activeName:flow.doc.name;
          return <li key={flow.id}>
            <button type="button" className={"fs-switcher-item"+(current?" is-current":"")} aria-current={current?"true":undefined}
              onClick={()=>{close(false);if(!current)onSwitch(flow.id);}}>
              <span className="fs-switcher-dot" data-on={flow.enabled===true} aria-hidden="true"/>
              <span className="fs-switcher-name">{name||"—"}</span>
              <span className="fs-switcher-meta">{flow.doc.nodes.length} · {flow.enabled===true?t("enabled"):t("disabled")}</span>
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
