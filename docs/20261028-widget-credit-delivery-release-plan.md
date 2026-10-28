# Stage 3 billing + delivery release review — 2026-10-28 (NO PROD GO)

Target: existing Supabase `nmhefwvhoholcjrbbila`. Branch stacked on `feature/flow-webhook-exclusive-claim` (PR #140). Immutable production facts at review time: `milan-api` v101, global flow switch OFF, 0 tenant switches enabled, 0 Outbox, 0 active flows. Existing exclusive claim SQL installed earlier by specific owner approval. **No migration/deploy/merge/sends in this PR.**

## Implemented review artifacts

- `20261028223000_widget_reply_credit.sql`: additive `public.widget_reply_ledger` with unique `widget_message_id` referencing the actual `widget_messages` table. `consume_widget_reply(tenant_id,widget_message_id)`: service-role-only SECURITY INVOKER, locked tenant credit row, verifies message tenant, Widget tenant, session tenant, outgoing `answer` kind, returns remaining balance or -1 no credit, -2 already billed, -3 invalid ownership. Atomic debit+ledger in one transaction; no-charge means no ledger; RLS on. No retroactive scan/update.
- `20261028224000_delivery_attempts.sql`: additive `automation_delivery_attempts` keyed by installed exclusive claim, immutable one-attempt reservation, `attempting/confirmed/uncertain`, optional provider message ID, human-review status `none/queued/resolved`, RLS+service-only, `flow_begin_delivery`, `flow_finish_delivery`, `flow_queue_uncertain_deliveries`. Confirmation is accepted HTTP 2xx, not an independently proven human receipt.
- `milan-api/widgetCredit.ts`: checks RPC `error` AND integer result, logs errors with tenant/message IDs, does not swallow negative status. Current Widget response returns `billingStatus` = charged/already_charged/pending/deferred, but still returns a saved answer on billing failure to avoid triggering duplicate browser retries. Missing message insert fails visibly.
- `milan-api/index.ts`: returns provider ID when available from Meta/WhatsApp response body, verifies `consume_reply` error/result and logs failures. Delivery tracking is gated by `DELIVERY_TRACKING_V1_ENABLED=true` (default OFF). Widget billing gated by `WIDGET_BILLING_V2_ENABLED=true` (default OFF). The old one-argument Widget `consume_reply` call is removed. Webhook uses `consume_reply(tenantId,outgoingMessageId)`, as in PR #140.
- `milan-api/exclusiveMessageClaim.ts`: when delivery tracking ON, reserves a unique attempt **before** the provider request; on 2xx writes confirmed/provider ID; on ambiguous exception marks uncertain, with stale `attempting` records eligible for review. A failed reservation blocks provider sending; DB confirmation failure blocks debit; no automatic resend.
- `scripts/flow-delivery-reconcile.mjs`: bounded explicit operational task; only invokes `flow_queue_uncertain_deliveries`, does not send or charge. Not scheduled and NOT run. Job identifies abandoned `attempting` and old `uncertain` statuses after a configurable minimum 15 minutes, marks them `queued` for human review. Notification/UI assignment not yet implemented; operators must inspect the service-only review queue. Scheduling needs separate production GO.

## Old history is never charged retroactively

Five pre-existing Widget `out`/`answer` records observed in production (plus one refusal). These have no Widget billing ledger. **No migration contains an `INSERT ... SELECT` backfill**, no `UPDATE` on existing Widget messages or historical credits. Their billing is a separate business-owner settlement decision, NOT automatic debit.

## Ordered, independent production approvals required

**GO 1: Widget additive SQL** `supabase/migrations/20261028223000_widget_reply_credit.sql` ONLY. Risk: new FK/ledger, service-only RLS and lock contention; no Edge caller yet. Postflight: 0 new ledger, anon/authenticated denied, service-role allowed, data counts unchanged, global OFF, outbox=0, `milan-api`=101. Rollback `supabase/rollbacks/20261028223000_widget_reply_credit.rollback.sql` only while empty; once charged disable caller, preserve history.

**GO 2: Delivery additive SQL** `supabase/migrations/20261028224000_delivery_attempts.sql` ONLY. Risk: table and service-only RPCs; no sends/reconciliation scheduling on its own. Postflight: RLS/ACL, 0 attempt rows, flags OFF, function v101. Rollback while empty only; if rows exist retain for reconciliation, disable writes instead.

**GO 3: staged compatible `milan-api` Edge revision** from this reviewed branch, ONLY after GO1+GO2. Flags `WIDGET_BILLING_V2_ENABLED` and `DELIVERY_TRACKING_V1_ENABLED` MUST remain OFF; `FLOW_RUNTIME_MODE` remains unset; Canary global OFF. New caller already passes the two-argument contract of the **existing** `consume_reply(uuid,uuid)` and is also compatible with GO4. Widget leaves billing deferred while flag OFF, preserving current observable charging behavior; traces clearly note it. This stage does not change the live RPC. Run test-owned customer-to-business simulation, Widget reply tests, signed Meta event tests, and check error reporting/legacy AI. Note: the existing RPC's historical ghost-ledger bug remains until GO4; do not claim the deploy alone fixes billing. Separate explicit Edge GO required. Do not deploy if missing credentials/tenant ownership or unable to verify rollback revision. Rollback to verified prior Edge image BEFORE GO4; monitor provider retries and duplicate receipts.

**GO 4: atomic `consume_reply` replacement** `supabase/migrations/20261028221000_consume_reply_atomic.sql` ONLY, after confirming GO3 is fully serving all instances and no v101 invocation remains. The function signature stays `(uuid,uuid)`; unlike v101, the newly deployed Webhook caller sends both arguments. If instances cannot be definitively drained, use a separately approved controlled inbound maintenance/queuing mechanism before GO4. Do not assume a fixed sleep is sufficient to prove old revision removal. Avoid automatic rollback to the ghost-ledger function; if needed halt charge paths and perform audited reconciliation. Existing three ledger rows stay and future replays return -2. Owner approval for GO4 does not imply Edge deploy or changing feature flags.

**GO 5: explicitly enabled charge and delivery tracking flags** — requires an **independent production GO** after test results and support plan. Turn on one test tenant/channel at a time, first Widget V2 then Delivery V1, while all flow/Canary gates remain OFF. Verify Widget 1 answer->1 debit and one ledger, retry -2, zero credit -1 no ghost; verify Meta confirmed/uncertain and human review. Rolling back GO5 means disabling feature flags, NEVER deleting attempt/billing records. A flag change is an operational production action, not authorized here.

**GO 6: reconciliation schedule/human queue handoff** — separate explicit owner GO. The task currently exists in source only; an approved scheduler (e.g. protected GitHub action or Supabase Cron) must call it periodically with service credentials and defined alert/assignment ownership. Queue exists, but no UI/in-app staff notification has been deployed. Never auto resend or auto debit an uncertain attempt.

`flow-publication` is deferred until the end and retains its unrun manual workflow in PR #139; NO secret entry needed now.

## Risk comparison across potential orders

| Order | Compatibility | Risk | Recommendation |
|---|---|---|---|
| Widget SQL -> delivery SQL -> compatible Edge with flags OFF -> verify all old instances drained -> B SQL -> separately activate | Old RPC remains callable by both revisions until complete Edge cutover; new Edge works with B after cutover | **Lowest available** with explicit deployment/drain verification | Recommended; separate GO each step |
| B SQL first -> old v101 Edge -> new Edge | Old v101 caller still omits `p_message_id`, and Widget billing stays broken; ghost-ledger issue cured but existing live caller never charges properly | High billing outage, ambiguous rollback | Reject |
| Edge first before additive SQL, with flags ON | Nonexistent `consume_widget_reply` and `flow_begin_delivery` RPCs; suppresses sends/charges | Critical service disruption | Reject |
| Enable new flows/Canary and delivery retries before claim+status correctness | Double sends and financial inconsistency | Critical | Reject |
| Apply Widget+delivery SQL before Edge but leave flags OFF indefinitely | Safe schema-only preparation, no immediate functional improvement | Low operational, unchanged known billing issue | Safe preliminary steps only |

## Rollback and material caveats

1. Both new SQL rollback scripts refuse deleting nonempty ledgers/attempts. Existing historical rows and claims are never truncated.
2. GO4 rollback file restores the **defective** legacy `consume_reply` body. Never run it blindly; consider halted paths, then reconcile rather than damaging financial history.
3. `automation_delivery_attempts.status='confirmed'` means provider returned HTTP success, not delivered/read. An ambiguous 200/timeout stays uncertain. Provider ID may be missing in successful response. No automatic retry.
4. After a send succeeds but storing `public.messages` or charging fails, service logs the error and retains claim; separate manual financial reconciliation is needed.
5. The human review list is service-only DB state; staff UI / alert mechanism not implemented. No scheduled worker started by these changes.

## Tests and verification

`.github/workflows/flow-credit-delivery-ci.yml`: PostgreSQL 17 checks Widget ownership, no-credit/no ghost, idempotent duplicate, two-connection racing debit (one succeeds, one -2), delivery reservation/confirmation/uncertain review, rollback guards, original exclusive claim race; Node tests Widget RPC errors, provider ambiguity and non-retry; Deno Edge source type check and Vite build. **All testing is synthetic**; no production send, Widget debit, migration or Edge deploy occurred.
