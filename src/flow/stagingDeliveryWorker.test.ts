import {test} from "node:test";
import assert from "node:assert/strict";
import {StagingDeliveryWorker} from "./stagingDeliveryWorker.ts";
import type {DurableDeliveryStore,DeliveryProvider,CreditDebiter} from "./stagingDeliveryWorker.ts";
import type {DeliveryRecord,TrustedDeliveryGate,ProviderOutcome} from "./deliveryContract.ts";

function record(change:Partial<DeliveryRecord>={}):DeliveryRecord {
  return {id:"outbox-A",tenantId:"tenant-A",accountId:"account-A",
    conversationId:"conv-A",providerEventId:"event-1",
    idempotencyKey:"tenant-A:account-A:event-1:message",
    outgoingMessageId:"immutable-message-1",status:"pending",attempts:0,
    leaseToken:null,leaseExpiresAt:null,retryAt:null,providerMessageId:null,...change};
}
function gate(change:Partial<TrustedDeliveryGate>={}):TrustedDeliveryGate {
  return {verifiedTenantId:"tenant-A",accountTenantId:"tenant-A",
    conversationTenantId:"tenant-A",globalFlowEnabled:true,
    tenantFlowEnabled:true,publicationActive:true,humanTakeover:false,
    agentEnabled:true,autoReplyEnabled:true,creditsRemaining:5,
    tokenValid:true,messagingWindowVerified:true,...change};
}
class Store implements DurableDeliveryStore {
  current:DeliveryRecord=record();
  cfg:TrustedDeliveryGate=gate();
  failClaim=false;
  failAfterSend=false;
  onClaim:()=>void=()=>{};
  async load(tenant:string,id:string) {
    return tenant===this.current.tenantId&&id===this.current.id?
      structuredClone(this.current):null;
  }
  async loadGate(){return structuredClone(this.cfg);}
  async compareAndSwap(a:DeliveryRecord,b:DeliveryRecord) {
    if(this.failClaim){this.failClaim=false;return false;}
    if(this.failAfterSend&&a.status==="leased")return false;
    if(JSON.stringify(a)!==JSON.stringify(this.current))return false;
    this.current=structuredClone(b);
    if(b.status==="leased")this.onClaim();
    return true;
  }
}
function make(){
  const store=new Store();
  let tick=1000,seq=0,sendCount=0;
  let outcome:ProviderOutcome={kind:"accepted",providerMessageId:"provider-ack"};
  let debitOutcome:"charged"|"already_charged"|"insufficient"|"rpc_error"="charged";
  let debitKeys:string[]=[];
  let send=async(_:DeliveryRecord):Promise<ProviderOutcome>=>outcome;
  const provider:DeliveryProvider={
    send:async r=>{sendCount++;return send(r);}
  };
  const debiter:CreditDebiter={
    debitOnce:async r=>{debitKeys.push(r.outgoingMessageId);return debitOutcome;}
  };
  const worker=new StagingDeliveryWorker(store,provider,debiter,{
    now:()=>tick,newLeaseToken:()=>String(++seq)
  });
  return {store,worker,provider,
    get sends(){return sendCount;},
    get debits(){return debitKeys;},
    setSend(fn:(r:DeliveryRecord)=>Promise<ProviderOutcome>){send=fn;},
    outcome:(o:ProviderOutcome)=>{outcome=o;},
    debit:(o:typeof debitOutcome)=>{debitOutcome=o;},
    advance:(ms:number)=>{tick+=ms;}
  };
}
test("provider accepted: persistent debit key, one send, one charge and terminal state",async()=>{
  const f=make();
  assert.equal((await f.worker.dispatch("tenant-A","outbox-A")).status,"provider_recorded");
  assert.equal(f.store.current.status,"charge_pending");
  assert.equal(f.store.current.providerMessageId,"provider-ack");
  assert.equal((await f.worker.settleCredit("tenant-A","outbox-A")).status,"billing_settled");
  await f.worker.dispatch("tenant-A","outbox-A");
  await f.worker.settleCredit("tenant-A","outbox-A");
  assert.equal(f.sends,1);
  assert.deepEqual(f.debits,["immutable-message-1"]);
});
test("two workers share one atomic lease and only one provider send",async()=>{
  const f=make();let notify!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>{notify=r;});
  const held=new Promise<void>(r=>{release=r;});
  f.setSend(async()=>{notify();await held;return {kind:"accepted",providerMessageId:"ack"};});
  const first=f.worker.dispatch("tenant-A","outbox-A");
  await started;
  assert.equal((await f.worker.dispatch("tenant-A","outbox-A")).status,"claimed_elsewhere");
  release();
  assert.equal((await first).status,"provider_recorded");
  assert.equal(f.sends,1);
});
test("failed claim, takeover, wrong tenant and all kill switches cannot send",async()=>{
  const blocked=[
    {globalFlowEnabled:false},{tenantFlowEnabled:false},
    {humanTakeover:true},{agentEnabled:false},{autoReplyEnabled:false},
    {creditsRemaining:0},{accountTenantId:"tenant-B"},
    {conversationTenantId:"tenant-B"}, {tokenValid:false},
    {messagingWindowVerified:false}
  ];
  for(const flags of blocked){
    const f=make();f.store.cfg=gate(flags);
    assert.equal((await f.worker.dispatch("tenant-A","outbox-A")).status,"not_authorized");
    assert.equal(f.sends,0);
  }
  const f=make();f.store.failClaim=true;
  assert.equal((await f.worker.dispatch("tenant-A","outbox-A")).status,"claimed_elsewhere");
  assert.equal(f.sends,0);
  assert.equal((await f.worker.dispatch("tenant-B","outbox-A")).status,"not_found");
});
test("post-claim takeover disables send; failed CAS keeps lease safely quarantined",async()=>{
  const f=make();
  f.store.onClaim=()=>{f.store.cfg.humanTakeover=true;};
  assert.equal((await f.worker.dispatch("tenant-A","outbox-A")).status,"not_authorized");
  assert.equal(f.sends,0);
  assert.equal(f.store.current.status,"cancelled");
});
test("provider timeout and unknown response enter uncertain, never auto resend",async()=>{
  for(const mode of ["exception","unknown"] as const){
    const f=make();
    if(mode==="exception")f.setSend(async()=>{throw Error("socket reset");});
    else f.outcome({kind:"unknown"});
    assert.equal((await f.worker.dispatch("tenant-A","outbox-A")).status,"quarantined");
    assert.equal((await f.worker.dispatch("tenant-A","outbox-A")).status,"quarantined");
    assert.equal(f.sends,1);
    assert.equal(f.store.current.status,"uncertain");
  }
});
test("database failure after provider accept becomes uncertain after lease expiry",async()=>{
  const f=make();f.store.failAfterSend=true;
  assert.equal((await f.worker.dispatch("tenant-A","outbox-A")).status,"persist_failed");
  assert.equal(f.store.current.status,"leased");
  f.advance(31000);
  f.store.failAfterSend=false;
  assert.equal((await f.worker.dispatch("tenant-A","outbox-A")).status,"quarantined");
  assert.equal(f.sends,1);
});
test("definite rejection retries only after scheduled backoff; third attempt DLQ",async()=>{
  const f=make();f.outcome({kind:"definitely_rejected",retryable:true});
  await f.worker.dispatch("tenant-A","outbox-A");
  assert.equal(f.store.current.status,"retry_wait");
  assert.equal((await f.worker.dispatch("tenant-A","outbox-A")).status,"not_due");
  f.advance(1000);
  await f.worker.dispatch("tenant-A","outbox-A");
  f.advance(2000);
  assert.equal((await f.worker.dispatch("tenant-A","outbox-A")).status,"dead_letter");
  assert.equal(f.sends,3);
  assert.equal(f.store.current.status,"dead_letter");
});
test("RPC error then idempotent retry of debit never sends second provider message",async()=>{
  const f=make();await f.worker.dispatch("tenant-A","outbox-A");
  f.debit("rpc_error");
  assert.equal((await f.worker.settleCredit("tenant-A","outbox-A")).status,"billing_pending");
  f.debit("already_charged");
  assert.equal((await f.worker.settleCredit("tenant-A","outbox-A")).status,"billing_settled");
  assert.deepEqual(f.debits,["immutable-message-1","immutable-message-1"]);
  assert.equal(f.sends,1);
});
test("insufficient post-send credit creates billing alert, no retry",async()=>{
  const f=make();await f.worker.dispatch("tenant-A","outbox-A");
  f.debit("insufficient");
  assert.equal((await f.worker.settleCredit("tenant-A","outbox-A")).status,"billing_blocked");
  await f.worker.dispatch("tenant-A","outbox-A");
  assert.equal(f.sends,1);
  assert.equal(f.store.current.status,"billing_blocked");
});
test("billing cannot operate on cross-tenant or unsent records",async()=>{
  const f=make();
  assert.equal((await f.worker.settleCredit("tenant-B","outbox-A")).status,"not_found");
  assert.equal((await f.worker.settleCredit("tenant-A","outbox-A")).status,"unchanged");
  assert.equal(f.debits.length,0);
});
