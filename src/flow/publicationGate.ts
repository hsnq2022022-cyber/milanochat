import {validateDocument} from "./model.ts";
import type {FlowDocument,FlowData,Kind} from "./model";
import type {SavedFlow} from "./library";

export type FlowCapability=
  | "execution-engine"
  | "instagram"|"messenger"|"whatsapp"
  | "trigger:message"|"trigger:keyword"|"trigger:comment"|"trigger:story"|"trigger:ad"|"trigger:live"|"trigger:referral"
  | "message:text"|"message:image"|"message:pdf"|"message:buttons"|"message:link"
  | "question:buttons"|"question:text"|"question:email"|"question:phone"|"question:number"
  | "condition"|"delay"|"action:tag"|"action:untag"|"action:set_field"
  | "action:handoff"|"action:notify"|"action:ai"|"randomizer"|"goto"|"request:https";
export type ReleaseIssue={severity:"error"|"warning";message:string;nodeId?:string;capability?:FlowCapability};
export type ReleaseAudit={canPublish:boolean;issues:ReleaseIssue[];required:FlowCapability[]};

/** The browser must NEVER supply its own trusted capabilities to a publishing endpoint.
 * An authenticated server supplies this set from deployed runtime support and Meta permissions.
 * The default empty set deliberately FAILS CLOSED until backend is implemented.
 */
export function auditFlowPublication(
  doc:FlowDocument,
  capabilities:ReadonlySet<FlowCapability>=new Set(),
  library?:SavedFlow[]
):ReleaseAudit {
  const issues:ReleaseIssue[]=validateDocument(doc,library);
  const required=new Set<FlowCapability>();
  const need=(cap:FlowCapability,nodeId?:string)=>{
    required.add(cap);
    if(!capabilities.has(cap))
      issues.push({severity:"error",message:"محرك التنفيذ لا يدعم الميزة حتى الآن: "+cap,nodeId,capability:cap});
  };
  need("execution-engine");
  for(const node of doc.nodes){
    const d:FlowData=node.data;
    if(d.kind==="trigger"){
      need(d.platform,node.id);
      need(("trigger:"+d.triggerMode) as FlowCapability,node.id);
    }else if(d.kind==="message"||d.kind==="question"){
      if(d.text.trim())need("message:text",node.id);
      if(d.image)need("message:image",node.id);
      for(const b of d.contentBlocks||[]){
        if(b.type==="text")need("message:text",node.id);
        else if(b.type==="image")need("message:image",node.id);
        else if(b.type==="pdf")need("message:pdf",node.id);
        else if(b.type==="delay")need("delay",node.id);
        else if(b.type==="collection")need(("question:"+(b.inputMode||"text")) as FlowCapability,node.id);
      }
      if(d.kind==="question")need(("question:"+d.inputMode) as FlowCapability,node.id);
      for(const option of d.options||[]){
        if(option.action==="website")need("message:link",node.id);
        else if(option.action==="flow")need("goto",node.id);
        else if(option.action==="ai")need("action:ai",node.id);
        else if(option.action==="actions")need("action:set_field",node.id);
        else if(option.action==="condition")need("condition",node.id);
        else if(option.action==="randomizer")need("randomizer",node.id);
        else need("message:buttons",node.id);
      }
    }else if(d.kind==="action")need(("action:"+d.actionType) as FlowCapability,node.id);
    else if(d.kind==="request")need("request:https",node.id);
    else if(["condition","delay","randomizer","goto"].includes(d.kind))
      need(d.kind as FlowCapability,node.id);
  }
  return {canPublish:!issues.some(x=>x.severity==="error"),issues,required:[...required]};
}
