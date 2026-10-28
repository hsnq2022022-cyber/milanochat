# Flow Builder rollout on the user's ONLY Supabase Free project

**Confirmed target:** `nmhefwvhoholcjrbbila`. No second Supabase project, no new paid project, no new paid service. This is the *existing* Free-tier project.

## Read-only live baseline — 2026-10-28

- Supabase project: `ACTIVE_HEALTHY`, PostgreSQL 17.
- Counts **only** (no private records read): 10 tenant rows, 4 channel accounts, 4 conversation rows, 3 credit reply ledger records, **0 flow drafts**.
- The owner states that there are **no real customers and the site is in development**. Existing rows may be test data; NEVER delete or change them merely because they are probably tests.
- No runtime publication/activation/receipt/outbox tables currently exist.
- Existing `consume_reply(uuid,uuid)` and `grant_credits(uuid,integer)` execute privileges are **service_role only**, not anon/authenticated. The existing debit function's ghost-ledger defect is separately reviewed in PR #131.

## Same-project development model

Use the existing database only. CI will continue to use short-lived PostgreSQL inside GitHub Actions (no Supabase project created, no additional Supabase subscription). If a real webhook test is needed, use **test-owned channel accounts** with an explicit per-tenant server flag, and preserve all other accounts/conversations.

No customer messages can be sent by a new flow while both switches are OFF.

**This PR adds OFF-by-default flags only:** `public.automation_flow_global_switch` and `public.automation_flow_tenant_switches`, with RLS and no anon/authenticated rights. The server-owned global flag AND tenant switch must both be enabled, plus separately approved runtime publication and verified Meta account checks, before any future worker can dispatch. UI toggles are not security boundaries.

## Change, risk, verification, rollback for an owner GO

- **Change:** apply exactly `supabase/migrations/20261028170000_automation_flow_switches.sql` to project `nmhefwvhoholcjrbbila`; no existing tenant rows touched, both new switches default OFF.
- **Why:** install a server-owned kill switch before implementing a real webhook/worker integration.
- **Risk:** consumes a tiny amount of database storage, adds two database objects, possible mismatch if another change creates same names; no messages are sent by this migration. The migration checks known schema fields and aborts on unexpected shapes.
- **Verification:** isolated Postgres 17 CI tests for double apply, startup OFF, tenant isolation, no authenticated/anon writes, switch revocation and guarded rollback; run `supabase/verification/20261028170000_automation_flow_switches.readonly.sql` after approval.
- **Rollback:** `supabase/rollbacks/20261028170000_automation_flow_switches.rollback.sql`. It refuses to drop nonempty tenant settings or any enabled flag and refuses to drop tables it did not create. Never use a destructive rollback just to reset activation: set the global flag OFF instead.
- **Authorization:** prior project designation allows read-only development assessment but does not supersede the owner's original requirement for an explicit **GO per production schema change**. Do NOT run the migration merely because the schema is additive.

## Future steps without creating another project

1. Finalize server-side publication and activation against audited live tables and add versioned migrations/rollback/checks.
2. Keep new runtime global and per-tenant flags OFF until a signed test-owned Meta event is processed without a duplicate AI reply.
3. Use fake providers, GitHub Actions PostgreSQL, and approved test accounts; never use actual customer credits for test fixtures.
4. Repair `consume_reply` along with ALL call sites, including widget billing, and test crashes/429/5xx before seeking a live GO.
5. Run phone UI screenshot QA, verify Meta permission scopes, monitor credits/ledger and rehearse rollback.
6. Seek separate GO for each function deploy, Meta webhook subscription, tenant activation and Pages merge. Do not claim launch before evidenced gates.

## Verified preflight immediately before owner GO (2026-10-28)

READ-ONLY SQL executed against the owner-confirmed project `nmhefwvhoholcjrbbila` using
`supabase/verification/20261028170000_automation_flow_switches.preflight.readonly.sql`:

```text
automation_flow_global_switch  already_exists=false  safe_to_create
automation_flow_tenant_switches already_exists=false  safe_to_create
```

Migration strengthened on [PR #133](https://github.com/hsnq2022022-cyber/milanochat/pull/133): if either table appears before install, only a table bearing this exact migration's creation marker may be reused. Unknown same-name tables are never granted privileges or modified.

[Isolated PostgreSQL 17 CI #40717139691](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40717139691)
**SUCCESS** on commit `873a84b4fe5463dd66ea773ef707613ca7e0b3d4`: creates/reapplies OFF switches, enforces browser-role denial, tests tenant opt-in and global OFF, refuses rollback with data, successfully rolls back empty new tables, and rejects an unrelated colliding table while preserving its contents.

**Pending owner GO solely for this exact schema migration.** No production SQL was applied. Do not confuse the preceding read-only preflight with migration installation; any SQL execution that creates these tables needs separate explicit approval.

Change: create two service-role-only OFF switches, no existing records updated/deleted. Risk: 2 additional tables; transaction stops on unexpected schema or permissions; optional extra disk usage. Verify using the committed read-only postflight. Rollback with the committed guarded rollback only while no state exists; otherwise keep global OFF, preserve tables and take a separately approved forward fix.
