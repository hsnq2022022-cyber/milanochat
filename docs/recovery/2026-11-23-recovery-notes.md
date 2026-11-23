# Recovery notes — security and flow work (2026-11-23)

Branch `recovery/security-and-flow-work-2026-11-23`, based on `ccr-7df0ec85-p0h2gk` @ `2750779`. Not for merge into `main`; it exists so the work can be recovered elsewhere.

## Contents
- `backups/production-2026-11-23/originals/` — transcriptions of the deployed Edge Functions `meta-auth` v63, `channels` v112, `api` v108 (rollback baseline). Source fidelity is NOT proven byte-exact; compare with `supabase functions download` before relying on it.
- `backups/production-2026-11-23/hotfix/` — reviewed hotfix sources (NOT deployed).
- `backups/production-2026-11-23/tests/` — behavior tests (29) plus the Deno import map used for local checks (`esm.sh` -> `npm:`).
- `backups/production-2026-11-23/hotfix-mutants/` — mutation runner (54 mutants) and last result.
- `tests/flow-multi-active-selection.test.ts` — +5 tests (revision re-selection, stale refs, dangling activation, V3/V4 parity, stale waiting run).
- Hashes: `backups/production-2026-11-23/SHA256SUMS` (does not cover `tests/importmap.json` and `hotfix-mutants/last-result.txt`, added afterwards).

## Not deployed / open
- Hotfixes are not deployed. Deploy order if approved: `api` -> `meta-auth` -> `channels`, `verify_jwt=false`, single `index.ts`.
- The lifecycle integration test fails from fixture drift (`channel_accounts.status` missing in `tests/sql/fixtures/flow-live-shape-bootstrap.sql`); unfixed.
- Same-revision reactivation policy is undecided; nothing implemented.
- Migration `20261115120000` is applied in production without a ledger row.
