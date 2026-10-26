import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { Plus, X } from "lucide-react";
import { makeNode } from "./model";
import type { FlowEdge } from "./model";
import { useFlowStore } from "./store";

export default function AutomationEdge(props:EdgeProps<FlowEdge>){
  const {id,sourceX,sourceY,targetX,targetY,sourcePosition,targetPosition,selected,markerEnd}=props;
  const [path,mx,my]=getBezierPath({sourceX,sourceY,targetX,targetY,sourcePosition,targetPosition});
  const remove=useFlowStore(s=>s.deleteEdge);
  const insert=()=>{
    const store=useFlowStore.getState(),doc=store.doc,old=doc.edges.find(e=>e.id===id);
    if(!old)return;
    const fresh=makeNode("message",{x:(sourceX+targetX)/2-130,y:(sourceY+targetY)/2-45},{title:"خطوة جديدة",text:"اكتب رسالتك هنا"});
    const edges=doc.edges.filter(e=>e.id!==id);
    edges.push({...old,id:crypto.randomUUID(),target:fresh.id,targetHandle:"in"},
      {id:crypto.randomUUID(),source:fresh.id,sourceHandle:"next",target:old.target,targetHandle:old.targetHandle,type:"flowEdge",data:{label:"التالي"}});
    store.replace({...doc,nodes:[...doc.nodes,fresh],edges});
  };
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={24}
      style={{stroke:selected?"#3DD189":"#87A39A",strokeWidth:selected?3:2.2}}/>
    <EdgeLabelRenderer><div className="nodrag nopan pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-lg border border-[#355D4E] bg-[#0B241C] px-1.5 py-1 text-[11px] text-[#DDEEE5] shadow-lg" style={{left:mx,top:my,transform:"translate(-50%, -50%)",pointerEvents:"all"}}>
      {!!props.data?.label&&<span className="max-w-28 truncate px-1">{String(props.data.label)}</span>}
      {selected&&<><button onClick={insert} title="إدراج خطوة بين العقدتين" aria-label="إدراج خطوة في الخط" className="rounded p-1 text-[#3DD189] hover:bg-[#173D30]"><Plus size={14}/></button>
      <button onClick={()=>remove(id)} aria-label="حذف الاتصال" title="حذف الاتصال" className="rounded p-1 text-red-300 hover:bg-[#173D30]"><X size={14}/></button></>}
    </div></EdgeLabelRenderer>
  </>;
}
