# إدارة سوشيال — Flow Builder integrated release candidate

**2026-10-28. REVIEW ONLY. NOT PRODUCTION READY.**
Base: the CI/typecheck review branch PR #117 (not merged to main).
Integration PR: https://github.com/hsnq2022022-cyber/milanochat/pull/126

## Source consolidation

- PR #117: typecheck, Node definitions, Dashboard API fixes and unified CI.
- PR #119: flow editor fixes, keyboard operations, 500ms undo batching, corrupt-draft backup and responsive browser QA.
- PR #122: pure leased delivery state machine, unknown-result quarantine, stable debit intent, pre-send kill checks.
- PR #123: disposable Postgres 17 transaction proof of receipt + run + outbox and two concurrent duplicate webhook sessions.
- PR #124: server-trusted identity checks and exclusive responder decision, with both flags OFF by default.
- PR #125: bounded tag/untag and internal notification action intents, not executed on live customers.
- New in PR #126: `flowPipeline.ts` composes verified inbound routing, immutable publication capability validation and a pure runtime plan.

## Explicit non-goals and high-risk release blockers

- NO changes to `supabase/functions/milan-api/index.ts`, Meta subscriptions, payment functions or production SQL.
- NO server-side publish endpoints, activation endpoints, persistent flow worker or scheduling loop are connected.
- NO production DB migration has been built: real channel_accounts, conversations, tenants and automation_flow_drafts definitions are not audited in this work session.
- No end-to-end signed webhook fixture against staging, no verified Meta send windows, no real delivery acknowledgments.
- Provider exact-once and credit exact-once have NOT been proven on the current Edge Function. PR #114 is blocked by post-send billing loss and unsafe replay.
- Pure contracts are not production security boundaries until invoked by the trusted backend with server-read permissions, owner IDs and atomic SQL receipts.
- Even when CI passes, real Android device screenshots, two authenticated tenant cloud sessions, payment sandbox and rollback rehearsal are required.

## Integrated CI and expected evidence

`.github/workflows/flows-ci.yml` on PR to main: `npm ci`, `npm run typecheck`, `npm run test:unit`, `npm run build`, Chromium Playwright,
disposable PostgreSQL draft-owner RLS checks and a second isolated PostgreSQL job for concurrent atomic event reservation.

Expected PostgreSQL concurrent result:

```text
Worker 1: t
Worker 2: f
receipt|run|outbox counts: 1|1|1
```

Passing this synthetic test does NOT imply real Meta delivery is idempotent.

## Production rollout sequence — requires owner GO PER ACTION

1. Obtain read-only production catalog results from PR #118 and RPC permissions from PR #86; reconcile versioned migration and safe rollback in repo.
2. Owner supplies dedicated staging Supabase project, two test-owned tenants per channel, Meta scopes/test receivers, and test payment accounts.
3. Build real immutable publishing endpoints, server-side activation defaults OFF, hard RLS and composite tenant/account/conversation FKs on staging.
4. Write a trusted Edge adapter that verifies raw Meta signature, resolves account/tenant from server, and enforces one responder after takeover/credit checks.
5. Build transactional runner/outbox + worker with durable delays and provider-response reconciliation; fake-provider crash, 429, timeout and replay drills.
6. Confirm billing uses an immutable outgoing message UUID; retry only billing, never ambiguous Meta send. Test widget and legacy Railway callers.
7. Pass signed test-owned Instagram, Facebook Messenger and WhatsApp canaries, Android QA, kill-switch and rollback rehearsal.
8. Request distinct GO approvals for any production SQL migration, function deployment, Meta subscription, tenant activation and Pages merge/deployment.

**Rollback principle:** keep the server flag OFF and existing AI responder unchanged, revert only a named approved deployment;
do not drop customer draft tables or erase credit ledger to roll back the UI.
