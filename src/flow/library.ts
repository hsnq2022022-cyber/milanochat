import { edgeFor, exampleFlow, importFlow, loadFlow, makeNode } from "./model.ts";
import type { FlowDocument } from "./model";

export const FLOW_LIBRARY_KEY="social_flow_library_v1";
export type SavedFlow={id:string;doc:FlowDocument;enabled?:boolean};
export type FlowLibrary={activeFlowId:string;flows:SavedFlow[]};

export function blankFlow(name:string,fromScratch=false):FlowDocument {
  const trigger=makeNode("trigger",{x:420,y:60},{title:"بداية المحادثة",triggerMode:"message",keywords:""});
  const message=makeNode("message",{x:420,y:330},{title:"الرسالة الأولى",text:"مرحباً! شلون نكدر نساعدك؟"});
  if(fromScratch)return {version:3,name,nodes:[trigger],edges:[]};
  return {version:3,name,nodes:[trigger,message],edges:[
    edgeFor({source:trigger.id,sourceHandle:"next",target:message.id,targetHandle:"in"},"التالي")
  ]};
}

export function loadLibrary():FlowLibrary {
  if(typeof window!=="undefined") {
    try {
      const raw=localStorage.getItem(FLOW_LIBRARY_KEY);
      if(raw) {
        const data:unknown=JSON.parse(raw);
        if(data&&typeof data==="object"&&"flows" in data&&Array.isArray(data.flows)) {
          const arr:SavedFlow[]=[];
          for(const item of data.flows.slice(0,30)) {
            if(!item||typeof item!=="object"||typeof item.id!=="string"||item.id.length>128)continue;
            const doc=importFlow(item.doc);
            if(doc&& !arr.some(x=>x.id===item.id))arr.push({id:item.id,doc,enabled:item.enabled===true});
          }
          if(arr.length) {
            const active=String("activeFlowId" in data?data.activeFlowId:"");
            return {activeFlowId:arr.some(x=>x.id===active)?active:arr[0].id,flows:arr};
          }
        }
      }
    } catch { /* Fall back to existing single-flow draft; do not erase it. */ }
  }
  return {activeFlowId:"default",flows:[{id:"default",doc:typeof window==="undefined"?exampleFlow():loadFlow(),enabled:false}]};
}

export function snapshotLibrary(activeFlowId:string,doc:FlowDocument,flows:SavedFlow[]):FlowLibrary {
  return {activeFlowId,flows:flows.map(flow=>flow.id===activeFlowId?{...flow,doc}:flow)};
}

export function saveLibrary(lib:FlowLibrary) {
  localStorage.setItem(FLOW_LIBRARY_KEY,JSON.stringify(lib));
}
