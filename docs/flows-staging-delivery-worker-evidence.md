# Stage 7 — Staging-only delivery worker and PostgreSQL transaction proof

**Status:** Review-only. This branch is based on PR #126 and must not be merged into `main` or deployed to Supabase production. Existing `milan-api`, provider tokens, customer conversations and credits are unchanged.

## Architecture delivered

- `src/flow/stagingDeliveryWorker.ts` coordinates durable pre-send CAS claims, re-evaluated server-side policy, provider result handling and independent idempotent credit settlement.
- `DurableDeliveryStore` is an adapter interface, **not** a connected production database client. A real adapter must provide tenant-resolved, version-based atomic compare-and-swap, not local mutable state.
- `DeliveryProvider` is injected and mocked. Unknown results / thrown transport errors are quarantined, never interpreted as proof of failed delivery. An expired lease is quarantined, never automatically re-sent.
- `CreditDebiter.debitOnce` is injected. It must call a verified transactional RPC keyed by immutable outgoing message UUID; retries are billing-only and must never trigger a second provider send.
- `tests/sql/flow-worker-staging.sql` extends disposable `flow_ci` Postgres 17 fixtures: atomic lease claims, fresh post-claim delivery guard, provider outcome CAS, expired-lease quarantine, private role grants, and a test-only transactional debit-once/ledger.
- `tests/sql/flow-worker-staging.test.sql` verifies takeover/global kill switch, tenant isolation, expired window, wrong lease token, duplicate attempts, uncertain provider result, one credit debit and failed/unbilled outcomes.

## Verified CI evidence

[GitHub Actions #40682268984](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40682268984):

- Node tests: staging worker **10/10**, delivery contracts **12/12**, exclusive responder **8/8**, pipeline **6/6**.
- Full TypeScript and Vite production build pass.
- Disposable PostgreSQL 17: atomic receipt/run/outbox and worker CAS/kill-switch/credit-ledger tests pass.

**Safety warning:** This verifies staging models only. An HTTP response timeout may have been accepted by the provider. Without a provider idempotency or reconciliation contract, the worker intentionally favors quarantine over sending a duplicate. A `definitely_rejected` outcome must be returned **only** after authoritative provider evidence that no message was accepted.

## Unfinished requirements / GO blockers

1. Owner to designate/authorize a dedicated **active** Supabase staging project. Two projects were visible in account metadata but **neither has been confirmed as safe staging**; no live database queries were performed.
2. Read-only production catalog results required for exact `channel_accounts`, `conversations`, `tenants`, draft and credit RPC function definitions (PR #118 and #86). All real schema migrations must be timestamped, include rollback + verifier, and receive owner GO before production.
3. Wire a server-only publisher, immutable revision and activation API, signed Meta webhook adapter, tenant-resolved queue, durable delayed wakeups, actual provider transport and billing RPC. No live worker is running.
4. Test two verified tenants, two test-owned accounts per channel, signed Meta replay, Android UI, 429/5xx, provider timeout, crash-after-send, cross-tenant isolation, ledger reconciliation and a full rollback rehearsal on staging.
5. Kill switch is rechecked before dispatch but cannot undo an in-flight HTTP request. Must specify a bounded tick and alerting semantics on staging.
6. Real Meta-approved message windows must be verified separately per channel and message type; the synthetic fixture accepts a server-provided deadline and is **not** proof of policy compliance.
7. Actual `milan-api` widget and Instagram/WhatsApp AI billing paths remain unchanged. Unsafe PR #114 is not approved for production.

## Release actions (each needs a distinct owner GO)

| Action | Risk | Verification | Rollback |
| --- | --- | --- | --- |
| Production migration | Data loss, credit/RLS bypass | Exact live catalog comparison, safe staging migration, RLS/transaction tests | Versioned lossless reverse migration; never drop customer data |
| Edge Function deploy | Duplicate replies/charges, webhook interruption | Signed webhook and fake-provider staging plus old-path flag-OFF regression | Server kill switch OFF and previously recorded deployed version |
| Meta app subscriptions | Unexpected real customer events | Test-owned Meta accounts only | Restore previously recorded subscriptions |
| Per-tenant activation | Unwanted outbound messages and charges | Canary all-channel drills and financial reconciliation | Tenant/global flag OFF immediately; quarantine in-flight |
| GitHub Pages merge/deploy | UI regression | Authenticated browser, 390×844 Android, visual evidence | Restore previously verified Pages commit |

Never auto-merge this review branch and never interpret passing unit/SQL fixtures as production-ready Meta delivery.
