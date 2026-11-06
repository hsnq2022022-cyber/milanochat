import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** Presentation-only draggable bottom sheet (closed / half / full) for the step inspector on phones. */
export type SheetSnap="half"|"full";
export const SHEET_HALF=.5, SHEET_FULL=.92;
const FLICK=.55; // px per ms

const reducedMotion=()=>typeof window!=="undefined"&&!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const viewportHeight=()=>window.visualViewport?.height??window.innerHeight;

export function useCompactViewport(query="(max-width: 767px)"){
  const [compact,setCompact]=useState(()=>typeof window!=="undefined"&&!!window.matchMedia?.(query).matches);
  useEffect(()=>{
    const media=window.matchMedia(query);const update=()=>setCompact(media.matches);update();
    media.addEventListener("change",update);return()=>media.removeEventListener("change",update);
  },[query]);
  return compact;
}

type DragState={id:number;startY:number;startH:number;lastY:number;lastT:number;v:number;moved:boolean;raf:number};

export function useBottomSheet({enabled,onClose}:{enabled:boolean;onClose:()=>void}){
  const sheetRef=useRef<HTMLElement>(null);
  const [snap,setSnap]=useState<SheetSnap>("half");
  const drag=useRef<DragState|null>(null);
  const dragEndedAt=useRef(-1e9);
  const closeTimer=useRef(0);
  useEffect(()=>()=>{window.clearTimeout(closeTimer.current);if(drag.current)cancelAnimationFrame(drag.current.raf);},[]);

  const settle=useCallback((target:SheetSnap|"closed")=>{
    const el=sheetRef.current;if(!el)return;
    el.classList.remove("is-dragging");
    if(target==="closed"){
      el.classList.add("is-closing");
      closeTimer.current=window.setTimeout(onClose,reducedMotion()?0:230);
      return;
    }
    el.style.removeProperty("height"); // hand control back to the CSS snap height (animated)
    setSnap(target);
  },[onClose]);

  // Window-level listeners follow the pointer even after it leaves the small handle (mouse has no implicit capture).
  const listeners=useRef<{move:(e:PointerEvent)=>void;end:(e:PointerEvent)=>void}|null>(null);
  const detach=()=>{
    const l=listeners.current;if(!l)return;listeners.current=null;
    window.removeEventListener("pointermove",l.move);window.removeEventListener("pointerup",l.end);window.removeEventListener("pointercancel",l.end);
  };
  useEffect(()=>detach,[]);

  const onPointerMove=(e:PointerEvent)=>{
    const d=drag.current;if(!d||d.id!==e.pointerId)return;
    const dy=e.clientY-d.startY;
    if(!d.moved&&Math.abs(dy)<6)return;
    if(!d.moved){d.moved=true;sheetRef.current?.classList.add("is-dragging");}
    const dt=Math.max(1,e.timeStamp-d.lastT);
    d.v=.7*((d.lastY-e.clientY)/dt)+.3*d.v; // positive = upwards
    d.lastY=e.clientY;d.lastT=e.timeStamp;
    const height=Math.max(0,Math.min(viewportHeight()*SHEET_FULL,d.startH-dy));
    cancelAnimationFrame(d.raf);
    d.raf=requestAnimationFrame(()=>{sheetRef.current?.style.setProperty("height",height+"px");});
  };
  const onPointerEnd=(e:PointerEvent)=>{
    const d=drag.current;if(!d||d.id!==e.pointerId)return;
    drag.current=null;cancelAnimationFrame(d.raf);detach();
    if(!d.moved)return;
    dragEndedAt.current=performance.now(); // only the click synthesised by this release is ignored
    // A gesture that stalled before release carries no momentum.
    const v=e.timeStamp-d.lastT>90?0:d.v;
    const vh=viewportHeight(),half=vh*SHEET_HALF,full=vh*SHEET_FULL;
    const height=Math.max(0,Math.min(full,d.startH-(e.clientY-d.startY)));
    let target:SheetSnap|"closed";
    if(v>FLICK)target=height<half-24?"half":"full";
    else if(v<-FLICK)target=height>half+24?"half":"closed";
    else{
      const projected=height+v*160;
      const options:[SheetSnap|"closed",number][]=[["closed",0],["half",half],["full",full]];
      target=options.reduce((best,item)=>Math.abs(item[1]-projected)<Math.abs(best[1]-projected)?item:best)[0];
    }
    settle(target);
  };
  const onPointerDown=(e:ReactPointerEvent<HTMLElement>)=>{
    if(!enabled||(e.pointerType==="mouse"&&e.button!==0))return;
    const target=e.target as HTMLElement;
    if(target.closest("input,select,textarea,a,button:not([data-sheet-handle])"))return;
    const el=sheetRef.current;if(!el)return;
    detach();
    drag.current={id:e.pointerId,startY:e.clientY,startH:el.getBoundingClientRect().height,lastY:e.clientY,lastT:e.timeStamp,v:0,moved:false,raf:0};
    const l={move:onPointerMove,end:onPointerEnd};listeners.current=l;
    window.addEventListener("pointermove",l.move,{passive:true});window.addEventListener("pointerup",l.end);window.addEventListener("pointercancel",l.end);
  };
  const onHandleClick=()=>{
    if(performance.now()-dragEndedAt.current<60)return;
    setSnap(s=>s==="half"?"full":"half");
  };
  const handlers=enabled?{onPointerDown}:{};
  return {sheetRef,snap,handlers,onHandleClick};
}
