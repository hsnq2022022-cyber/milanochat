# Production read-only billing audit and proposed atomic RPC fix

**Verified live project:** `nmhefwvhoholcjrbbila`, PostgreSQL 17; read-only `pg_catalog` queries on 2026-10-28. **Nothing was applied to production.** This is an approval-gated proposal.

## Confirmed live facts

- `public.tenants.credits_remaining`: integer, default 0, NOT NULL.
- `public.reply_ledger.message_id`: UUID, UNIQUE, foreign key to `public.messages(id)`; `tenant_id` references tenants.
- `public.messages.id` UUID, `tenant_id` UUID, `conversation_id` UUID, `direction` = in/out.
- RPC `public.consume_reply(uuid,uuid)` returns integer, SECURITY DEFINER; `anon` and `authenticated` **cannot EXECUTE**, `service_role` **can EXECUTE**. `grant_credits(uuid,integer)` has the same service-only execute grant.
- **Confirmed bug:** current function first `INSERT ... reply_ledger ON CONFLICT DO NOTHING`, then `UPDATE tenants SET credits_remaining=credits_remaining-1 WHERE credits_remaining>0`. If no credits, it returns `-1` **after committing a ledger row**. A future retry sees UNIQUE conflict, returns `-2` (already charged) although no credit was consumed. There is no safe way to infer historical undercharges solely from the ledger.

## Patch

- `supabase/migrations/20261028150000_consume_reply_atomic.sql`: before any ledger write, lock the tenant row, verify an existing outgoing message linked to a conversation for that tenant, check idempotency, check balance, then UPDATE credits and INSERT ledger in the **same transaction**. Missing/wrong message or tenant returns new `-3` (existing `-1`, `-2` and remaining-balance conventions preserved).
- Keeps SECURITY DEFINER, sets `search_path=''` and qualified table names, grants execute ONLY to `service_role`.
- `supabase/rollbacks/20261028150000_consume_reply_atomic.rollback.sql`: restores the **exact previously-live function**, but **reintroduces the billing defect**. It is not an automatic production rollback and requires a separate incident/security decision.
- `supabase/verification/20261028150000_consume_reply_atomic.readonly.sql`: function/guard/role checks, safe to run without reading customer message bodies.

## Verified in disposable PostgreSQL 17

[GitHub Actions run #40686374762](https://github.com/hsnq2022022-cyber/milanochat/actions/runs/40686374762):

```text
REPRODUCED: original RPC writes ghost ledger on no credit
PASS: no ghost ledger, retry idempotent, tenant-owned outgoing message, correct credits
Concurrent RPC return values: 0 / -1
Tenant B ledger|remaining: 1|0
```

The migration re-applied successfully on the disposable database. Initial CI failed because synthetic `service_role` was not granted the real service role's table privileges; after correcting only the isolated fixture, CI passed. No production privilege was changed.

## Known launch blockers

1. **Current live `milan-api/index.ts` calls `consume_reply` without `p_message_id`** for both Meta and Widget paths. In Supabase PostgREST, the response contains an error object even when no JavaScript exception is thrown. A function migration alone cannot repair these callers; the Meta handler must persist the outgoing message ID, and the Widget needs a separately scoped billing design because its `widget_messages` IDs are not in `public.messages`. PR #114 only partially addresses Meta, has unresolved provider-retry and failure-after-send risk, and must **not** be deployed as is.
2. An outgoing message can be accepted by Meta then fail to persist locally; this still creates a missing charge and cannot be solved by changing the debit RPC alone. Requires staging provider mocks, durable outbox and reconciliation.
3. The live `grant_credits` function currently accepts any integer; callers must not supply arbitrary/negative values and payment grant idempotency remains separately unverified.
4. Existing historical ledger rows are preserved. No destructive cleanup or automatic back-charge should occur.

## Explicit owner GO is required for ANY production action

- **Requested future change:** install only the transactional debit RPC migration after a successful staging rehearsal and matching caller patch.
- **Risk:** invalid historical callers will receive `-3`, and currently broken callers without message IDs will remain broken. High throughput is serialized per tenant row (correctness first).
- **Verification:** read-only verifier, side-by-side signature audit, signed webhook + fake-provider tests, credits/ledger before-after monitoring, widget regression.
- **Rollback:** restore the prior function revision from the versioned rollback file ONLY with a dedicated risk acknowledgment; because rollback reinstates ghost billing, use a forward hotfix whenever possible.
- No SQL applied and no Edge Function deployed in this work session.
