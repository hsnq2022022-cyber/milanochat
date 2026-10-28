# Phase 4 and Phase 6 launch gate — review only

Project: nmhefwvhoholcjrbbila. No migration or deploy from this branch is approved.

## Applied migration audit

- Widget credit: 20261028223000_widget_reply_credit.sql, success. RLS private, service_role granted, zero new ledger entries.
- Delivery attempts: 20261028224000_delivery_attempts.sql, success. Three service-only RPCs and private table, zero attempt entries.
- Postflight after BOTH: global switch false, enabled tenants 0, outbox 0, tenants 10, accounts 4, conversations 4, Widget messages 12, historical answers 5, old reply ledger 3. milan-api remains version 101.
- GO3 Edge deploy NOT performed: no live HTTP Widget test/cleanup capability or automatic version 101 reactivation. The v101 source was retrieved and preserved in Supabase; ordinary redeploy would create a newer version number, not reactivate 101. Do NOT deploy until these gates can be proven.

## Proposed, uninstalled runtime source

- 20261028225000_flow_runtime_advance.sql: service-only RLS run leases, atomic state + idempotent outbox effects + metrics transaction, durable delay wake-up. Not applied.
- src/flow/runtimePlan.ts: buttons (question and message), customer input collection, conditions, time delays, tags, un-tags, notification and handoff, bounded loops and state.
- supabase/functions/flow-runtime-worker/index.ts: undeployed service-only wake-up worker, NO provider sending or billing; no scheduler installed.
- aiMetricsGate.ts: tenant/knowledge/credit/manual-handoff safety gate. AI node is a NON-SENDING placeholder; private retrieval and actual LLM answering NOT wired.
- Dashboard DeliveryReviewPanel: read-only RTL responsive owner-scoped review and tenant metrics. Staff memberships are NOT in live database; do not call it staff-authorized until a separate verified role design.
- Phase 6: new atomic metric event writes for transitions/completion/handoff; other events (provider delivered, start, buttons) need real authenticated producers and E2E confirmation.
- Current implementation is a review-only partial runtime. Full action dispatch, provider delivery status/operational alerting, and signed Meta integration remain release blockers.

## Independent production approvals still needed

1. GO3: deployment of compatible milan-api version from PR #141 with Widget and Delivery flags BOTH OFF. Only after an approved real-test-owned Widget HTTP harness that can create and remove fixture rows, inspect logs and safely restore exact v101 SOURCE. Test must leave all original counts unchanged. Neither step is fulfilled in current tools.
2. GO(d): ONLY 20261028221000_consume_reply_atomic.sql. Requires GO3 success AND proof no old v101 code is processing in-flight requests. Function version metadata alone is not proof. Plan a separately approved durable signed webhook ingress buffer, pause outgoing sends, drain old handler executions with infrastructure evidence, apply migration then resume. If no provable barrier, STOP; do not assume sleeping a fixed number of seconds establishes safety.
3. Separate GO for Widget billing feature activation on a test tenant, with one reply -> one charge and zero-credit/dedup tests; rollback by switching flag OFF, NEVER deleting ledger history.
4. Separate GO for delivery tracking; status uncertain always requires human review, no automatic retries or charge.
5. Separate GO for uninstalled runtime SQL and Edge worker; keep global switch OFF, then canary test tenant before any production sends.
6. Separate GO for reconciliation scheduling/staff authorization and, last, flow-publication deployment.

## Risk / rollback

- Old RPC first: high risk, old v101 Webhook/Widget callers still omit message_id. Reject.
- Edge with feature flags ON before SQL: critical RPC failures and missing charges. Reject.
- Additive Widget and delivery SQL -> compatible Edge with flags OFF -> prove old invocations drained -> atomic credit RPC -> separately activate: LOWEST relative risk with review gates. Recommended.
- GO3 failure: pause automated sends, restore saved v101 source by a NEW deploy version, independently verify functional equivalence; do not falsely claim version number 101 recovered.
- GO(d) failure: pause charging, preserve all three historical ledger rows; blind rollback of old consume_reply would restore ghost-ledger defect.
- Runtime error: leave global/tenant switches OFF; stop worker, keep durable claims/leases/outbox records for recovery.
- Unsure if Meta accepted a send: mark uncertain and escalate, NEVER auto-resend.
- Widget historical 5 answers: business-owner settlement only; NO retroactive charge.

## Launch checklist

- [x] Widget and delivery additive SQL by specific user GO.
- [x] RLS/service-only grants, invariants and v101 verified.
- [ ] Real HTTP test harness for GO3 with cleanup and validated v101 code restore.
- [ ] Compatible Edge under independent GO, flags OFF, mobile Widget result and logs clean.
- [ ] Approved durable ingress buffer or infrastructure proof of old-version drain.
- [ ] GO(d) SQL then test idempotent atomic billing.
- [ ] Fully trusted AI retrieval/approved evidence, tenant-scoped.
- [ ] All outbox action executors, providers/Meta sandbox tested, no double send.
- [ ] Permanent delay scheduler with lease, no duplicate timed send.
- [ ] Security-reviewed operator/employee membership authorization.
- [ ] Alerting for uncertain deliveries and billing failures.
- [ ] Production provider webhooks signatures and Meta App Review permission grants.
- [ ] Phone RTL browser checks, zero overflow; isolated Postgres17, Node, Deno and TypeScript checks.
- [ ] Test-only canary approved separately, flow-publication deployed LAST.

## Manual owner steps — not performed

1. Meta app review: approve required Instagram permissions, direct login consent, message-send screen recording and signed webhook; use ONLY separately approved test Meta accounts.
2. Meta/WhatsApp: confirm Cloud API phone number ID, webhook subscribed events, verified callback URI, and permanent authorized tokens. No actual customer messages for this review.
3. Supabase: inspect actual secrets required by milan-api including SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and FIELD_ENCRYPTION_KEY; confirm Meta and WhatsApp secret names directly against deployed source. Do not paste values in chat or logs. WIDGET_BILLING_V2_ENABLED and DELIVERY_TRACKING_V1_ENABLED remain unset/false.
4. Domain: confirm actual browser Origin https://hsnq2022022-cyber.github.io and path /milanochat/, especially Android WebView origin/CORS differences.
5. Assign a responsible operator for uncertain deliveries and five pre-existing Widget answer settlement; no automatic debit, resend or queue schedule.
6. Each later SQL, deploy, scheduler, feature flag, Meta send and merge requires fresh, explicit approval.
