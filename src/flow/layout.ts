import dagre from "@dagrejs/dagre";
import type { FlowDocument, FlowNode } from "./model";

/**
 * A top-to-bottom layout sized to the actual content of each card.
 * Dagre reports node centers; React Flow stores top-left coordinates.
 * Only coordinates change: node IDs, settings, connections, and images survive.
 */
export function cardSize(node: FlowNode): { width: number; height: number } {
  const d=node.data;
  const count=d.kind==="question"&&d.inputMode!=="buttons"?2:
    ["message","question","condition","randomizer","request"].includes(d.kind)?
      (d.kind==="condition"||d.kind==="request"?2:
      d.kind==="question"&&d.inputMode!=="buttons"?2:
      1+d.options.length):d.kind==="end"||d.kind==="goto"?0:1;
  const rows=Math.ceil(count/Math.max(1,Math.min(3,count)));
  const imageExtra=!!d.image&&["message","question"].includes(d.kind)?144:0;
  const textExtra=d.text.length>160?52:d.text.length>80?24:0;
  const contentExtra=d.kind==="trigger"?44:d.kind==="question"||d.kind==="message"?48+textExtra:36;
  return {width:280,height:58+contentExtra+imageExtra+(count?Math.max(1,rows)*55+18:22)+22};
}

export function arrangeFlow(doc: FlowDocument): FlowDocument {
  if(!doc.nodes.length)return doc;
  const graph=new dagre.graphlib.Graph({multigraph:true});
  graph.setDefaultEdgeLabel(()=>({}));
  graph.setGraph({rankdir:"TB",nodesep:110,ranksep:140,marginx:65,marginy:65,ranker:"network-simplex"});
  for(const node of doc.nodes){
    graph.setNode(node.id,cardSize(node));
  }
  for(const edge of doc.edges) {
    if(graph.hasNode(edge.source)&&graph.hasNode(edge.target)&&edge.source!==edge.target){
      graph.setEdge(edge.source,edge.target,{},edge.id);
    }
  }
  dagre.layout(graph);
  return {...doc,nodes:doc.nodes.map(node=>{
    const position=graph.node(node.id);
    if(!position||!Number.isFinite(position.x)||!Number.isFinite(position.y))return node;
    const size=cardSize(node);
    return {...node,position:{x:Math.round(position.x-size.width/2),y:Math.round(position.y-size.height/2)}};
  })};
}
