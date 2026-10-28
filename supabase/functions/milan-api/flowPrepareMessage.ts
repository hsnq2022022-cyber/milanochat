import type {SupabaseClient} from "npm:@supabase/supabase-js@2";
type Platform = "instagram" | "facebook" | "whatsapp";

/**
 * Deliberately minimal supported engine: ONE trigger(message) -> ONE text
 * message. Never executes requests/actions/delays or hidden side effects.
 * Unavailable/invalid graph -> null and legacy AI is claimed instead.
 */
export async function prepareSimpleFlowReply(
 sb:SupabaseClient, tenantId:string, accountId:string, platform:Platform,
):Promise<string|null>{
 if(Deno.env.get("FLOW_RUNTIME_MODE")!=="message_only")return null;
 try{
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
  return simpleMessageFromDocument(publication.document,platform);
 }catch{return null;}
}

/** Pure validation for the supported subset of published FlowDocument v3. */
export function simpleMessageFromDocument(raw:unknown,platform:Platform):string|null{
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const doc=raw as Record<string,unknown>;
 if(doc.version!==3||!Array.isArray(doc.nodes)||!Array.isArray(doc.edges)||
    doc.nodes.length!==2||doc.edges.length!==1)return null;
 // Node storage order has no semantic meaning in FlowDocument v3.
 // Locate the only trigger and message by kind; malformed/extra nodes fail closed.
 const nodes=doc.nodes as Record<string,unknown>[];
 const start=nodes.find(n=>(n?.data as Record<string,unknown>|undefined)?.kind==="trigger");
 const message=nodes.find(n=>(n?.data as Record<string,unknown>|undefined)?.kind==="message");
 const s=start?.data as Record<string,unknown>|undefined;
 const m=message?.data as Record<string,unknown>|undefined;
 const requestedPlatform=platform==="facebook"?"messenger":platform;
 if(s?.kind!=="trigger"||s.platform!==requestedPlatform||
    s.triggerMode!=="message"||m?.kind!=="message")return null;
 const edge=doc.edges[0] as Record<string,unknown>;
 if(edge.source!==start.id||edge.target!==message.id||
    edge.sourceHandle!=="next")return null;
 if(!Array.isArray(m.options)||m.options.length!==0||
    !Array.isArray(m.contentBlocks)||m.contentBlocks.length!==0||
    (typeof m.image==="string" && m.image.trim()))return null;
 if(typeof m.text!=="string"||m.text.trim().length===0||
    new TextEncoder().encode(m.text).byteLength>1000)return null;
 return m.text.trim();
}
