import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeFlowAI, planFlowMetric } from "./aiMetricsGate.ts";
import type { FlowAIRequest } from "./aiMetricsGate.ts";

const base: FlowAIRequest = {
  verifiedTenantId:"t1",publishedFlowTenantId:"t1",
  knowledgeTenantId:"t1",conversationTenantId:"t1",
  sourceCount:2,retrievedEvidenceCount:1,
  knowledgeRetrievalSucceeded:true,creditBalance:10,
  humanTakeover:false,agentEnabled:true
};
test("AI requires tenant-aligned retrieved evidence and positive credits",()=>{
  assert.deepEqual(authorizeFlowAI(base),{allowed:true,evidenceRequired:true});
  for(const [change,reason] of [
    [{knowledgeTenantId:"t2"},"wrong_tenant"],
    [{publishedFlowTenantId:"t2"},"wrong_tenant"],
    [{conversationTenantId:"t2"},"wrong_tenant"],
    [{sourceCount:0},"no_approved_sources"],
    [{retrievedEvidenceCount:0},"unverified_evidence"],
    [{knowledgeRetrievalSucceeded:false},"knowledge_unavailable"],
    [{creditBalance:0},"no_credits"],
    [{humanTakeover:true},"manual_handoff"],
    [{agentEnabled:false},"automation_disabled"]
  ] as const){
    const result=authorizeFlowAI({...base,...change});
    assert.deepEqual(result,{allowed:false,reason});
  }
});
test("raw customer messages and provider errors are never copied into metrics",()=>{
  const row=planFlowMetric({
    tenantId:"tenant",runId:"run",kind:"transition",occurredAt:"2026-10-28T00:00:00Z",
    isSimulation:false
  });
  assert.deepEqual(Object.keys(row||{}),["tenantId","runId","kind","occurredAt"]);
  assert.equal(planFlowMetric({
    tenantId:"tenant",runId:"run",kind:"delivered",occurredAt:"2026-10-28T00:00:00Z"
  }),null);
  assert.equal(planFlowMetric({
    tenantId:"tenant",runId:"run",kind:"delivered",occurredAt:"2026-10-28T00:00:00Z",
    providerDeliveryConfirmed:true,isSimulation:true
  }),null);
  assert.equal(planFlowMetric({
    tenantId:"tenant",runId:"run",kind:"delivered",occurredAt:"2026-10-28T00:00:00Z",
    providerDeliveryConfirmed:true
  })?.kind,"delivered");
});
