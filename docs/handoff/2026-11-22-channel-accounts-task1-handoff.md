# Handoff: channel_accounts hardening (Task 1), 2026-11-22

> **Reconstruction notice.** The original handoff file from the previous session
> (local branch `docs/handoff-channel-accounts-task1-2026-11-22`, uncommitted and
> unpushed) was lost with that container. This file was rewritten from facts
> verified read-only during the follow-up session. Anything marked
> "unverified" could not be confirmed.

## Scope

- Repository: `hsnq2022022-cyber/milanochat`
- Supabase project: `nmhefwvhoholcjrbbila`
- Migration: `supabase/migrations/20261115120000_channel_accounts_hardening.sql` (18,059 bytes)
- Rollback: `supabase/rollbacks/20261115120000_channel_accounts_hardening.rollback.sql` (7,604 bytes)
- Both files are byte-identical to the previously reviewed commit `3849ae4`.

## What happened

1. The previous session's `apply_migration` call timed out at the 60-second
   confirmation window. Nothing was applied.
2. This session made two more attempts through `apply_migration`. The second timed out
   the same way. A read-only check afterwards showed the database unchanged.
3. The confirmation prompt is shown to the user in the Claude app and the tool call
   blocks while it waits, so the agent cannot announce the prompt mid-call. No documented
   way to extend the 60 seconds, pre-authorize it, or make it non-blocking was found.
4. On a later read-only verification the migration's effects were found **already
   applied in production**. The agent never got `apply_migration` to run, so it was
   applied by another route. The route is unverified.

## Verified production state (read-only, 2026-11-22)

| Check | Result |
|---|---|
| RLS enabled on `public.channel_accounts` | PASS |
| Policy `users manage their channel accounts` | absent (PASS) |
| Policy `users see their channel accounts` | present: SELECT, `{authenticated}`, PERMISSIVE, owner-scoped via `tenants.user_id = auth.uid()` |
| `anon` table SELECT | false |
| `authenticated` INSERT/UPDATE/DELETE/TRUNCATE | all false |
| `authenticated` SELECT on `access_token`, `access_token_encrypted`, `metadata`, `error_message`, `scope` | all false |
| `authenticated` SELECT on the 28 safe columns | 28 of 28 true; no table-level SELECT |
| `service_role` INSERT | true |
| Index `channel_accounts_channel_external_id_global_uq` | exists, valid, unique, expected predicate |
| Index comment marker `CREATED_BY_20261115120000_CHANNEL_ACCOUNTS_HARDENING\|{...}` | present, records the previous state |
| Migration ledger row for `20261115120000` | **MISSING** (latest ledger version is `20261029330000`) |

## Open item: ledger gap

- `supabase_migrations.schema_migrations` has 33 rows. Existing rows use
  `version` plus `name` (snake_case without the timestamp), with `statements`,
  `created_by` and `idempotency_key` null or empty.
- The repo has 39 migration files. The ledger is behind the repo for other
  migrations too: `20261029340000`, `20261029350000`, `20261029360000`,
  `20261115130000` and `20261115150000` are not applied in production.
- There is no `supabase/config.toml`, and no workflow runs `supabase db push`.
- Recommended: do not rerun the migration and do not insert a ledger row by hand.
  Reconcile all unapplied versions together with `supabase migration repair` from
  a linked CLI on the owner's machine.
- Risk: `supabase db push` would treat `20261115120000` as pending (harmless, the
  migration is idempotent) and would also push the other unapplied files.

## Rules still in force

- Do not run the rollback automatically. It re-opens the client write and token read hole.
- No Edge Function deployments, feature flags, secrets, Auth or unrelated database changes.
- Do not push or merge without approval.
- Task 2 has not been started.
