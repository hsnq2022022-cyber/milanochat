# Provider delivery state machine — review-only

**No live sends, no Supabase writes, no payment changes.** This branch adds
`src/flow/deliveryContract.ts`, a pure contract for a future trusted outbox
worker. It cannot be used by the browser to activate or send automation.

## Safety invariants

- Flow delivery is disabled unless **both** global and tenant server flags,
  publication activation, account agent settings, available credits,
  approved messaging window and valid token are all proven server-side.
- Every flow effect must have one durable outgoing message UUID and a unique
  event/effect key before sending. **Must commit receipt, run state and outbox
  atomically**. The current proposed SQL has NOT implemented that routine.
- Workers may call Meta only after a lease is acquired with a database-level
  conditional update (compare-and-swap) and that transaction has committed.
- Provider acceptance does **not** mean delivered. Store the accepted provider
  message ID and charge with the same immutable `outgoingMessageId`.
- An unknown result, network timeout, lost response, or expired lease is
  **uncertain**, not an automatically retryable failure. Reconciliation with
  provider evidence is mandatory; otherwise leave quarantined.
- An explicit provider rejection guaranteed not to send may be retried up to
  three total attempts with bounded backoff, then dead-lettered.
- `consume_reply` failure must retain a charge-pending record for
  retry of **billing only**, never resend the message. Insufficient balance
  after an accepted send is escalated as billing_blocked, not hidden.
- Human takeover, disabled agent/auto-reply, no credits and mismatched
  tenant/account/conversation must fail closed.
- Never count accepted as delivered in analytics. Do not log raw customer text.

## What tests really prove

- Pure transitions, tenant/kill guards, fake compare-and-swap, crash/unknown
  outcome handling, bounded retry/dead-letter, charge-idempotency decisions.
- They **do not** prove actual DB atomicity, provider exactly-once semantics,
  legitimate signed webhooks, Meta messaging windows, or the current
  `milan-api` AI-vs-flow exclusive responder contract.
- They do not validate a real provider's idempotency support.
- This cannot be deployed to production or wired into `milan-api`
  without Step 6 staging, exact SQL migrations, provider fixtures and an
  owner GO for each production change.

## Next staging implementation (blocked on owner)

1. Provision owner-supplied staging Supabase, not the production project.
2. Read stage schema, create timestamped migrations + rollback + verification
   queries, real composite tenant ownership constraints and atomic SQL RPC.
3. Test two concurrent claimers against PostgreSQL and provider replay with
   an isolated fake Meta server.
4. Add strict provider adapter and delayed retry scheduler with verified
   messaging-window policy.
5. Integrate with existing AI responder behind default-OFF server flag and
   assert byte-for-byte equivalence when OFF.
6. Perform credit ledger reconciliation and restart/crash drills, then seek
   per-action owner GO. Do not send to actual customers first.
