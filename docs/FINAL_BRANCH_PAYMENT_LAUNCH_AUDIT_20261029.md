# Final branch and payment gate — read-only production audit, 2026-10-29

This review is SOURCE-ONLY. No SQL migration, Edge deploy, PR merge, GitHub workflow dispatch, Meta message, Wayl payment or credit modification is authorized by this document.

## Source audit

1. GitHub main **b4349c2e3ebe330cef599b48cc4a13b254efaf41** already includes the prior Instagram text candidate and staged advanced flows / delivery review / Wayl readiness, as explicitly confirmed by main commit subjects. Do not re-merge every old branch or overwrite newer main with old snapshots.
2. PR #146 is an older stacked advanced-flows draft; PR #147 contains Wayl payment readiness but is stacked on that older base. `integration/main-advanced-payment-consolidation` at `9d7c4d4e745152fd1cdfc14af246eb437419841b` is a newer consolidation comparison candidate, but is **behind main by one commit** and MUST be reconciled against current main (not merged blindly). Isolated test workflows were green on that branch at the time of read.
3. Older editor branches (`fix/flow-editor-defects`, `feature/flow-dagre-compact-ui`, batch7 recovery) contain historical improvements, but replacing current FlowBuilder/store would risk losing newer authentication/cloud publication behavior. Cherry-pick only proven missing behavior with targeted UI tests.
4. `integration/flow-full-features-post-canary` retains broader Flow Builder and scheduler changes, not yet a verified live Meta deployment. The first real canary must still use one tenant, one Instagram account, text-only.
5. Main `.github/workflows/deploy-functions.yml` is now **manual-only** with explicit approval input and protected Environment; do not run it wholesale (it would deploy other Edge functions). GitHub Pages source commits can trigger frontend deployment; a merge is NOT a no-op.

## Production checked read-only

Project `nmhefwvhoholcjrbbila`:
- `milan-api` v101 ACTIVE, legacy `wayl-webhook` v44 ACTIVE.
- No deployed `flow-publication`, `topup-create`, or `wayl-topup-webhook` listed at check time.
- Global flow enabled=false, enabled test tenants=0, outbox=0, flow publications=0.
- Atomic `wayl_grant_topup_once(uuid,integer)` not installed.
- Payment merchant is not linked per owner; no real Wayl checkout can be claimed. Never expose `WAYL_TOKEN` or webhook secret to frontend.
- Five historical Widget answers are FREE by explicit owner choice. No retroactive charges.

## Payment: exact unfinished product gates

1. Link/verify merchant Wayl account, obtain API token via provider, register HTTPS SITE_URL and webhook endpoint. `PAYMENTS_ENABLED`, `WAYL_TOPUP_WEBHOOK_ENABLED`, `VITE_WAYL_CHECKOUT_ENABLED` remain OFF.
2. Check provider API compatibility against official `https://wayl.io/docs`: `POST /api/v1/links`, `env=test`, `X-WAYL-AUTHENTICATION`, IQD `total`, `referenceId`, signed raw-body `x-wayl-signature-256`. Provider docs describe link status `Complete`; note that webhook `paymentStatus` might have a different enum. Our proposed `wayl-topup-webhook/index.ts` only accepts `complete/completed`. Before GO-P, obtain an authentic provider sandbox event; do not silently map `Paid` to Complete without evidence and independent GET status verification. Otherwise a legitimately paid order could remain uncredited.
3. Compare production `payments` table shape and any legacy credit code with draft migration `20261028230000_wayl_atomic_topup.sql`; no SQL without separate GO-P1, source SHA review and isolated PG17 tests. Require correct tenant ownership, amount/currency match, replay-safe one-time credit grant and audit trail.
4. Stage test merchant credentials in Supabase Secrets only (`WAYL_TOKEN`, `WAYL_WEBHOOK_SECRET`, `WAYL_ENV=test`, `SITE_URL`). No credential needs to be posted into chat.
5. Only after GO-P1 approval: deploy only `topup-create` and `wayl-topup-webhook` as independently approved functions, with correct JWT policy, and verify sandbox GET link status + signed callback, bad signature, mismatched amount, duplicate and delayed webhook, missing reply, refund / reversal handling.
6. Only after verified test settlement and separate GO-P2: `WAYL_ENV=live`, merchant payout confirmation and Vite frontend checkout flag. No live charging based solely on a simulated webhook.
7. Temporary workaround before payment integration: continue to hide/disable paid self-service purchase controls; owner may choose manual invoicing as a separate externally managed business process, but never manually mutate tenant credits without an approved audited workflow.

## Minimal launch order (no Widget feature work)

**Gate A** — verify GitHub protected Environment's required reviewers and selected branch main. Do not assume repository secrets mean this protection is active.

**Gate B** — approve source/production deployment compatibility separately; prove draining in-flight v101 requests or pre-approved no-loss ingress buffer before swapping incompatible consume_reply RPC.

**Gate C** — GO-R: save source101 and verify live sandbox fixture create/delete baseline counts and HTTP behavior. Deploy compatible `milan-api` and `flow-publication` with flags OFF; rollback upon failed smoke.

**Gate D** — GO-D: apply only previously reviewed atomic consume_reply SQL when old v101 callers safely drained; validate old Widget path compatibility (no need to *develop* Widget) and no double charge.

**Gate E** — GO-T: one Instagram test account + one test tenant + two-node text flow + verified signed webhook, 1 response, 1 ledger entry, no double send on replay. Revert all switches OFF.

**Gate F** — ensure Dashboard/InBox RTL/mobile and Meta App Review, operator logs, protected credentials and clear human escalation; enable one customer tenant only after canary evidence.

**Gate P** — Wayl test merchant onboarding -> independent atomic topup SQL GO -> webhook and checkout sandbox -> independent live GO. This is a separate track, not a prerequisite for the one-message test, but IS a blocker for self-service paid launch.

## What cannot be asserted

A green isolated GitHub CI and code merged into main do **NOT** prove a live Meta reply, production-specific Auth JWT, real money settlement, merchant callback schema, mobile browser UX or rollback worked. Future completion time is dependent on account/API approval, owner consent, actual deploy tests and reproducible evidence.

## Current action status

This document is a branch audit, not an authorization request to take production action. No deployment, SQL, approval gate, payment, real customer message, or credit change occurred in this audit.

## Targeted remediation staged

Signed Wayl webhook events with `paymentStatus=Paid` now return 503 (retry/reconcile) rather than an incorrect successful 200 ignored status; no credit is granted or merchant linked. Dedicated Deno test signs a genuine test payload and verifies 503 before any Supabase interaction. This policy is intentionally conservative until a sandbox status lookup can distinguish Paid from final Complete.
