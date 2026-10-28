# Flow Builder completion status

Baseline: main at `21d232465f4bff89b0509ea0bff83346ebd4a45f` (2026-10-28).
**No production GO has been given for any action in this work session.**
This tracker lives in [PR #117](https://github.com/hsnq2022022-cyber/milanochat/pull/117) pending owner GO to merge and deploy; **main does not contain these updates**.

| Step | Status | Evidence | Outstanding risks and owner dependencies |
| --- | --- | --- | --- |
| 1. Repo/CI/typecheck | blocked-owner | [PR #117](https://github.com/hsnq2022022-cyber/milanochat/pull/117), [success CI #40593861119](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40593861119) | CI gate, node typings, all unit tests/build/Playwright/Postgres verified. Authenticated Dashboard recharge and clipboard copy actions **not manually verified**; need test account, payment sandbox, GO to merge/deploy Pages workflow. |
| 2. Draft schema drift | blocked-owner | [PR #118 read-only catalog query](https://github.com/hsnq2022022-cyber/milanochat/pull/118) | Owner runs read-only catalog SQL and shares definition; only then write exact idempotent migration, safe rollback & migration CI, owner GO for any production SQL. |
| 3. Editor defects | blocked-owner | [PR #119](https://github.com/hsnq2022022-cyber/milanochat/pull/119), [PASS #40674101775](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40674101775), [layout screenshot artifacts](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40596898814/artifacts/12777067003) | 78 Node unit / 73 Chromium browser tests passed. Fixed cross-flow edit coalescing and tested switch/duplicate/delete history. Real Android QA, verified Meta numeric windows and explicit GO to merge/site deploy remain missing. |
| 4. Billing fix #114 | blocked-owner | [PR #114](https://github.com/hsnq2022022-cyber/milanochat/pull/114), [review PR #121](https://github.com/hsnq2022022-cyber/milanochat/pull/121), `tests/credit-guard-order.test.ts` on PR #114 | Added static guard-order checks for duplicate provider IDs, takeover, low credits and disabled account; **these do not establish runtime behavior**. Post-send insert/RPC can lose charges, provider retries remain non-idempotent, widget caller still broken. Requires durable transactional outbox, fake-provider integration, staging, GO. **DO NOT DEPLOY PR #114**. |
| 5. Credit RPC lockdown | blocked-owner | [PR #86](https://github.com/hsnq2022022-cyber/milanochat/pull/86), [PASS isolated Postgres #40674168406](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40674168406), `supabase/verification/20261026_restrict_credit_rpcs.readonly.sql` | Synthetic PostgreSQL verified initial lockdown, idempotent reapply and rollback; **live privilege state NOT inspected**. Owner catalog SQL output/GO needed. Legacy Railway server running status unknown; rollback would restore public EXECUTE (unsafe). |
| 6. Publishing/routing | blocked-owner | [PR #123 atomic PostgreSQL proof](https://github.com/hsnq2022022-cyber/milanochat/pull/123), [PR #124 exclusive responder policy](https://github.com/hsnq2022022-cyber/milanochat/pull/124) | Tested duplicate-event atomic reservation and default-OFF, unique responder selection as isolated contracts. Still missing production schema review, actual signed webhook adapter, authenticated publishing API, trusted feature flag, staging and per-step GO. Existing `milan-api` unchanged. |
| 7. Runner/AI/canary | blocked-owner | [PR #120 runbook](https://github.com/hsnq2022022-cyber/milanochat/pull/120), [PR #122 delivery contract](https://github.com/hsnq2022022-cyber/milanochat/pull/122), [PR #123 atomic SQL proof](https://github.com/hsnq2022022-cyber/milanochat/pull/123), [PR #125 action intents](https://github.com/hsnq2022022-cyber/milanochat/pull/125) | Pure action effects (tag/untag/notify), uncertain delivery quarantine and SQL receipt/run/outbox tests are proven only in isolation. No trusted worker, real delivery, credit reconciliation, Meta canary or staging approvals. Real customer sends OFF. |

## Active gates / decision history

- A test suite passing is not proof of authenticated payment UI, live RLS sessions, Meta sends, or SMS/WhatsApp windows.
- Never merge a site-changing branch without specific owner GO, even when CI passes.
- Existing production `milan-api` must continue to own all traffic until a tested, mutually exclusive responder exists.
- Each future live action requires its own change, risk, verification and rollback plan, with named owner GO and a versioned migration for SQL.

## Integration review candidate (not a production release)

- [PR #126](https://github.com/hsnq2022022-cyber/milanochat/pull/126) combines the reviewed CI/editor/flow modules from #117, #119, #122, #123, #124 and #125 and adds `src/flow/flowPipeline.ts` with unit tests.
- Integrated CI runs full typecheck, every Node test, Vite, Chromium UI tests, two PostgreSQL RLS suites and concurrent inbound reservation. A passing run is **integration evidence only**; no actual Meta sender or billing ledger is connected.
- All Step 1–7 production release gates remain blocked by owner-approved staging, live schema verification, signed E2E and per-action GO. **Do not merge this PR to main just because CI is green.**

## Work session — staging publisher, worker, signed-webhook audit (2026-10-28)

| Review PR | Verified work | Release status |
| --- | --- | --- |
| [#127](https://github.com/hsnq2022022-cyber/milanochat/pull/127) | 36 Node regressions; disposable PostgreSQL lease CAS, kill-switch, provider quarantine, credit debit-once. [CI #40682268984](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40682268984). | Review-only, no live worker or billing RPC. |
| [#128](https://github.com/hsnq2022022-cyber/milanochat/pull/128) | 11 Node publishing regressions; disposable PostgreSQL immutable revisions, private RLS grants, canary activation default OFF, rollback. [CI #40683116186](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40683116186). | Review-only, no authenticated live publish endpoints. |
| [#129](https://github.com/hsnq2022022-cyber/milanochat/pull/129) | **Confirmed fail-open IG/FB webhook signature bug** when both secrets missing; 6 HMAC tests, configured-secret fail-closed and 503 for missing config. [CI #40683730053](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40683730053). | Changes `milan-api` and therefore MUST NOT merge/deploy without secure secret review, staging signed E2E, rollback plan and owner GO. |

Supabase connector returned two project metadata entries: an active project and an **inactive** project named `meta`. No project was designated as staging; no production SQL, account data, function deployment or Meta subscription changes were performed. Do not infer inactive `meta` can be used as a testing environment.

**Do not mark Stages 8–12 as released.** Remaining blockers: approved live schema read-only catalog; explicitly designated, active staging; matching server-side Auth/tenant adapter, Meta webhook signing and provider delivery E2E, durable worker scheduler, production credit RPC idempotency, all-channel canary, Android testing, owner-by-owner GO for production steps.
