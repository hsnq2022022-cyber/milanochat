import { findOpenPosition } from "./layout.ts";
import type { FlowDocument, FlowEdge, FlowNode } from "./model.ts";

export type SelectionClipboard = {nodes:FlowNode[];edges:FlowEdge[]};
export type PasteResult = {ok:true;nodes:FlowNode[];edges:FlowEdge[];skippedTriggers:number} |
  {ok:false;reason:"no_copyable_nodes"|"node_limit"};

export function copySelection(doc:FlowDocument,ids:readonly string[]):SelectionClipboard {
  const selected=new Set(ids);
  const nodes=doc.nodes.filter(n=>selected.has(n.id));
  return {nodes:structuredClone(nodes),
    edges:structuredClone(doc.edges.filter(e=>selected.has(e.source)&&selected.has(e.target)))};
}

/** Duplicate only internal links; trigger nodes cannot be cloned in any path. */
export function pasteSelection(doc:FlowDocument,clip:SelectionClipboard):PasteResult{
  const nodes=clip.nodes.filter(n=>n.data.kind!=="trigger");
  const skippedTriggers=clip.nodes.length-nodes.length;
  if(nodes.length===0)return {ok:false,reason:"no_copyable_nodes"};
  if(doc.nodes.length+nodes.length>100)return {ok:false,reason:"node_limit"};
  const ids=new Map(nodes.map(n=>[n.id,crypto.randomUUID()]));
  const handles=new Map<string,Map<string,string>>();
  const placed:FlowNode[]=[];
  for(const n of nodes){
    const optionIds=new Map(n.data.options.map(o=>[o.id,crypto.randomUUID()]));
    handles.set(n.id,optionIds);
    const clone:FlowNode={
      ...structuredClone(n),id:ids.get(n.id)!,
      selected:true,dragging:false,measured:undefined,
      position:findOpenPosition([...doc.nodes,...placed],n,
        {x:n.position.x+370,y:n.position.y+110}),
      data:{...structuredClone(n.data),options:n.data.options.map(o=>({
        ...structuredClone(o),id:optionIds.get(o.id)!
      }))}
    };
    placed.push(clone);
  }
  const newEdges=clip.edges.filter(e=>ids.has(e.source)&&ids.has(e.target)).map(e=>({
    ...structuredClone(e),id:crypto.randomUUID(),
    source:ids.get(e.source)!,target:ids.get(e.target)!,
    sourceHandle:handles.get(e.source)?.get(e.sourceHandle||"")??e.sourceHandle,
    selected:false
  }));
  return {ok:true,nodes:placed,edges:newEdges,skippedTriggers};
}
