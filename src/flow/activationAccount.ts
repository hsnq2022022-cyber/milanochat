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
/** The account's single active publication as reported by `catalog` (null = none). */
export type CatalogActive={flow_key:string;revision:number};

/**
 * Which server flow_key the editor toggle manages. The editor id is LOCAL
 * (uuid/"default"), while publications live under their own flow_key:
 * the account's active publication (catalog `active.flow_key`) when present,
 * else the local key (published under its own key, not yet published, or
 * catalog unavailable: old behaviour). `catalog` is accepted for call-site
 * compatibility but does not change the result.
 * UI selection only: the server re-checks tenant/account scope on every call.
 */
export function resolveServerFlowKey(input:{localKey:string;
 catalog?:readonly CatalogFlow[]|null;active?:CatalogActive|null}):string{
 const active=input.active?.flow_key;
 return typeof active==="string"&&active.length>0?active:input.localKey;
}

/** Another flow_key than `serverKey` is active on the account (runtime allows one). */
export function otherActiveFlowKey(active:CatalogActive|null|undefined,serverKey:string):string|null{
 const key=active?.flow_key;
 return typeof key==="string"&&key.length>0&&key!==serverKey?key:null;
}

/** Shape of the server `readiness` report fields the client reads. */
export type ReadinessReport={checks:Record<string,boolean|undefined>;candidateKind?:string;
 configured?:boolean;needsButtons?:boolean;needsScheduler?:boolean;
 needsInternalActions?:boolean;needsMedia?:boolean;commentTrigger?:unknown};

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
