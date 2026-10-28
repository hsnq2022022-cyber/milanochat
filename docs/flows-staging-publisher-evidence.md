# Stage 8 — Staging publishing and immutable revisions

**NO PRODUCTION DEPLOYMENT.** This PR derives from integrated review PR #126, not from a deployed runtime. It does not change `milan-api`, Supabase production or customer activation settings.

## Code delivered

- `src/flow/stagingPublisher.ts` implements an authenticated publisher service interface with server-resolved identity and account capabilities (never from the browser).
- Publish accepts v3 documents only, enforces a 4 MiB limit and invokes the existing shared publication validator before requesting an atomic, immutable database append.
- Activate requires explicit **server-side test-account canary approval** (default false), verifies account ownership, selected revision and current server-derived capabilities.
- Rollback moves an activation pointer to an earlier immutable revision; deactivate remains allowed even when the account is disabled.
- `tests/sql/flow-publisher-staging.sql` creates a disposable PostgreSQL fixture with tenant/account composite foreign keys, immutable documents, private service-only RPCs, RLS enabled, test-account approval default false, and atomic revision allocation through a tenant-row lock. **It is not a Supabase migration.**
- `tests/sql/flow-publisher-staging.test.sql` tests cross-tenant denial, double publication, immutable update/delete triggers, activation default OFF, canary approval, rollback, global kill and deactivation.

## Verification

[GitHub Actions run #40683116186](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40683116186): 7 publisher unit tests, 4 existing publication gate tests, TypeScript, Vite, and PostgreSQL fixture assertions all passed.

## Critical limitations

- This is **not** mounted on any live Edge Function or callable browser endpoint.
- `PublisherAuth.identify` and `PublicationStore` are interfaces; a real server must verify Supabase JWT with `auth.getUser` and derive tenant/account from the actual live schema. Never trust `user_metadata`, request tenant IDs or client-provided capabilities.
- The SQL fixture checks JSON structure and permissions, but the authoritative runtime/capability graph validation is the TypeScript service. Real code must use a Deno-compatible shared validation module and persist in the same transaction.
- A real migration depends on the read-only live schema audit (PR #118), with rollback and a separate SQL reviewer GO. Do not transplant these fixture tables into production.
- Published revisions have no real channel Meta permission approvals or provider subscriptions yet. Test-account canary activation is **not** permission to send messages. New runtime server-side feature flags must stay OFF.
- Stage 9–12 still need a signed webhook adapter, exclusive responder integration, durable worker, credit RPC repair, real staging Meta test accounts, Android QA and rollback rehearsal.
