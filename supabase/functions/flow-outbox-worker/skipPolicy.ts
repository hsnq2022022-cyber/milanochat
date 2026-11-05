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
export type OutboxSkipReason="human_takeover"|"revision_inactive"|"ineligible";

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
export const OUTBOX_DISPATCH_LIMIT=10;
export const OUTBOX_STALE_MINUTES=60;
