# Emergency release candidate — Instagram text first (2026-10-28)

**Review-only. DO NOT MERGE OR DEPLOY without separate explicit owner approvals.**
Current production is intentionally unchanged: `milan-api` v101, global flow OFF, zero active flows/publications/outbox.

## What this candidate now integrates in ONE branch

- React Flow Builder + an authenticated `FlowPublicationPanel`, behind
  `VITE_ENABLE_FLOW_PUBLICATION_PREVIEW !== "true"` by default.
- Reviewed `flow-publication` Edge source with tenant-scoped Auth and JWT verification
  required at gateway (deployment must set `verify_jwt = true`).
- Exact stage-3 `milan-api` compatible source from pinned commit
  `fd4f3cb3f252e9e367b0963ef37d1c8e84daee85`; signed Meta webhooks,
  single durable inbound claim, default legacy AI when flow engine OFF or unable
  to prepare a valid 2-node text flow.
- Claim SQL present for source/audit; already installed in production under
  separate prior GO. Do not reapply.
- Atomic `consume_reply` SQL present as **UNAPPROVED** future GO-D. Do NOT
  apply while old v101 requests can be in flight.
- Tests for JWT publication validation, Meta signatures, AI fallback,
  one-shot claim, 2-node Instagram text-only flow, PostgreSQL race across
  two independent clients, TypeScript, Vite, Deno type checks.
- Legacy/UI TypeScript defects: production compiler excludes Node-only .test.ts,
  removes an undefined Railway `API` reference from the no-longer-used SSE
  branch, adds missing Dashboard `api` import and preserves old out-of-scope
  Widget embed behavior. **No Widget feature development** in this candidate.

## Critical: NEVER merge this candidate directly into main in one step

Current `.github/workflows/deploy-functions.yml` runs on ALL
`supabase/functions/**` pushes to main and deploys several Edge Functions,
including `milan-api`. A direct merge would AUTOMATICALLY deploy the new
webhook code before GO-D in-flight drain/rollback testing and could alter
billing/live messages. Merging `src/**` also triggers GitHub Pages.

**Safe approval sequence**:
1. Review this candidate + isolated CI. Confirm backup and exact GitHub
   Environment protection (Required reviewers, selected branch `main`).
2. Separate GO to protect/disable legacy bulk Edge push deployment BEFORE
   any `supabase/functions/**` commit reaches main.
3. Separate GO-R for protected manual deployment of `milan-api` with flags
   OFF, from pinned source, and verified 101 restoration on failure. Validate
   real Auth + HTTP with test-only fixtures and exact cleanup.
4. Separate GO-D for `consume_reply_atomic.sql`, ONLY after proved drain of
   old version invocations or approved durable signed webhook ingress buffer.
   No fixed-time sleep is valid proof of complete draining.
5. Separate GO to publish ONE test-only Instagram document
   `trigger(message) -> message(text)` (immutable; no automatic deletion).
6. Separate GO-T to enable only nominated tenant/account with global/tenant
   switches, `FLOW_RUNTIME_MODE=message_only`, approved restricted Canary.
   Keep all other accounts legacy AI and all rich-feature workers OFF.
7. Observe incoming signed Meta test webhook -> exactly one outbound provider
   send -> exactly one correct credit ledger; replay twice and concurrent
   request; test engine OFF fallback and no credit. Escalate uncertain Meta
   acceptances; do not auto-resend.
8. Return all flow switches OFF after test and reconcile claim, outbox, credits,
   Meta account access and logs. Only then expand with new approval.

## Core website readiness gates outside Flow Builder

- GitHub Pages/Vite must build and load phone/RTL in Chromium and Android WebView.
- Authentication, tenant isolation and existing Inbox manual send/receive via
  Instagram must be tested on real owned accounts; connected `channel_accounts`
  does not guarantee current Meta credentials.
- Facebook, WhatsApp and online payment operations remain on legacy paths;
  do not claim they are production-verified merely because Edge functions exist.
- Verify Meta App Review: `instagram_business_basic`,
  `instagram_business_manage_messages`, complete English screencasts,
  proper consent and real outbound receipt demo.
- Check real billing/Wayl invoice issuance and review permissions before
  accepting paying customers. Keep any disputed/uncertain sends in human queue.
- Historical five Widget answers are FREE by explicit owner decision, no
  retroactive debit or settlement.
- Defer Widget, advanced multi-node actions, RAG, staff RBAC, quick replies,
  Instagram-rich blocks and WhatsApp expansion until basic text path passes.

## Verification vs. unverified

CI isolated PostgreSQL/Node/Deno/TypeScript/Vite: see candidate PR/checks.
No end-to-end Meta message, production deploy, SQL migration, payments,
or actual rollback was performed. Passing CI is not a replacement for GO-R
or GO-T. This document does not authorize production actions.

## Emergency stop

1. Set the global flow switch OFF and the test tenant switch OFF through an
   independently approved operator action; turn off all sender/Canary flags.
2. If new milan-api handler fails after release, restore **saved complete
   v101 source** through protected redeploy, verify source hash, JWT config and
   an actual safe Widget/legacy response; new function version number differs.
3. Preserve all claims, debit ledgers, provider message IDs and uncertain
   attempts; NEVER blindly replay ambiguous Meta sends or delete financial
   history. Do not restore the old ghost-charge RPC as an automatic rollback.
4. Inspect production logs and compare original tenant/account/conversation
   counts. Report actual evidence to owner; resume only after a fresh GO.
