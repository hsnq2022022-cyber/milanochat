import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { Plus, X } from "lucide-react";
import { makeNode } from "./model";
import type { FlowEdge } from "./model";
import { useFlowStore } from "./store";
import { findOpenPosition } from "./layout";
import { SKIN_COLOR } from "./skin";

export default function AutomationEdge(props:EdgeProps<FlowEdge>){
  const {id,sourceX,sourceY,targetX,targetY,sourcePosition,targetPosition,selected,markerEnd}=props;
  // Presentation only: a smooth curve between the same handles React Flow resolved for this edge.
  const [path,mx,my]=getBezierPath({sourceX,sourceY,targetX,targetY,sourcePosition,targetPosition,curvature:.32});
  const remove=useFlowStore(s=>s.deleteEdge);
  const sourceNode=useFlowStore(s=>s.doc.nodes.find(n=>n.id===props.source));
  const targetKind=useFlowStore(s=>s.doc.nodes.find(n=>n.id===props.target)?.data.kind);
  const isTypedQuestion=sourceNode?.data.kind==="question"&&sourceNode.data.inputMode!=="buttons";
  const displayLabel=isTypedQuestion?(props.sourceHandleId==="valid"?"التالي":""):String(props.data?.label||"");
  const fromColor=sourceNode?SKIN_COLOR[sourceNode.data.kind]:"#8B9E96",toColor=targetKind?SKIN_COLOR[targetKind]:"#8B9E96";
  const gradientId="fs-edge-grad-"+id;
  const insert=()=>{
    const store=useFlowStore.getState(),doc=store.doc,old=doc.edges.find(e=>e.id===id);
    if(!old)return;
    const preferred={x:(sourceX+targetX)/2-130,y:(sourceY+targetY)/2-45};
    const draft=makeNode("message",preferred,{title:"خطوة جديدة",text:"اكتب رسالتك هنا"});
    const fresh={...draft,position:findOpenPosition(doc.nodes,draft,preferred)};
    const edges=doc.edges.filter(e=>e.id!==id);
    edges.push({...old,id:crypto.randomUUID(),target:fresh.id,targetHandle:"in"},
      {id:crypto.randomUUID(),source:fresh.id,sourceHandle:"next",target:old.target,targetHandle:old.targetHandle,type:"flowEdge",data:{label:"التالي"}});
    store.replace({...doc,nodes:[...doc.nodes,fresh],edges});
  };
  return <>
    <defs>
      <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX} y2={targetY===sourceY&&targetX===sourceX?sourceY+1:targetY}>
        <stop offset="0" stopColor={fromColor}/><stop offset="1" stopColor={toColor}/>
      </linearGradient>
    </defs>
    <path d={path} className="fs-edge-glow" fill="none" stroke={`url(#${gradientId})`} aria-hidden="true"/>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={24}
      className={"fs-edge-path"+(selected?" is-selected":"")}
      style={{stroke:selected?"#3DD189":`url(#${gradientId})`,strokeWidth:selected?3.2:2.4,strokeLinejoin:"round",strokeLinecap:"round"}}/>
    <EdgeLabelRenderer><div className={"fs-edge-label nodrag nopan pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 px-1.5 py-1 text-[11px]"+(selected?" is-selected":"")+(displayLabel||selected?"":" is-empty")} style={{left:mx,top:my,transform:"translate(-50%, -50%)",pointerEvents:"all"}}>
      {!!displayLabel&&<span className="max-w-28 truncate px-1">{displayLabel}</span>}
      {selected&&<><button onClick={insert} title="إدراج خطوة بين العقدتين" aria-label="إدراج خطوة في الخط" className="fs-edge-btn text-[#3DD189]"><Plus size={14}/></button>
      <button onClick={()=>remove(id)} aria-label="حذف الاتصال" title="حذف الاتصال" className="fs-edge-btn text-[#F45B69]"><X size={14}/></button></>}
    </div></EdgeLabelRenderer>
  </>;
}
