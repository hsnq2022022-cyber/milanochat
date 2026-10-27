# Flow Builder completion status

Baseline: `main` at `21d23246` (2026-10-28). Production changes require a separate owner GO for each action.

| Step | Status | Evidence | Open risks |
|---|---|---|---|
| 1. Repo/CI/typecheck | in progress | `chore/ci-and-typecheck` | Browser acceptance with authenticated payment/widget actions not yet proven; CI consolidation pending |
| 2. Schema drift | blocked-owner | `supabase/proposals/automation_flow_drafts.review.sql` | Owner must provide read-only catalog query output or session permission; no production SQL until GO |
| 3. Editor defects | todo | `src/flow/`, `tests/` | Trigger, undo history, import, backup, layout, Playwright tests pending |
| 4. Billing review | todo | [PR #114](https://github.com/hsnq2022022-cyber/milanochat/pull/114) | Existing responder charges, retry behavior and rollback need review; deployment needs GO |
| 5. Credit RPC lockdown | blocked-owner | `docs/automation-flow-release-evidence.md` | Owner must supply read-only privilege query output or permission; migration/rollback review + GO |
| 6. Publishing/routing | blocked-owner | `supabase/proposals/automation_flow_runtime.review.sql` | Staging Supabase project and Step 1–5 approvals required; flag OFF |
| 7. Durable runner/AI/canary | blocked-owner | `docs/automation-flow-release-evidence.md` | Staging, fake provider, two test-owned accounts/channel, release authorization; no live sends |

Update this record after each tested PR. `done` requires direct evidence, not just passing unrelated unit tests.