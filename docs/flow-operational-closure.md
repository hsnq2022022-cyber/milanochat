# Flow V3/V4 operational closure checklist

State of 2026-11-26, `main` = `fb0dc3f0` (PRs #212-#215 merged). Read-only evidence only; no production change was made to produce this page. Complements, does not repeat, `flow-deployment-handoff.md`, `flow-v3-v4-activation-readiness.md` and `flow-rollback-dependency-matrix.md`.
Statuses: VERIFIED · NOT VERIFIED · BLOCKED - OWNER ACTION · BLOCKED - APPROVAL REQUIRED · COMPLETED · NOT APPLICABLE.

## Live baseline (Edge list, read-only)
`milan-api` v140 (R1+R2, deployed 2026-11-25 18:24Z) · `flow-publication` v38 · `flow-internal-worker` v7 · `flow-outbox-worker` v33 · `flow-runtime-worker` v32. All pre-date PR #212; none contains the constant-time bearer compare or the verify-token handshake. The four deploy pins (`a1da2f4e`) now refuse (PR #215 changed `supabase/functions`).

## 1. Edge environment variables - BLOCKED - OWNER ACTION
Values cannot be read from here; presence is NOT VERIFIED (behavioural inference is not verification). The documented "eight" is **incomplete**: the outbox worker also hard-requires `FLOW_ATOMIC_CONSUME_READY` and `FIELD_ENCRYPTION_KEY` (blocked/503 without them), and activation reads `FLOW_DURABLE_ACTIVATION_READY`.

| Name | Needed for | Expected value | SHA-256 of the value (non-secret literals only) |
|---|---|---|---|
| `FLOW_WORKERS_OPERATOR_RELEASE` | all workers (gate) | `production-canary-approved` | `ca490e654d7035bda1872141f6f81ae9e3e64725e480cba442e7af5036946d27` |
| `FLOW_OUTBOX_SEND_ENABLED` | sending | `true` | `b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b` |
| `FLOW_ATOMIC_CONSUME_READY` (not in the old list) | sending (debit) | `true` | same as above |
| `FLOW_DURABLE_INGRESS_ENABLED` | durable ingress | `true` | same as above |
| `FLOW_DURABLE_CANARY_ACCOUNT_ID` | canary scoping | the canary `channel_accounts.id` (UUID) | compare with the registry row |
| `FLOW_DURABLE_SCHEDULER_ENABLED` | delay/wake flows | `true` | same as above |
| `FLOW_DURABLE_ACTIVATION_READY` (not in the old list) | activation | `true` | same as above |
| `FLOW_WAKE_MAX_OVERDUE_MINUTES` | optional stale-wake guard | absent = OFF | n/a |
| `FLOW_OPERATOR_USER_IDS`, `FIELD_ENCRYPTION_KEY`, `flow_worker_service_role_key` | operator actions / decryption / cron auth | secret: present only | n/a, never compare values |
Must be absent or not exactly `true`: `FLOW_INTERNAL_ACTIONS_ENABLED`, `FLOW_MULTICHANNEL_ENABLED`, `FLOW_INBOUND_RECOVERY_ENABLED`, `FLOW_COMMENT_AUTOMATION_ENABLED`, `FLOW_MEDIA_SEND_ENABLED`, `FLOW_RAG_ENABLED`.
**Owner steps:** Supabase Dashboard -> Edge Functions -> Secrets. For each row confirm the name exists and, for non-secret literals, that the Dashboard digest equals the table. Record "present / digest matches" per name (never paste values). Claude cannot do this.

## 2. Canary sender identity - BLOCKED - OWNER ACTION
Metadata only (3-digit suffixes). The canary account has 9 Instagram conversations. Flow runs exist for **four** senders, not three:
| Suffix | Flow runs (completed) | Last message (UTC) | Note |
|---|---|---|---|
| `…037` | 1 (1) | 2026-11-25 12:15 | before the 12:3x deploy |
| `…541` | 6 (4) | 2026-11-25 14:12 | the only post-deploy end-to-end traffic; served by milan-api before v140 |
| `…610` | 5 (1) | 2026-11-18 10:20 | owns the 2026-11-15 `uncertain` attempt |
| `…352` | 1 (1) | 2026-11-15 15:19 | **not in the original list**; Flow also ran for it (gating is per business account, not per sender) |
Five further conversations (`034, 095, 361, 398, 565`) have no Flow runs. Who each sender is cannot be established from the repo.
**Owner steps:** in Meta Business Suite / Instagram inbox of the disposable test account, open the threads with activity on the dates above and match the usernames against your own test profiles; or read `sender_username` for `right(coalesce(platform_id,wa_chat_id),3)` in `conversations` yourself. Confirm: which suffix is yours, and whether `…352` is also yours. Anything not yours means the canary account is serving a real customer and must be reviewed before widening anything.

## 3. R1 on milan-api v140 - NOT VERIFIED (needs a natural webhook)
Count-only log queries (2026-11-26): 0 function invocations after v140 deployed; 0 `stage_timings`, 0 `profile_timing`, 0 `background_task_failed`. The canary traffic of 2026-11-25 14:12Z ran on the previous milan-api version. Nothing was manufactured.
**Needed:** one real inbound Instagram message to the canary account, ideally from the owner's own test profile. Then (Claude, read-only): `stage_timings` present with `total` far below 6.6 s / 15.6 s / 24.8 s, `profile_timing` present, no `background_task_failed`, HTTP 200, no repeated delivery of the same event (no Meta retry). Do not deploy v141 first.

## 4. Uncertain delivery 2026-11-15 - BLOCKED - OWNER ACTION (decision)
Evidence: one `uncertain` attempt in total, kind `message`, attempted 2026-11-15 12:40:03.6Z, marked uncertain 0.6 s later, **no provider message id**, 1 attempt, outbox `uncertain`, `review_status=none` (no operator decision recorded), `failure_class` empty (predates the failure-info migration), no settled effect in the same run, sender `…610`. A 0.6 s ambiguous result cannot say whether Meta delivered it.
**Decision needed from the owner:** did the message appear in the `…610` thread of the Instagram account at ~12:40 UTC on 2026-11-15? Record "delivered / not delivered / cannot tell" and who decided. No code path may retry or resend it; nothing was changed.

## 5. Default-OFF features (each needs its own approval; none is enabled)
| Feature | Gate (code) | Extra prerequisites | State | Ready for an approved exercise? |
|---|---|---|---|---|
| Internal Actions | `FLOW_INTERNAL_ACTIONS_ENABLED=true` and operator release | tags/notification tables (migration 228000, present), staff membership data; outbox worker runs the executor after its pass | OFF (not verified from here, see 1) | After items 1-3. Exercise: tag/notify on the canary only; evidence = effect settled once, no duplicate, `flow_staff_notifications` row; rollback = unset the flag |
| Recovery | `FLOW_INBOUND_RECOVERY_ENABLED=true` and operator release | a recovery cron job (none exists: creating it is a separate approval), tenant allow-list row, grace window | OFF, no cron | After items 1-3 and a cron approval. Evidence = abandoned inbound re-driven once; rollback = unset flag / remove cron |
| Multichannel | `FLOW_MULTICHANNEL_ENABLED=true` (+ `FLOW_RICH_BUTTONS_ENABLED` for buttons) | non-Instagram canary account registered; FB/WhatsApp credentials | OFF; only Instagram conversations exist on the canary | After items 1-3 and a non-Instagram canary. Evidence = one send on that channel; rollback = unset flag |

## 6. milan-api v141 - BLOCKED - APPROVAL REQUIRED (optional)
Would contain only: constant-time bearer compare (`flowWorkerAuth.ts`) and the constant-time Meta verify-token handshake (`verifyToken.ts`, `index.ts`); R1/R2 unchanged. Hardening, no demonstrated exploit, no behaviour change. Risks: replaces the v140 object that R1 still has to be observed on; rollback = redeploy `55a3e58c` source with the pin moved back. Requires: one-line pin PR to `fb0dc3f0` (workflow-only, no CI runs), `dry_run=true` first, typed confirmation, `verify_jwt=false` check pre/post. The workers and `flow-publication` do not need deployment.

## Owner actions, in priority order
1. Verify the environment variables (section 1). 2. Identify the senders (section 2). 3. Send one natural test message from your own test profile to the canary account; Claude then closes R1 (section 3). 4. Decide the uncertain delivery (section 4). 5. Approve, one at a time, feature exercises (section 5). 6. Decide on v141 (section 6).
