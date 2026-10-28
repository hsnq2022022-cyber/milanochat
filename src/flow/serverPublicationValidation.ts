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
