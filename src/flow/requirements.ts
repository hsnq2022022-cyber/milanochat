/**
 * PURE capability derivation for a flow document (shared by the editor and the
 * flow-publication Edge Function; no Deno/browser globals, never throws).
 *
 * Every node maps to stable capability ids through one table (nodeRequirements).
 * The derived `engine` is INTERNAL ONLY (never display it): it names which
 * server runtime class the document targets IF it is otherwise valid. The
 * server classifiers stay authoritative (milan-api flowPrepareMessage.ts
 * simpleFlowDocumentSupported, flowDurableIngress.ts supportedDurableDocument /
 * durableRuntimeNeeds / durableNeedsInternalActions, commentTrigger.ts
 * commentFlowPlan, publicationGate.ts flowNeedsMedia); tests/flow-requirements
 * .test.ts proves parity over a corpus. Shapes no live engine runs are
 * "unsupported_block" with a reason code (never live).
 */
export type Capability=
 |"trigger_message"|"keyword_trigger"|"message_scope"
 |"comment_trigger"|"public_reply"|"private_reply"
 |"text"|"media_image"|"buttons"|"website_buttons"|"typed_question"
 |"delay"|"conditions"|"variables"|"randomizer"|"goto"
 |"internal_actions"|"ai_step"
 /** Document level: a flow the simple one-reply runtime cannot answer (several steps, variables, ...). */
 |"multi_step"|"unsupported_block";
export const CAPABILITIES:readonly Capability[]=["trigger_message","keyword_trigger","message_scope",
 "comment_trigger","public_reply","private_reply","text","media_image","buttons","website_buttons",
 "typed_question","delay","conditions","variables","randomizer","goto","internal_actions","ai_step","multi_step","unsupported_block"];
/** Why a node is never live (stable codes; see capabilityReasons.ts for plain text). */
export type UnsupportedReason=
 |"malformed_document"|"unknown_block"|"trigger_not_supported"|"trigger_channel_mismatch"
 |"pdf_not_supported"|"number_question_not_supported"|"http_request_not_supported"
 |"content_blocks_not_supported"|"legacy_image_not_supported"|"button_action_not_supported"
 |"mixed_buttons_not_supported"|"inbound_message_condition"|"action_not_supported";
export type FlowEngineClass="simple"|"durable"|"comment";
export type ProviderPlatform="instagram"|"facebook"|"whatsapp";
export type AvailabilityEntry={available:boolean;reason:string|null};
export type Availability=Partial<Record<Capability,AvailabilityEntry>>;
export type NodeRequirement={capabilities:Capability[];unsupported:UnsupportedReason[]};
export type Requirements={
 /** false = malformed input (fail closed: engine null, unsupported_block required). */
 ok:boolean;
 /** INTERNAL ONLY. null = no live engine can run this document. */
 engine:FlowEngineClass|null;
 required:Capability[];
 /** Capabilities per node id (deterministic order). */
 nodes:Record<string,Capability[]>;
 unsupported:Array<{nodeId:string|null;reason:UnsupportedReason}>;
 /** Required capabilities not available (availability given), with node ids. null = no availability map given. */
 unavailable:Array<{capability:Capability;reason:string;nodeIds:string[]}>|null;
};

type Rec=Record<string,unknown>;
const rec=(v:unknown):v is Rec=>!!v&&typeof v==="object"&&!Array.isArray(v);
const str=(v:unknown)=>typeof v==="string"?v:"";
const INTERNAL=new Set(["tag","untag","notify","handoff"]);
const TYPED=new Set(["text","email","phone"]);
const DOC_PLATFORM:Record<ProviderPlatform,string>={instagram:"instagram",facebook:"messenger",whatsapp:"whatsapp"};

/** Capabilities ONE node needs (the table). Malformed data -> unknown_block. */
export function nodeRequirements(data:unknown,platform?:ProviderPlatform|null):NodeRequirement{
 const caps=new Set<Capability>(),why=new Set<UnsupportedReason>();
 const bad=(r:UnsupportedReason)=>{caps.add("unsupported_block");why.add(r);};
 if(!rec(data)){bad("unknown_block");return out(caps,why);}
 const d=data;
 switch(d.kind){
  case "trigger":{
   const mode=d.triggerMode;
   if(mode==="message")caps.add("trigger_message");
   else if(mode==="keyword")caps.add("keyword_trigger");
   else if(mode==="comment"){caps.add("comment_trigger");if(str(d.publicReplyText).trim())caps.add("public_reply");}
   else bad("trigger_not_supported");
   if(Object.prototype.hasOwnProperty.call(d,"messageScope"))caps.add("message_scope");
   if(platform&&d.platform!==DOC_PLATFORM[platform])bad("trigger_channel_mismatch");
   break;
  }
  case "message":case "question":{
   if(str(d.text).trim())caps.add("text");
   if(str(d.image))bad("legacy_image_not_supported");
   const blocks=Array.isArray(d.contentBlocks)?d.contentBlocks:[];
   let images=0;
   for(const b of blocks){
    const t=rec(b)?b.type:undefined;
    if(t==="image"){caps.add("media_image");images++;}
    else if(t==="text")caps.add("text");
    else if(t==="pdf")bad("pdf_not_supported");
    else bad("content_blocks_not_supported"); // inline delay, data collection, unknown
   }
   if(blocks.length>0&&images===0&&!why.size)bad("content_blocks_not_supported");
   if(d.kind==="question"){
    if(d.inputMode==="buttons")caps.add("buttons");
    else if(TYPED.has(str(d.inputMode)))caps.add("typed_question");
    else if(d.inputMode==="number")bad("number_question_not_supported");
    else bad("unknown_block");
   }
   const opts=Array.isArray(d.options)?d.options:[];
   let site=0,step=0;
   for(const o of opts){
    const a=rec(o)?o.action:undefined;
    if(a==="website"&&d.kind==="message"){site++;caps.add("website_buttons");}
    else if(a===undefined||a==="step"){step++;if(d.kind==="message")caps.add("buttons");}
    else bad("button_action_not_supported");
   }
   if(site>0&&step>0)bad("mixed_buttons_not_supported");
   break;
  }
  case "delay":caps.add("delay");break;
  case "condition":
   caps.add("conditions");
   if(d.conditionField==="message")caps.add("trigger_message"); // inbound text test (simple shape only)
   break;
  case "action":
   if(INTERNAL.has(str(d.actionType)))caps.add("internal_actions");
   else if(d.actionType==="set_field")caps.add("variables");
   else if(d.actionType==="ai")caps.add("ai_step");
   else bad("action_not_supported");
   break;
  case "randomizer":caps.add("randomizer");break;
  case "goto":caps.add("goto");break;
  case "end":break;
  case "request":bad("http_request_not_supported");break;
  default:bad("unknown_block");
 }
 return out(caps,why);
}
const out=(caps:Set<Capability>,why:Set<UnsupportedReason>):NodeRequirement=>({
 capabilities:CAPABILITIES.filter(c=>caps.has(c)),unsupported:[...why].sort()});

/** The two shapes the simple engine answers (flowPrepareMessage.ts simpleReply). */
function simpleShape(nodes:Rec[],edges:Rec[]):boolean{
 const kinds=nodes.map(n=>(n.data as Rec).kind);
 const count=(k:string)=>kinds.filter(x=>x===k).length;
 const lone=nodes.length===2&&edges.length===1&&count("trigger")===1&&count("message")===1;
 const cond=nodes.length===4&&edges.length===3&&count("trigger")===1&&count("message")===2&&count("condition")===1&&
  (nodes.find(n=>(n.data as Rec).kind==="condition")!.data as Rec).conditionField==="message";
 if(!lone&&!cond)return false;
 const t=nodes.find(n=>(n.data as Rec).kind==="trigger")!.data as Rec;
 if(t.triggerMode!=="message"&&t.triggerMode!=="keyword")return false;
 return nodes.every(n=>{
  const d=n.data as Rec;
  return d.kind!=="message"||(Array.isArray(d.options)&&d.options.length===0&&
   Array.isArray(d.contentBlocks)&&d.contentBlocks.length===0&&!str(d.image));
 });
}

/**
 * Requirements of a document for an account platform. `availability` (from the
 * server `capabilities` action) yields `unavailable`; a capability absent from
 * the map counts as unavailable (fail closed). unsupported_block is never available.
 */
export function deriveRequirements(document:unknown,platform?:ProviderPlatform|null,availability?:Availability|null):Requirements{
 try{
  if(!rec(document)||!Array.isArray(document.nodes)||!Array.isArray(document.edges)||
     document.nodes.length===0||!document.nodes.every(n=>rec(n)&&typeof n.id==="string"&&rec(n.data)))
   return malformed(availability);
  const nodes=document.nodes as Rec[],edges=document.edges.filter(rec) as Rec[];
  const per:Record<string,Capability[]>={},unsupported:Requirements["unsupported"]=[];
  const required=new Set<Capability>();
  for(const n of nodes){
   const r=nodeRequirements(n.data,platform);
   per[n.id as string]=r.capabilities;
   r.capabilities.forEach(c=>required.add(c));
   r.unsupported.forEach(reason=>unsupported.push({nodeId:n.id as string,reason}));
  }
  const triggers=nodes.filter(n=>(n.data as Rec).kind==="trigger");
  if(triggers.length!==1){required.add("unsupported_block");unsupported.push({nodeId:null,reason:"malformed_document"});}
  const comment=required.has("comment_trigger");
  if(comment){
   // The comment runtime sends ONE plain private reply: message nodes are that reply.
   for(const n of nodes)if((n.data as Rec).kind==="message"){
    const caps=per[n.id as string];
    if(caps.includes("text"))per[n.id as string]=CAPABILITIES.filter(c=>c==="private_reply"||(c!=="text"&&caps.includes(c)));
   }
   required.delete("text");
   if(nodes.some(n=>(n.data as Rec).kind==="message"))required.add("private_reply");
  }
  const simple=!comment&&simpleShape(nodes,edges);
  // An inbound-text condition exists only in the simple shape.
  if(!simple)for(const n of nodes){
   const d=n.data as Rec;
   if(d.kind==="condition"&&d.conditionField==="message"){
    required.add("unsupported_block");unsupported.push({nodeId:n.id as string,reason:"inbound_message_condition"});
    per[n.id as string]=CAPABILITIES.filter(c=>c==="unsupported_block"||(per[n.id as string].includes(c)&&c!=="trigger_message"));
   }
  }
  if(!simple&&!nodes.some(n=>{const d=n.data as Rec;return d.kind==="trigger"&&d.triggerMode==="message";}))
   required.delete("trigger_message");
  if(simple)required.delete("conditions"); // the simple engine's own inbound condition
  const engine:FlowEngineClass|null=required.has("unsupported_block")?null:comment?"comment":simple?"simple":"durable";
  if(engine==="durable")required.add("multi_step");
  return finish({ok:true,engine,required,per,unsupported},availability);
 }catch{
  return malformed(availability);
 }
}
function malformed(availability?:Availability|null):Requirements{
 return finish({ok:false,engine:null,required:new Set(["unsupported_block"]),per:{},
  unsupported:[{nodeId:null,reason:"malformed_document"}]},availability);
}
function finish(r:{ok:boolean;engine:FlowEngineClass|null;required:Set<Capability>;per:Record<string,Capability[]>;
 unsupported:Requirements["unsupported"]},availability?:Availability|null):Requirements{
 const required=CAPABILITIES.filter(c=>r.required.has(c));
 let unavailable:Requirements["unavailable"]=null;
 if(availability){
  unavailable=[];
  for(const c of required){
   const a=availability[c];
   const ok=c!=="unsupported_block"&&rec(a)&&a.available===true;
   if(ok)continue;
   const nodeIds=Object.keys(r.per).filter(id=>r.per[id].includes(c)).sort();
   const reason=c==="unsupported_block"?(r.unsupported[0]?.reason??"not_supported"):
    rec(a)&&typeof a.reason==="string"&&a.reason?a.reason:"unavailable";
   unavailable.push({capability:c,reason,nodeIds});
  }
 }
 return {ok:r.ok,engine:r.engine,required,nodes:r.per,unsupported:r.unsupported,unavailable};
}
