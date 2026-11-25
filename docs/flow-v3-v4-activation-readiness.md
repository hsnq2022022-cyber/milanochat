# Flow V3/V4 durable engine — activation readiness (2026-11-25)

Status labels: **VERIFIED** (executed, with the stated evidence) · **PARTIALLY VERIFIED** · **UNVERIFIED** · **BLOCKED** · **NOT EXECUTED**.
Baseline: `main` after R1/R2 (`milan-api` v140, `flow-publication` v38, `flow-internal-worker` v7,
`flow-outbox-worker` v33, `flow-runtime-worker` v32). This document makes no production change and
does not authorize one.

## 1. What this task added (VERIFIED, local + GitHub CI)

Two new behavioural tests on real, separate PostgreSQL sessions (throwaway clusters, no network):

| Guarantee | Test | Result |
|---|---|---|
| 8 sessions x 5 publishes of one flow key: 40 distinct, gapless revisions, none lost or failed; two tenants publish independently; concurrent activate/deactivate leaves exactly one activation row with a requested revision; concurrent publishes never move the active revision | `tests/flow-publication-rpcs-sql.test.mjs` (live test "concurrent publication") | pass |
| 24 due sleeping runs, 6 concurrent worker sessions x 3 lease rounds: no run leased twice, none lost (the rest is leased by the next tick), every lease is attempt 1; two sessions committing the same wake with the same token: exactly one wins, one effect row | `tests/flow-lifecycle-integration.test.ts` (new step; suite now 33 steps) | pass |

No production defect was demonstrated by these probes, so **no source or migration change was needed**
(nothing to deploy, no guard update). Mutating the code (see section 7) is not part of this PR.

## 2. Existing guarantees, with the suite that proves them (already in `main`, CI green)

| Workstream | Evidence in repo |
|---|---|
| Ingress idempotency / duplicate events | `flow-lifecycle-integration` steps "signed webhook ... replays", "B1 duplicates never interfere"; `flow-claim-begin-durable-run` (concurrent atomic starts: same event -> one run); `flow-exclusive-claim`; R1 test `webhook-ingress-r1` (ingress awaited before anything is deferred; 503 unchanged) |
| Atomic run claim / consumption | `flow-claim-begin-durable-run`, `flow-begin-durable-run-superseding`, `flow-run-lifecycle` (partial unique index + trigger serialize concurrent starts) |
| Worker concurrency | `flow_lease_due_runs` uses `FOR UPDATE SKIP LOCKED` plus `INSERT .. ON CONFLICT DO UPDATE .. WHERE expires_at<=now()` (second guard); outbox reserve and inbound recovery lease use SKIP LOCKED (`flow-outbox-lease-recovery-sql`, `flow-inbound-recovery-sql` "lease race") |
| Partial failure / crash | lifecycle steps "crashed worker lease expires; wake commits once", "internal actions reliability on PostgreSQL: crash between write and settle, lease expiry, concurrent executors, final-attempt recovery" |
| Outbox delivery states | `flow-outbox-delivery.test.sql`, `flow-delivery-failure-sql` (14), `flow-outbox-confirmed-settlement`, lifecycle "provider 5xx / timeout / 2xx without id / 4xx -> uncertain, never resent" |
| Failure classification | `deliveryFailure.ts`: provider sends are never retried; every failure class is `uncertain` (human review) except a definite Meta refusal (4xx not 408/429 with code 100) and a refused image -> `dead_letter`; knowledge_ai retries are bounded (5 failures -> dead_letter; 401/400 immediately) |
| Publication | `flow-publication-rpcs-sql` (validation, production approval gate `test_only OR production_approved`, atomicity, rate limit, tenant isolation, rollback exactness) + the new concurrency test |
| Internal actions | `flow-internal-worker.test.ts` (16), `tests/sql/flow-internal-actions.test.sql`, lifecycle "internal actions: ... exactly once, takeover, silence, replays, tenant isolation" |
| Recovery | `flow-inbound-recovery-sql` (10): default OFF, grace window, lease race, bounded attempts + backoff, 48 h cap, live webhook wins, tenant isolation |
| V2 isolation | `flow-canary-claim-durable`: `flow_claim_inbound` (V2) byte-for-byte unchanged and identical over the switch matrix |

These are local/CI results on throwaway databases. They are not production evidence.

## 3. V2 / V3 / V4 compatibility matrix

| Component | V2 (legacy AI / text) | V3 / V4 (durable) | Shared? |
|---|---|---|---|
| Inbound webhook | `milan-api` `instagram_webhook` / `whatsapp_webhook` | same handler; `routeInbound` picks the owner | **shared** (single entry) |
| Event claim | `flow_claim_inbound` (unchanged) | `flow_claim_inbound_durable`, `flow_begin_durable_run` | shared claims table, separate functions |
| Reply path | `answerFromKnowledge` / `consume_flow_reply` | `automation_flow_outbox` -> `flow-outbox-worker` | billing function shared (`consume_flow_reply`) |
| State | `messages`, `conversations` | `automation_flow_runs`, `_outbox`, `_run_leases`, `_delivery_attempts`, `_event_receipts` | `messages`/`conversations`/`channel_accounts` shared |
| Publication | n/a | `flow-publication` + `flow_publish_revision`, `flow_activate_revision`, `flow_deactivate_revision` | version-specific |
| Gates | account `agent_enabled`, `auto_reply`, credits | global switch, tenant switch (`enabled`, `test_only`, `production_approved`), canary registry, activations | gates are ANDed: V3/V4 off -> V2 behaviour |
| Workers | none | `flow-runtime-worker`, `flow-outbox-worker`, `flow-internal-worker` (+ 2 pg_cron jobs, conditional) | version-specific |

V3/V4 cannot alter V2 unless the global and tenant switches, the canary registry, `FLOW_DURABLE_INGRESS_ENABLED`
and `FLOW_DURABLE_CANARY_ACCOUNT_ID` all admit the account; otherwise `attemptDurableInstagram` returns `fallback`.

### Migrations (read-only catalog check on 2026-11-25; PARTIALLY VERIFIED)
- Tracker rows exist for every Flow migration through `20261125122521 flow_publication_rpcs`; all six 2026-11-25 migrations verified earlier by pinned function hashes.
- Repo ownership markers absent in production (`125000`, `200000`-`230000` media/multichannel, `170000`) are explained: those migrations replace existing functions and keep their earlier markers (production functions already contain the media / multichannel logic: `message_image` in `flow_commit_run_step`, `flow_reserve_outbox_delivery`, `flow_skip_blocked_outbox`; the `flow-media` bucket and the widened `effect_kind` check exist).
- **UNVERIFIED:** no tracker row exists for `20261029200000_flow_media_storage` (the bucket does exist); byte-for-byte hashes of every function were not re-pinned in this task.
- **NOT APPLIED / out of scope:** `20261115130000_wayl_topup_atomic_grant` (billing) and the Activation Generation migration. Neither is required for V3/V4 activation of text flows.

### Names (no values) required at runtime
- Operator gates: `FLOW_WORKERS_OPERATOR_RELEASE` (exact value is in source), `FLOW_DURABLE_SCHEDULER_ENABLED`, `FLOW_OUTBOX_SEND_ENABLED`, `FLOW_DURABLE_INGRESS_ENABLED`, `FLOW_DURABLE_CANARY_ACCOUNT_ID`, `FLOW_WAKE_MAX_OVERDUE_MINUTES`.
- Default-off features: `FLOW_INTERNAL_ACTIONS_ENABLED`, `FLOW_MULTICHANNEL_ENABLED`, `FLOW_INBOUND_RECOVERY_ENABLED`, `FLOW_COMMENT_AUTOMATION_ENABLED`, `FLOW_MEDIA_SEND_ENABLED`, `FLOW_AI_STEP_ENABLED`, `FLOW_RAG_ENABLED`, `FLOW_RICH_BUTTONS_ENABLED`, `FLOW_META_RECEIPTS_ENABLED`, `FLOW_ATOMIC_CONSUME_READY`, `FLOW_SHADOW_MODE`.
- Secrets: `SUPABASE_SERVICE_ROLE_KEY`, Vault/Edge key `flow_worker_service_role_key`, `FIELD_ENCRYPTION_KEY`, `INSTAGRAM_APP_SECRET` and/or `META_APP_SECRET`, plus the channel access tokens stored encrypted.
- Edge variable values were never readable from this environment: **UNVERIFIED / BLOCKED** (owner check via Dashboard -> Edge Functions -> Secrets, names + digests only).

## 4. Remaining blockers to controlled V3/V4 activation
1. Owner confirmation of the eight Edge variable digests (see handoff doc section 9).
2. Canary sender identity / customer isolation: Flow is gated by business account, not by sender; the test sender ids are unverified.
3. R1 production verification pending the first natural webhook on v140 (`stage_timings`, deferred profile enrichment).
4. Uncertain delivery from 2026-11-15: operator decision; never retry.
5. Not exercised in production: Internal Actions, Multichannel, Recovery (all OFF), failure/retry paths.

## 5. Proposed activation sequence (NOT performed)
1. Clear blockers 1-4. 2. Keep Recovery, Multichannel and Internal Actions OFF. 3. One text flow, one canary account, one natural inbound; inspect run/outbox/receipt and the R1 timings. 4. Only then consider enabling one further feature at a time on the canary account, with its own evidence.

## 6. Rollback
- Immediate, no deploy: set the tenant switch `enabled=false` or the global switch `enabled=false` (workers then lease nothing; V2 answers), or deactivate the revision with `flow_deactivate_revision` (works with switches off).
- Pause automation: `FLOW_OUTBOX_SEND_ENABLED` / `FLOW_DURABLE_INGRESS_ENABLED` not `"true"`; remove the account from `FLOW_DURABLE_CANARY_ACCOUNT_ID`.
- Code: redeploy the previous source through the pinned manual workflow (needs its guard moved back); migrations roll back only in strict reverse order via `supabase/rollbacks/`.

## 7. Not done in this task
No production migration, setting, secret, flag, cron or Meta change; no deployment; no customer message. Fault-injection (mutating the SQL to show the new tests fail) and per-function production hash re-pinning were not performed.
