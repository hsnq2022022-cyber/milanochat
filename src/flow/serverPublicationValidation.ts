/**
 * Shared browser-independent checks for the authenticated flow publication API.
 * A valid publication is NOT an authorization to execute a flow.
 */
import {importFlow,validateDocument} from "./model.ts";
import type {FlowDocument,Platform} from "./model.ts";
import {auditFlowPublication} from "./publicationGate.ts";
import type {FlowCapability} from "./publicationGate.ts";

export type ProviderPlatform="instagram"|"facebook"|"whatsapp";
export const MAX_FLOW_PUBLICATION_BYTES=4*1024*1024;
export const VALID_FLOW_KEY=/^[A-Za-z0-9_-]{1,128}$/;
export const UUID_REGEX=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function providerPlatform(platform:Platform):ProviderPlatform {
 return platform==="messenger"?"facebook":platform;
}

export function preparePublishedDocument(raw:unknown,accountPlatform:ProviderPlatform):FlowDocument|null {
 try {
  if(raw===null||typeof raw!=="object"||Array.isArray(raw)||
     (raw as Record<string,unknown>).version!==3)return null;
  const serialized=JSON.stringify(raw);
  if(!serialized||new TextEncoder().encode(serialized).byteLength>MAX_FLOW_PUBLICATION_BYTES)
   return null;
  const doc=importFlow(JSON.parse(serialized));
  if(!doc||doc.version!==3||validateDocument(doc).some(x=>x.severity==="error"))
   return null;
  const starts=doc.nodes.filter(n=>n.data.kind==="trigger");
  if(starts.length!==1||providerPlatform(starts[0].data.platform)!==accountPlatform)
   return null;
  return doc;
 }catch{return null;}
}

/** Runtime capabilities are supplied by the SERVER, never by document JSON. */
export function publicationCanActivate(
 doc:FlowDocument,platform:ProviderPlatform,capabilities:ReadonlySet<FlowCapability>,
 serverCanaryEnabled:boolean
):boolean{
 if(!serverCanaryEnabled)return false;
 const verified=preparePublishedDocument(doc,platform);
 return Boolean(verified&&auditFlowPublication(verified,capabilities).canPublish);
}

/**
 * Activation needs a separately armed Edge Function environment AND matching
 * UUIDs. No user input or client feature flag can arm it.
 */
export function testCanaryArmed(
 enabled:string|undefined,
 configuredTenant:string|undefined,
 configuredAccount:string|undefined,
 verifiedTenant:string,
 verifiedAccount:string
):boolean{
 return enabled==="true" && UUID_REGEX.test(verifiedTenant) &&
  UUID_REGEX.test(verifiedAccount) &&
  configuredTenant===verifiedTenant && configuredAccount===verifiedAccount;
}

/**
 * Server-owned comment automation context for productionActivationAuthorized.
 * Populate ONLY from the Edge Function environment (and, for commentTrigger,
 * from the server-stored published document). Never from a browser request.
 */
export type CommentActivationContext={
 /** The flow is a comment-trigger flow (server-side check of the stored document). */
 commentTrigger:boolean;
 /** FLOW_COMMENT_AUTOMATION_ENABLED==="true" (default OFF). */
 commentAutomationEnabled:boolean;
 /** FLOW_MULTICHANNEL_ENABLED==="true" (default OFF; Facebook Page comment ingress). */
 multichannelEnabled:boolean;
};

/**
 * Live tenant approval is a separate, operator-owned database boundary.
 * Browser arguments, a published document, or a feature flag cannot approve it.
 * Text-only Instagram is the first supported live sending capability.
 *
 * Comment flows (optional `comment` context, server-populated only):
 * - instagram: unchanged (the same result with or without the context).
 * - facebook: authorized ONLY for a comment-trigger flow while BOTH
 *   FLOW_COMMENT_AUTOMATION_ENABLED and FLOW_MULTICHANNEL_ENABLED are on.
 *   Facebook DM (non-comment) flows stay NOT authorized.
 * - whatsapp: never. Meta's WhatsApp Cloud API has no comment surface, so a
 *   WhatsApp comment flow cannot exist; WhatsApp DM flows stay NOT authorized.
 * Absent context or any flag not exactly true: exactly the previous result.
 */
export function productionActivationAuthorized(
 platform:ProviderPlatform,
 globalEnabled:unknown,
 tenantEnabled:unknown,
 productionApproved:unknown,
 comment?:CommentActivationContext
):boolean {
 if(globalEnabled!==true||tenantEnabled!==true||productionApproved!==true)return false;
 if(platform==="instagram")return true;
 return platform==="facebook"&&comment?.commentTrigger===true&&
  comment.commentAutomationEnabled===true&&comment.multichannelEnabled===true;
}

/**
 * Provider platform of a document's single comment trigger, else null.
 * A UI hint only (account selection / showing controls); never an
 * authorization: the server re-derives everything from the stored document.
 */
export function commentTriggerProviderPlatform(doc:unknown):ProviderPlatform|null{
 if(!doc||typeof doc!=="object"||Array.isArray(doc))return null;
 const nodes=(doc as {nodes?:unknown}).nodes;
 if(!Array.isArray(nodes))return null;
 const triggers=nodes.filter(n=>!!n&&typeof n==="object"&&
  (n as {data?:{kind?:unknown}}).data?.kind==="trigger") as Array<{data:Record<string,unknown>}>;
 if(triggers.length!==1||triggers[0].data.triggerMode!=="comment")return null;
 const p=triggers[0].data.platform;
 return p==="instagram"||p==="messenger"?providerPlatform(p):null;
}
