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

---

## 8. Reliability / fault-injection suite (second pass, 2026-11-25)

All scenarios run in `tests/flow-lifecycle-integration.test.ts` (Deno, real worker handlers, throwaway PostgreSQL 16; now **40 steps**, run by the `flow-lifecycle-integration` CI job). Faults are injected only through test mocks (`meta.plan`, `meta.faults` per recipient, `hang`/`lost`/`throw`/`status` modes; a `hooked` supabase client for DB failures); production code carries no debug switch.

**Fidelity fix.** The lifecycle chain lacked two migrations that production already has: `20261029360000_flow_inbound_recovery` and `20261115150000_flow_delivery_failure_info`. They are now part of the chain. One older expectation was stale because of it: a Meta 400 with code 100 is a definite refusal and ends `dead_letter` (as designed), not `uncertain`.

| Scenario (fault) | Evidence |
|---|---|
| Provider matrix, 18 cases (see table below) | one provider call per effect, never resent after retries / ticks / aged attempts; provider-side acceptances equal the modelled ones |
| Worker killed mid-request (hung provider call, accepted or not) | live lease never taken over; inside the 13 min grace nothing changes; after expiry the attempt is finished `uncertain`, never reset to pending, never resent |
| Recovery: 2 concurrent sweepers + a concurrent live redelivery over 3 abandoned inbounds | each event re-driven at most once, exactly one run and one send per conversation, later sweeps inert |
| Recovery vs live work | inbound inside the grace window not leased; event under a live sweeper lease not reclaimed; expired lease reclaimed once; stale token cannot finish |
| Recovery bounded | unknown flow state retried with backoff, exactly `RECOVERY_MAX_ATTEMPTS` (5) attempts, then `exhausted`; no run, no send |
| Publication change during a run | a newer published (not activated) revision never changes the revision a sleeping run sends from |
| Concurrent lease / wake commit (PR #210) | no double lease; one winner for a concurrent commit |
| Internal actions (existing step, unchanged) | tag / untag / notify / handoff: crash between write and settle, lease expiry, concurrent executors, final-attempt recovery, replays, tenant isolation |

### Provider delivery state-transition matrix (VERIFIED on the throwaway chain)
| Provider outcome | Failure class | Outbox state | Attempt | Resent? |
|---|---|---|---|---|
| 2xx + message id | - | `settled` | `confirmed` | no (done) |
| 2xx, no id | none | `uncertain` | `uncertain` | never |
| 5xx / 500 / 503 | ambiguous | `uncertain` | `uncertain` | never |
| 408 | ambiguous | `uncertain` | `uncertain` | never |
| 429 + throttle code (4,17,32,613,130429,131056) | throttled | `uncertain` | `uncertain` | never |
| 429 without code | ambiguous | `uncertain` | `uncertain` | never |
| 401 + code 190 / 401,403 without code | auth | `uncertain` | `uncertain` | never |
| 400 + code 131047 / code 10 + subcode 2018278 | outside_window | `uncertain` | `uncertain` | never |
| 400 + code 10 | permanent_other | `uncertain` | `uncertain` | never |
| 400 + other code | ambiguous | `uncertain` | `uncertain` | never |
| **400 + code 100** | rejected_invalid | **`dead_letter`** | `rejected` | never |
| 429 + code 100 | rejected_invalid | `uncertain` (429 is excluded from dead letter) | `uncertain` | never |
| network error / timeout before any response | no record | `uncertain` | `uncertain` | never |
| timeout after the provider accepted (response lost) | no record | `uncertain` | `uncertain` | never (provider holds exactly 1 copy) |
| worker killed mid-request | no record | `leased` -> `uncertain` after expiry + 13 min grace | `attempting` -> `uncertain` | never |

Policy preserved: provider sends are never retried automatically. Only knowledge_ai steps retry (bounded). Ambiguous outcomes go to human review.

## 9. Confirmed defect fixed: rollback order was not enforced for 340000 -> 360000
`20261029360000_flow_inbound_recovery`'s lease function reads `automation_inbound_routing_retries` (created by `20261029340000`). Rolling back 340000 while 360000 was installed was **accepted** (table dropped when it holds no `retrying` rows), leaving the recovery functions broken (`relation does not exist`). The documented strict reverse order protected against this only as a procedure. `supabase/rollbacks/20261029340000_flow_inbound_routing_retry.rollback.sql` now refuses with `roll back 20261029360000_flow_inbound_recovery first` before touching anything. Regression: new step "rollback order" (refused + nothing changed + recovery functions intact; then the documented order 170000 -> 160000 -> 150000 -> 360000 -> 350000 -> 340000 applies cleanly). The step fails against the previous rollback file (checked). Production impact: none (rollback file only; recovery is OFF and has no cron); nothing was applied anywhere.

## 10. Migration reconciliation: `20261029200000_flow_media_storage` (read-only, VERIFIED)
No tracker row exists, but every schema effect is present in production: bucket `flow-media` (public, 2,097,152 byte limit, `image/jpeg,image/png,image/webp` - exactly the migration's expected configuration), the four policies `flow_media_{insert,select,update,delete}_own` on `storage.objects` carrying the marker `CREATED_BY_20261029200000_FLOW_MEDIA_STORAGE`, RLS enabled on `storage.objects`. Conclusion: **applied outside the tracker; harmless, not a deployment gap.** Re-running it would be a no-op (it logs "left unchanged"). An owner may record the tracker row for hygiene; nothing was changed.
Rollback dependency closure (2026-11-26, VERIFIED on disposable PostgreSQL only): the original "23 pairs" were never enumerated and cannot be reconstructed; the pairs were re-derived from the SQL and every Flow rollback was run out of order against the full chain. 15 rollbacks refuse (nothing changed), 9 are accepted with no remaining function referencing anything they dropped, and the strict reverse order of all 24 applies cleanly. No unprotected SQL dependency remains. See `docs/flow-rollback-dependency-matrix.md` and the lifecycle step "rollback closure over the whole Flow chain" (suite now 41 steps).
