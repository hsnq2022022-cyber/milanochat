/**
 * Stage 11 contract only: this function does not call an LLM or fetch private
 * knowledge. Runtime AI must be implemented in a trusted tenant-scoped service.
 */
export type AIStopReason =
  | "wrong_tenant" | "manual_handoff" | "automation_disabled" | "no_credits"
  | "knowledge_unavailable" | "no_approved_sources" | "unverified_evidence"
  | "invalid_request";
export type FlowAIRequest = {
  verifiedTenantId: string;
  publishedFlowTenantId: string;
  knowledgeTenantId: string;
  conversationTenantId: string;
  sourceCount: number;
  retrievedEvidenceCount: number;
  knowledgeRetrievalSucceeded: boolean;
  creditBalance: number;
  humanTakeover: boolean;
  agentEnabled: boolean;
};
export type AIAuthorization =
  | {allowed: true; evidenceRequired: true}
  | {allowed: false; reason: AIStopReason};

/** لا تخمين لأسعار أو معلومات خارج مصادر المتجر المعتمدة. */
export function authorizeFlowAI(input: FlowAIRequest): AIAuthorization {
  if (!input || typeof input.verifiedTenantId !== "string" ||
      !input.verifiedTenantId || !Number.isSafeInteger(input.sourceCount) ||
      !Number.isSafeInteger(input.retrievedEvidenceCount) ||
      !Number.isFinite(input.creditBalance))
    return { allowed: false, reason: "invalid_request" };
  if ([input.publishedFlowTenantId,input.knowledgeTenantId,input.conversationTenantId]
       .some(id => id !== input.verifiedTenantId))
    return { allowed: false, reason: "wrong_tenant" };
  if (input.humanTakeover) return { allowed: false, reason: "manual_handoff" };
  if (!input.agentEnabled) return { allowed: false, reason: "automation_disabled" };
  if (input.creditBalance <= 0) return { allowed: false, reason: "no_credits" };
  if (!input.knowledgeRetrievalSucceeded)
    return { allowed: false, reason: "knowledge_unavailable" };
  if (input.sourceCount <= 0)
    return { allowed: false, reason: "no_approved_sources" };
  if (input.retrievedEvidenceCount <= 0)
    return { allowed: false, reason: "unverified_evidence" };
  return { allowed: true, evidenceRequired: true };
}

// لا تُخزن محتوى الرسالة أو بيانات الزبون ضمن سجل الأداء.
export type FlowMetricKind = "started" | "transition" | "button" |
  "delivered" | "completed" | "handoff" | "failed";
export type FlowMetric = {
  tenantId: string;
  runId: string;
  kind: FlowMetricKind;
  occurredAt: string;
};
export function planFlowMetric(
  source: {
    tenantId: string; runId: string; kind: FlowMetricKind;
    occurredAt: string; providerDeliveryConfirmed?: boolean;
    isSimulation?: boolean;
  }
): FlowMetric | null {
  if (source.isSimulation || !source.tenantId || !source.runId ||
      !Number.isFinite(Date.parse(source.occurredAt))) return null;
  if (!["started","transition","button","delivered","completed","handoff","failed"]
      .includes(source.kind)) return null;
  // Delivered counts only reflect provider receipts, not the outgoing HTTP request.
  if (source.kind === "delivered" && source.providerDeliveryConfirmed !== true)
    return null;
  return {
    tenantId: source.tenantId, runId: source.runId,
    kind: source.kind, occurredAt: source.occurredAt
  };
}
