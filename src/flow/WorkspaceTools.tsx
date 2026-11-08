import { useState } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { ZoomIn, ZoomOut, Maximize, SlidersHorizontal, ArrowDownUp, ArrowLeftRight } from "lucide-react";
import { useFlowStore } from "./store";
import { arrangeFlow } from "./layout";
import type { LayoutDirection } from "./layout";
import { flowText } from "./uiLocale";
import type { FlowLanguage } from "./uiLocale";

/** View-only replacement for React Flow <Controls>: zoom in/out and fit, nothing touches the graph. */
export default function WorkspaceTools({language}:{language:FlowLanguage}){
  const {zoomIn,zoomOut,fitView}=useReactFlow();
  const zoom=useStore(s=>Math.round(s.transform[2]*100));
  const minZoom=useStore(s=>s.minZoom),maxZoom=useStore(s=>s.maxZoom);
  const [collapsed,setCollapsed]=useState(false);
  const t=(key:Parameters<typeof flowText>[0])=>flowText(key,language);
  const reduce=typeof window!=="undefined"&&window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [direction,setDirection]=useState<LayoutDirection>("TB");
  const applyLayout=(next:LayoutDirection)=>{
    setDirection(next);
    // replace() pushes undo history, so the layout change is undoable.
    useFlowStore.getState().replace(arrangeFlow(useFlowStore.getState().doc,next));
    window.setTimeout(()=>void fitView({padding:.22,maxZoom:1,duration:reduce?0:300}),75);
  };
  const duration=reduce?0:220;
  return <div className={"fs-tools nodrag nopan"+(collapsed?" is-collapsed":"")} role="toolbar" aria-label={t("workspaceTools")} data-testid="flow-workspace-tools">
    <button type="button" className="fs-ibtn" aria-label={t("workspaceTools")} aria-expanded={!collapsed} onClick={()=>setCollapsed(v=>!v)}><SlidersHorizontal size={18}/></button>
    <div className="fs-tools-group" hidden={collapsed}>
      <span className="fs-vsep" aria-hidden="true"/>
      <button type="button" className="fs-ibtn" aria-label={t("zoomOut")} title={t("zoomOut")} disabled={zoom<=Math.round(minZoom*100)} onClick={()=>void zoomOut({duration})}><ZoomOut size={18}/></button>
      <span className="fs-zoom-lbl">{zoom}%</span>
      <button type="button" className="fs-ibtn" aria-label={t("zoomIn")} title={t("zoomIn")} disabled={zoom>=Math.round(maxZoom*100)} onClick={()=>void zoomIn({duration})}><ZoomIn size={18}/></button>
      <button type="button" className="fs-ibtn" aria-label={t("fitView")} title={t("fitView")} onClick={()=>void fitView({padding:.2,duration:reduce?0:300})}><Maximize size={18}/></button>
      <span className="fs-vsep" aria-hidden="true"/>
      <div role="group" aria-label={t("layoutDirection")} className="fs-tools-group" data-testid="flow-layout-toggle">
        <button type="button" className="fs-ibtn" data-testid="layout-vertical" aria-pressed={direction==="TB"} aria-label={t("layoutVertical")} title={t("layoutVertical")} onClick={()=>applyLayout("TB")}><ArrowDownUp size={18}/></button>
        <button type="button" className="fs-ibtn" data-testid="layout-horizontal" aria-pressed={direction==="LR"} aria-label={t("layoutHorizontal")} title={t("layoutHorizontal")} onClick={()=>applyLayout("LR")}><ArrowLeftRight size={18}/></button>
      </div>
    </div>
  </div>;
}
