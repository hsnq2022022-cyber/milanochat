import type { Node, Edge, XYPosition, Connection } from "@xyflow/react";

export type Kind = "trigger" | "message" | "question" | "condition" | "delay" | "action" | "randomizer" | "goto" | "request" | "end";
export type Platform = "instagram" | "messenger" | "whatsapp";
export type TriggerMode = "keyword" | "message" | "comment" | "story" | "ad" | "live" | "referral";
export type ButtonAction = "step" | "flow" | "website" | "ai" | "actions" | "condition" | "randomizer";
export type Choice = {
  id: string; label: string; weight?: number;
  buttonType?: "button" | "quick_reply";
  action?: ButtonAction;
  targetFlowId?: string;
  url?: string;
};
export type ContentBlock = {
  id: string;
  type: "text" | "image" | "pdf" | "delay" | "collection";
  text?: string;
  url?: string;
  seconds?: number;
  field?: string;
  inputMode?: "text" | "email" | "phone" | "number";
};
export const PLATFORM_LABELS: Record<Platform,string> = {
  instagram:"Instagram", messenger:"Messenger", whatsapp:"WhatsApp"
};
export const TRIGGER_OPTIONS: Record<Platform,Array<{id:TriggerMode;label:string}>> = {
  instagram:[
    {id:"message",label:"العميل يرسل رسالة"}, {id:"keyword",label:"رسالة تحتوي كلمة"},
    {id:"comment",label:"تعليق على منشور أو Reel"}, {id:"story",label:"رد على Story"},
    {id:"ad",label:"النقر على إعلان Instagram"}, {id:"live",label:"تعليق على البث المباشر"}
  ],
  messenger:[
    {id:"message",label:"العميل يرسل رسالة"}, {id:"keyword",label:"رسالة تحتوي كلمة"},
    {id:"comment",label:"تعليق على منشور"}, {id:"referral",label:"الدخول من رابط Messenger"}
  ],
  whatsapp:[
    {id:"message",label:"وصول رسالة WhatsApp"}, {id:"keyword",label:"رسالة تحتوي كلمة"}
  ]
};
export type FlowData = Record<string, unknown> & {
  kind: Kind;
  title: string;
  text: string;
  image: string;
  options: Choice[];
  contentBlocks: ContentBlock[];
  platform: Platform;
  keywords: string;
  triggerMode: TriggerMode;
  inputMode: "buttons" | "text" | "email" | "phone" | "number";
  inputField: string;
  conditionField: string;
  operator: "contains" | "equals" | "not_equals" | "exists";
  conditionValue: string;
  delayValue: number;
  delayUnit: "seconds" | "minutes" | "hours" | "days";
  actionType: "tag" | "untag" | "set_field" | "handoff" | "notify";
  actionValue: string;
  gotoNode: string;
  requestMethod: "GET" | "POST";
  requestUrl: string;
};
export type FlowNode = Node<FlowData, "flowNode">;
export type FlowEdge = Edge<Record<string, unknown> & { label?: string }, "flowEdge">;
export type FlowDocument = { version: 3; name: string; nodes: FlowNode[]; edges: FlowEdge[] };
export const SAVE_KEY = "social_flow_reactflow_v3";
export const LEGACY_KEY = "social_flow_visual_v2";
export const LABELS: Record<Kind, string> = {
  trigger: "بداية الأتمتة", message: "إرسال رسالة", question: "سؤال وجمع بيانات",
  condition: "شرط", delay: "انتظار ذكي", action: "إجراء",
  randomizer: "توزيع عشوائي", goto: "الانتقال لخطوة", request: "طلب خارجي", end: "نهاية",
};
export const ACCENT: Record<Kind,string> = {
  trigger:"#3DD189", message:"#60A5FA", question:"#A78BFA", condition:"#E5B54B",
  delay:"#94A3B8", action:"#2DD4BF", randomizer:"#FB923C", goto:"#22D3EE",
  request:"#38BDF8", end:"#F87171",
};
export const KIND_LIST = Object.keys(LABELS) as Kind[];
const id = () => crypto.randomUUID();
export function makeNode(kind: Kind, position: XYPosition, opts?: Partial<FlowData>): FlowNode {
  return {
    id: id(), position, type:"flowNode",
    data: {
      kind, title: LABELS[kind], text: kind==="message"?"أهلاً بيك! شلون نكدر نساعدك؟":kind==="question"?"اختار شتحتاج":"", image:"",
      options: kind==="question"?[{id:id(),label:"الأسعار"},{id:id(),label:"موظف"}]:kind==="randomizer"?[{id:id(),label:"A",weight:50},{id:id(),label:"B",weight:50}]:[],
      contentBlocks:[],platform:"instagram",keywords:"",triggerMode:"keyword",inputMode:"buttons",inputField:"response",
      conditionField:"message",operator:"contains",conditionValue:"",
      delayValue:1,delayUnit:"minutes",actionType:"tag",actionValue:"",
      gotoNode:"",requestMethod:"GET",requestUrl:"",...opts,
    }
  };
}
export function outputs(node: FlowNode): Choice[] {
  const d=node.data;
  if(d.kind==="end"||d.kind==="goto")return [];
  if(d.kind==="question")return d.inputMode==="buttons"?d.options.filter(o=>!o.action||o.action==="step"):[{id:"valid",label:"صحيح"},{id:"invalid",label:"غير صحيح"}];
  if(d.kind==="message")return [{id:"next",label:"التالي"},...d.options.filter(o=>!o.action||o.action==="step")];
  if(d.kind==="condition")return [{id:"yes",label:"نعم"},{id:"no",label:"لا"}];
  if(d.kind==="request")return [{id:"success",label:"نجاح"},{id:"error",label:"خطأ"}];
  if(d.kind==="randomizer")return d.options;
  return [{id:"next",label:"التالي"}];
}
export function edgeFor(connection: Connection, label=""): FlowEdge {
  return {id:id(),type:"flowEdge",source:connection.source,target:connection.target,
    sourceHandle:connection.sourceHandle||"next",targetHandle:connection.targetHandle||"in",data:{label}};
}
export function canConnect(c: Connection, doc: FlowDocument, ignoredEdgeId?: string): boolean {
  if(!c.source||!c.target||c.source===c.target||!c.sourceHandle)return false;
  const from=doc.nodes.find(n=>n.id===c.source),to=doc.nodes.find(n=>n.id===c.target);
  if(!from||!to||from.data.kind==="end"||from.data.kind==="goto"||to.data.kind==="trigger")return false;
  if(!outputs(from).some(p=>p.id===c.sourceHandle))return false;
  if(c.targetHandle&&c.targetHandle!=="in")return false;
  return !doc.edges.some(e=>e.id!==ignoredEdgeId&&e.source===c.source&&e.sourceHandle===c.sourceHandle&&e.target===c.target);
}
export function upsertConnection(doc: FlowDocument,c: Connection, ignoredEdgeId?:string): FlowDocument {
  if(!canConnect(c,doc,ignoredEdgeId))return doc;
  const from=doc.nodes.find(n=>n.id===c.source)!;
  const label=outputs(from).find(p=>p.id===c.sourceHandle)?.label || "";
  const next=doc.edges.filter(e=>e.id!==ignoredEdgeId&&!(e.source===c.source&&e.sourceHandle===c.sourceHandle));
  return {...doc,edges:[...next,edgeFor(c,label)]};
}
export function exampleFlow(): FlowDocument {
  const a=makeNode("trigger",{x:400,y:0},{title:"عند إرسال كلمة",keywords:"TOD, اشتراكات"});
  const b=makeNode("message",{x:400,y:250},{title:"الترحيب",text:"أهلاً بيك! اختار الخدمة التي تحتاجها."});
  const c=makeNode("question",{x:400,y:525},{title:"اختيار البلد",text:"اختار دولتك",options:[{id:id(),label:"العراق"},{id:id(),label:"عمان"},{id:id(),label:"الإمارات"}]});
  const ds=c.data.options.map((o,i)=>makeNode("message",{x:i*355-10,y:875},{title:"أسعار "+o.label,text:"تواصل ويانا لمعرفة الأسعار الحالية لخدمتك في "+o.label+"."}));
  const edges=[edgeFor({source:a.id,sourceHandle:"next",target:b.id,targetHandle:"in"}),edgeFor({source:b.id,sourceHandle:"next",target:c.id,targetHandle:"in"}),...ds.map((n,i)=>edgeFor({source:c.id,sourceHandle:c.data.options[i].id,target:n.id,targetHandle:"in"},c.data.options[i].label))];
  return {version:3,name:"تدفق ترحيبي",nodes:[a,b,c,...ds],edges};
}
export function validateDocument(doc: FlowDocument): string[] {
  const errors:string[]=[];if(!doc.nodes.length||doc.nodes.length>100)errors.push("عدد الخطوات يجب أن يكون بين 1 و100.");
  if(doc.edges.length>250)errors.push("التوصيلات تتجاوز الحد الأقصى.");
  const starts=doc.nodes.filter(n=>n.data.kind==="trigger");if(starts.length!==1)errors.push("أضف خطوة بداية واحدة فقط.");
  const ids=new Set(doc.nodes.map(n=>n.id));if(ids.size!==doc.nodes.length)errors.push("تكرار معرّفات الخطوات.");
  const unique=new Set<string>();
  for(const n of doc.nodes){
    if(["message","question"].includes(n.data.kind)&&!n.data.text.trim()&&!n.data.image&&!n.data.contentBlocks?.some(b=>b.type!=="delay"))errors.push("محتوى الرسالة فارغ: "+n.data.title);
    if(n.data.kind==="trigger"&&!TRIGGER_OPTIONS[n.data.platform]?.some(t=>t.id===n.data.triggerMode))errors.push("حدث البداية غير متاح للقناة المحددة.");
    for(const option of n.data.options){
      if(option.action==="website"&&(!option.url||!/^https:\/\/\S+$/i.test(option.url)))errors.push("رابط الموقع للزر "+option.label+" يجب أن يبدأ بـ HTTPS.");
      if(option.action==="flow"&&!option.targetFlowId)errors.push("اختر التدفق المرتبط بالزر "+option.label+".");
    }
    for(const block of n.data.contentBlocks||[]){
      if(["image","pdf"].includes(block.type)&&!(/^https:\/\/\S+$/i.test(block.url||"")||block.type==="image"&&/^data:image\/(?:webp|jpeg|png);base64,/i.test(block.url||"")))errors.push("رابط "+(block.type==="pdf"?"PDF":"الصورة")+" غير صالح في "+n.data.title);
    }
    if(n.data.image&&!/^https:\/\//i.test(n.data.image)&&!/^data:image\/(?:png|jpeg|webp);base64,/i.test(n.data.image))errors.push("رابط صورة غير آمن: "+n.data.title);
    if(n.data.kind==="question"&&n.data.inputMode==="buttons"&&n.data.options.length===0)errors.push("أضف خيارًا إلى "+n.data.title);
    if(n.data.kind==="randomizer"&&Math.abs(n.data.options.reduce((sum,o)=>sum+(o.weight||0),0)-100)>.01)errors.push("مجموع نسب التوزيع يجب أن يساوي 100%.");
    if(n.data.kind==="delay"&&n.data.delayValue<=0)errors.push("حدد مدة انتظار موجبة.");
    if(n.data.kind==="request"&&n.data.requestUrl&&!/^https:\/\//i.test(n.data.requestUrl))errors.push("الطلب الخارجي يتطلب HTTPS.");
  }
  for(const e of doc.edges){
    if(!ids.has(e.source)||!ids.has(e.target))errors.push("خط متصل بخطوة محذوفة.");
    const signature=e.source+":"+(e.sourceHandle||"next");
    if(unique.has(signature))errors.push("هناك أكثر من اتصال لنفس مخرج الخطوة.");
    unique.add(signature);
    if(!canConnect({source:e.source,sourceHandle:e.sourceHandle||"next",target:e.target,targetHandle:e.targetHandle||"in"}, {...doc,edges:doc.edges.filter(x=>x.id!==e.id)}))errors.push("توصيل غير صالح.");
  }
  return [...new Set(errors)];
}
const safeString=(v:unknown,d="")=>typeof v==="string"?v:d;
const kindOf=(v:unknown):Kind=>KIND_LIST.includes(v as Kind)?v as Kind:"message";
function cleanImported(raw:unknown): FlowDocument | null {
  if(!raw||typeof raw!=="object")return null;
  const val=raw as Record<string,unknown>;
  if(!Array.isArray(val.nodes)||!Array.isArray(val.edges)||val.nodes.length>100||val.edges.length>250||!val.nodes.length)return null;
  const nodes:FlowNode[]=[];
  for(const item of val.nodes){
    if(!item||typeof item!=="object")return null;
    const n=item as Record<string,unknown>, position=n.position as XYPosition|undefined;
    if(typeof n.id!=="string"||!position||!Number.isFinite(position.x)||!Number.isFinite(position.y)||Math.abs(position.x)>1e5||Math.abs(position.y)>1e5)return null;
    const d=n.data as Record<string,unknown>|undefined;if(!d||typeof d!=="object")return null;
    const kind=kindOf(d.kind);
    const options:Array<Choice>=Array.isArray(d.options)?d.options.slice(0,12).filter((x:unknown)=>!!x&&typeof x==="object").map((x:unknown)=>{const c=x as Record<string,unknown>;
      const action:ButtonAction=["step","flow","website","ai","actions","condition","randomizer"].includes(String(c.action))?c.action as ButtonAction:"step";
      return {id:safeString(c.id,id()),label:safeString(c.label).slice(0,100),weight:typeof c.weight==="number"?c.weight:undefined,
        buttonType:c.buttonType==="quick_reply"?"quick_reply":"button",action,
        targetFlowId:safeString(c.targetFlowId).slice(0,150),url:safeString(c.url).slice(0,2000)};
    }):[];
    const contentBlocks:ContentBlock[]=Array.isArray(d.contentBlocks)?d.contentBlocks.slice(0,24).filter((x:unknown)=>!!x&&typeof x==="object").map((x:unknown)=>{
      const b=x as Record<string,unknown>;
      return {id:safeString(b.id,id()),type:["text","image","pdf","delay","collection"].includes(String(b.type))?b.type as ContentBlock["type"]:"text",
        text:safeString(b.text).slice(0,2000),url:safeString(b.url).slice(0,1400000),seconds:typeof b.seconds==="number"&&Number.isFinite(b.seconds)?Math.max(1,Math.min(86400,b.seconds)):3,
        field:safeString(b.field,"response").slice(0,100),inputMode:["text","email","phone","number"].includes(String(b.inputMode))?b.inputMode as ContentBlock["inputMode"]:"text"};
    }):[];
    const clean=makeNode(kind,position,{title:safeString(d.title,LABELS[kind]).slice(0,120),text:safeString(d.text).slice(0,2000),image:safeString(d.image).slice(0,1500000),options,keywords:safeString(d.keywords).slice(0,500),
      platform:["instagram","messenger","whatsapp"].includes(String(d.platform))?d.platform as Platform:"instagram",contentBlocks,
      triggerMode:["keyword","message","comment","story","ad","live","referral"].includes(String(d.triggerMode))?d.triggerMode as FlowData["triggerMode"]:"keyword",
      inputMode:["buttons","text","email","phone","number"].includes(String(d.inputMode))?d.inputMode as FlowData["inputMode"]:"buttons",
      inputField:safeString(d.inputField,"response").slice(0,100),conditionField:safeString(d.conditionField,"message").slice(0,100),
      operator:["contains","equals","not_equals","exists"].includes(String(d.operator))?d.operator as FlowData["operator"]:"contains",
      conditionValue:safeString(d.conditionValue).slice(0,250),delayValue:typeof d.delayValue==="number"?d.delayValue:1,
      delayUnit:["seconds","minutes","hours","days"].includes(String(d.delayUnit))?d.delayUnit as FlowData["delayUnit"]:"minutes",
      actionType:["tag","untag","set_field","handoff","notify"].includes(String(d.actionType))?d.actionType as FlowData["actionType"]:"tag",
      actionValue:safeString(d.actionValue).slice(0,500),gotoNode:safeString(d.gotoNode),requestMethod:d.requestMethod==="POST"?"POST":"GET",requestUrl:safeString(d.requestUrl).slice(0,2048)});
    clean.id=n.id;nodes.push(clean);
  }
  const ids=new Set(nodes.map(n=>n.id));if(ids.size!==nodes.length)return null;
  const edges:FlowEdge[]=[];
  for(const item of val.edges){
    if(!item||typeof item!=="object")return null;const e=item as Record<string,unknown>;
    if(typeof e.source!=="string"||typeof e.target!=="string"||!ids.has(e.source)||!ids.has(e.target))return null;
    edges.push({id:safeString(e.id,id()),source:e.source,target:e.target,sourceHandle:safeString(e.sourceHandle,"next"),targetHandle:"in",type:"flowEdge",data:{label:safeString((e.data as Record<string,unknown>|undefined)?.label).slice(0,100)}});
  }
  return {version:3,name:safeString(val.name,"تدفق جديد").slice(0,100),nodes,edges};
}
export function importFlow(raw:unknown):FlowDocument|null {
  if(!raw||typeof raw!=="object")return null;
  const v=raw as Record<string,unknown>;
  if(v.version===3)return cleanImported(v);
  // Compatibility with the current site (v2). Preserve the user's local draft.
  if(v.version===2&&Array.isArray(v.nodes)&&Array.isArray(v.edges)){
    const nodes:FlowNode[]=[];
    for(const item of v.nodes){
      if(!item||typeof item!=="object")return null;const n=item as Record<string,unknown>,kind=kindOf(n.type);
      const options:Array<Choice>=Array.isArray(n.choices)?n.choices.map((c:unknown)=>{const t=c as Record<string,unknown>;return {id:safeString(t.id,id()),label:safeString(t.text),weight:kind==="randomizer"?Number(t.text)||0:undefined};}):[];
      const node=makeNode(kind,{x:Number(n.x)||0,y:Number(n.y)||0},{title:safeString(n.title,LABELS[kind]),text:safeString(n.text),image:safeString(n.image),keywords:safeString(n.keyword),
        options,delayValue:typeof n.delay==="number"?n.delay:1,delayUnit:"seconds"});
      node.id=safeString(n.id,id());nodes.push(node);
    }
    const ids=new Set(nodes.map(n=>n.id));const edges:FlowEdge[]=v.edges.filter((e:unknown)=>!!e&&typeof e==="object").map((it:unknown)=>{const e=it as Record<string,unknown>;return {id:safeString(e.id,id()),source:safeString(e.from),sourceHandle:safeString(e.port,"next"),target:safeString(e.to),targetHandle:"in",type:"flowEdge" as const,data:{}};}).filter(e=>ids.has(e.source)&&ids.has(e.target));
    return {version:3,name:safeString(v.name,"تدفق سابق"),nodes,edges};
  }
  return null;
}
export function loadFlow():FlowDocument {
  try{const modern=localStorage.getItem(SAVE_KEY);if(modern){const d=importFlow(JSON.parse(modern));if(d)return d;}
    const old=localStorage.getItem(LEGACY_KEY);if(old){const d=importFlow(JSON.parse(old));if(d)return d;}
  }catch{/* Browser storage may be blocked or malformed. */}
  return exampleFlow();
}
