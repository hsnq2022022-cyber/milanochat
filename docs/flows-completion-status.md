# Flow Builder completion status

Baseline: main at `21d232465f4bff89b0509ea0bff83346ebd4a45f` (2026-10-28).
**No production GO has been given for any action in this work session.**
This tracker lives in [PR #117](https://github.com/hsnq2022022-cyber/milanochat/pull/117) pending owner GO to merge and deploy; **main does not contain these updates**.

| Step | Status | Evidence | Outstanding risks and owner dependencies |
| --- | --- | --- | --- |
| 1. Repo/CI/typecheck | blocked-owner | [PR #117](https://github.com/hsnq2022022-cyber/milanochat/pull/117), [success CI #40593861119](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40593861119) | CI gate, node typings, all unit tests/build/Playwright/Postgres verified. Authenticated Dashboard recharge and clipboard copy actions **not manually verified**; need test account, payment sandbox, GO to merge/deploy Pages workflow. |
| 2. Draft schema drift | blocked-owner | [PR #118 read-only catalog query](https://github.com/hsnq2022022-cyber/milanochat/pull/118) | Owner runs read-only catalog SQL and shares definition; only then write exact idempotent migration, safe rollback & migration CI, owner GO for any production SQL. |
| 3. Editor defects | blocked-owner | [PR #119](https://github.com/hsnq2022022-cyber/milanochat/pull/119), [PASS #40596905658](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40596905658), [layout screenshot artifacts](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40596898814/artifacts/12777067003) | 76 Node unit and 73 Chromium browser tests passed including edge pointer reconnect/detach, trigger, backup, 20-node mobile layout. Real Android-device QA, official numeric Meta windows and GO to merge/site deploy remain missing. |
| 4. Billing fix #114 | blocked-owner | [PR #114 blocking review comment](https://github.com/hsnq2022022-cyber/milanochat/pull/114), [billing review PR #121](https://github.com/hsnq2022022-cyber/milanochat/pull/121) | Post-send insert/RPC can lose charges, provider retries not idempotent, widget caller still broken, missing transactional outbox. Requires staging, fake-provider E2E and rollback and explicit GO to deploy Edge; **DO NOT DEPLOY PR #114**. |
| 5. Credit RPC lockdown | blocked-owner | [PR #86](https://github.com/hsnq2022022-cyber/milanochat/pull/86), `supabase/verification/20261026_restrict_credit_rpcs.readonly.sql`, `docs/flow-credit-rpc-callers.md` | Live privilege state **not queried this session**, owner must supply query results or session authorization. Legacy Railway/Express running status unknown; rollback intentionally unsafe; owner GO for SQL. |
| 6. Publishing/routing | blocked-owner | `supabase/proposals/automation_flow_runtime.review.sql`, [release evidence](./automation-flow-release-evidence.md) | Steps 1-5 merged and owner-approved plus a **dedicated staging Supabase project** required; no publishing endpoints or live integration deployed; server-side tenant flag OFF. |
| 7. Runner/AI/canary | blocked-owner | [PR #120 staging/canary runbook](https://github.com/hsnq2022022-cyber/milanochat/pull/120) | Staging, fake provider, real test-owned Meta accounts & approved scopes per channel; unique delivery/payment accounting, rollback, kill switch, owner GO; **no live customer sends**. |

## Active gates / decision history

- A test suite passing is not proof of authenticated payment UI, live RLS sessions, Meta sends, or SMS/WhatsApp windows.
- Never merge a site-changing branch without specific owner GO, even when CI passes.
- Existing production `milan-api` must continue to own all traffic until a tested, mutually exclusive responder exists.
- Each future live action requires its own change, risk, verification and rollback plan, with named owner GO and a versioned migration for SQL.
