import dagre from "@dagrejs/dagre";
import type { XYPosition } from "@xyflow/react";
import type { FlowDocument, FlowNode } from "./model";

/** Actual React Flow measurements are preferred; fallback reserves enough space for rich content. */
export function cardSize(node:FlowNode):{width:number;height:number}{
  const d=node.data,blocks=d.contentBlocks||[];
  const portCount=d.kind==="question"&&d.inputMode!=="buttons"?2:
    ["message","question","condition","randomizer","request"].includes(d.kind)?
      (["condition","request"].includes(d.kind)?2:1+d.options.length):
    ["end","goto"].includes(d.kind)?0:1;
  const rows=Math.ceil(portCount/Math.max(1,Math.min(3,portCount)));
  const imageExtra=(d.image&&["message","question"].includes(d.kind)?144:0)+
    (blocks.some(b=>b.type==="image"&&b.url)?128:0);
  const contentLabel=blocks.length?Math.ceil(blocks.map(b=>b.type).join(" · ").length/36)*18+38:0;
  const textExtra=d.text.length>160?52:d.text.length>80?24:0;
  const contentExtra=d.kind==="trigger"?85: ["message","question"].includes(d.kind)?48+textExtra:36;
  const estimate={width:280,height:58+contentExtra+imageExtra+contentLabel+
    (portCount?Math.max(1,rows)*55+18:22)+22};
  const width=node.measured?.width;
  const height=node.measured?.height;
  return {width:width&&width>0?Math.max(280,width):estimate.width,
    height:height&&height>0?height:estimate.height};
}

function collides(a:XYPosition,as:{width:number;height:number},b:XYPosition,bs:{width:number;height:number},gap:number){
  return a.x<b.x+bs.width+gap&&a.x+as.width+gap>b.x&&
    a.y<b.y+bs.height+gap&&a.y+as.height+gap>b.y;
}

/** Stable deterministic search avoids overlaps without touching existing nodes. */
export function findOpenPosition(nodes:FlowNode[],candidate:FlowNode,preferred:XYPosition,gap=48):XYPosition {
  const size=cardSize(candidate);
  const occupied=nodes.filter(n=>n.id!==candidate.id);
  const isFree=(p:XYPosition)=>occupied.every(n=>!collides(p,size,n.position,cardSize(n),gap));
  if(isFree(preferred))return preferred;
  const step=80;
  for(let ring=1;ring<=40;ring++){
    const offsets:Array<[number,number]>=[];
    for(let x=-ring;x<=ring;x++){
      offsets.push([x,-ring],[x,ring]);
    }
    for(let y=-ring+1;y<ring;y++){
      offsets.push([-ring,y],[ring,y]);
    }
    // Prefer positions lower than the insertion point for a top-to-bottom editor.
    offsets.sort((a,b)=>((b[1]>=0?1:0)-(a[1]>=0?1:0))||(Math.abs(a[0])+Math.abs(a[1]) - Math.abs(b[0])-Math.abs(b[1])));
    for(const [dx,dy] of offsets){
      const position={x:preferred.x+dx*step,y:preferred.y+dy*step};
      if(isFree(position))return position;
    }
  }
  return {x:preferred.x,y:preferred.y+occupied.length*(size.height+gap)};
}

export function arrangeFlow(doc:FlowDocument):FlowDocument{
  if(!doc.nodes.length)return doc;
  const graph=new dagre.graphlib.Graph({multigraph:true});
  graph.setDefaultEdgeLabel(()=>({}));
  graph.setGraph({rankdir:"TB",nodesep:110,ranksep:140,marginx:65,marginy:65,ranker:"network-simplex"});
  for(const node of doc.nodes)graph.setNode(node.id,cardSize(node));
  for(const edge of doc.edges){
    if(graph.hasNode(edge.source)&&graph.hasNode(edge.target)&&edge.source!==edge.target)
      graph.setEdge(edge.source,edge.target,{},edge.id);
  }
  dagre.layout(graph);
  return {...doc,nodes:doc.nodes.map(node=>{
    const p=graph.node(node.id);
    if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y))return node;
    const size=cardSize(node);
    return {...node,position:{x:Math.round(p.x-size.width/2),y:Math.round(p.y-size.height/2)}};
  })};
}
