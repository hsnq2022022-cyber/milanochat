import { useState } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { ZoomIn, ZoomOut, Maximize, SlidersHorizontal } from "lucide-react";
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
  const duration=reduce?0:220;
  return <div className={"fs-tools nodrag nopan"+(collapsed?" is-collapsed":"")} role="toolbar" aria-label={t("workspaceTools")} data-testid="flow-workspace-tools">
    <button type="button" className="fs-ibtn" aria-label={t("workspaceTools")} aria-expanded={!collapsed} onClick={()=>setCollapsed(v=>!v)}><SlidersHorizontal size={18}/></button>
    <div className="fs-tools-group" hidden={collapsed}>
      <span className="fs-vsep" aria-hidden="true"/>
      <button type="button" className="fs-ibtn" aria-label={t("zoomOut")} title={t("zoomOut")} disabled={zoom<=Math.round(minZoom*100)} onClick={()=>void zoomOut({duration})}><ZoomOut size={18}/></button>
      <span className="fs-zoom-lbl">{zoom}%</span>
      <button type="button" className="fs-ibtn" aria-label={t("zoomIn")} title={t("zoomIn")} disabled={zoom>=Math.round(maxZoom*100)} onClick={()=>void zoomIn({duration})}><ZoomIn size={18}/></button>
      <button type="button" className="fs-ibtn" aria-label={t("fitView")} title={t("fitView")} onClick={()=>void fitView({padding:.2,duration:reduce?0:300})}><Maximize size={18}/></button>
    </div>
  </div>;
}
