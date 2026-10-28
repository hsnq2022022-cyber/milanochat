# Release readiness ledger — main, 2026-10-29

READ-ONLY production and source audit. Not an approval to deploy, execute production fixtures, send Meta messages, apply SQL, enable switches or charge users.

## Confirmed Git status
- main after Wayl security patch PR #149: 04cfd980e9de56cb99f479154c3b15f2ea0aaf9b.
- Main already includes merged Instagram candidate 77292a9 and advanced flow/payment staging b4349c2; do NOT blindly merge historical stacked PRs.
- Main source includes React Flow Builder, publication controls, signed Meta webhook and exclusive inbound claim, durable runtime and Outbox, delay, tags, employee RBAC, RAG helper, Meta delivery receipts, Wayl checkout and signed webhook.
- GitHub Pages responds to frontend files only. Legacy Edge functions deploy Workflow is manual-only and environment-protected; source push alone does not deploy Edge.
- Existing old Draft PRs represent historical work, not owner-approved releases.

## Read-only Supabase production snapshot
Project nmhefwvhoholcjrbbila:
- milan-api v101; create-payment and legacy wayl-webhook v44. flow-publication, flow-runtime-worker, flow-outbox-worker, topup-create and wayl-topup-webhook NOT deployed.
- 10 tenants, 4 channel accounts, 4 conversations; global flow OFF, 0 enabled tenants, 0 active flows, 0 publications, 0 Outbox rows.
- 10 existing payment rows, 0 orders; these counts do NOT prove settled money, a connected Wayl merchant, or actual credit grants. Preserve this history.
- wayl_grant_topup_once(uuid,integer) is not installed. Existing consume_reply(uuid,uuid) does NOT imply the proposed atomic implementation is installed; verify definition/ledger and old v101 drain before billing GO-D.
- Historical five Widget answers are FREE by owner's explicit decision, with no retrospective debit or settlement.

## Unified isolated CI
.github/workflows/prelaunch-full-integration-ci.yml runs ONLY on the review branch and relevant PRs to main. It contains no production secrets, uses read-only repository permissions, disposable PostgreSQL17, Node, Deno and Chromium.
- Instagram signing and exclusive claim, two concurrent writers, candidate atomic credit RPC.
- Staff RLS, tenant isolation, Outbox, tags, confirmed/read Meta receipts.
- Wayl atomic payment grant, idempotency, mismatches, refunds and restricted EXECUTE.
- Node Meta signatures, fallback and flow planning; TS/Vite build; Chromium 360/390px, RTL; Deno Edge source; Wayl OFF + signed webhook tests.
Isolated CI is NOT evidence of real production Meta delivery, merchant verification, billing, rollback or live customer readiness.

## Sequential independent production approval gates
1. Verify protected GitHub Environment has REQUIRED REVIEWERS and deployment restriction to main; protected immutable checkout pin and complete v101 backup. Any live dry-run creates and deletes temporary Auth/tenant/Widget fixtures; separate explicit GO required.
2. GO-R: deploy compatible milan-api and flow-publication only, all flow/payment/delivery flags OFF. Verify HTTP Auth A/B, Widget legacy-parity, before/after fixture counts, cleanup, source101 redeploy on failure.
3. GO-D: after proved old v101 in-flight drain or approved durable signed webhook maintenance buffer, apply atomic consume_reply migration 20261028221000 (separate SQL approval). Verify no duplicate reply/debit and no ghost ledger.
4. GO-T: Meta App Review scopes instagram_business_basic, instagram_business_manage_messages, one test tenant, one Instagram account, one separate test recipient, signed webhook, single 2-node text flow. Enable only test tenant/account, test one message / one response / one debit, replay and network ambiguity; return all flags OFF.
5. Advanced workers: later separate GO for migration sequence delivery 24000, runtime 25000, Outbox 26000, staff 27000, internal 28000 and receipts 29000, then worker deploy and graduated enablement. Do not enable rich actions, staff, RAG, WhatsApp or multi-node in first canary.
6. Wayl merchant: not connected. Keep VITE_WAYL_CHECKOUT_ENABLED, PAYMENTS_ENABLED and WAYL_TOPUP_WEBHOOK_ENABLED OFF. Operator obtains verified Wayl sandbox merchant and callback schema; sets WAYL_TOKEN, WAYL_WEBHOOK_SECRET, SITE_URL, WAYL_ENV=test as secrets only; confirms provider paymentStatus lifecycle using authenticated sandbox. Never use legacy wayl-webhook for new checkout. Atomic SQL migration 20261028230000 requires separate GO, then gated topup-create / wayl-topup-webhook deployment with verify_jwt contract and sandbox tests. Enable live payments only on a later explicit GO.
7. Broader customer launch: manual Inbox outbound, successful Instagram outbound receipt, correct OAuth consent, Meta permissions, subscription UX, mobile RTL, support and observability, safe rollback and incident process.

## Owner manual steps
1. Confirm protected GitHub Environment reviewers and selected main branch. Do not dispatch anything until individually approved.
2. Finish Meta App Review video and test account setup.
3. Prepare dedicated test store and recipient, with no regular customer traffic.
4. Obtain Wayl sandbox credentials and confirm official callback and return URL with provider. Never post credentials in chat or commit them.
5. Explicitly approve each deployment, production migration, canary and payment activation separately.

## Emergency stop
Turn global and tenant flow OFF; stop Outbox worker flags; preserve ambiguous Meta attempts without blind resend. Restore complete source101 via protected redeploy and verify behavior (version number will change). Keep all messages, financial ledgers and payments. Never automatically restore historical ghost-charge billing RPC.
