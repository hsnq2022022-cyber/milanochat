/**
 * SERVER ONLY. Signed Instagram webhook -> durable question/delay plan.
 * Disabled until an explicit operator-selected account passes live send tests.
 * Never calls Meta or charges: effects are stored for the separate Outbox.
 */
import type {SupabaseClient} from "npm:@supabase/supabase-js@2";
import {createRuntimeState,type RuntimeState} from "../../../src/flow/runtimePlan.ts";
import {planUntilWait,seedFromEventKey,MAX_CHAIN_EFFECTS,hash32,collectedFields,
 renderCollectedTemplate,type ChainPlan} from "../../../src/flow/runtimeChain.ts";
import type {FlowDocument} from "../../../src/flow/model.ts";
import {simpleMessageFromDocument} from "./flowPrepareMessage.ts";
import {durableAnswerMode,normalizeDurableAnswer,reaskText,type DurableAnswerMode}
 from "./flowDurableAnswer.ts";

type RecordValue=Record<string,unknown>;
const record=(v:unknown):v is RecordValue=>!!v&&typeof v==="object"&&!Array.isArray(v);
const safeId=(s:unknown):s is string=>typeof s==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(s);
const MAX_NODES=100,MAX_EDGES=300,MAX_BUTTONS=13;
const textOk=(t:unknown)=>typeof t==="string"&&t.trim().length>0&&
 new TextEncoder().encode(t).byteLength<=1000;
/** No image, no content blocks (media/collections/inline delays). */
const plain=(d:RecordValue)=>(d.image===""||d.image===undefined)&&
 Array.isArray(d.contentBlocks)&&d.contentBlocks.length===0;
/** Run variable names usable by set_field/condition. "message" (the inbound text) is never allowed. */
const fieldOk=(f:unknown):f is string=>typeof f==="string"&&
 /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(f)&&!f.startsWith("__")&&
 f.toLowerCase()!=="message"&&f!=="constructor"&&f!=="prototype";
/**
 * Tag names: exactly the planner rule (runtimePlan.ts) on the trimmed value,
 * which also satisfies the flow_conversation_tags CHECK (1..64, no <> or
 * control characters). Never rendered.
 */
export const tagOk=(t:string)=>/^[\p{L}\p{N}_ -]{1,64}$/u.test(t)&&t.trim()===t;
/**
 * Staff notification text: 1..500 characters after trim (planner rule and the
 * flow_staff_notifications body CHECK), no control characters except tab and
 * line breaks. Only the collected {{field}} placeholders are rendered.
 */
export const notifyOk=(t:unknown)=>typeof t==="string"&&t.trim().length>=1&&
 t.trim().length<=500&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t);
/** Step buttons only (no website/flow/AI actions), same limits as before. */
const stepButtons=(opts:unknown,min:number)=>Array.isArray(opts)&&
 opts.length>=min&&opts.length<=MAX_BUTTONS&&
 opts.every(o=>record(o)&&safeId(o.id)&&typeof o.label==="string"&&
  o.label.trim().length>0&&o.label.length<=20&&
  (o.action===undefined||o.action==="step")&&
  (o.url===undefined||o.url==="")&&(o.targetFlowId===undefined||o.targetFlowId==="")&&
  (o.buttonType===undefined||o.buttonType==="button"||o.buttonType==="quick_reply"))&&
 new Set(opts.map(o=>(o as RecordValue).id)).size===opts.length;

/**
 * Output ports a whitelisted node may have; null = node not supported live.
 * `required` ports must each have exactly one edge.
 */
function durablePorts(d:RecordValue):{ports:string[];required:string[]}|null{
 switch(d.kind){
  case "trigger":
   return d.platform==="instagram"&&d.triggerMode==="message"?
    {ports:["next"],required:["next"]}:null;
  case "message":{
   if(!textOk(d.text)||!plain(d)||!Array.isArray(d.options))return null;
   if(d.options.length===0)return {ports:["next"],required:[]};
   if(!stepButtons(d.options,1))return null;
   const ids=(d.options as RecordValue[]).map(o=>o.id as string);
   return {ports:ids,required:ids};
  }
  case "question":{
   if(!textOk(d.text)||!plain(d))return null;
   // Typed-answer questions (text/email/phone; number stays unsupported):
   // the answer is stored under inputField (same name rules as set_field,
   // never "message"). Planner ports: "valid", else "next"; exactly one of
   // them must be connected (checked below). No buttons on such a question.
   if(durableAnswerMode(d.inputMode))
    return fieldOk(d.inputField)&&(d.options===undefined||
     (Array.isArray(d.options)&&d.options.length===0))?
     {ports:["valid","next"],required:[]}:null;
   if(d.inputMode!=="buttons"||!stepButtons(d.options,1))return null;
   const ids=(d.options as RecordValue[]).map(o=>o.id as string);
   return {ports:ids,required:ids};
  }
  case "delay":
   return typeof d.delayValue==="number"&&Number.isSafeInteger(d.delayValue)&&
    d.delayValue>=1&&d.delayValue<=30&&
    ["seconds","minutes","hours","days"].includes(String(d.delayUnit))?
    {ports:["next"],required:["next"]}:null;
  case "condition":
   // Never on the inbound message (V2 owns that, and durable never stores it).
   return fieldOk(d.conditionField)&&
    ["contains","equals","not_equals","exists"].includes(String(d.operator))&&
    (d.operator==="exists"||(typeof d.conditionValue==="string"&&
     d.conditionValue.trim().length>0&&d.conditionValue.length<=250))?
    {ports:["yes","no"],required:["yes","no"]}:null;
  case "action":{
   // set_field, tag/untag, notify and handoff; AI stays unsupported live.
   // Internal actions run in flow-internal-worker/internalEffects.ts (never
   // sent to Meta, never billed) behind FLOW_INTERNAL_ACTIONS_ENABLED.
   if(d.actionType==="handoff")
    // Terminal: the planner never follows an edge out of a handoff, so none
    // may exist. The optional handoff message is a message node BEFORE it;
    // text typed into the node itself would never be sent, so it is refused.
    return d.actionValue===undefined||d.actionValue===null||
     (typeof d.actionValue==="string"&&d.actionValue.trim()==="")?
     {ports:[],required:[]}:null;
   if(typeof d.actionValue!=="string")return null;
   if(d.actionType==="tag"||d.actionType==="untag")
    return tagOk(d.actionValue.trim())?{ports:["next"],required:[]}:null;
   if(d.actionType==="notify")
    return notifyOk(d.actionValue)?{ports:["next"],required:[]}:null;
   if(d.actionType!=="set_field")return null;
   const at=d.actionValue.indexOf("=");
   const value=d.actionValue.slice(at+1).trim();
   return at>=1&&fieldOk(d.actionValue.slice(0,at).trim())&&value.length<=500?
    {ports:["next"],required:[]}:null;
  }
  case "randomizer":{
   const opts=d.options;
   if(!Array.isArray(opts)||opts.length<1||opts.length>MAX_BUTTONS||
      !opts.every(o=>record(o)&&safeId(o.id)&&typeof o.weight==="number"&&
       Number.isFinite(o.weight)&&o.weight>=0)||
      new Set(opts.map(o=>(o as RecordValue).id)).size!==opts.length||
      (opts as RecordValue[]).reduce((s,o)=>s+(o.weight as number),0)<=0)return null;
   const ids=(opts as RecordValue[]).map(o=>o.id as string);
   return {ports:ids,required:ids};
  }
  case "goto":
   return safeId(d.gotoNode)?{ports:[],required:[]}:null;
  case "end":
   return {ports:[],required:[]};
  default:
   // request (HTTP), unknown kinds: never live.
   return null;
 }
}

/**
 * Whitelist of graphs the live durable engine runs. Accepts the two original
 * shapes and chained graphs built only from: one Instagram message trigger,
 * text messages (optional step buttons), button questions, text/email/phone
 * questions (answer stored under a safe inputField), delay (1..30 units),
 * condition (not on the inbound message), set_field, randomizer, goto, end,
 * tag/untag (safe tag name), notify (bounded text) and handoff (terminal, no
 * outgoing edge). Every node must be reachable from the trigger and every
 * branch port connected exactly once. Graphs the existing V2 simple engine
 * (flowPrepareMessage.ts) handles are NEVER accepted, so they keep falling
 * back to V2 unchanged.
 */
export function supportedDurableDocument(raw:unknown):raw is FlowDocument{
 if(!record(raw)||raw.version!==3||!Array.isArray(raw.nodes)||
    !Array.isArray(raw.edges))return false;
 const nodes=raw.nodes as unknown[],edges=raw.edges as unknown[];
 if(nodes.length<2||nodes.length>MAX_NODES||edges.length>MAX_EDGES)return false;
 if(nodes.some(n=>!record(n)||!safeId(n.id)||!record(n.data))||
    edges.some(e=>!record(e))||
    new Set(nodes.map(n=>(n as RecordValue).id)).size!==nodes.length)return false;
 const byId=new Map((nodes as RecordValue[]).map(n=>[n.id as string,n.data as RecordValue]));
 const triggers=(nodes as RecordValue[]).filter(n=>(n.data as RecordValue).kind==="trigger");
 if(triggers.length!==1)return false;
 const ports=new Map<string,{ports:string[];required:string[]}>();
 for(const [nodeId,data] of byId){
  const p=durablePorts(data);
  if(!p)return false;
  ports.set(nodeId,p);
 }
 // Same port semantics as the planner: a missing sourceHandle means "next".
 const out=new Map<string,Map<string,string>>();
 for(const e of edges as RecordValue[]){
  if(typeof e.source!=="string"||typeof e.target!=="string"||
     (e.sourceHandle!==undefined&&e.sourceHandle!==null&&typeof e.sourceHandle!=="string"))return false;
  const handle=(e.sourceHandle as string|undefined)||"next";
  const target=byId.get(e.target);
  if(!byId.has(e.source)||!target||target.kind==="trigger"||
     !ports.get(e.source)!.ports.includes(handle))return false;
  const m=out.get(e.source)??new Map<string,string>();
  if(m.has(handle))return false; // ambiguous branch
  m.set(handle,e.target);out.set(e.source,m);
 }
 for(const [nodeId,p] of ports){
  if(p.required.some(h=>!out.get(nodeId)?.has(h)))return false;
  const d=byId.get(nodeId)!;
  // A typed-answer question continues through exactly one destination.
  if(d.kind==="question"&&durableAnswerMode(d.inputMode)&&
     ["valid","next"].filter(h=>out.get(nodeId)?.has(h)).length!==1)return false;
  if(d.kind==="goto"){
   const to=byId.get(d.gotoNode as string);
   if(!to||to.kind==="trigger")return false;
  }
 }
 // Reachability from the trigger (edges + goto jumps).
 const start=triggers[0].id as string,seen=new Set([start]),queue=[start];
 while(queue.length){
  const at=queue.shift()!;
  const next=[...(out.get(at)?.values()??[])];
  const d=byId.get(at)!;
  if(d.kind==="goto")next.push(d.gotoNode as string);
  for(const n of next)if(!seen.has(n)){seen.add(n);queue.push(n);}
 }
 if(seen.size!==byId.size)return false;
 // V2 keeps its shapes (lone trigger->text, trigger->condition(message)->2 texts).
 if(simpleMessageFromDocument(raw,"instagram","")!==null)return false;
 return true;
}
/** Operator flags a whitelisted graph needs (buttons sender, delay scheduler). */
export function durableRuntimeNeeds(doc:FlowDocument):{buttons:boolean;scheduler:boolean}{
 const nodes=doc.nodes as unknown as RecordValue[];
 const kind=(n:RecordValue)=>(n.data as RecordValue).kind;
 return {
  // Text/email/phone questions are plain messages: no buttons sender needed.
  buttons:nodes.some(n=>(kind(n)==="question"&&(n.data as RecordValue).inputMode==="buttons")||(kind(n)==="message"&&
   Array.isArray((n.data as RecordValue).options)&&((n.data as RecordValue).options as unknown[]).length>0)),
  scheduler:nodes.some(n=>kind(n)==="delay")
 };
}
/** Internal actions (FLOW_INTERNAL_ACTIONS_ENABLED) the graph needs: tag/untag/notify/handoff. */
export const INTERNAL_ACTION_TYPES=["tag","untag","notify","handoff"] as const;
export function durableNeedsInternalActions(doc:FlowDocument):boolean{
 return (doc.nodes as unknown as RecordValue[]).some(n=>{
  const d=n.data as RecordValue;
  return d.kind==="action"&&(INTERNAL_ACTION_TYPES as readonly unknown[]).includes(d.actionType);
 });
}
export type DurableCandidateKind="buttons"|"delay"|"mixed"|"text"|"unsupported";
/** Readiness/activation classification shared with flow-publication. */
export function durableCandidateKind(raw:unknown):DurableCandidateKind{
 if(!supportedDurableDocument(raw))return "unsupported";
 const n=durableRuntimeNeeds(raw);
 return n.buttons&&n.scheduler?"mixed":n.buttons?"buttons":n.scheduler?"delay":"text";
}
export function selectedFlowChoice(raw:unknown):string|null{
 if(!record(raw)||!record(raw.quick_reply))return null;
 const payload=raw.quick_reply.payload;
 if(typeof payload!=="string"||!payload.startsWith("flow-choice:"))return null;
 const value=payload.slice("flow-choice:".length);
 return safeId(value)?value:null;
}
// payload carries `seq` (order inside this commit) for the Outbox ordering.
const effectsPayload=(effects:ChainPlan["effects"])=>
 effects.map(e=>({kind:e.kind,idempotencyKey:e.idempotencyKey,payload:e}));
/**
 * Effects the live engine may commit. Internal kinds (tag/untag/
 * staff_notification/handoff) are executed by internalEffects.ts after every
 * earlier effect of the run; knowledge_ai ("source") stays excluded.
 */
export const LIVE_EFFECT_KINDS=["message","question","delay","tag","untag","staff_notification","handoff"];
/**
 * A handoff ends the automated flow: it must be the LAST effect and the run
 * must end in status "handoff" (and "handoff" only with that effect).
 */
export const safePlan=(plan:ChainPlan)=>
 !plan.error&&plan.state.status!=="blocked"&&
 ["completed","sleeping","awaiting_input","handoff"].includes(plan.state.status)&&
 plan.effects.length>=1&&plan.effects.length<=MAX_CHAIN_EFFECTS&&
 plan.effects.every((e,i)=>e.seq===i&&
  LIVE_EFFECT_KINDS.includes(e.kind)&&!("source" in e)&&
  (e.kind!=="handoff"||i===plan.effects.length-1))&&
 (plan.state.status==="handoff")===(plan.effects[plan.effects.length-1].kind==="handoff");
/** After a typed answer a flow may also end silently (answer -> end). */
const safeAnswerPlan=(plan:ChainPlan)=>safePlan(plan)||
 (!plan.error&&plan.state.status==="completed"&&plan.effects.length===0);

export type DurableEvent={
 tenantId:string;accountId:string;conversationId:string;inboundId:string;
 eventId:string;platform:string;selectedChoiceId?:string|null;
 /**
  * Inbound text, used ONLY as the answer to a waiting text/email/phone
  * question. Never logged; above MAX_INBOUND_ANSWER_CHARS it is ignored
  * (an invalid answer).
  */
 text?:string|null;
 /**
  * True only when the provider itself supplied this message id (set where
  * milan-api/index.ts derives it). Fail closed: absent/false/non-true means
  * synthetic, and the event falls back to V2 before any database access.
  */
 providerEventIdGenuine:boolean;
};
type Db=Pick<SupabaseClient,"from"|"rpc">;
type Result="fallback"|"handled";
/**
 * milan-api/index.ts substitutes `ig_${Date.now()}` when Meta sends no
 * message id. Such an id is new on every delivery, so neither the messages
 * index nor the claim key can recognize a replay: it is never a dedupe key.
 * Provenance comes ONLY from the explicit providerEventIdGenuine flag, never
 * from the id's format; without `true` the durable path refuses the event
 * before any database access (V2 unchanged).
 */
const validEvent=(e:DurableEvent)=>
 [e.tenantId,e.accountId,e.conversationId,e.inboundId].every(x=>
  typeof x==="string"&&/^[a-f\d]{8}-[a-f\d-]{27,36}$/i.test(x))&&
 typeof e.eventId==="string"&&e.eventId.length>=1&&e.eventId.length<=256&&
 e.providerEventIdGenuine===true&&e.platform==="instagram";
type Prior="new"|"claimed"|"redelivered"|"error";
/**
 * READ-ONLY "already received?" check, run before anything can cancel,
 * supersede or resume a run. It consumes nothing, so a new free-text event
 * still reaches V2's own exclusive claim after its cancel.
 *  claimed:     the exact claim key (tenant, account, platform, provider id)
 *               exists: this event was already processed (V2 would see a
 *               duplicate claim and stay silent).
 *  redelivered: another inbound row of THIS tenant/conversation carries the
 *               same provider id (possible only without the messages unique
 *               index, or when its pre-check was skipped): a repeat delivery.
 */
async function priorDelivery(db:Db,event:DurableEvent):Promise<Prior>{
 const [claim,inbound]=await Promise.all([
  db.from("automation_message_claims").select("id")
   .eq("tenant_id",event.tenantId).eq("channel_account_id",event.accountId)
   .eq("platform","instagram").eq("provider_event_id",event.eventId).limit(1),
  db.from("messages").select("id")
   .eq("tenant_id",event.tenantId).eq("conversation_id",event.conversationId)
   .eq("direction","in").eq("wa_message_id",event.eventId).limit(2)
 ]);
 if(claim.error||inbound.error||!Array.isArray(claim.data)||!Array.isArray(inbound.data))
  return "error";
 if(claim.data.length>0)return "claimed";
 if(inbound.data.some(m=>!record(m)||m.id!==event.inboundId))return "redelivered";
 return "new";
}
type CancelReason="free_text"|"revision_inactive"|"superseded";
const ACTIVE_RUN_STATUSES=["ready","awaiting_input","sleeping"] as const;
const activeRunConflict=(error:unknown)=>record(error)&&error.code==="23505"&&
 typeof error.message==="string"&&error.message.includes("flow_active_run_exists");
/** Tenant-scoped cancel; true only when the RPC itself succeeded. */
async function cancelRun(db:Db,tenantId:string,runId:string,reason:CancelReason,
 expect:string):Promise<boolean>{
 const r=await db.rpc("flow_cancel_run",{
  p_tenant:tenantId,p_run:runId,p_reason:reason,p_expect_status:expect
 });
 // data=false means the run already left that state (tap/expiry won): not an error.
 return !r.error&&typeof r.data==="boolean";
}
/**
 * Ends a waiting run and hands the message to the existing V2/AI path.
 * Fails closed (handled) only when the cancel cannot be confirmed.
 */
async function cancelThenFallback(db:Db,tenantId:string,runId:string,
 reason:"free_text"|"revision_inactive"):Promise<Result>{
 if(await cancelRun(db,tenantId,runId,reason,"awaiting_input"))return "fallback";
 console.warn("[flow-durable] waiting run cancel unconfirmed");
 return "handled";
}
/** Supersedes every active run of this tenant conversation; false = fail closed. */
async function supersedeActiveRuns(db:Db,event:DurableEvent):Promise<boolean>{
 const active=await db.from("automation_flow_runs")
  .select("id,tenant_id,conversation_id,run_status")
  .eq("tenant_id",event.tenantId).eq("conversation_id",event.conversationId)
  .in("run_status",[...ACTIVE_RUN_STATUSES]).limit(20);
 if(active.error||!Array.isArray(active.data))return false;
 for(const run of active.data){
  if(!record(run)||run.tenant_id!==event.tenantId||
     run.conversation_id!==event.conversationId||typeof run.id!=="string"||
     !ACTIVE_RUN_STATUSES.includes(run.run_status as never))return false;
 }
 for(const run of active.data as RecordValue[]){
  // Ignore result=false (already ended); the DB trigger still guards races.
  if(!await cancelRun(db,event.tenantId,run.id as string,"superseded",
     run.run_status as string))return false;
 }
 return true;
}
/** Bound of the tenant-wide queued-handoff read (a full page fails closed). */
export const PENDING_HANDOFF_SCAN=100;
/**
 * Age limit of a queued handoff that may still silence a conversation. Must
 * equal flow-internal-worker INTERNAL_STALE_MINUTES (the worker never executes
 * an older one), so a handoff that can no longer run never holds the
 * conversation, whether or not FLOW_INTERNAL_ACTIONS_ENABLED is on.
 */
export const PENDING_HANDOFF_MAX_MINUTES=1440;
/**
 * READ-ONLY: is a handoff of THIS tenant/account/conversation committed but
 * not yet executed (outbox effect pending or leased) and younger than
 * PENDING_HANDOFF_MAX_MINUTES? Between the commit and the internal worker
 * switching conversations.transferred, the conversation must stay silent like
 * a human takeover. Executed, cancelled, failed (dead_letter) or expired
 * handoffs do not hold anything; expired rows are filtered in the query so
 * they never count toward the full-page cap. Errors fail closed.
 */
async function pendingHandoff(db:Db,event:DurableEvent):Promise<"none"|"pending"|"error">{
 const cutoff=new Date(Date.now()-PENDING_HANDOFF_MAX_MINUTES*60000).toISOString();
 const queued=await db.from("automation_flow_outbox").select("run_id,tenant_id")
  .eq("tenant_id",event.tenantId).eq("effect_kind","handoff")
  .in("delivery_status",["pending","leased"]).gt("created_at",cutoff)
  .limit(PENDING_HANDOFF_SCAN);
 if(queued.error||!Array.isArray(queued.data))return "error";
 if(queued.data.length>=PENDING_HANDOFF_SCAN)return "error";
 const runIds=[...new Set((queued.data as RecordValue[])
  .filter(r=>record(r)&&r.tenant_id===event.tenantId&&typeof r.run_id==="string")
  .map(r=>r.run_id as string))];
 if(runIds.length===0)return "none";
 const runs=await db.from("automation_flow_runs").select("id,tenant_id,channel_account_id,conversation_id")
  .eq("tenant_id",event.tenantId).eq("conversation_id",event.conversationId)
  .in("id",runIds).limit(PENDING_HANDOFF_SCAN);
 if(runs.error||!Array.isArray(runs.data))return "error";
 return (runs.data as RecordValue[]).some(r=>record(r)&&r.tenant_id===event.tenantId&&
  r.conversation_id===event.conversationId&&runIds.includes(r.id as string))?"pending":"none";
}
type Claimed="acquired"|Result;
/**
 * Exclusive inbound claim for the durable path.
 * TEST mode (test_only tenants): flow_claim_inbound (20261028220000),
 * unchanged; anything but an acquired 'flow' claim fails closed.
 * PRODUCTION CANARY mode (production_approved, test_only=false):
 * flow_claim_inbound_durable (20261029170000), which re-verifies the
 * operator-registered canary tenant/account/platform, switches, activation
 * and ownership in SQL. No row = not eligible and NO claim was written, so
 * the inbound is left to V2 ("fallback"); an RPC error also writes no claim
 * here (or, if it did, V2's own claim then sees a duplicate and stays
 * silent), so it falls back too. A returned non-acquired row means another
 * delivery already owns this event.
 */
async function claimInbound(db:Db,event:DurableEvent,canary:boolean):Promise<Claimed>{
 if(canary){
  const r=await db.rpc("flow_claim_inbound_durable",{
   p_tenant_id:event.tenantId,p_account_id:event.accountId,
   p_platform:"instagram",p_provider_event_id:event.eventId,
   p_conversation_id:event.conversationId,p_inbound_message_id:event.inboundId
  });
  if(r.error||!Array.isArray(r.data))return "fallback";
  if(r.data.length===0)return "fallback";
  return r.data.length===1&&r.data[0].acquired===true&&r.data[0].route==="flow"?
   "acquired":"handled";
 }
 const claim=await db.rpc("flow_claim_inbound",{
  p_tenant_id:event.tenantId,p_account_id:event.accountId,
  p_platform:"instagram",p_provider_event_id:event.eventId,
  p_conversation_id:event.conversationId,p_inbound_message_id:event.inboundId,
  p_engine_ready:true
 });
 if(claim.error||!Array.isArray(claim.data)||claim.data.length!==1||
    claim.data[0].acquired!==true||claim.data[0].route!=="flow")
  return "handled";
 return "acquired";
}
/** Max default re-asks per typed question; afterwards V2 answers, the run keeps waiting. */
export const MAX_REASKS=3;
type TypedQuestion={nodeId:string;mode:DurableAnswerMode;text:string};
/** The whitelisted text/email/phone question the run waits at, else null. */
function typedQuestionAt(raw:unknown,nodeId:unknown):TypedQuestion|null{
 if(typeof nodeId!=="string"||!supportedDurableDocument(raw))return null;
 const n=(raw.nodes as unknown as RecordValue[]).find(x=>x.id===nodeId);
 const d=n?.data as RecordValue|undefined;
 return d&&d.kind==="question"&&durableAnswerMode(d.inputMode)&&typeof d.text==="string"?
  {nodeId,mode:d.inputMode,text:d.text}:null;
}
/**
 * Invalid-answer counter of one question. "__" names can never be read or
 * written by a document (fieldOk) or rendered; it exists only while the run
 * waits at that node and is removed by the valid answer.
 */
export const reaskField=(nodeId:string)=>"__reask_"+hash32(nodeId).toString(16).padStart(8,"0");
const withoutReaskCounters=(v:Record<string,string>)=>
 Object.fromEntries(Object.entries(v).filter(([k])=>!k.startsWith("__reask_")));
/**
 * Typed answer to the waiting question, after priorDelivery, the run scope
 * checks and the activation check. Both outcomes commit through the
 * unchanged flow_resume_button_run (claim 'flow' route, receipt per provider
 * event, FOR UPDATE on the expected step/node), so a redelivered or
 * concurrent copy of the same answer can never resume or re-ask twice.
 *  valid:   normalized value -> variables[inputField]; plan from the next
 *           node with planUntilWait (same safety rules as a tap).
 *  invalid: the run stays awaiting_input at the SAME node (step + 1, counter
 *           + 1) with one plain re-ask message; after MAX_REASKS the message
 *           goes to V2 with no state change (the input-timeout sweep ends it).
 * The answer is never logged or put into an error.
 */
async function answerTypedQuestion(db:Db,event:DurableEvent,canary:boolean,runId:string,
 doc:FlowDocument,state:RuntimeState,q:TypedQuestion):Promise<Result>{
 const variables=record(state.variables)?state.variables as Record<string,string>:{};
 const answer=normalizeDurableAnswer(q.mode,event.text);
 const commit=async(next:{nodeId:string;stepCount:number;status:string;
  variables:Record<string,string>;wakeAt:number|null},effects:ReturnType<typeof effectsPayload>)=>{
  const claimed=await claimInbound(db,event,canary);
  if(claimed!=="acquired")return claimed;
  const r=await db.rpc("flow_resume_button_run",{
   p_tenant:event.tenantId,p_run:runId,p_event:event.eventId,
   p_inbound:event.inboundId,p_expect_step:state.stepCount,
   p_expect_node:state.nodeId,p_next:next.nodeId,
   p_next_step:next.stepCount,p_status:next.status,
   p_variables:next.variables,
   p_wake:next.wakeAt?new Date(next.wakeAt).toISOString():null,
   p_effects:effects
  });
  if(r.error||r.data!==true)
   console.warn("[flow-durable] typed answer continuation pending manual review");
  return "handled" as Result;
 };
 if(answer!==null){
  const plan=planUntilWait(doc,{...state,variables:withoutReaskCounters(variables)},{
   eventKey:event.eventId,nowMs:Date.now(),seed:seedFromEventKey(event.eventId),answer
  });
  if(!safeAnswerPlan(plan))return "handled";
  return commit(plan.state,effectsPayload(plan.effects));
 }
 const key=reaskField(q.nodeId);
 const raw=variables[key];
 const count=raw===undefined?0:/^[0-9]$/.test(String(raw))?Number(raw):MAX_REASKS;
 // Bound reached (or no step budget left): V2 answers, run untouched.
 if(count>=MAX_REASKS||state.stepCount+1>150)return "fallback";
 const effect={kind:"message" as const,
  idempotencyKey:JSON.stringify([state.flowId,state.revision,event.eventId,state.stepCount,q.nodeId,"reask"]),
  nodeId:q.nodeId,
  text:reaskText(q.mode,renderCollectedTemplate(q.text,variables,collectedFields(doc))),seq:0};
 return commit({nodeId:q.nodeId,stepCount:state.stepCount+1,status:"awaiting_input",
  variables:{...variables,[key]:String(count+1)},wakeAt:null},effectsPayload([effect]));
}
/**
 * Returns handled only when this server-owned path has taken responsibility
 * or must fail closed. false/fallback allows the existing text-only engine.
 */
export async function attemptDurableInstagram(
 db:Db,event:DurableEvent
):Promise<Result>{
 if(Deno.env.get("FLOW_DURABLE_INGRESS_ENABLED")!=="true"||
    Deno.env.get("FLOW_DURABLE_CANARY_ACCOUNT_ID")!==event.accountId||
    !validEvent(event))return "fallback";
 try{
  const [g,s]=await Promise.all([
   db.from("automation_flow_global_switch").select("enabled")
    .eq("singleton",true).maybeSingle(),
   db.from("automation_flow_tenant_switches").select("enabled,test_only,production_approved")
    .eq("tenant_id",event.tenantId).maybeSingle()
  ]);
  if(g.error||s.error)return "handled";
  // flow_claim_inbound (20261028220000) routes an inbound to 'flow' only for
  // test_only tenants. Without test_only it would be acquired as 'legacy_ai',
  // this path would return "handled" and the existing reply path would then
  // see a duplicate claim: the customer gets no answer at all. So:
  //  * test_only + approved  -> TEST mode, flow_claim_inbound (unchanged);
  //  * approved, test_only=false -> PRODUCTION CANARY mode, the separate
  //    flow_claim_inbound_durable, which writes no claim unless the SQL side
  //    confirms the registered canary (then V2 claims as before);
  //  * anything else -> leave the inbound unclaimed for V2/AI.
  if(g.data?.enabled!==true||s.data?.enabled!==true||
     s.data?.production_approved!==true)return "fallback";
  const testMode=s.data?.test_only===true;
  const canaryMode=s.data?.test_only===false;
  if(!testMode&&!canaryMode)return "fallback";
  // A duplicate or previously processed event must never cancel, supersede
  // or resume a (newer) run. Checked read-only BEFORE the waiting-run logic.
  const prior=await priorDelivery(db,event);
  if(prior==="error"||prior==="claimed")return "handled";
  // Repeat delivery not claimed yet (the first copy is still in flight, or
  // was never claimed): leave every run alone; V2's exclusive claim on the
  // same key answers at most once (silent if the first copy claims first).
  if(prior==="redelivered")return "fallback";
  const waiting=await db.from("automation_flow_runs")
   .select("id,tenant_id,channel_account_id,platform,conversation_id,provider_event_id,flow_key,publication_revision,current_node_id,run_status,step_count,variables,wake_at")
   .eq("tenant_id",event.tenantId).eq("channel_account_id",event.accountId)
   .eq("conversation_id",event.conversationId).eq("run_status","awaiting_input")
   .limit(2);
  if(waiting.error)return "handled";
  const current=waiting.data??[];
  if(current.length>1)return "handled";
  const choice=event.selectedChoiceId??null;
  if(current.length===1){
   const run=current[0];
   // Fail closed: never act on a row that is not exactly this tenant/account/conversation.
   if(!record(run)||run.tenant_id!==event.tenantId||
      run.channel_account_id!==event.accountId||
      run.conversation_id!==event.conversationId||
      typeof run.id!=="string"||run.platform!=="instagram")return "handled";
   // A replay of the event that started this run is already claimed and
   // answered by it: never let it end the wait as "free text".
   if(run.provider_event_id===event.eventId)return "handled";
   const tapped=typeof choice==="string"&&safeId(choice);
   const readPublication=()=>db.from("automation_flow_publications")
    .select("document").eq("tenant_id",event.tenantId)
    .eq("channel_account_id",event.accountId).eq("platform","instagram")
    .eq("flow_key",run.flow_key).eq("revision",run.publication_revision).maybeSingle();
   let publication:Awaited<ReturnType<typeof readPublication>>|null=null;
   if(!tapped){
    // Free text / missing payload: only a waiting text/email/phone question
    // takes it as its answer; any other wait ends so the existing reply path
    // answers (unchanged behaviour).
    publication=await readPublication();
    if(publication.error)return "handled";
    if(!typedQuestionAt(publication.data?.document,run.current_node_id))
     return cancelThenFallback(db,event.tenantId,run.id,"free_text");
   }
   const live=await db.from("automation_flow_activations")
    .select("flow_key,revision,is_active").eq("tenant_id",event.tenantId)
    .eq("channel_account_id",event.accountId).eq("platform","instagram")
    .eq("flow_key",run.flow_key).eq("revision",run.publication_revision)
    .eq("is_active",true).limit(2);
   if(live.error)return "handled";
   if(!Array.isArray(live.data)||!live.data.some(a=>record(a)&&a.is_active===true&&
      a.flow_key===run.flow_key&&Number(a.revision)===Number(run.publication_revision)))
    return cancelThenFallback(db,event.tenantId,run.id,"revision_inactive");
   if(!publication){
    publication=await readPublication();
    if(publication.error)return "handled";
   }
   if(!supportedDurableDocument(publication.data?.document))
    return cancelThenFallback(db,event.tenantId,run.id,"revision_inactive");
   const doc=publication.data.document;
   const state:RuntimeState={
    flowId:run.flow_key,revision:Number(run.publication_revision),
    nodeId:run.current_node_id,status:"awaiting_input",stepCount:Number(run.step_count),
    variables:run.variables??{},wakeAt:null
   };
   const typed=typedQuestionAt(doc,state.nodeId);
   if(typed){
    // A button tap (current or stale) is not an answer to a typed question:
    // the run keeps waiting unchanged and V2 answers this message.
    if(tapped)return "fallback";
    return answerTypedQuestion(db,event,canaryMode,run.id as string,doc,state,typed);
   }
   const plan=planUntilWait(doc,state,{
    eventKey:event.eventId,nowMs:Date.now(),seed:seedFromEventKey(event.eventId),answer:choice as string
   });
   // A stale/unknown button for this question behaves like free text.
   if(plan.error==="unsupported button response")
    return cancelThenFallback(db,event.tenantId,run.id,"free_text");
   if(!safePlan(plan))return "handled";
   const tapClaim=await claimInbound(db,event,canaryMode);
   if(tapClaim!=="acquired")return tapClaim;
   const commit=await db.rpc("flow_resume_button_run",{
    p_tenant:event.tenantId,p_run:run.id,p_event:event.eventId,
    p_inbound:event.inboundId,p_expect_step:state.stepCount,
    p_expect_node:state.nodeId,p_next:plan.state.nodeId,
    p_next_step:plan.state.stepCount,p_status:plan.state.status,
    p_variables:plan.state.variables,
    p_wake:plan.state.wakeAt?new Date(plan.state.wakeAt).toISOString():null,
    p_effects:effectsPayload(plan.effects)
   });
   if(commit.error||commit.data!==true)
    console.warn("[flow-durable] button continuation pending manual review");
   return "handled";
  }
  if(choice)return "handled"; // stale choice must never start a fresh run.
  // A committed handoff whose conversation switch is still queued: the human
  // takeover is about to start, so neither a new run nor V2/AI may answer.
  const handoff=await pendingHandoff(db,event);
  if(handoff!=="none")return "handled";
  const active=await db.from("automation_flow_activations")
   .select("flow_key,revision,is_active").eq("tenant_id",event.tenantId)
   .eq("channel_account_id",event.accountId).eq("platform","instagram")
   .eq("is_active",true).limit(2);
  if(active.error)return "handled";
  if(!Array.isArray(active.data)||active.data.length!==1)return "fallback";
  const selection=active.data[0];
  if(!Number.isSafeInteger(Number(selection.revision)))return "handled";
  const pub=await db.from("automation_flow_publications").select("document")
   .eq("tenant_id",event.tenantId).eq("channel_account_id",event.accountId)
   .eq("platform","instagram").eq("flow_key",selection.flow_key)
   .eq("revision",selection.revision).maybeSingle();
  if(pub.error)return "handled";
  if(!supportedDurableDocument(pub.data?.document))return "fallback";
  const doc=pub.data.document;
  const state=createRuntimeState(doc,selection.flow_key,Number(selection.revision));
  const plan=planUntilWait(doc,state,{
   eventKey:event.eventId,nowMs:Date.now(),seed:seedFromEventKey(event.eventId)
  });
  if(!safePlan(plan))return "handled";
  const claimed=await claimInbound(db,event,canaryMode);
  if(claimed!=="acquired")return claimed;
  // Only after this inbound is exclusively claimed (duplicate deliveries stop
  // above): end any older active run so its delayed reply is never sent.
  if(!await supersedeActiveRuns(db,event))return "handled";
  const begin=await db.rpc("flow_begin_durable_run",{
   p_tenant:event.tenantId,p_account:event.accountId,
   p_conversation:event.conversationId,p_inbound:event.inboundId,
   p_event:event.eventId,p_flow:selection.flow_key,p_revision:selection.revision,
   p_start:state.nodeId,p_next:plan.state.nodeId,
   p_next_step:plan.state.stepCount,p_status:plan.state.status,
   p_variables:plan.state.variables,
   p_wake:plan.state.wakeAt?new Date(plan.state.wakeAt).toISOString():null,
   p_effects:effectsPayload(plan.effects)
  });
  if(activeRunConflict(begin.error))
   // A concurrent start owns this conversation; never send a second reply.
   console.warn("[flow-durable] active run exists; new run skipped");
  else if(begin.error||typeof begin.data!=="string")
   console.warn("[flow-durable] initial run pending manual review");
  return "handled";
 }catch(error){
  console.error("[flow-durable] guarded path failed",error instanceof Error?error.name:"unknown");
  return "handled";
 }
}
