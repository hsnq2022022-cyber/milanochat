/**
 * PURE client helpers: which channel account the activation toggle targets and
 * whether the server said activation is possible there. UI hints only; the
 * flow-publication Edge Function re-checks everything on activate. The client
 * never reads server flags: `canActivateComments` comes from the server's
 * `accounts` reply (FLOW_COMMENT_AUTOMATION_ENABLED / FLOW_MULTICHANNEL_ENABLED).
 */
import type {ProviderPlatform} from "./serverPublicationValidation.ts";

export type ActivationAccount={id:string;platform:string;is_active:boolean|null;
 canActivate?:boolean;canActivateComments?:boolean};

/** Activation allowed for this account and flow (commentPlatform: null = not a comment flow). */
export function accountCanActivate(a:ActivationAccount|null|undefined,commentPlatform:ProviderPlatform|null):boolean{
 if(!a)return false;
 return a.canActivate===true||
  (commentPlatform!==null&&a.platform===commentPlatform&&a.canActivateComments===true);
}

/**
 * Non-comment flows: exactly the previous choice (first canActivate, else first).
 * Comment flows: prefer an account of the trigger's own platform that may activate it.
 */
export function pickActivationAccount(list:ActivationAccount[],commentPlatform:ProviderPlatform|null):ActivationAccount|null{
 if(commentPlatform!==null){
  const own=list.find(a=>a.platform===commentPlatform&&accountCanActivate(a,commentPlatform));
  if(own)return own;
 }
 return list.find(a=>a.canActivate===true)??list[0]??null;
}

/** One entry of the server `catalog` reply (latest revision per published flow key). */
export type CatalogFlow={flowKey:string;latestRevision:number};
/** One active publication of the account as reported by `catalog` (flow_key + ITS active revision). */
export type CatalogActive={flow_key:string;revision:number};

const asActive=(v:unknown):CatalogActive|null=>{
 if(!v||typeof v!=="object")return null;
 const a=v as {flow_key?:unknown;revision?:unknown};
 return typeof a.flow_key==="string"&&a.flow_key.length>0&&typeof a.revision==="number"
  ?{flow_key:a.flow_key,revision:a.revision}:null;
};
/**
 * ALL active flows of the account from a `catalog` reply. Several flows may be
 * active at once, each independently with its own revision. Current server:
 * `activeFlows` (array). Older server without that field: its legacy single
 * `active` (0 or 1 entry). Malformed entries are dropped; a flow_key appears
 * at most once (first entry kept).
 */
export function catalogActiveFlows(reply:{activeFlows?:unknown;active?:unknown}|null|undefined):CatalogActive[]{
 if(!reply||typeof reply!=="object")return [];
 const raw=Array.isArray(reply.activeFlows)?reply.activeFlows:[reply.active];
 const out:CatalogActive[]=[];
 for(const item of raw){
  const a=asActive(item);
  if(a&&!out.some(x=>x.flow_key===a.flow_key))out.push(a);
 }
 return out;
}
/** Active revision of exactly `key` among the account's active flows, null = this flow is OFF. */
export function activeRevisionOf(activeFlows:readonly CatalogActive[]|null|undefined,key:string):number|null{
 return (activeFlows??[]).find(a=>a?.flow_key===key)?.revision??null;
}

/**
 * Which server flow_key the editor toggle manages. The editor id is LOCAL
 * (uuid/"default"), while publications live under their own flow_key:
 * 1. the local key when it is a server flow of this account (listed in the
 *    catalog or active): the toggle manages THAT flow only, whatever other
 *    flows are active (several flows may be active independently);
 * 2. else the account's only active flow when exactly one is active (the
 *    previous behaviour: a local draft of a live flow published under its own
 *    server key, e.g. ig_live_welcome_20261029);
 * 3. else the local key (not yet published, catalog unavailable, or several
 *    active flows: never guess which one this draft is).
 * `active` (legacy single entry) is used only when `activeFlows` is absent.
 * UI selection only: the server re-checks tenant/account scope on every call.
 */
export function resolveServerFlowKey(input:{localKey:string;
 catalog?:readonly CatalogFlow[]|null;active?:CatalogActive|null;
 activeFlows?:readonly CatalogActive[]|null}):string{
 const actives=catalogActiveFlows({activeFlows:input.activeFlows??undefined,active:input.active});
 const local=input.localKey;
 const published=Array.isArray(input.catalog)&&
  input.catalog.some(f=>!!f&&typeof f==="object"&&f.flowKey===local);
 if(published||actives.some(a=>a.flow_key===local))return local;
 return actives.length===1?actives[0].flow_key:local;
}

/** Shape of the server `readiness` report fields the client reads. */
export type ReadinessReport={checks:Record<string,boolean|undefined>;candidateKind?:string;
 configured?:boolean;needsButtons?:boolean;needsScheduler?:boolean;
 needsInternalActions?:boolean;needsMedia?:boolean;commentTrigger?:unknown;
 /** Additive server diagnostics (flow-publication readiness.ts readinessCandidate); absent on older servers. */
 candidate?:unknown};

/** Validated, secret-free view of the server's readiness `candidate` diagnostics. */
export type ReadinessCandidateSummary={flowKey:string;revision:number|null;
 source:"requested"|"active"|"none";found:boolean;activeRevision:number|null;
 engine:"durable"|"v2"|"comment"|null;
 reasons:{activeRevision:string|null;supportedCandidate:string|null}};
const REASON=/^[a-z_]{1,40}$/;
const revOrNull=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0?v:null;
const reasonOrNull=(v:unknown)=>typeof v==="string"&&REASON.test(v)?v:null;
/**
 * The examined flow/revision and the server's reasons, or null when the server
 * sent none or a malformed value (older server: UI and copy stay as before).
 * Never derived in the browser and never another revision than the server's.
 */
export function readinessCandidateSummary(report:ReadinessReport|null|undefined):ReadinessCandidateSummary|null{
 const c=report&&typeof report==="object"?report.candidate:undefined;
 if(!c||typeof c!=="object"||Array.isArray(c))return null;
 const v=c as Record<string,unknown>;
 const source=v.source==="requested"||v.source==="active"||v.source==="none"?v.source:null;
 if(source===null||typeof v.flowKey!=="string"||v.flowKey.length===0||typeof v.found!=="boolean")return null;
 const r=v.reasons&&typeof v.reasons==="object"?v.reasons as Record<string,unknown>:{};
 return {flowKey:v.flowKey.slice(0,120),revision:source==="none"?null:revOrNull(v.revision),source,
  found:v.found,activeRevision:revOrNull(v.activeRevision),
  engine:v.engine==="durable"||v.engine==="v2"||v.engine==="comment"?v.engine:null,
  reasons:{activeRevision:reasonOrNull(r.activeRevision),supportedCandidate:reasonOrNull(r.supportedCandidate)}};
}

/** candidateKind values the server can report (flow-publication readiness). */
const SIMPLE_KINDS=new Set(["text","unsupported"]);
const ADVANCED_KINDS=new Set(["buttons","delay","mixed","comment"]);

/**
 * Whether the revision targets the advanced (durable/comment) runtime, from the
 * server readiness report only:
 * - "advanced": candidateKind buttons/delay/mixed/comment, a commentTrigger
 *   report, or any needsButtons/needsScheduler/needsInternalActions/needsMedia===true;
 * - "simple": candidateKind "text" (whitelisted graph without buttons/delay) or
 *   "unsupported" (not a durable graph: the server's legacy simple-message path,
 *   flow-publication index.ts activate `if(!durable)` branch) with none of the above;
 * - "unknown": missing/malformed report or an unrecognised candidateKind.
 * Server facts: readiness sets candidateKind="unsupported" and needsInternalActions/
 * needsMedia=false for non-durable documents; durableCandidateKind returns "text"
 * when a whitelisted graph needs neither buttons nor scheduler.
 */
export function readinessTargetKind(report:ReadinessReport|null|undefined):"simple"|"advanced"|"unknown"{
 if(!report||typeof report!=="object"||!report.checks||typeof report.checks!=="object")return "unknown";
 const kind=report.candidateKind;
 if(typeof kind!=="string")return "unknown";
 if(report.needsButtons===true||report.needsScheduler===true||
    report.needsInternalActions===true||report.needsMedia===true)return "advanced";
 if(report.commentTrigger!==undefined&&report.commentTrigger!==null)return "advanced";
 if(ADVANCED_KINDS.has(kind))return "advanced";
 if(SIMPLE_KINDS.has(kind))return "simple";
 return "unknown";
}

/**
 * Client blockers before activating exactly one revision. Rule:
 * - SIMPLE target (see readinessTargetKind): no readiness blockers at all. The
 *   advanced operator checks (ingress, canary, outbox, supportedCandidate, ...)
 *   do not apply to the server's legacy simple-message path; the server still
 *   authorizes (switches, approval, simpleMessageFromDocument, capabilities) and
 *   its rejection is shown with its code.
 * - ADVANCED target: the panel's interpretation (FlowPublicationPanel
 *   readinessNeeds/missingReadinessChecks): every check must be true, except
 *   scheduler/buttons/internalActions/media when not needed. `activeRevision`
 *   ("this flow already has an active revision") is ignored when the flow is OFF;
 *   when it is ON a server `configured:false` also blocks.
 * - UNKNOWN (missing/malformed/unrecognised report): fail-closed, treated as
 *   advanced-and-unverifiable -> ["readiness_unavailable"] or its blockers.
 * Empty array = may proceed to the confirm + activate.
 */
export function readinessBlockers(report:ReadinessReport|null|undefined,
 opts:{currentlyActive:boolean}):string[]{
 if(!report||typeof report!=="object"||!report.checks||typeof report.checks!=="object")
  return ["readiness_unavailable"];
 // The server examined no document (no such revision, or none at all): never
 // treat that as a simple text revision. Absent diagnostics = previous rule.
 const examined=readinessCandidateSummary(report);
 if(examined&&!examined.found)return ["candidateNotFound"];
 const target=readinessTargetKind(report);
 if(target==="simple")return [];
 const kind=report.candidateKind;
 const needs={
  buttons:typeof report.needsButtons==="boolean"?report.needsButtons:kind==="buttons"||kind==="mixed",
  scheduler:typeof report.needsScheduler==="boolean"?report.needsScheduler:kind==="delay"||kind==="mixed",
  internalActions:report.needsInternalActions===true,
  media:report.needsMedia===true
 };
 const blockers=Object.entries(report.checks)
  .filter(([key,ready])=>ready!==true&&
   (key!=="scheduler"||needs.scheduler)&&
   (key!=="buttons"||needs.buttons)&&
   (key!=="internalActions"||needs.internalActions)&&
   (key!=="media"||needs.media)&&
   (key!=="activeRevision"||opts.currentlyActive))
  .map(([key])=>key);
 if(target==="unknown"&&blockers.length===0)blockers.push("readiness_unclassified");
 if(kind==="unsupported"&&!blockers.includes("supportedCandidate"))blockers.push("supportedCandidate");
 if(opts.currentlyActive&&report.configured===false&&blockers.length===0)blockers.push("configured");
 return blockers;
}
