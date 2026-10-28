/**
 * Staging-only orchestrator. Not imported by milan-api; no network credentials,
 * database clients, live sends or billing calls are created here.
 *
 * IMPORTANT CONTRACT WITH THE BACKEND ADAPTER:
 * - load() and loadGate() MUST resolve tenant and account from trusted server data.
 * - compareAndSwap() MUST commit atomically in PostgreSQL (tenant + row id
 *   + complete expected version), and return false on a stale version.
 * - ProviderOutcome.definitely_rejected is valid ONLY when the provider
 *   explicitly proves the message was not accepted.
 * - debitOnce MUST enforce a unique outgoingMessageId in a DB transaction.
 */
import {
  claimDelivery, authorizeLeasedDispatch, recordProviderOutcome,
  recordDebitOutcome, type DeliveryRecord, type ProviderOutcome,
  type TrustedDeliveryGate,
} from "./deliveryContract.ts";

export type WorkStatus =
  | "not_found" | "not_due" | "not_authorized" | "claimed_elsewhere"
  | "quarantined" | "provider_recorded" | "persist_failed"
  | "billing_pending" | "billing_settled" | "billing_blocked"
  | "dead_letter" | "unchanged";

export interface DurableDeliveryStore {
  /** The ID and tenant must come from an authenticated worker queue, not a browser. */
  load(tenantId:string,deliveryId:string):Promise<DeliveryRecord|null>;
  /** FRESH read of the server-side kill switches/ownership before every send. */
  loadGate(record:DeliveryRecord):Promise<TrustedDeliveryGate>;
  /**
   * Commit expected -> desired with version predicate. NO HTTP send unless
   * this resolves true. A whole-object version can instead be an integer CAS.
   */
  compareAndSwap(expected:DeliveryRecord,desired:DeliveryRecord):Promise<boolean>;
}

export interface DeliveryProvider {
  send(record:DeliveryRecord):Promise<ProviderOutcome>;
}
export interface CreditDebiter {
  /** Exactly-once ledger semantics based on immutable outgoingMessageId. */
  debitOnce(record:DeliveryRecord):Promise<
    "charged"|"already_charged"|"insufficient"|"rpc_error"
  >;
}
export interface WorkerClock {
  now():number;
  newLeaseToken():string;
}

export type WorkerResult={status:WorkStatus;deliveryId:string};

function result(status:WorkStatus,deliveryId:string):WorkerResult {
  return {status,deliveryId};
}

export class StagingDeliveryWorker {
  private readonly store:DurableDeliveryStore;
  private readonly provider:DeliveryProvider;
  private readonly debiter:CreditDebiter;
  private readonly clock:WorkerClock;

  constructor(
    store:DurableDeliveryStore,
    provider:DeliveryProvider,
    debiter:CreditDebiter,
    clock:WorkerClock,
  ) {
    this.store=store;
    this.provider=provider;
    this.debiter=debiter;
    this.clock=clock;
  }

  /**
   * One bounded tick. Does not retry unknown provider outcomes.
   * A failed DB CAS or load always aborts; it never sends optimistically.
   */
  async dispatch(tenantId:string,deliveryId:string):Promise<WorkerResult> {
    const initial=await this.store.load(tenantId,deliveryId);
    if(!initial||initial.tenantId!==tenantId)
      return result("not_found",deliveryId);

    // A crashed worker may already have delivered. Quarantine after lease
    // expiry; DO NOT automatically reclaim and send a second Meta message.
    if(initial.status==="leased"){
      const guard=await this.store.loadGate(initial);
      const proposed=claimDelivery(initial,guard,this.clock.now(),this.clock.newLeaseToken());
      if(proposed.decision==="quarantined"){
        const committed=await this.store.compareAndSwap(initial,proposed.record);
        return result(committed?"quarantined":"claimed_elsewhere",deliveryId);
      }
      return result("claimed_elsewhere",deliveryId);
    }
    if(initial.status==="charge_pending")
      return result("billing_pending",deliveryId);
    if(initial.status==="uncertain")
      return result("quarantined",deliveryId);
    if(initial.status==="dead_letter"||initial.status==="billing_blocked")
      return result("dead_letter",deliveryId);
    if(initial.status==="settled"||initial.status==="cancelled")
      return result("unchanged",deliveryId);

    const gate=await this.store.loadGate(initial);
    const leaseToken=this.clock.newLeaseToken();
    const claim=claimDelivery(initial,gate,this.clock.now(),leaseToken);
    if(claim.decision==="denied")
      return result("not_authorized",deliveryId);
    if(claim.decision==="skipped")
      return result(claim.reason==="not_due"?"not_due":"unchanged",deliveryId);
    if(claim.decision==="quarantined")
      return result("quarantined",deliveryId);
    if(!await this.store.compareAndSwap(initial,claim.record))
      return result("claimed_elsewhere",deliveryId);

    // Reread the server-owned flags, credits, takeover and token AFTER
    // committing the lease. If they changed, do not send.
    const freshGate=await this.store.loadGate(claim.record);
    const allowed=authorizeLeasedDispatch(
      claim.record,freshGate,this.clock.now(),leaseToken,
    );
    if(!allowed.authorized){
      const cancelled={...claim.record,status:"cancelled" as const,
        leaseToken:null,leaseExpiresAt:null};
      // If CAS fails, leased record expires to uncertain. Either way NO SEND.
      const committed=await this.store.compareAndSwap(claim.record,cancelled);
      return result(committed?"not_authorized":"persist_failed",deliveryId);
    }

    let outcome:ProviderOutcome;
    try {
      outcome=await this.provider.send(claim.record);
    } catch {
      // No exception type from a network failure can reliably prove the
      // provider did NOT accept the request.
      outcome={kind:"unknown"};
    }
    const updated=recordProviderOutcome(
      claim.record,leaseToken,outcome,this.clock.now(),
    );
    if(updated.decision!=="updated")
      return result("persist_failed",deliveryId);
    // Storage failure AFTER provider acceptance: only a leased row remains.
    // Its expiry is quarantined, never re-sent.
    const committed=await this.store.compareAndSwap(claim.record,updated.record);
    if(!committed)
      return result("persist_failed",deliveryId);
    if(updated.record.status==="uncertain")
      return result("quarantined",deliveryId);
    if(updated.record.status==="dead_letter")
      return result("dead_letter",deliveryId);
    return result("provider_recorded",deliveryId);
  }

  /**
   * Credit recovery is an independent operation. It MUST NOT call provider.
   * The production backend still needs a unique ledger constraint/RPC fix.
   */
  async settleCredit(tenantId:string,deliveryId:string):Promise<WorkerResult> {
    const record=await this.store.load(tenantId,deliveryId);
    if(!record||record.tenantId!==tenantId)
      return result("not_found",deliveryId);
    if(record.status==="settled")
      return result("billing_settled",deliveryId);
    if(record.status!=="charge_pending")
      return result("unchanged",deliveryId);
    // Identity + stable outgoingMessageId must be validated in the service
    // adapter; debitOnce itself must be idempotent with the same message UUID.
    let charge:"charged"|"already_charged"|"insufficient"|"rpc_error";
    try {
      charge=await this.debiter.debitOnce(record);
    } catch {
      charge="rpc_error";
    }
    const updated=recordDebitOutcome(record,charge);
    if(updated===record)return result("billing_pending",deliveryId);
    const committed=await this.store.compareAndSwap(record,updated);
    if(!committed)return result("persist_failed",deliveryId);
    return result(updated.status==="settled"?"billing_settled":"billing_blocked",deliveryId);
  }
}
