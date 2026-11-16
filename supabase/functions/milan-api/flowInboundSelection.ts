/**
 * SERVER ONLY. The ONE selection layer for an inbound direct message when
 * several flows are active on the same (tenant, channel account, platform).
 *
 * Pure core (chooseInboundFlow, compareCandidates) + a thin, read-only DB
 * wrapper (selectActiveFlowForInbound). Never claims, starts, cancels,
 * supersedes, sends or writes anything: callers (flowDurableIngress.ts
 * attemptDurableInstagram for a NEW durable run, flowPrepareMessage.ts
 * prepareSimpleFlowReply for V2) run the winner with their own engine, gates
 * and claim, exactly as before.
 *
 * Scope: tenantId / accountId / platform MUST come from the verified
 * channel_accounts row (milan-api/index.ts handleIncomingWebhookMessage
 * receives `account` resolved from the signed webhook's external id), never
 * from the payload. Every read is filtered by all three.
 *
 * Candidates: every ACTIVE activation of that scope. For each, exactly the
 * activated revision's publication document is loaded (no fallback to the
 * latest or any other revision). A candidate is eligible when
 *  1. the caller's engine classifier says an available engine can run it
 *     ("durable" | "v2"; null = not executable here), and
 *  2. its single trigger accepts the inbound text as a DM
 *     (triggerKeywords.ts dmTriggerAcceptsText: "message" = every DM,
 *     "keyword" = at least one valid keyword contained in the text). Comment
 *     and any other trigger modes are never DM candidates (comment flows keep
 *     their own commentIngress.ts routing, untouched).
 *  3. its trigger's optional messageScope allows this message
 *     (flowMessageScope.ts): absent / "every_message" = every message
 *     (legacy, unchanged); "conversation_start" only when the caller proved
 *     this is the conversation's first customer DM (conversationStart ===
 *     true, conversationStart.ts); an invalid value never runs. A skipped
 *     flow simply is not a candidate: the next-ranked flow or the AI answers.
 *
 * Precedence (deterministic, total order; src/flow/eventRouting.ts has no
 * priority semantics, only an "ambiguous -> no reply" proposal that no
 * production path uses):
 *  1. a matching KEYWORD trigger beats a catch-all MESSAGE trigger (a generic
 *     trigger never overrides a more specific one);
 *  2. among keyword triggers: the longest matching normalized keyword wins
 *     (more specific; matching = the trigger's own mode, token-aware
 *     "contains" or whole-message "exact", triggerKeywords.ts);
 *  2b. at equal length an "exact" trigger beats a "contains" trigger;
 *  3. then the earliest activated_at (NULL / unparsable = after every
 *     timestamp);
 *  4. then flow_key ascending (plain code-unit comparison, locale-free).
 *  flow_key is unique per scope (table primary key), so exactly one winner.
 * Exactly ONE flow is returned; two competing conversational flows never run
 * for one inbound event.
 *
 * Errors: an activation or publication READ ERROR is {status:"error"}, never
 * "none" (a flow may own this message, so the legacy AI must not answer it);
 * callers turn it into a retryable event (inboundRoutingRetry.ts).
 * A genuinely empty or non-matching result is {status:"none"} and the caller
 * falls through to the main AI chatbot exactly as before.
 */
import {documentTriggerData,dmTriggerAcceptsText,matchedKeywordLength,isExactKeywordTrigger} from "./triggerKeywords.ts";
import {classifyMessageScope,messageScopeAllowsFlow} from "./flowMessageScope.ts";

export type FlowEngine="durable"|"v2";
/** null = no engine available in this context can run the document. */
export type EngineClassifier=(document:unknown)=>FlowEngine|null;
export type ActiveFlowCandidate={
 flowKey:string;revision:number;activatedAt:string|null;document:unknown;
};
export type SelectedFlow={
 flowKey:string;revision:number;activatedAt:string|null;document:unknown;
 engine:FlowEngine;triggerMode:"keyword"|"message";matchedKeywordLength:number;
 /** Keyword trigger in "exact" mode (more specific than "contains" at equal length). */
 exactKeyword?:boolean;
};
export type InboundSelection=
 |{status:"selected";flow:SelectedFlow}
 |{status:"none"}
 |{status:"error"};
export type SelectionScope={tenantId:string;accountId:string;platform:string};

type Rec=Record<string,unknown>;
const rec=(v:unknown):v is Rec=>!!v&&typeof v==="object"&&!Array.isArray(v);
const validKey=(k:unknown):k is string=>typeof k==="string"&&k.length>0&&k.length<=256;
const validRevision=(r:unknown)=>Number.isSafeInteger(Number(r))&&Number(r)>=1;
const activatedMs=(a:string|null)=>{
 const ms=typeof a==="string"?Date.parse(a):NaN;
 return Number.isFinite(ms)?ms:Number.POSITIVE_INFINITY;
};

/**
 * Total order: negative = `a` wins over `b`. Pure, used by chooseInboundFlow
 * and by the catalog's legacy single `active` (activation order only).
 */
export function compareCandidates(a:SelectedFlow,b:SelectedFlow):number{
 const tier=(f:SelectedFlow)=>f.triggerMode==="keyword"?0:1;
 if(tier(a)!==tier(b))return tier(a)-tier(b);
 if(a.matchedKeywordLength!==b.matchedKeywordLength)
  return b.matchedKeywordLength-a.matchedKeywordLength;
 const exact=(f:SelectedFlow)=>f.exactKeyword===true?0:1;
 if(exact(a)!==exact(b))return exact(a)-exact(b);
 return compareActivationOrder(a,b);
}
/** Earliest activated_at (NULL last), then flow_key ascending. */
export function compareActivationOrder(a:{activatedAt:string|null;flowKey:string},
 b:{activatedAt:string|null;flowKey:string}):number{
 const ta=activatedMs(a.activatedAt),tb=activatedMs(b.activatedAt);
 if(ta!==tb)return ta<tb?-1:1;
 return a.flowKey<b.flowKey?-1:a.flowKey>b.flowKey?1:0;
}

/**
 * PURE: evaluate every candidate for one inbound text and return the single
 * winner, or null when none is eligible. Input order never matters.
 */
export function chooseInboundFlow(candidates:readonly ActiveFlowCandidate[],text:unknown,
 classify:EngineClassifier,conversationStart?:boolean|null):SelectedFlow|null{
 let best:SelectedFlow|null=null;
 const seen=new Set<string>();
 for(const c of candidates){
  if(!rec(c)||!validKey(c.flowKey)||!validRevision(c.revision))continue;
  // Defensive: one activation per flow_key (primary key). A duplicate key in
  // the input is ambiguous data; never guess between two revisions.
  if(seen.has(c.flowKey))return null;
  seen.add(c.flowKey);
  let engine:FlowEngine|null=null;
  try{engine=classify(c.document);}catch{engine=null;}
  if(engine!=="durable"&&engine!=="v2")continue;
  const trigger=documentTriggerData(c.document);
  if(!trigger||!dmTriggerAcceptsText(trigger,text))continue;
  if(!messageScopeAllowsFlow(classifyMessageScope(trigger),conversationStart))continue;
  const mode=trigger.triggerMode==="keyword"?"keyword":"message";
  const candidate:SelectedFlow={flowKey:c.flowKey,revision:Number(c.revision),
   activatedAt:typeof c.activatedAt==="string"?c.activatedAt:null,document:c.document,
   engine,triggerMode:mode,matchedKeywordLength:mode==="keyword"?matchedKeywordLength(trigger,text):0,
   exactKeyword:mode==="keyword"&&isExactKeywordTrigger(trigger)};
  if(!best||compareCandidates(candidate,best)<0)best=candidate;
 }
 return best;
}

type Db={from:(table:string)=>any};
/**
 * Technical read bound (PostgREST's default max-rows), NOT a product limit:
 * a full page fails closed ("error") instead of silently ignoring flows.
 */
export const ACTIVE_FLOW_SCAN=1000;
export type ActiveActivation={flowKey:string;revision:number;activatedAt:string|null};
/**
 * Every active activation of the scope (read-only), or null on a read error.
 * activated_at is optional schema-wise: only if PostgREST reports the column
 * as undefined (42703) is the list re-read without it (all NULL = flow_key
 * order). Any other error is an error.
 */
export async function listActiveActivations(db:Db,scope:SelectionScope):Promise<ActiveActivation[]|null>{
 const read=(columns:string)=>db.from("automation_flow_activations").select(columns)
  .eq("tenant_id",scope.tenantId).eq("channel_account_id",scope.accountId)
  .eq("platform",scope.platform).eq("is_active",true).limit(ACTIVE_FLOW_SCAN);
 let r=await read("flow_key,revision,is_active,activated_at");
 if(r?.error&&rec(r.error)&&r.error.code==="42703")r=await read("flow_key,revision,is_active");
 if(!r||r.error||!Array.isArray(r.data)||r.data.length>=ACTIVE_FLOW_SCAN)return null;
 const out:ActiveActivation[]=[];
 for(const row of r.data as unknown[]){
  // Rows are filtered by the query; an explicit non-active row is skipped.
  if(!rec(row)||row.is_active===false)continue;
  if(!validKey(row.flow_key)||!validRevision(row.revision))return null;
  // One activation per flow_key (primary key): a duplicate is never guessed.
  if(out.some(a=>a.flowKey===row.flow_key))return null;
  out.push({flowKey:row.flow_key,revision:Number(row.revision),
   activatedAt:typeof row.activated_at==="string"?row.activated_at:null});
 }
 return out;
}

/**
 * Thin DB wrapper: list the scope's active activations, load each EXACT
 * activated revision, then chooseInboundFlow. Read errors -> "error".
 */
export async function selectActiveFlowForInbound(db:Db,scope:SelectionScope,text:unknown,
 classify:EngineClassifier,conversationStart?:boolean|null):Promise<InboundSelection>{
 try{
  const active=await listActiveActivations(db,scope);
  if(active===null)return {status:"error"};
  if(active.length===0)return {status:"none"};
  const loaded=await Promise.all(active.map(async a=>{
   const pub=await db.from("automation_flow_publications").select("document")
    .eq("tenant_id",scope.tenantId).eq("channel_account_id",scope.accountId)
    .eq("platform",scope.platform).eq("flow_key",a.flowKey)
    .eq("revision",a.revision).maybeSingle();
   if(!pub||pub.error)return "error" as const;
   // FK guarantees the row; a missing one is simply not a candidate.
   return {...a,document:pub.data?.document} as ActiveFlowCandidate;
  }));
  if(loaded.some(c=>c==="error"))return {status:"error"};
  const winner=chooseInboundFlow(loaded as ActiveFlowCandidate[],text,classify,conversationStart);
  return winner?{status:"selected",flow:winner}:{status:"none"};
 }catch{
  return {status:"error"};
 }
}
