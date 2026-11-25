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

## 3. Edge Function deployment state
| Function | Deployed version | sha256 prefix | Status |
|---|---|---|---|
| flow-publication | **v38** (was v37), sha `4a0beb1f…6d0bfe`, verify_jwt=true | | **VERIFIED deployed** via workflow run 45614509803 from `main` b075b057. Runtime behavior/logs **UNVERIFIED**. |
| flow-internal-worker | v6 | 60eba6de | **BLOCKED / NOT EXECUTED** |
| flow-outbox-worker | v32 | 6cbb5f6c | **BLOCKED / NOT EXECUTED** |
| flow-runtime-worker | v31 | 945ed482 | **BLOCKED / NOT EXECUTED** |
| milan-api | v137 | 4f2a0e99 | **BLOCKED / NOT EXECUTED** |

Required order: flow-internal-worker → flow-outbox-worker → flow-runtime-worker → flow-publication (done, out of order; DB deps were satisfied) → milan-api. Remaining order: internal → outbox → runtime → milan-api. Verify each version (list_edge_functions: version up, hash changed, verify_jwt unchanged) before the next; stop on any failure.

Expected verify_jwt: internal false, outbox false, runtime false, publication true, milan-api false.

## 4. Blocker
`SUPABASE_ACCESS_TOKEN` exists as a GitHub Actions secret and was refreshed by the user (VERIFIED working: the publication workflow authenticated). Value never seen. It is NOT available in the Claude shell (Management API returns 401 there). No single-function workflow exists for the other four; inlining ~375k tokens through the MCP connector was judged unsafe.

## 5. Existing deployment tooling
- `scripts/deploy-functions.js --only <slug> [--dry-run]` — single-function deploy via Management API; needs `SUPABASE_ACCESS_TOKEN` + project ref.
- `.github/workflows/deploy-flow-publication-manual.yml` — flow-publication only; input `confirm_release: deploy-flow-publication-reviewed`; requires `refs/heads/main`; protected environment.
- `.github/workflows/deploy-functions.yml` — bulk deploy of unrelated functions. **Do not use.**
- Newly created workflow files: **none** (NOT EXECUTED). No uncommitted deployment work existed.

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
1. Deploy `flow-internal-worker` with `node scripts/deploy-functions.js --only flow-internal-worker --dry-run`, then without `--dry-run`, in an environment holding the token (or add a single-function manual workflow mirroring the publication one, merged to `main`, then dispatch it).
2. Verify via `list_edge_functions` (expect version > 6, new hash, verify_jwt=false). Repeat for outbox (>32), runtime (>31), milan-api (>137).
3. Then read-only checks of logs and cron, and safe operational verification on the dedicated test tenant only; produce a consolidated report.
