import type {SupabaseClient} from "npm:@supabase/supabase-js@2";
import {hasPlaceholder,sanitizePlaceholders,clipUtf8Bytes} from "../../../src/flow/placeholders.ts";
import {keywordTriggerProblem,dmTriggerAcceptsText,MAX_INBOUND_TEXT} from "./triggerKeywords.ts";
import {selectActiveFlowForInbound} from "./flowInboundSelection.ts";
import {documentTriggerData} from "./triggerKeywords.ts";
import {classifyMessageScope,messageScopeAllowsFlow} from "./flowMessageScope.ts";
import {FlowRoutingUnavailableError} from "./exclusiveMessageClaim.ts";
type Platform ="instagram" | "facebook" | "whatsapp";

/**
 * V2 availability for an account whose global + tenant switches and operator
 * approval are ALREADY verified (the durable path checks them first): the
 * same FLOW_RUNTIME_MODE / platform rule prepareSimpleFlowReply applies.
 * Used by the durable path's selection so both paths rank identically.
 */
export function v2EngineAvailable(platform:string):boolean{
 let mode="";
 try{mode=Deno.env.get("FLOW_RUNTIME_MODE")??"";}catch{return false;}
 if(mode==="off")return false;
 return mode==="message_only"||platform==="instagram";
}

export type PrepareOptions={
 /**
  * Set by milan-api/index.ts ONLY while the durable ingress is configured
  * for this exact account/platform (flowDurableIngress.ts
  * durableIngressConfigured): returns true for documents the durable engine
  * runs. It lets V2 rank durable flows exactly like the durable path did, so
  * a durable winner is never replaced by a lower-ranked V2 flow (V2 then
  * returns null, as it did for a lone durable flow). Absent: durable
  * documents are not candidates here (unchanged behaviour).
  */
 durableDocument?:(document:unknown)=>boolean;
 /**
  * True only when milan-api proved this is the conversation's first customer
  * DM (conversationStart.ts). Gates triggers whose messageScope is
  * "conversation_start" (flowMessageScope.ts); absent/null/false = not a
  * start. Triggers without messageScope are unaffected.
  */
 conversationStart?:boolean|null;
};

/**
 * Deliberately minimal supported engine: ONE trigger(message, or keyword
 * with a matching inbound text) -> ONE text message. Never executes
 * requests/actions/delays or hidden side effects.
 * Several active flows: the single deterministic winner of
 * flowInboundSelection.ts (all active flows of this verified
 * tenant/account/platform, each at its exact activated revision). Only a V2
 * winner is answered here.
 * Unavailable/invalid graph, no matching flow or a durable winner -> null
 * and legacy AI is claimed instead (unchanged).
 * A READ ERROR on the automation switches, the activations or their
 * publications (flow eligibility UNKNOWN) throws FlowRoutingUnavailableError:
 * processExclusiveEvent then makes no claim and sends nothing, so the legacy
 * AI never answers a message a flow may own; milan-api keeps the event
 * retryable (inboundRoutingRetry.ts). A missing account id (e.g. a WhatsApp
 * wa_bindings account without a channel_accounts row) can own no activation:
 * null, as before.
 */
export async function prepareSimpleFlowReply(
 sb:SupabaseClient, tenantId:string, accountId:string, platform:Platform,
 incomingText:string="", options:PrepareOptions={},
):Promise<string|null>{
 const mode=Deno.env.get("FLOW_RUNTIME_MODE")??"";
 // An explicit emergency OFF always overrides database approvals.
 if(mode==="off")return null;
 let selection:Awaited<ReturnType<typeof selectActiveFlowForInbound>>;
 try{
  if(mode!=="message_only"){
   // No environment flag is required for an approved production account,
   // but BOTH independent database switches and operator approval are.
   if(platform!=="instagram")return null;
   const [global,tenant]=await Promise.all([
    sb.from("automation_flow_global_switch").select("enabled")
      .eq("singleton",true).maybeSingle(),
    sb.from("automation_flow_tenant_switches")
      .select("enabled,production_approved").eq("tenant_id",tenantId).maybeSingle()
   ]);
   if(global.error||tenant.error)throw new FlowRoutingUnavailableError();
   if(global.data?.enabled!==true||
      tenant.data?.enabled!==true||tenant.data?.production_approved!==true)
    return null;
  }
  // No channel_accounts id (index.ts passes String(account.id) for a WhatsApp
  // wa_bindings account): it can own no activation -> null, as before.
  if(typeof accountId!=="string"||!accountId||accountId==="undefined"||accountId==="null")return null;
  const durableDocument=options.durableDocument;
  selection=await selectActiveFlowForInbound(sb,{tenantId,accountId,platform},incomingText,
   doc=>simpleFlowDocumentSupported(doc,platform)?"v2":
    (durableDocument&&durableDocument(doc))?"durable":null,options.conversationStart);
 }catch(e){
  if(e instanceof FlowRoutingUnavailableError)throw e;
  return null;
 }
 if(selection.status==="error")throw new FlowRoutingUnavailableError();
 if(selection.status!=="selected"||selection.flow.engine!=="v2")return null;
 // Re-checked on the exact document (selection already required it).
 if(!messageScopeAllowsFlow(classifyMessageScope(documentTriggerData(selection.flow.document)),
   options.conversationStart))return null;
 try{
  return simpleMessageFromDocument(selection.flow.document,platform,incomingText);
 }catch{return null;}
}

/** Pure validation: no IO, actions, schedules or hidden side effects.
 * Supports: trigger(message|keyword)->message(text), and
 * trigger(message|keyword)->condition(message)->yes/no plain-text replies.
 * A keyword trigger needs >= 1 valid keyword (else unsupported = null) and
 * replies ONLY when incomingText matches (triggerKeywords.ts, same rule as
 * src/flow/eventRouting.ts); a non-matching message returns null, so the
 * caller claims the legacy AI route exactly as for an inactive flow.
 * Message triggers are unchanged: every message.
 */
export function simpleMessageFromDocument(
 raw:unknown,platform:Platform,incomingText:string=""
):string|null{
 return simpleReply(raw,platform,incomingText,true);
}
/**
 * Shape check only (activation / durable disjointness): true when the V2
 * engine supports this document, independent of any inbound text. For
 * message triggers identical to simpleMessageFromDocument(raw,platform,"")!==null.
 */
export function simpleFlowDocumentSupported(raw:unknown,platform:Platform):boolean{
 return simpleReply(raw,platform,"",false)!==null;
}
function simpleReply(
 raw:unknown,platform:Platform,incomingText:string,gateTrigger:boolean
):string|null{
 if(!raw||typeof raw!=="object"||Array.isArray(raw)||
    typeof incomingText!=="string"||incomingText.length>MAX_INBOUND_TEXT)return null;
 const doc=raw as Record<string,unknown>;
 if(doc.version!==3||!Array.isArray(doc.nodes)||!Array.isArray(doc.edges))return null;
 const nodes=doc.nodes as Record<string,unknown>[];
 const edges=doc.edges as Record<string,unknown>[];
 const conditional=nodes.length===4&&edges.length===3;
 if(!(nodes.length===2&&edges.length===1)&&!conditional)return null;
 if(nodes.some(n=>!n||typeof n!=="object"||typeof n.id!=="string"||!n.id||
   !n.data||typeof n.data!=="object")||
   new Set(nodes.map(n=>n.id)).size!==nodes.length)return null;
 const kind=(n:Record<string,unknown>)=>(n.data as Record<string,unknown>).kind;
 const starts=nodes.filter(n=>kind(n)==="trigger");
 const messages=nodes.filter(n=>kind(n)==="message");
 const conditions=nodes.filter(n=>kind(n)==="condition");
 if(starts.length!==1||messages.length!==(conditional?2:1)||
    conditions.length!==(conditional?1:0))return null;
 const start=starts[0],s=start.data as Record<string,unknown>;
 const requestedPlatform=platform==="facebook"?"messenger":platform;
 if(s.platform!==requestedPlatform)return null;
 if(s.triggerMode==="keyword"){
  // Fail safe: a keyword trigger without one valid keyword is unsupported.
  if(keywordTriggerProblem(s)!==null)return null;
  if(gateTrigger&&!dmTriggerAcceptsText(s,incomingText))return null;
 }else if(s.triggerMode!=="message")return null;
 const edge=(source:string,target:string,port:string)=>
  edges.filter(e=>e?.source===source&&e.target===target&&e.sourceHandle===port).length===1;
 const textOf=(node:Record<string,unknown>):string|null=>{
  const d=node.data as Record<string,unknown>;
  if(!Array.isArray(d.options)||d.options.length!==0||
     !Array.isArray(d.contentBlocks)||d.contentBlocks.length!==0||
     (typeof d.image==="string"&&d.image.trim())||
     typeof d.text!=="string"||!d.text.trim()||
     new TextEncoder().encode(d.text).byteLength>1000)return null;
  return d.text.trim();
 };
 if(!conditional){
  const reply=messages[0];
  if(!edge(String(start.id),String(reply.id),"next"))return null;
  return customerText(textOf(reply));
 }
 const test=conditions[0],data=test.data as Record<string,unknown>;
 if(data.conditionField!=="message"||
    !["contains","equals","not_equals","exists"].includes(String(data.operator))||
    (data.operator!=="exists"&&
      (typeof data.conditionValue!=="string"||!data.conditionValue.trim()||
       data.conditionValue.length>250)))return null;
 const yesEdges=edges.filter(e=>e.source===test.id&&e.sourceHandle==="yes");
 const noEdges=edges.filter(e=>e.source===test.id&&e.sourceHandle==="no");
 if(!edge(String(start.id),String(test.id),"next")||
    yesEdges.length!==1||noEdges.length!==1||
    yesEdges[0].target===noEdges[0].target)return null;
 const yes=messages.find(n=>n.id===yesEdges[0].target);
 const no=messages.find(n=>n.id===noEdges[0].target);
 if(!yes||!no)return null;
 const yesText=textOf(yes),noText=textOf(no);
 if(!yesText||!noText)return null;
 const expected=typeof data.conditionValue==="string"?data.conditionValue:"";
 const matched=data.operator==="exists"?Boolean(incomingText):
  data.operator==="equals"?incomingText===expected:
  data.operator==="not_equals"?incomingText!==expected:
  incomingText.includes(expected);
 return customerText(matched?yesText:noText);
}
/**
 * V2 has no collected values: no placeholder is ever sent literally
 * ({{first_name}} -> FIRST_NAME_FALLBACK, any other -> MISSING_VALUE_FALLBACK),
 * kept within the same 1000 UTF-8 byte bound. Text without placeholders is
 * returned unchanged; null stays null.
 */
function customerText(text:string|null):string|null{
 if(text===null||!hasPlaceholder(text))return text;
 return clipUtf8Bytes(sanitizePlaceholders(text),1000);
}
