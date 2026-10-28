# Atomic inbound reservation — isolated PostgreSQL proof

**NOT A PRODUCTION MIGRATION.** No Supabase project, Meta webhook or live billing was changed.

## Evidence

- Fixture: `tests/sql/flow-atomic-staging-bootstrap.sql` in disposable Postgres 17.
- Tests: `tests/sql/flow-atomic-staging.test.sql` and two concurrent psql connections.
- Unique provider-event receipt, tenant-scoped run and uniquely keyed outbox row are inserted in one PostgreSQL function/transaction.
- Default global, per-tenant and per-flow activation flags are OFF.
- Credit, human takeover, account agent/auto-reply, token and verified-window conditions are checked.
- A replay returns false with no second run or outbox row.
- A conflicting effect key aborts the operation, rolling back the new receipt and run.
- Composite tenant/account/conversation foreign keys prevent cross-tenant and wrong-channel linkage.
- RLS enabled on all fixture tables, anon/authenticated grants revoked, service_role can execute.
- Concurrent psql sessions for one event produced one true and one false; final row counts `1|1|1`.

## Boundaries

- The real `milan-api` handler is unchanged. No Meta sending or customer account activation occurs.
- This only proves transaction semantics of a private synthetic schema, not production schema compatibility.
- `p_window_verified` must originate from a trusted server, never from the browser.
- A change in flags after reservation needs another pre-dispatch check.
- Two different events on the same conversation still need run serialization.
- This function does not charge credits, schedule delays, or deliver messages.
- It does not prove exactly-once Meta delivery, provider response handling or credit reconciliation.
- Live tenant schema must be inspected before authoring a timestamped migration + rollback + read-only verifier.
- A separate staging Supabase project and explicit per-action production GO remain mandatory.

## Reproduction

Run the GitHub Actions workflow `.github/workflows/flow-atomic-staging-ci.yml`.
Expected SQL output: `PASS: atomic receipt+run+outbox, duplicate/rollback/tenant/guard/RLS`.
Expected concurrent output: one `t`, one `f`, and `receipt|run|outbox counts: 1|1|1`.
