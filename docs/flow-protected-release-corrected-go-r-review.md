# GO-R repair review — scripts/source-only, NOT LIVE VERIFIED

Project: nmhefwvhoholcjrbbila. No workflow dispatch, Edge function deployment,
SQL migration, test Auth users or GitHub main commit occurred in this review.

## Immutable source identifiers

- Corrected runner shell and live fixture helper are both present at GitHub
  commit `631efb44958a165d032f7fc508df29534101fd6f`.
- Corrected `scripts/flow-protected-release.sh` blob:
  `bd878001687ce5d6d241402c69e9642aa988ecb3`.
- Corrected `scripts/flow-protected-live-smoke.mjs` blob:
  `ff1cef51b01ed89bbcff96bc0ad819a0f31df3d3`.
- Branch-only protected workflow with DRY-RUN FIRST:
  GitHub commit `e12ae063ddad99908fa72fb252e9ad747841a551`
  and YAML blob `8358b7ed7858533cc3e0bdeb0d791f7f30abddab`.
- Candidate `milan-api` commit `fd4f3cb3f252e9e367b0963ef37d1c8e84daee85`;
  `flow-publication` commit `f37a8be7800e1c47d7e3c0db4ab69e612e3f4cc9`;
  these were not modified or deployed.
- Main protected Workflow is **STILL OLD** and references
  `bdbddd972928f2ee7649abaf14b3bfae52439633`,
  **NOT** the fixed script. Do not press Run workflow.

## Fixes and fail-closed design

1. The count now performs `select('*',{count:'exact',head:true})`.
   The real tables `automation_flow_activations` and
   `flow_publication_rate_windows` have no `id` column.
2. The disposable Widget insert supplies cryptographically random explicit
   `token` **and** `public_token`, as required by the current SQL schema.
3. Auth email intent is journaled BEFORE createUser; if creating Auth succeeds
   but its reply is lost, cleanup attempts to resolve that exact disposable
   email. Tenant ID, channel account ID and Widget ID are journaled BEFORE
   each insert. A corrupted journal stops the workflow rather than silently
   resetting to empty.
4. On ordinary command error or SIGTERM: EXIT trap calls restoration if a
   deployment began, then fixture cleanup, printing baseline, counts before
   deletion, counts after deletion. Database totals MUST exactly match the
   pretest snapshot. If cleanup fails after a successful release, restoration
   is attempted and the job fails. Fixture ids are retained for operator
   intervention when automatic cleanup is incomplete.
5. `dry-run` is the first operational step in the **branch-only** future YAML:
   check the project, CLI version 101/absent publication, read counts, create
   disposable A/B Auth accounts, tenants, inactive Instagram channel rows and
   Widget, invoke old Widget via real HTTP, clean everything and compare counts.
   If anything fails, do NOT enter the release step. This is a
   **write-and-delete production fixture test**, not a read-only transaction;
   Supabase Auth users cannot be created and rolled back in one PostgreSQL
   transaction.
6. `release` is isolated in a second invocation with a new fixture journal:
   preserve source 101 tar+hash, deploy `milan-api` with flags OFF, test
   safe-refusal Widget parity, deploy `flow-publication` verify_jwt true,
   test separate Auth accounts, reject cross-tenant publish/activate/deactivate,
   rate limit 30/min, B unaffected, cleanup. No Meta sends.
7. No rollback can run after host destruction/SIGKILL/total GitHub outage,
   and CLI rollback deploy receives a NEW version number. A human recovery
   runbook and existing independent backup are therefore essential.

## Essential change-control limitation

Approval to copy **ONLY** `scripts/flow-protected-release.sh` to `main`
would not make the new logic executable. The workflow currently checks out
an immutable older repo commit with the uncorrected shell **and helper**.
Two necessary independently approved GitHub changes are:

- **GO-M2 (script file only):** copy `scripts/flow-protected-release.sh`
  into `main` in a dedicated commit, without changing workflow configuration,
  SQL, Edge source, or launching anything. Inspect GitHub Actions runs for
  that exact commit; expect zero given current main push path filters.
  This step alone is inert for the protected workflow.
- **GO-M3 (separate workflow-only):** copy the corrected branch-only protected
  workflow YAML to `main`. It pins the corrected two-script commit
  `631efb44958a165d032f7fc508df29534101fd6f` and adds the
  dry-run step before deployment. No script copies are needed for actual
  execution because the checkout pin resolves both fixed scripts.
  Confirm zero Actions runs for the workflow-only commit and owner's
  Environment required reviewers and selected branch main rules.

**GO-R remains blocked** until GO-M2/GO-M3 are separately approved,
completed and reviewed, GitHub Environment protection is confirmed by the
owner and the corrected scripts pass a real protected dry-run.

No test was executed in this turn, per user instruction. Syntax, CLI flags,
rollback behavior, Auth user creation and cleanup are CODE-REVIEWED ONLY.
