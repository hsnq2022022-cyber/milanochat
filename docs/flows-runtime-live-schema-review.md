# Flow runtime schema aligned with the existing Supabase Free project

**Target project:** `nmhefwvhoholcjrbbila` (live owner project, not a second/staging project). This is a review-only migration; **not applied**.

## Production findings verified using read-only catalog queries

- `channel_accounts.platform`: actual stored values include `facebook`, `instagram`, `whatsapp`. The frontend uses the alias `messenger`; its trusted backend must map messenger -> facebook at storage boundaries.
- One channel account has `platform=whatsapp` with legacy `channel=salla`. Do NOT rewrite legacy channel values to make the flow feature work.
- `conversations.account_id` is nullable; flow execution must reject an unbound conversation rather than assigning an account by guess.
- All 4 existing conversations have account IDs today, with no observed cross-tenant mismatch. The schema still permits NULL for future legacy conversations.
- Existing data: 10 tenant rows, 4 channel accounts, 4 conversation rows, 3 credit ledger entries, zero flow drafts. No existing rows were updated or deleted.

## New schema (timestamped, service-only)

`supabase/migrations/20261028180000_flow_runtime_tenant_bound.sql`, after PR #133:

- Publications are immutable, tenant/account/platform-bound and store v3 JSON (4 MiB max).
- Activations start `is_active=false`; none created by migration.
- Event receipts have a tenant-account-platform-event unique key.
- Run rows reference **exact matching tenant, existing channel account, actual conversation and immutable publication** via composite foreign keys. A null-account or cross-tenant conversation cannot become a flow run.
- Outbox has a unique tenant+effect key and stable outgoing UUID with lease and quarantine statuses, but **no sender/worker is installed**.
- Metrics have no raw customer text/contact fields.
- All six new tables have RLS enabled; browser roles have no grants; service role is granted only required access. Publication rows cannot be overwritten/deleted, including by service-role writers.
- Two additive UNIQUE indexes on existing account/conversation tables enable strict composite foreign keys. They do **not** modify existing rows.

## Testing and rollback

- CI creates a fresh disposable PostgreSQL 17 with synthetic old tenant/account/conversation tables.
- Runs PR #133 OFF-switch migration, then runs this migration twice, checks RLS and unique/FK constraints, rejects wrong tenant/platform/unbound conversation, repeated Meta receipts/runs/outbox IDs, immutable revisions and default-OFF activation.
- Rollback **refuses to delete any nonempty flow table** and refuses to drop unfamiliar tables; tests verify existing channel and conversation rows remain.
- Rollback intentionally leaves the two harmless composite UNIQUE indexes on existing tables, to avoid breaking any future FK consumer. Their removal requires independent dependency review and GO.
- Live read-only verifier: `supabase/verification/20261028180000_flow_runtime_tenant_bound.readonly.sql`.

## Not yet implemented — production NO-GO

- No authenticated server API for publishing or activation uses the new tables.
- No atomic function binding signed inbound receipt + run state + outbox in ONE transaction.
- No durable delay scheduler, sender, provider idempotency proof, credit billing RPC reconciliation or signed test-owned Meta canary.
- No production SQL was applied. Any schema change to the existing Supabase project requires a dedicated owner GO for the exact migration and verified rollback.
- **Never auto-enable any flow**, even when an owner requests a preview. The legacy AI responder remains unchanged.

## Release sequence without new Supabase projects

1. Owner reviews and explicitly approves additive OFF-switch migration PR #133 (requires its own GO).
2. Apply this reviewed runtime migration with another GO after matching live catalog and saving a schema backup.
3. Deploy separate authenticated, test-only publication endpoint after a third GO, with server-computed permissions.
4. Integrate signed inbound -> one responder -> atomic receipt/outbox behind OFF flags; test with fake provider and test-owned accounts.
5. Fix real Meta/widget billing and retry, test rollback, then separately approve production activation/website deployment.

## 2026-10-28 release-gate recheck against actual production

- Stage 1 was applied with prior explicit owner GO: Supabase recorded version `20261028155425` (`automation_flow_switches`). Live read-only query confirms both switches exist, RLS is ON, `anon` and `authenticated` cannot update either table, global OFF, **0** configured/enabled tenants.
- Stage-2 runtime tables remain **absent** in production; this exact migration has NOT been run and needs a separate GO.
- Live preflight found no existing conflicting `channel_accounts_flow_owner_uq`, `conversations_flow_owner_uq` or `reject_automation_flow_revision_mutation()`.
- The migration now rejects any unrelated existing index/function with the same names, with explicit creation markers. Rollback checks the immutable-trigger function marker before removing it; preserves existing-table composite indexes even after safely removing empty new flow tables.
- Latest tested branch commit `e63990197c45d64fb2ad320674019b6b7dddf2c9`: [GitHub Actions #40724819573](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40724819573) **SUCCESS**. Tests exercised tenant/account/conversation FK denials, provider replay and outbox uniqueness, revision immutability, RLS, full transaction rollback with no data loss, repeat migration, and refusal to overwrite an unrelated pre-existing trigger function.
- PR #138 (separate future management RPCs + new Edge Function) passed its publication+Edge [CI #40723475325](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40723475325) on its latest head, but is NOT deployed and requires a different approval; this PR's GO does not authorize #138.
