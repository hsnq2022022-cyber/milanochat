import type {SupabaseClient} from "npm:@supabase/supabase-js@2";
type Platform = "instagram" | "facebook" | "whatsapp";

/**
 * Deliberately minimal supported engine: ONE trigger(message) -> ONE text
 * message. Never executes requests/actions/delays or hidden side effects.
 * Unavailable/invalid graph -> null and legacy AI is claimed instead.
 */
export async function prepareSimpleFlowReply(
 sb:SupabaseClient, tenantId:string, accountId:string, platform:Platform,
 incomingText:string="",
):Promise<string|null>{
 const mode=Deno.env.get("FLOW_RUNTIME_MODE")??"";
 // An explicit emergency OFF always overrides database approvals.
 if(mode==="off")return null;
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
   if(global.error||tenant.error||global.data?.enabled!==true||
      tenant.data?.enabled!==true||tenant.data?.production_approved!==true)
    return null;
  }
  const {data:active,error}=await sb.from("automation_flow_activations")
   .select("flow_key,revision")
   .eq("tenant_id",tenantId).eq("channel_account_id",accountId)
   .eq("platform",platform).eq("is_active",true).limit(2);
  // Multiple active flows have ambiguous trigger ownership. Never guess.
  if(error||!Array.isArray(active)||active.length!==1)return null;
  const selected=active[0];
  const {data:publication,error:pubError}=await sb.from("automation_flow_publications")
   .select("document").eq("tenant_id",tenantId).eq("channel_account_id",accountId)
   .eq("platform",platform).eq("flow_key",selected.flow_key)
   .eq("revision",selected.revision).maybeSingle();
  if(pubError||!publication)return null;
  return simpleMessageFromDocument(publication.document,platform,incomingText);
 }catch{return null;}
}

/** Pure validation: no IO, actions, schedules or hidden side effects.
 * Supports: trigger(message)->message(text), and
 * trigger(message)->condition(message)->yes/no plain-text replies.
 */
export function simpleMessageFromDocument(
 raw:unknown,platform:Platform,incomingText:string=""
):string|null{
 if(!raw||typeof raw!=="object"||Array.isArray(raw)||
    typeof incomingText!=="string"||incomingText.length>4096)return null;
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
 if(s.platform!==requestedPlatform||s.triggerMode!=="message")return null;
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
  return textOf(reply);
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
 return matched?yesText:noText;
}
