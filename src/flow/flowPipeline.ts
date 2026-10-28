/**
 * STAGING-ONLY pure assembly of separately reviewed routing, publication and
 * execution contracts. This file is not imported from the live milan-api.
 * It does not authenticate Meta, query Supabase, write outbox, send, or debit.
 */
import {selectResponder} from "./responderDecision.ts";
import type {TrustedResponderSnapshot} from "./responderDecision.ts";
import {auditFlowPublication} from "./publicationGate.ts";
import type {FlowCapability} from "./publicationGate.ts";
import {createRuntimeState,planRuntimeTransition} from "./runtimePlan.ts";
import type {RuntimePlan} from "./runtimePlan.ts";
import type {EnabledFlow,NormalizedInboundEvent} from "./eventRouting.ts";

export type ServerPublishedFlow = EnabledFlow & {revision:number};

export type PipelineResult =
 | {owner:"legacy_ai";reason:"flow_off"|"no_match"|"ambiguous_match"}
 | {owner:"stop";reason:string}
 | {owner:"flow";flowId:string;revision:number;plan:RuntimePlan};

/**
 * The calling trusted backend MUST:
 *  - validate Meta signature over the raw body and resolve identities itself;
 *  - fetch only activated/immutable publications scoped to this tenant;
 *  - derive capabilities from server config and Meta-approved permissions;
 *  - persist receipt, runtime state and outbox atomically BEFORE sending.
 * Client-supplied flags, capabilities, tenant IDs and documents are forbidden.
 */
export function planVerifiedInbound(
  trusted:TrustedResponderSnapshot,
  inbound:NormalizedInboundEvent,
  serverFlows:readonly ServerPublishedFlow[],
  serverCapabilities:ReadonlySet<FlowCapability>,
  nowMs:number,
  seed:number
):PipelineResult {
  // Any malformed server-read document must fail closed; do not let a bad
  // publication crash webhook handling or accidentally fall back to two AIs.
  try {
  const decision=selectResponder(trusted,inbound,serverFlows);
  if(decision.owner==="stop")return decision;
  if(decision.owner==="legacy_ai")return decision;

  const matches=serverFlows.filter(x=>x.id===decision.match.flowId &&
    x.tenantId===trusted.tenantId && x.accountId===trusted.accountId &&
    x.enabled===true);
  if(matches.length!==1)return {owner:"stop",reason:"non_unique_publication"};
  const publication=matches[0];
  if(!Number.isSafeInteger(publication.revision)||publication.revision<1)
    return {owner:"stop",reason:"invalid_revision"};
  if(!serverCapabilities || !auditFlowPublication(
    publication.document,serverCapabilities
  ).canPublish)return {owner:"stop",reason:"invalid_publication"};
  if(!Number.isSafeInteger(nowMs)||nowMs<0||!Number.isSafeInteger(seed))
    return {owner:"stop",reason:"invalid_tick"};

  try {
    const initial=createRuntimeState(publication.document,publication.id,publication.revision);
    const plan=planRuntimeTransition(publication.document,initial,{
      eventKey:inbound.eventId,nowMs,seed
    });
    if(plan.error || plan.state.status==="blocked" || plan.effects.length>1)
      return {owner:"stop",reason:"execution_blocked"};
    return {owner:"flow",flowId:publication.id,revision:publication.revision,plan};
  } catch {
    return {owner:"stop",reason:"invalid_publication"};
  }
  } catch {
    return {owner:"stop",reason:"malformed_server_event_or_document"};
  }
}
