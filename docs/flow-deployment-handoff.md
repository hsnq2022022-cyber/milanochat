# Milanochat Flow — Deployment Handoff

Repository: `hsnq2022022-cyber/milanochat` · Supabase project ref `nmhefwvhoholcjrbbila` (Postgres 17.6)
Baseline commit: `b075b057c89d9ea4e355586ba1461f0ef3978f98` (merge of PR #205 into `main`). This file is added on top of it.
Date of state: 2026-11-25.

Labels: **VERIFIED** (checked against production/GitHub), **UNVERIFIED**, **BLOCKED**, **NOT EXECUTED**.

## 1. Completed work
- Flow Tasks 1–4 implemented and merged (PR #205; original commits 029aef16, a9aa1965, 2a475e52, f3aec17c, 06cf2dc1, 6b984578 preserved). **VERIFIED**; Pages deploy succeeded.
- Local fixes/tests/builds and token-free `--dry-run` bundling of all five functions. **VERIFIED**.

## 2. Production migrations — all six applied, one at a time (VERIFIED)
Applied exactly as written in repo, verified by normalized-`prosrc` md5 hashes; tracker rows inserted separately (tracker 33 → 39 rows). Tracker timestamps are real apply times, not repo versions.

| Repo migration | Tracker version | Name |
|---|---|---|
| 20261029340000 | 20261125121850 | flow_inbound_routing_retry |
| 20261029350000 | 20261125121941 | flow_durable_keyword_start |
| 20261029360000 | 20261125122059 | flow_inbound_recovery |
| 20261115150000 | 20261125122235 | flow_delivery_failure_info |
| 20261115160000 | 20261125122409 | flow_registry_wake_hold |
| 20261115170000 | 20261125122521 | flow_publication_rpcs |

Rollbacks exist in `supabase/rollbacks/*.rollback.sql`; only strict reverse order 170000 → 160000 → 150000 → 360000 → 350000 → 340000. Cron stayed healthy; unauthenticated worker calls return 401.

## 3. Edge Function deployment state — ALL FIVE DEPLOYED (VERIFIED via list_edge_functions, 2026-11-25)
| Function | Before | Now | sha256 (now) | verify_jwt | Run |
|---|---|---|---|---|---|
| flow-publication | v37 | **v38** | 4a0beb1f190dec3ec35cafb66e9c2ca112caefcd576e960be6c3c0089e6d0bfe | true | 45614509803 |
| flow-internal-worker | v6 | **v7** | 782c6552d4d473608f3fe1735afb97ad4d1522c041ccbbce49334ec13a192ab9 | false | 45615826255 |
| flow-outbox-worker | v32 | **v33** | e37d5c07154adcccf5cf19fbd8773566e3f0e90ea1a688abfb24decc7ec388ce | false | 45615910914 |
| flow-runtime-worker | v31 | **v32** | 6d22c6619337af2098cef4343d6fd1e544e107cb5160858de0ec94cee98d0114 | false | 45616001417 |
| milan-api | v137 | **v138** | e728e2a7dd428b29cdc1501c2200708a7196e15b6496263d4449b82f51233b3a | false | 45616074389 |

All ACTIVE. Order executed: publication (out of order, DB deps met) → internal → outbox → runtime → milan-api. Dry-runs (remote bundleOnly) passed for all four new workflows first. Runtime behavior/logs after deploy: UNVERIFIED.

## 4. Token
`SUPABASE_ACCESS_TOKEN` GitHub secret exists and works in Actions (VERIFIED by successful deploys). Value never seen. Not available in the Claude shell.

## 5. Deployment tooling
- `scripts/deploy-functions.js --only <slug> [--dry-run]` (hard-coded verify_jwt map, post-deploy verify_jwt check).
- `deploy-flow-publication-manual.yml` (CLI deploy, publication only).
- NEW (commit 70c80cbc, VERIFIED working): `deploy-flow-internal-worker-manual.yml`, `deploy-flow-outbox-worker-manual.yml`, `deploy-flow-runtime-worker-manual.yml`, `deploy-milan-api-manual.yml`. Inputs `confirm_release: deploy-<slug>-reviewed` and `dry_run: true|false`; enforce repo, `refs/heads/main`, ancestor of b075b057, and `supabase/functions` + deploy script identical to b075b057; use the script. Note: they share a concurrency group, so a newer dispatch cancels a *pending* run.
- `deploy-functions.yml` is bulk — never use.

## 6. Unverified
- Edge env vars (names only; values unreadable): FLOW_DURABLE_SCHEDULER_ENABLED, FLOW_WORKERS_OPERATOR_RELEASE, FLOW_DURABLE_CANARY_ACCOUNT_ID, FLOW_WAKE_MAX_OVERDUE_MINUTES, FLOW_OUTBOX_SEND_ENABLED, FLOW_INTERNAL_ACTIONS_ENABLED, FLOW_DURABLE_INGRESS_ENABLED, FLOW_MULTICHANNEL_ENABLED; Vault/Edge key `flow_worker_service_role_key`.
- Post-deploy flow-publication logs / end-to-end behavior.
- Real message delivery: no provider evidence or receipt; none claimed.

## 7. Safety restrictions — never do
- Never run `supabase db push`, bulk migration commands, or `migration repair` as a substitute.
- Never rerun the six migrations or `20261115120000` (already adopted); exclude `20261115130000` (Wayl).
- Never apply/deploy Activation Generation `20261123100000_flow_activation_generation.sql` (NOT EXECUTED, separate approval).
- Never fabricate/backdate tracker timestamps; never print or change secrets.
- Do not change env vars, feature flags, or cron without verified evidence; keep inbound recovery/cron off.
- No deleting customer data, no enabling all tenants, no real customer messages; tests only with a verified dedicated test tenant.
- Do not use `deploy-functions.yml`. Never deploy unrelated functions.
- Sonnet only per user preference; no subagents; minimal tokens, no repeated audits.

## 8. Exact next action
Function deployment is complete. Remaining (read-only first): check post-deploy logs of the five functions and cron health; confirm the eight FLOW_* env values with the owner (cannot be read here); safe operational verification on a dedicated test tenant only. Activation Generation (`20261123100000`) stays NOT EXECUTED pending separate approval.

## 9. Post-deployment operational audit (2026-11-25, read-only; VERIFIED unless noted)
- Cron: exactly two jobs (`milanochat-flow-durable-wake-v1`, `milanochat-flow-outbox-v1`), active, `* * * * *`, 1440/1440 runs succeeded in 24h; no recovery cron. Each only POSTs when its `EXISTS` gate finds work, so most runs are no-ops. Queue empty.
- New function versions (v38/v7/v33/v32/v138) have NOT yet served any non-probe traffic (only my unauthenticated 401 probes). Last real worker activity was pre-deploy (v31/v32 at 12:17-12:18Z: run completed, message delivered, provider id + confirmed attempt).
- Dedicated test target exists: tenant switch enabled, `test_only=false`, `production_approved=true`; one canary account (instagram, note "Option B canary - disposable test account"); active flow `ig_live_welcome_20261029` rev 4. A new end-to-end test needs a human DM from that disposable account (NOT EXECUTED; no forged webhooks or synthetic records).
- Anomalies explained: completed runs have no `ended_at` by design (only cancel/expire set it); 6 blocked runs = 5 `superseded` + 1 `revision_inactive` (expected); 5-6 `delay` outbox rows stay `pending` forever (outbox worker never processes `delay`; inert); 1 `uncertain` delivery (2026-11-15) has no provider id and no review — do not retry; unknown whether it reached the provider.
- Decryption errors (2026-11-24 18:12Z, 18 lines) came from milan-api v137 (message-body read path), not Flow. v137 logged ciphertext prefixes; v138 source logs only a fixed code. Two matching legacy messages (Sep-Oct) found, no Flow link.
- Env vars: values not readable with available access (shell token invalid; no connector lists secrets). Behavioral inference only: outbox send at 12:18Z implies WORKERS_OPERATOR_RELEASE=production-canary-approved, OUTBOX_SEND_ENABLED=true, DURABLE_SCHEDULER_ENABLED=true at that time.
- Local: 280 flow tests pass (tests/flow-*.test.mjs).
