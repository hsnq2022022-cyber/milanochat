/**
 * ONE deterministic decision: who owns an inbound customer message.
 *
 * Pure of IO, env and Deno globals: every read/write is an injected callback,
 * so the whole precedence is unit-testable and handleIncomingWebhookMessage
 * (index.ts) contains no routing logic of its own.
 *
 * PRECEDENCE (first match wins, evaluated in exactly this order):
 *   1. HUMAN        conversation transferred to a person (manual takeover,
 *                   AI-handoff takeover). Nobody answers. An expired
 *                   "manual_takeover" is resumed first (see resumeTakeover).
 *   2. NO REPLY     automation paused or ineligible: credits pause, account
 *                   auto-reply / agent disabled, no credits left, account not
 *                   proven, event cannot be claimed (no provider id).
 *   3. FLOW SESSION a durable Flow session already exists for this
 *                   conversation (waiting for the customer, or a handoff
 *                   queued): the Flow engine owns the message. The AI NEVER
 *                   answers a message a Flow session owns.
 *   4. FLOW TRIGGER the best matching active Flow starts (or a simple V2 flow
 *                   answers): the Flow owns the message, the AI does not.
 *   5. AI           no Flow owns the message: the knowledge-base AI answers
 *                   (unchanged behaviour of answerFromKnowledge).
 *
 * "Unknown" is never "no flow": when Flow eligibility cannot be READ (database
 * error, unconfirmed claim) NOBODY answers and the event is kept retryable, so
 * a Flow failure can never silently turn into a conflicting AI reply.
 * "Fallback" (flow not started, nothing claimed - gates closed, document
 * refused, no trigger matched, session just ended) hands the message to
 * step 4/5 under the SAME atomic claim.
 *
 * ATOMICITY. Ownership is not decided by this module: it is decided by one
 * database row per provider event (automation_message_claims, UNIQUE
 * (tenant, account, platform, provider_event_id); flow_claim_inbound /
 * flow_claim_inbound_durable / flow_claim_begin_durable_run). The winner of
 * that insert owns the event for good; a concurrent or redelivered copy sees
 * acquired=false and never answers ("duplicate"). This module only orders the
 * checks that happen BEFORE the claim and interprets what comes back.
 *
 * SESSION LIFECYCLE (all enforced in SQL / flowDurableIngress.ts):
 *   - completion   a run reaching End / its last step ends as 'completed'.
 *   - cancellation a customer's free text while the session waits for a button
 *                  choice ends it ('cancelled', free_text) and the message goes
 *                  on through steps 4-5; a deactivated/unsupported revision ends
 *                  it ('revision_inactive'). An unconfirmed cancel = retry.
 *   - expiration   flow_expire_waiting_runs ends sessions that wait too long.
 *   - handoff      a queued or executed handoff holds the conversation silent
 *                  like a human takeover; conversations.transferred then keeps
 *                  it silent until staff release it or the takeover expires.
 */
import {isRetryableOutcome} from "./inboundRoutingRetry.ts";
import type {LiveNoReplyReason} from "./inboundRecovery.ts";

export type Owner="human"|"flow_session"|"flow"|"ai"|"none"|"unknown";

export type ConversationFacts={
 transferred:unknown;
 autoPausedReason:unknown;
 /** Parsed expiry of a manual takeover (ms). NaN / null = no usable expiry (never "expired"). */
 humanAgentExpiresAtMs:number|null;
 agentEnabled:unknown;
 autoReply:unknown;
 creditsRemaining:number;
 nowMs:number;
};

export type GateDecision=
 |{action:"proceed";resumeTakeover:boolean}
 |{action:"stop";owner:"human"|"none";reason:Extract<LiveNoReplyReason,"live_human_takeover"|"live_credits_paused"|"live_auto_reply_off"|"live_no_credits">;
    pauseForCredits:boolean;resumeTakeover:boolean};

/** Steps 1-2 on conversation/account facts. Same order and semantics as the former inline checks. */
export function conversationGate(f:ConversationFacts):GateDecision{
 let transferred=Boolean(f.transferred);
 let paused=f.autoPausedReason;
 let resume=false;
 // An expired manual takeover hands the conversation back to automation.
 if(transferred&&paused==="manual_takeover"&&f.humanAgentExpiresAtMs!==null&&
    f.humanAgentExpiresAtMs<=f.nowMs){
  resume=true;transferred=false;paused=null;
 }
 if(transferred)return {action:"stop",owner:"human",reason:"live_human_takeover",pauseForCredits:false,resumeTakeover:resume};
 if(paused==="credits")return {action:"stop",owner:"none",reason:"live_credits_paused",pauseForCredits:false,resumeTakeover:resume};
 if(f.agentEnabled===false||f.autoReply===false)
  return {action:"stop",owner:"none",reason:"live_auto_reply_off",pauseForCredits:false,resumeTakeover:resume};
 if(f.creditsRemaining<=0)return {action:"stop",owner:"none",reason:"live_no_credits",pauseForCredits:true,resumeTakeover:resume};
 return {action:"proceed",resumeTakeover:resume};
}

export type FlowStage="handled"|"retry"|"fallback";
export type Route="legacy_ai"|"flow";
export type ExclusiveRun={outcome:string;/** route of the committed claim, null when none was acquired/read */route:Route|null};

export type RouteInput={
 conversation:ConversationFacts;
 /** channel_accounts row proven for this tenant/platform. */
 accountProven:boolean;
 /** persisted inbound row AND a stable provider event id (<=256) exist. */
 eventClaimable:boolean;
 /** the durable engine may be consulted for this channel (instagram, or multichannel flag). */
 durableApplicable:boolean;
};
export type RouteDeps={
 resumeTakeover():Promise<void>;
 pauseForCredits():Promise<void>;
 /** Log-only observation hook between the gate and the flow stage (no effect on routing). */
 afterGate?():Promise<void>;
 attemptDurable():Promise<FlowStage>;
 exclusive():Promise<ExclusiveRun>;
};

export type RouteDecision=
 |{kind:"no_reply";owner:"human"|"none";reason:LiveNoReplyReason;resolve:true}
 |{kind:"no_reply";owner:"none";reason:"account_unproven";resolve:true}
 |{kind:"no_reply";owner:"none";reason:"event_unclaimable";resolve:false}
 |{kind:"retry";owner:"unknown";stage:"flow"|"claim"}
 |{kind:"flow_session";owner:"flow_session";resolve:true}
 |{kind:"claimed";owner:"flow"|"ai"|"none";outcome:string;resolve:true};

/** Owner of an event after the exclusive claim. */
export function ownerOfClaim(run:ExclusiveRun):"flow"|"ai"|"none"{
 if(run.route==="flow")return "flow";
 if(run.route==="legacy_ai")return "ai";
 return "none";
}

/**
 * The single routing entry point. Calls the injected stages in precedence
 * order and stops at the first that owns, silences or defers the message.
 */
export async function routeInbound(input:RouteInput,deps:RouteDeps):Promise<RouteDecision>{
 const gate=conversationGate(input.conversation);
 // An expired takeover is handed back first, even when a later check then silences the reply.
 if(gate.resumeTakeover)await deps.resumeTakeover();
 if(gate.action==="stop"){
  if(gate.pauseForCredits)await deps.pauseForCredits();
  return {kind:"no_reply",owner:gate.owner,reason:gate.reason,resolve:true};
 }
 if(deps.afterGate)await deps.afterGate();
 if(!input.accountProven)return {kind:"no_reply",owner:"none",reason:"account_unproven",resolve:true};
 if(!input.eventClaimable)return {kind:"no_reply",owner:"none",reason:"event_unclaimable",resolve:false};
 if(input.durableApplicable){
  const stage=await deps.attemptDurable();
  if(stage==="retry")return {kind:"retry",owner:"unknown",stage:"flow"};
  if(stage==="handled")return {kind:"flow_session",owner:"flow_session",resolve:true};
 }
 const run=await deps.exclusive();
 if(isRetryableOutcome(run.outcome))return {kind:"retry",owner:"unknown",stage:"claim"};
 return {kind:"claimed",owner:ownerOfClaim(run),outcome:run.outcome,resolve:true};
}
