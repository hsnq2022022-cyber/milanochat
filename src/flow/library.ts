import { edgeFor, exampleFlow, importFlow, loadFlow, makeNode, getInvalidDraftBackups } from "./model.ts";
import type { FlowDocument } from "./model";

export const FLOW_LIBRARY_KEY="social_flow_library_v1";
export type SavedFlow={id:string;doc:FlowDocument;enabled?:boolean};
export type LocalBackup = {key:string;sourceKey:string;raw:string};
export type RecoveryReport = { messages: string[]; recovered: number; skipped: number; backups:LocalBackup[] };
export type FlowLibrary={activeFlowId:string;flows:SavedFlow[]};
let lastRecoveryReport: RecoveryReport={messages:[],recovered:0,skipped:0,backups:[]};
export function getLibraryRecoveryReport(): RecoveryReport {
  return {...lastRecoveryReport,messages:[...lastRecoveryReport.messages],
    backups:lastRecoveryReport.backups.map(b=>({...b}))};
}
function protectRaw(sourceKey:string,raw:string):void {
  const key="social_flow_backup_"+new Date().toISOString()+"_"+sourceKey;
  lastRecoveryReport.backups.push({key,sourceKey,raw});
  try{localStorage.setItem(key,raw);}catch{
    lastRecoveryReport.messages.push("تعذّر تخزين النسخة الاحتياطية؛ نزّل نسخة من التنبيه قبل المتابعة.");
  }
}

export function blankFlow(name:string,fromScratch=false):FlowDocument {
  const trigger=makeNode("trigger",{x:420,y:60},{title:"بداية المحادثة",triggerMode:"message",keywords:""});
  const message=makeNode("message",{x:420,y:330},{title:"الرسالة الأولى",text:"مرحباً! شلون نكدر نساعدك؟"});
  if(fromScratch)return {version:3,name,nodes:[trigger],edges:[]};
  return {version:3,name,nodes:[trigger,message],edges:[
    edgeFor({source:trigger.id,sourceHandle:"next",target:message.id,targetHandle:"in"},"التالي")
  ]};
}

export function loadLibrary():FlowLibrary {
  lastRecoveryReport={messages:[],recovered:0,skipped:0,backups:[]};
  if(typeof window!=="undefined"){
    let raw:string|null=null;
    try{raw=localStorage.getItem(FLOW_LIBRARY_KEY);}
    catch{lastRecoveryReport.messages.push("تعذّر قراءة تخزين المتصفح. لم نُعدّل بياناتك.");}
    if(raw){
      try{
        const data:unknown=JSON.parse(raw);
        if(data&&typeof data==="object"&&"flows" in data&&Array.isArray(data.flows)){
          const arr:SavedFlow[]=[];
          const items=data.flows as unknown[];
          for(const item of items.slice(0,30)){
            if(!item||typeof item!=="object"||typeof (item as SavedFlow).id!=="string"||(item as SavedFlow).id.length>128){
              lastRecoveryReport.skipped++;continue;
            }
            const candidate=item as SavedFlow, doc=importFlow(candidate.doc);
            if(doc&&!arr.some(x=>x.id===candidate.id)){
              arr.push({id:candidate.id,doc,enabled:candidate.enabled===true});
            }else lastRecoveryReport.skipped++;
          }
          lastRecoveryReport.skipped+=Math.max(0,items.length-30);
          lastRecoveryReport.recovered=arr.length;
          if(lastRecoveryReport.skipped)protectRaw(FLOW_LIBRARY_KEY,raw);
          if(lastRecoveryReport.skipped)
            lastRecoveryReport.messages.push("استُرجع "+arr.length+" تدفق، وتُجاهل "+lastRecoveryReport.skipped+" عنصر غير صالح أو زائد. لم تُحذف النسخة الأصلية.");
          if(arr.length){
            const active=String("activeFlowId" in data?data.activeFlowId:"");
            return {activeFlowId:arr.some(x=>x.id===active)?active:arr[0].id,flows:arr};
          }
          if(!lastRecoveryReport.backups.some(b=>b.sourceKey===FLOW_LIBRARY_KEY))protectRaw(FLOW_LIBRARY_KEY,raw);
          lastRecoveryReport.messages.push("لم يمكن استرجاع تدفق صالح من المكتبة المحفوظة. بيانات التخزين الأصلية باقية.");
        }else {protectRaw(FLOW_LIBRARY_KEY,raw);lastRecoveryReport.messages.push("صيغة مكتبة التدفقات غير صالحة؛ استخدم تصدير نسخة احتياطية قبل أي تعديل.");}
      }catch{
        protectRaw(FLOW_LIBRARY_KEY,raw);
        lastRecoveryReport.messages.push("ملف مكتبة التدفقات المحلية تالف (JSON غير صالح). لم يُحذف أو يُكتب فوقه أثناء الاسترجاع.");
      }
    }
  }
  const fallback=typeof window==="undefined"?exampleFlow():loadFlow();
  for(const record of getInvalidDraftBackups()){
    lastRecoveryReport.backups.push(record);
    lastRecoveryReport.messages.push("تم العثور على مسودة محلية تالفة وحُفظت نسختها الخام: "+record.sourceKey);
  }
  return {activeFlowId:"default",flows:[{id:"default",doc:fallback,enabled:false}]};
}

export function snapshotLibrary(activeFlowId:string,doc:FlowDocument,flows:SavedFlow[]):FlowLibrary {
  return {activeFlowId,flows:flows.map(flow=>flow.id===activeFlowId?{...flow,doc}:flow)};
}

export function saveLibrary(lib:FlowLibrary) {
  localStorage.setItem(FLOW_LIBRARY_KEY,JSON.stringify(lib));
}
