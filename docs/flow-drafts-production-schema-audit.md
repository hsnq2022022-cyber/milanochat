# Production flow drafts schema reconciliation — October 28, 2026

**Production:** `nmhefwvhoholcjrbbila`; PostgreSQL 17; read-only catalog inspection only. **No SQL was executed to modify live tables.**

## Independently verified live state

`public.automation_flow_drafts` exists and has RLS enabled. Seven columns:
`tenant_id uuid NOT NULL`, `flow_key text NOT NULL`, `name text NOT NULL`,
`document jsonb NOT NULL`, `draft_revision integer NOT NULL DEFAULT 1`,
`created_at timestamptz NOT NULL DEFAULT now()`,
`updated_at timestamptz NOT NULL DEFAULT now()`.

Constraints: primary key `(tenant_id,flow_key)`, FK to `tenants(id) ON DELETE CASCADE`, flow key 1–128, name 1–100, positive draft revision, document version 3 with array nodes/edges and 4 MiB max JSON text. Index `(tenant_id,updated_at DESC)`.

Exactly three authenticated-owner RLS policies: SELECT, INSERT, UPDATE. No DELETE policy.

Live `authenticated` privileges: table SELECT/INSERT; column UPDATE only `name`, `document`, `draft_revision`, `updated_at` (not `tenant_id`, `flow_key`, `created_at`). IMPORTANT: `has_table_privilege(authenticated, ..., 'UPDATE')` returns false here **by design** because UPDATE is granted per column. `anon` has no table grants.

## Schema/migration drift

The actual Supabase migration history lists `20260913170629_fix_wa_binding_tenant_to_milano`; the drafts table was applied separately and is NOT in that tracked history. The repo previously held `supabase/proposals/automation_flow_drafts.review.sql` rather than a versioned migration. This PR provides a safe baseline consistent with the observed live table, not a second production table.

## New artifacts

- `supabase/migrations/20261028151500_automation_flow_drafts_baseline.sql`: creates only if missing; validates key shape; idempotent index, RLS, grants and owner policies; tags only newly created tables.
- `supabase/rollbacks/20261028151500_automation_flow_drafts_baseline.rollback.sql`: skips any preexisting table, NEVER deletes customer drafts. Removes a table created by this migration only when empty; refuses if data exists.
- `supabase/verification/20261028151500_automation_flow_drafts_baseline.readonly.sql`: checks RLS, owner policies, allowed column permissions and forbidden owner/key edits.
- `.github/workflows/flow-drafts-baseline-ci.yml`: fresh PG17, already-existing-table PG17, repeated migration, owner A/B/anon RLS tests, safe rollback and refusal on nonempty table.

## Evidence

[GitHub Actions #40686872903](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40686872903): **both disposable PostgreSQL jobs passed.** Existing-table rollback preserved the table; new empty table rollback succeeded; nonempty table rollback refused and retained all two synthetic drafts.

## Owner release gate (NOT approved yet)

This is a **migration-history reconciliation**, not a feature that requires live data movement. Nevertheless, adding a migration version to production affects operational schema tracking; do not run blindly from the repo. An owner GO must include the exact migration version, a fresh live metadata verification, Supabase migration history reconciliation and staging rehearsal. No user data, real credits, or Meta settings should be changed. If live metadata differs from this audit, stop rather than replacing the table.

This PR does not enable automation, send messages or address the separate unsafe billing workflow. Backend publishing, durable worker and all-channel canary remain blocked on a separately authorized staging project and per-action production GO.
