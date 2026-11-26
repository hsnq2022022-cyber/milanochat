/**
 * Pure, Deno-free classification of outbox effects that must NEVER be sent
 * later. A non-null reason means the worker skips the effect through
 * flow_skip_outbox_effect (delivery_status='cancelled' + cancel_reason), so a
 * message blocked during a human takeover is not delivered after it ends and
 * permanently blocked rows stop occupying the oldest-first batch.
 *
 * TEMPORARY pauses (tenant inactive, account inactive, agent_enabled or
 * auto_reply switched off) are NOT reasons here: see temporaryOutboxPause.
 * Those effects, like effects held by operator rollout gates (global/tenant
 * switch, test_only/production approval, canary account, rich-button/RAG
 * flags, credits, provider token), stay pending and the stale sweep
 * (flow_skip_blocked_outbox, OUTBOX_STALE_MINUTES) bounds how long they wait.
 */
export type OutboxSkipReason="human_takeover"|"revision_inactive"|"ineligible"|"superseded";

/**
 * Same rule as milan-api (lazy expiry ~index.ts:1672-1700) and the SQL helper
 * flow_conversation_human_takeover (20261029150000). Canonical columns:
 * conversations.transferred, human_agent_expires_at, auto_paused_reason
 * (human_agent_until does not exist). Active while transferred is true,
 * unless the expiry has passed for a 'manual_takeover'. Malformed values fail
 * closed (= takeover).
 */
export function humanTakeoverActive(transferred:unknown,expiresAt:unknown,
 pausedReason:unknown,nowMs:number):boolean{
 if(transferred==null||transferred===false)return false;
 if(transferred!==true)return true;
 if(expiresAt==null)return true;
 if(typeof expiresAt!=="string")return true;
 const t=Date.parse(expiresAt);
 if(!Number.isFinite(t)||!Number.isFinite(nowMs)||t>nowMs)return true;
 return pausedReason!=="manual_takeover";
}

export type OutboxSkipInput={
 tenantFound:boolean;tenantActive:unknown;
 runFound:boolean;
 accountFound:boolean;conversationFound:boolean;
 accountTenantMatches:boolean;conversationTenantMatches:boolean;
 accountPlatformMatchesRun:boolean;conversationAccountMatches:boolean;
 accountActive:unknown;agentEnabled:unknown;autoReply:unknown;
 allowedChannel:boolean;
 humanTransferred:unknown;humanAgentExpiresAt:unknown;humanPausedReason:unknown;
 revisionActive:unknown;
};

/** Only call with rows from queries that succeeded; lookup errors are transient. */
export function permanentOutboxBlock(v:OutboxSkipInput,nowMs:number):OutboxSkipReason|null{
 if(!v.tenantFound||!v.runFound)return "ineligible";
 if(v.conversationFound&&v.conversationTenantMatches&&
    humanTakeoverActive(v.humanTransferred,v.humanAgentExpiresAt,v.humanPausedReason,nowMs))
  return "human_takeover";
 if(v.revisionActive!==true)return "revision_inactive";
 if(!v.accountFound||!v.conversationFound||!v.accountTenantMatches||
    !v.conversationTenantMatches||!v.accountPlatformMatchesRun||
    !v.conversationAccountMatches||!v.allowedChannel)return "ineligible";
 return null;
}

export type OutboxPauseReason="tenant_inactive"|"account_inactive"|"agent_disabled"|"auto_reply_off";
/** Temporary pause: the effect stays pending (never cancelled by the worker). */
export function temporaryOutboxPause(v:Pick<OutboxSkipInput,
 "tenantActive"|"accountActive"|"agentEnabled"|"autoReply">):OutboxPauseReason|null{
 if(v.tenantActive!==true)return "tenant_inactive";
 if(v.accountActive!==true)return "account_inactive";
 if(v.agentEnabled!==true)return "agent_disabled";
 if(v.autoReply!==true)return "auto_reply_off";
 return null;
}

/** Bounded scan: skipped/blocked rows must not starve newer sendable rows. */
export const OUTBOX_SCAN_LIMIT=50;
/** Provider sends per tick (cron: once a minute). Measured on the throwaway PG chain (lifecycle step "outbox capacity"):
 *  about 85 ms of server work per send, so a full tick is seconds, not minutes, and never overlaps the next tick.
 *  Shared round-robin between tenants (fairness.ts). Sends stay sequential: per-run order and billing are unchanged. */
export const OUTBOX_DISPATCH_LIMIT=40;
export const OUTBOX_STALE_MINUTES=60;

/**
 * SUPERSESSION by a newer AI reply (production tenants, unsent Flow effects).
 *
 * A `legacy_ai` row in automation_message_claims only says the AI route was SELECTED and the event
 * claimed. It is inserted by flow_claim_inbound BEFORE the answer is generated or sent and it is
 * permanent (a webhook retry sees "duplicate"), so an empty answer, a failed or unconfirmed send or an
 * unavailable delivery reservation all leave a claim and NO reply. A claim alone is therefore never
 * proof; a Flow message is superseded only by DELIVERY EVIDENCE for that claim:
 *   - a persisted outbound message whose id is the claim's outgoing_message_id (written by persistSent
 *     only after the provider accepted the send), or
 *   - its automation_delivery_attempts row with status 'confirmed' (delivery tracking enabled).
 * 'attempting' = the send is in flight: HOLD. 'uncertain' (send_failed / sent_unconfirmed / timeout) is
 * not delivery: proceed. An unknown status or a truncated claim list is unknown state: HOLD.
 */
export type NewerClaim={id:string;outgoingMessageId:string};
export type SupersessionVerdict="supersede"|"hold"|"proceed";
export function supersessionVerdict(i:{
 claims:readonly NewerClaim[];
 /** More newer claims exist than were read: the answer is unknown. */
 truncated:boolean;
 /** Ids of persisted direction='out' messages (read for the claims' outgoing_message_id values). */
 persistedOutIds:ReadonlySet<string>;
 /** claim id -> automation_delivery_attempts.status (absent = no attempt row). */
 attempts:ReadonlyMap<string,string>;
}):SupersessionVerdict{
 let inFlightOrUnknown=i.truncated;
 for(const c of i.claims){
  const status=i.attempts.get(c.id);
  if(i.persistedOutIds.has(c.outgoingMessageId)||status==="confirmed")return "supersede";
  if(status!==undefined&&status!=="uncertain")inFlightOrUnknown=true; // 'attempting' or an unrecognised value
 }
 return inFlightOrUnknown?"hold":"proceed";
}
