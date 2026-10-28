import {test} from "node:test";
import assert from "node:assert/strict";
import {
 claimDelivery, deliveryGate, authorizeLeasedDispatch, recordDebitOutcome, recordProviderOutcome,
 reconcileUncertain, MAX_SEND_ATTEMPTS, type DeliveryRecord,
 type TrustedDeliveryGate, type ProviderOutcome
} from "./deliveryContract.ts";

function record(overrides:Partial<DeliveryRecord>={}):DeliveryRecord {
 return {
  id:"outbox-1",tenantId:"tenant-A",accountId:"account-A",
  conversationId:"conversation-A",providerEventId:"meta-mid-1",
  idempotencyKey:"tenant-A:account-A:meta-mid-1:flow:message",
  outgoingMessageId:"persisted-message-uuid-1",
  status:"pending",attempts:0,leaseToken:null,leaseExpiresAt:null,
  retryAt:null,providerMessageId:null,...overrides
 };
}
function gate(overrides:Partial<TrustedDeliveryGate>={}):TrustedDeliveryGate {
 return {
  verifiedTenantId:"tenant-A",accountTenantId:"tenant-A",
  conversationTenantId:"tenant-A",globalFlowEnabled:true,
  tenantFlowEnabled:true,publicationActive:true,humanTakeover:false,
  agentEnabled:true,autoReplyEnabled:true,creditsRemaining:10,
  tokenValid:true,messagingWindowVerified:true,...overrides
 };
}

test("global and per-tenant flags default false and deny all dispatches",()=>{
 for(const g of [
  gate({globalFlowEnabled:false}),
  gate({tenantFlowEnabled:false}),
  gate({publicationActive:false})
 ]){
  assert.equal(deliveryGate(record(),g),"disabled");
  assert.deepEqual(claimDelivery(record(),g,1000,"lease-A").decision,"denied");
 }
});

test("tenant/account/conversation mismatch, human takeover and low credit fail closed",()=>{
 for(const [overrides,reason] of [
  [{verifiedTenantId:"tenant-B"},"wrong_tenant"],
  [{accountTenantId:"tenant-B"},"wrong_tenant"],
  [{conversationTenantId:"tenant-B"},"wrong_tenant"],
  [{humanTakeover:true},"human_takeover"],
  [{agentEnabled:false},"agent_disabled"],
  [{autoReplyEnabled:false},"agent_disabled"],
  [{creditsRemaining:0},"no_credits"],
  [{creditsRemaining:Number.NaN},"no_credits"],
  [{tokenValid:false},"invalid_token"],
  [{messagingWindowVerified:false},"window_unverified"]
 ] as const){
  assert.equal(deliveryGate(record(),gate(overrides)),reason);
 }
});

test("only one worker can persist a claimed lease in an atomic fake compare-and-swap",()=>{
 const row=record();
 let saved=row, sends=0;
 function casClaim(worker:string){
  const old=saved;
  const claim=claimDelivery(old,gate(),1000,worker);
  if(claim.decision!=="leased")return claim.decision==="skipped"?claim.reason:claim.decision;
  // A production adapter MUST enforce this predicate inside PostgreSQL.
  if(saved.status!==old.status||saved.attempts!==old.attempts)return "lost_race";
  saved=claim.record;
  sends++;
  return "leased";
 }
 assert.equal(casClaim("worker-one"),"leased");
 assert.equal(casClaim("worker-two"),"already_claimed");
 assert.equal(sends,1);
 assert.equal(saved.attempts,1);
 assert.equal(recordProviderOutcome(saved,"wrong-token",{kind:"accepted",providerMessageId:"m1"},1002).decision,"ignored");
});

test("successful provider acceptance yields a stable debit key; RPC errors never cause a resend",()=>{
 let stored=record();
 const leased=claimDelivery(stored,gate(),10_000,"lease-1");
 assert.equal(leased.decision,"leased");
 if(leased.decision!=="leased")throw Error("not leased");
 const accepted=recordProviderOutcome(leased.record,"lease-1",
  {kind:"accepted",providerMessageId:"meta-sent-id-1"},10_002);
 assert.equal(accepted.decision,"updated");
 if(accepted.decision!=="updated")throw Error("not updated");
 stored=accepted.record;
 assert.equal(stored.status,"charge_pending");
 const afterRPCFailure=recordDebitOutcome(stored,"rpc_error");
 assert.deepEqual(afterRPCFailure,stored);
 assert.equal(claimDelivery(afterRPCFailure,gate(),12_000,"new-lease").decision,"skipped");
 assert.equal(recordDebitOutcome(afterRPCFailure,"already_charged").status,"settled");
 assert.equal(recordDebitOutcome(afterRPCFailure,"charged").status,"settled");
 assert.equal(recordDebitOutcome(afterRPCFailure,"insufficient").status,"billing_blocked");
 assert.equal(afterRPCFailure.outgoingMessageId,"persisted-message-uuid-1");
});

test("ambiguous timeout, crash and expired lease cannot generate an automatic second send",()=>{
 const first=claimDelivery(record(),gate(),10_000,"lease-1");
 if(first.decision!=="leased")throw Error("not leased");
 assert.equal(claimDelivery(first.record,gate(),10_100,"lease-2").decision,"skipped");
 const expired=claimDelivery(first.record,gate(),40_000,"lease-2");
 assert.equal(expired.decision,"quarantined");
 if(expired.decision!=="quarantined")throw Error("not quarantined");
 assert.equal(expired.record.status,"uncertain");
 assert.equal(claimDelivery(expired.record,gate(),40_100,"lease-3").decision,"skipped");
 const unknown=recordProviderOutcome(first.record,"lease-1",{kind:"unknown"},10_001);
 assert.equal(unknown.decision,"updated");
 if(unknown.decision!=="updated")throw Error("not updated");
 assert.equal(unknown.record.status,"uncertain");
 assert.equal(claimDelivery(unknown.record,gate(),50_000,"lease-3").decision,"skipped");
 assert.equal(reconcileUncertain(unknown.record,
  {kind:"confirmed_accepted",providerMessageId:"meta-reconciled"}).status,"charge_pending");
});

test("definite transient provider rejection retries with bounded backoff, then dead-letters",()=>{
 let stored=record();let now=10_000;
 for(let n=1;n<=MAX_SEND_ATTEMPTS;n++){
  const claimed=claimDelivery(stored,gate(),now,"lease-"+n);
  assert.equal(claimed.decision,"leased");
  if(claimed.decision!=="leased")throw Error("not leased");
  const outcome:ProviderOutcome={kind:"definitely_rejected",retryable:true};
  const rejected=recordProviderOutcome(claimed.record,"lease-"+n,outcome,now+50);
  assert.equal(rejected.decision,"updated");
  if(rejected.decision!=="updated")throw Error("not updated");
  stored=rejected.record;
  if(n<MAX_SEND_ATTEMPTS){
   assert.equal(stored.status,"retry_wait");
   assert.equal(claimDelivery(stored,gate(),now+51,"premature").decision,"skipped");
   assert.ok(stored.retryAt!==null);
   now=stored.retryAt!;
  }else assert.equal(stored.status,"dead_letter");
 }
 assert.equal(stored.attempts,MAX_SEND_ATTEMPTS);
 assert.equal(claimDelivery(stored,gate(),now+100_000,"lease-again").decision,"skipped");
});

test("permanent rejection and malformed provider acknowledgments do not retry",()=>{
 const claimed=claimDelivery(record(),gate(),1000,"lease-1");
 if(claimed.decision!=="leased")throw Error("not leased");
 const rejected=recordProviderOutcome(claimed.record,"lease-1",
  {kind:"definitely_rejected",retryable:false},1100);
 assert.equal(rejected.decision,"updated");
 if(rejected.decision!=="updated")throw Error("not updated");
 assert.equal(rejected.record.status,"dead_letter");
 const invalid=recordProviderOutcome(claimed.record,"lease-1",
  {kind:"accepted",providerMessageId:""},1100);
 assert.equal(invalid.decision,"updated");
 if(invalid.decision!=="updated")throw Error("not updated");
 assert.equal(invalid.record.status,"uncertain");
});

test("manual reconciliation requires proof before requeueing uncertain work",()=>{
 const ambiguous=record({status:"uncertain",attempts:1});
 assert.equal(claimDelivery(ambiguous,gate(),5000,"lease-2").decision,"skipped");
 assert.deepEqual(reconcileUncertain(ambiguous,
  {kind:"confirmed_accepted",providerMessageId:""}),ambiguous);
 const cleared=reconcileUncertain(ambiguous,{kind:"confirmed_rejected"});
 assert.equal(cleared.status,"retry_wait");
 assert.equal(cleared.retryAt,0);
 assert.equal(claimDelivery(cleared,gate(),5000,"lease-2").decision,"leased");
 const ended=reconcileUncertain(record({status:"uncertain",attempts:3}),
  {kind:"confirmed_rejected"});
 assert.equal(ended.status,"dead_letter");
});

test("validation refuses missing provider ids, untrusted tenant and lease token",()=>{
 assert.equal(deliveryGate(record({outgoingMessageId:""}),gate()),"invalid_record");
 assert.equal(deliveryGate(record({idempotencyKey:"".padEnd(1025,"x")}),gate()),"invalid_record");
 assert.equal(claimDelivery(record(),gate(),1000,"").decision,"denied");
 assert.equal(claimDelivery(record(),gate(),-1,"lease").decision,"denied");
});

test("two workers planning against the same old snapshot require an atomic database CAS",()=>{
 const original=record();
 const first=claimDelivery(original,gate(),2000,"worker-1");
 const second=claimDelivery(original,gate(),2000,"worker-2");
 assert.equal(first.decision,"leased");
 assert.equal(second.decision,"leased");
 if(first.decision!=="leased" || second.decision!=="leased")throw Error("no lease");
 let databaseRow=original,sends=0;
 function compareAndSwap(expected:DeliveryRecord,desired:DeliveryRecord){
   if(databaseRow.status!==expected.status ||
      databaseRow.attempts!==expected.attempts ||
      databaseRow.leaseToken!==expected.leaseToken)return false;
   databaseRow=desired;
   return true;
 }
 if(compareAndSwap(original,first.record))sends++;
 if(compareAndSwap(original,second.record))sends++;
 assert.equal(sends,1);
 assert.equal(databaseRow.leaseToken,"worker-1");
 // Without the database CAS both callers would have received a valid *plan*
 // and sent twice. The module is not a substitute for SQL atomicity.
});

test("provider-event receipt and outbox keys remain unique in fake atomic reservation",()=>{
 const receipts=new Set<string>(),outbox=new Set<string>();let sends=0;
 function reserve(event:string,effect:string){
   const receiptKey=JSON.stringify(["tenant-A","account-A",event]);
   const outboxKey=JSON.stringify(["tenant-A","account-A",effect]);
   if(receipts.has(receiptKey)||outbox.has(outboxKey))return false;
   receipts.add(receiptKey);outbox.add(outboxKey);return true;
 }
 assert.equal(reserve("meta-mid-1","flow-message-1"),true);
 assert.equal(reserve("meta-mid-1","flow-message-1"),false);
 if(receipts.size===1 && outbox.size===1)sends=1;
 assert.equal(sends,1);
 assert.equal(receipts.size,1);
 assert.equal(outbox.size,1);
 // In production the two inserts plus runtime transition must commit together.
});

test("kill switch and manual takeover checked again after lease and before provider HTTP",()=>{
 const claim=claimDelivery(record(),gate(),1000,"owner-lease");
 assert.equal(claim.decision,"leased");
 if(claim.decision!=="leased")throw Error("not leased");
 assert.deepEqual(authorizeLeasedDispatch(claim.record,gate(),1010,"owner-lease"),
  {authorized:true});
 for(const [flags,reason] of [
  [{globalFlowEnabled:false},"disabled"],
  [{tenantFlowEnabled:false},"disabled"],
  [{humanTakeover:true},"human_takeover"],
  [{creditsRemaining:0},"no_credits"],
  [{accountTenantId:"other-tenant"},"wrong_tenant"],
  [{messagingWindowVerified:false},"window_unverified"]
 ] as const){
  assert.deepEqual(authorizeLeasedDispatch(claim.record,gate(flags),1010,"owner-lease"),
   {authorized:false,reason});
 }
 assert.deepEqual(authorizeLeasedDispatch(claim.record,gate(),1010,"wrong-worker"),
  {authorized:false,reason:"invalid_lease"});
 assert.deepEqual(authorizeLeasedDispatch(claim.record,gate(),31000,"owner-lease"),
  {authorized:false,reason:"invalid_lease"});
});
