import { create } from "zustand";
import { applyNodeChanges, applyEdgeChanges, reconnectEdge } from "@xyflow/react";
import type { NodeChange, EdgeChange, Connection } from "@xyflow/react";
import { canConnect, edgeFor, outputs } from "./model.ts";
import { blankFlow, loadLibrary, snapshotLibrary } from "./library.ts";
import { stageCloudDraftCopy } from "./cloudDraft.ts";
import { pasteSelection as cloneIntoDocument } from "./clipboard.ts";
import type { SelectionClipboard } from "./clipboard.ts";
import type { CloudDraft } from "./cloudDraft.ts";
import type { SavedFlow } from "./library.ts";
import type { FlowDocument, FlowData, FlowEdge, FlowNode } from "./model.ts";

export type FlowState = {
  doc: FlowDocument;
  activeFlowId: string;
  flows: SavedFlow[];
  createFlow: (name?:string,fromScratch?:boolean)=>string|null;
  setFlowEnabled: (id:string,enabled:boolean)=>boolean;
  duplicateFlow: ()=>string|null;
  switchFlow: (id:string)=>boolean;
  deleteFlow: (id:string)=>boolean;
  restoreCloudCopy: (source:CloudDraft,copyId:string)=>boolean;
  past: FlowDocument[];
  future: FlowDocument[];
  pastEnabled: boolean[];
  futureEnabled: boolean[];
  lastEdit: { id:string; fields:string; at:number } | null;
  selectedId: string | null;
  setSelected: (id: string | null) => void;
  pushHistory: () => void;
  replace: (doc: FlowDocument) => void;
  rename: (name:string) => void;
  addNode: (node:FlowNode) => "added" | "duplicate_trigger" | "limit_reached";
  pasteSelection: (clipboard:SelectionClipboard)=>"added"|"no_copyable_nodes"|"node_limit";
  changeNode: (id:string, data:Partial<FlowData>) => void;
  nodesChanged: (changes:NodeChange<FlowNode>[])=>void;
  edgesChanged: (changes:EdgeChange<FlowEdge>[])=>void;
  connect: (connection:Connection)=>void;
  reconnect: (old:FlowEdge,connection:Connection)=>void;
  deleteEdge: (id:string)=>void;
  deleteNode: (id:string, bridge?:boolean)=>boolean;
  undo: ()=>void;
  redo: ()=>void;
};

function savePast(state: FlowState): Pick<FlowState,"past"|"future"|"pastEnabled"|"futureEnabled"|"lastEdit"> {
  const enabled=state.flows.find(f=>f.id===state.activeFlowId)?.enabled===true;
  return {lastEdit:null,past:[...state.past.slice(-99),state.doc],future:[],
    pastEnabled:[...state.pastEnabled.slice(-99),enabled],futureEnabled:[]};
}
const initialLibrary=loadLibrary();
const initial=initialLibrary.flows.find(flow=>flow.id===initialLibrary.activeFlowId)!.doc;
export const useFlowStore=create<FlowState>((set,get)=>({
  doc:initial,activeFlowId:initialLibrary.activeFlowId,flows:initialLibrary.flows,past:[],future:[],pastEnabled:[],futureEnabled:[],lastEdit:null,selectedId:null,
  createFlow:(name,fromScratch=false)=>{
    if(get().flows.length>=30)return null;
    const id=crypto.randomUUID();
    set(s=>{
      if(s.flows.length>=30)return s;
      const current=snapshotLibrary(s.activeFlowId,s.doc,s.flows);
      const doc=blankFlow(name||"تدفق جديد "+(current.flows.length+1),fromScratch);
      return {doc,activeFlowId:id,flows:[...current.flows,{id,doc,enabled:false}],selectedId:null,past:[],future:[],pastEnabled:[],futureEnabled:[]};
    });
    return id;
  },
  setFlowEnabled:(id,enabled)=>{
    const state=get();
    if(!state.flows.some(flow=>flow.id===id))return false;
    set(s=>{
      const current=s.flows.find(f=>f.id===id)?.enabled===true;
      if(current===enabled)return s;
      return {flows:snapshotLibrary(s.activeFlowId,s.doc,s.flows).flows.map(flow=>
        flow.id===id?{...flow,enabled}:flow),...(id===s.activeFlowId?savePast(s):{})};
    });
    return true;
  },
  duplicateFlow:()=>{
    const s=get();
    if(s.flows.length>=30)return null;
    const id=crypto.randomUUID();
    const doc=structuredClone(s.doc);
    doc.name=s.doc.name+" (نسخة)";
    set({doc,activeFlowId:id,flows:[...snapshotLibrary(s.activeFlowId,s.doc,s.flows).flows,{id,doc,enabled:false}],selectedId:null,past:[],future:[],pastEnabled:[],futureEnabled:[]});
    return id;
  },
  switchFlow:(id)=>{
    const s=get();
    if(s.activeFlowId===id)return true;
    const target=s.flows.find(flow=>flow.id===id);
    if(!target)return false;
    const current=snapshotLibrary(s.activeFlowId,s.doc,s.flows);
    set({activeFlowId:id,flows:current.flows,doc:target.doc,selectedId:null,past:[],future:[],pastEnabled:[],futureEnabled:[]});
    return true;
  },
  deleteFlow:(id)=>{
    const s=get();
    if(s.flows.length<2||!s.flows.some(flow=>flow.id===id))return false;
    const flows=snapshotLibrary(s.activeFlowId,s.doc,s.flows).flows.filter(flow=>flow.id!==id);
    const activeFlowId=s.activeFlowId===id?flows[0].id:s.activeFlowId;
    const doc=s.activeFlowId===id?flows[0].doc:s.doc;
    set({flows,activeFlowId,doc,selectedId:null,past:[],future:[],pastEnabled:[],futureEnabled:[]});
    return true;
  },
  restoreCloudCopy:(source,copyId)=>{
    let restored=false;
    set(s=>{
      try{
        // نسخة جديدة غير مفعّلة، دون التعديل على التدفق المفتوح أو تاريخه.
        const snapshot=snapshotLibrary(s.activeFlowId,s.doc,s.flows);
        const staged=stageCloudDraftCopy(snapshot,source,copyId);
        restored=true;
        return {...s,flows:staged.flows};
      }catch{
        return s;
      }
    });
    return restored;
  },
  setSelected:(id)=>set({selectedId:id}),
  pushHistory:()=>set(s=>({...savePast(s)})),
  replace:(doc)=>set(s=>({doc,selectedId:s.selectedId&&doc.nodes.some(n=>n.id===s.selectedId)?s.selectedId:null,...savePast(s)})),
  rename:(name)=>set(s=>{
    const normalized=name.slice(0,100);
    if(normalized===s.doc.name)return s;
    const now=Date.now();
    const coalesced=s.lastEdit?.id==="@document"&&s.lastEdit.fields==="name"&&now-s.lastEdit.at>=0&&now-s.lastEdit.at<500;
    return {doc:{...s.doc,name:normalized},...(coalesced?{}:savePast(s)),lastEdit:{id:"@document",fields:"name",at:now}};
  }),
  addNode:(node)=>{
    const previous=get();
    if(previous.doc.nodes.length>=100)return "limit_reached";
    if(node.data.kind==="trigger"&&previous.doc.nodes.some(n=>n.data.kind==="trigger"))
      return "duplicate_trigger";
    set(s=>({doc:{...s.doc,nodes:[...s.doc.nodes,node]},selectedId:node.id,...savePast(s)}));
    return "added";
  },
  pasteSelection:(clipboard)=>{
    const source=get();
    const result=cloneIntoDocument(source.doc,clipboard);
    if(!result.ok)return result.reason;
    set(s=>({
      doc:{...s.doc,
        nodes:[...s.doc.nodes.map(n=>({...n,selected:false})),...result.nodes],
        edges:[...s.doc.edges,...result.edges]},
      selectedId:result.nodes[result.nodes.length-1]?.id??null,...savePast(s)
    }));
    return "added";
  },
  changeNode:(id,data)=>set(s=>{
    const before=s.doc.nodes.find(n=>n.id===id);
    if(!before||Object.keys(data).every(key=>Object.is(before.data[key as keyof FlowData],data[key as keyof FlowData])))return s;
    const fields=Object.keys(data).sort().join("|");
    const now=Date.now();
    const coalesced=s.lastEdit?.id===id&&s.lastEdit.fields===fields&&
      now-s.lastEdit.at>=0&&now-s.lastEdit.at<500;
    return {
      doc:{...s.doc,nodes:s.doc.nodes.map(n=>n.id===id?{...n,data:{...n.data,...data}}:n)},
      ...(coalesced?{}:savePast(s)),lastEdit:{id,fields,at:now}
    };
  }),
  nodesChanged:(changes)=>set(s=>{
    const remove=changes.some(c=>c.type==="remove");
    const nodes=applyNodeChanges(changes,s.doc.nodes) as FlowNode[];
    const ids=new Set(nodes.map(n=>n.id));
    const edges=remove?s.doc.edges.filter(e=>ids.has(e.source)&&ids.has(e.target)):s.doc.edges;
    return {doc:{...s.doc,nodes,edges},...(remove?savePast(s):{})};
  }),
  edgesChanged:(changes)=>set(s=>{
    const removing=changes.some(c=>c.type==="remove");
    return {doc:{...s.doc,edges:applyEdgeChanges(changes,s.doc.edges) as FlowEdge[]},...(removing?savePast(s):{})};
  }),
  connect:(c)=>set(s=>{
    if(!canConnect(c,s.doc))return s;
    const from=s.doc.nodes.find(n=>n.id===c.source)!;
    const label=outputs(from).find(p=>p.id===c.sourceHandle)?.label??"";
    const edges=s.doc.edges.filter(e=>!(e.source===c.source&&e.sourceHandle===c.sourceHandle));
    return {doc:{...s.doc,edges:[...edges,edgeFor(c,label)]},...savePast(s)};
  }),
  reconnect:(old,c)=>set(s=>{
    if(!canConnect(c,s.doc,old.id))return s;
    const from=s.doc.nodes.find(n=>n.id===c.source)!;
    const label=outputs(from).find(p=>p.id===c.sourceHandle)?.label??"";
    const unique=s.doc.edges.filter(e=>e.id===old.id||!(e.source===c.source&&e.sourceHandle===c.sourceHandle));
    const updated=reconnectEdge(old,c,unique,{shouldReplaceId:false}) as FlowEdge[];
    return {doc:{...s.doc,edges:updated.map(e=>e.id===old.id?{...e,type:"flowEdge" as const,data:{...e.data,label}}:e)},...savePast(s)};
  }),
  deleteEdge:(id)=>set(s=>({doc:{...s.doc,edges:s.doc.edges.filter(e=>e.id!==id)},...savePast(s)})),
  deleteNode:(id,bridge=false)=>{
    const s=get(),node=s.doc.nodes.find(n=>n.id===id);if(!node)return false;
    const incoming=s.doc.edges.filter(e=>e.target===id),outgoing=s.doc.edges.filter(e=>e.source===id);
    let edges=s.doc.edges.filter(e=>e.source!==id&&e.target!==id);
    if(bridge&&incoming.length===1&&outgoing.length===1){
      const c:Connection={source:incoming[0].source,sourceHandle:incoming[0].sourceHandle||"next",target:outgoing[0].target,targetHandle:outgoing[0].targetHandle||"in"};
      const without={...s.doc,nodes:s.doc.nodes.filter(n=>n.id!==id),edges};
      if(canConnect(c,without)){
        const src=without.nodes.find(n=>n.id===c.source)!;
        const label=outputs(src).find(p=>p.id===c.sourceHandle)?.label??"";
        edges=[...edges,edgeFor(c,label)];
      }
    }
    set({doc:{...s.doc,nodes:s.doc.nodes.filter(n=>n.id!==id),edges},selectedId:null,...savePast(s)});
    return true;
  },
  undo:()=>set(s=>{
    if(!s.past.length)return s;
    const oldEnabled=s.pastEnabled[s.pastEnabled.length-1]??false;
    return {doc:s.past[s.past.length-1],past:s.past.slice(0,-1),future:[s.doc,...s.future].slice(0,100),lastEdit:null,
      pastEnabled:s.pastEnabled.slice(0,-1),
      futureEnabled:[s.flows.find(f=>f.id===s.activeFlowId)?.enabled===true,...s.futureEnabled].slice(0,100),
      flows:s.flows.map(f=>f.id===s.activeFlowId?{...f,enabled:oldEnabled}:f),selectedId:null};
  }),
  redo:()=>set(s=>{
    if(!s.future.length)return s;
    const nextEnabled=s.futureEnabled[0]??false;
    return {doc:s.future[0],future:s.future.slice(1),past:[...s.past.slice(-99),s.doc],lastEdit:null,
      pastEnabled:[...s.pastEnabled.slice(-99),s.flows.find(f=>f.id===s.activeFlowId)?.enabled===true],
      futureEnabled:s.futureEnabled.slice(1),
      flows:s.flows.map(f=>f.id===s.activeFlowId?{...f,enabled:nextEnabled}:f),selectedId:null};
  }),
}));
