# Billing and Meta reply release review — DO NOT DEPLOY

Scope: PR #114 (and stacked #111/#112). **Read-only code review, no production access in this session.**

## Confirmed defects and PR #114 assessment

1. The present `milan-api` handler calls `consume_reply` with only `p_tenant_id`. The SQL function signature documented earlier is `consume_reply(uuid,uuid)`, including `p_message_id`.
2. PR #114 stores the outgoing message and passes its generated ID to `consume_reply`. It inspects the Supabase response `{error,data}`, fixing the missing-argument mistake **for that one handler**.
3. PR #114 is **NOT replay-safe**: sending to Meta occurs before a durable outbox reservation and before storing the outgoing ID. Inbound duplicate filtering and unique `wa_message_id` alone do not cover a worker crash after sending or a failed DB insert.
4. If the outgoing insert/RPC fails, the customer may have received a free reply, because the code returns without a retryable charge record. Conversely a new retry may send a second reply with a different ID and charge again.
5. The **widget** reply path still calls `consume_reply` without `p_message_id`. This is outside PR #114's patch.
6. Prior live definition of `consume_reply` inserts `reply_ledger` BEFORE deducting a credit; a depleted balance can return -1 while the ledger row remains. Re-check via read-only SQL authorized by owner before altering any function.
7. Human takeover/expiry, low credits, `agent_enabled` and `auto_reply` must retain precedence in all test cases. No flow-generated messages are authorized yet.
8. The current workflow `.github/workflows/deploy-functions.yml` automatically deploys EIGHT functions on changes under `supabase/functions/**` pushed to `main`, including `milan-api`. Thus merging #114 can deploy more than the intended function — **do not merge without owner GO**.
9. PR #114's current tests inspect source text; they are not a fake provider end-to-end or transactional duplicate/credit test.
10. The correct design needs a server-side per-tenant flag default OFF, atomic event receipt + run state + idempotent outbox, a provider delivery reconciliation state, and exact once debit anchored to a stable outgoing record.

## Required staging acceptance before any deployment

| Scenario | Setup | Required evidence |
| --- | --- | --- |
| Repeat same Meta provider message ID | Send same signed webhook twice and concurrently through fake provider | 1 receipt, 1 outbox row, 1 provider send, 1 debit |
| Provider send succeeds then DB fails | Fail DB outgoing insert/credit RPC after successful send | Durable reconciliation/alarm, no second provider message; debt explicitly tracked |
| Provider 429/5xx | Fake provider errors twice then recovers | Bounded backoff/dead-letter, stable message ID, no double charges |
| Low credits | Tenant balance 0 | No flow or AI provider send and no credit decrement |
| Human takeover | Conversation transferred=true / manual takeover window | No automatic send or debit |
| Flag OFF | Same signed fixtures on old/new handler | Identical AI path outputs and DB side effects |
| Widget response | Authenticated mock widget request | Correct unique outgoing message ID used, no free or duplicate charge |
| Unknown account / tenant mismatch | Signed webhook ID for unbound or another tenant | No cross-tenant retrieval/credit/send |

These are **planned**, not executed; staging project and test-owned accounts are still missing.

## Exact deployment and rollback gate

**Required owner GO** explicitly authorizing one change: the reviewed `milan-api` commit and its stated dependencies, not general project deployment.

- **Change:** deploy only a reconciled, tested Edge Function to a staging instance first; production deployment only with separate GO.
- **Reason:** fix the incorrect billing RPC signature and duplicate provider reply accounting without breaking current AI.
- **Risk:** misconfigured Meta secrets can reject all webhooks; incorrect reservation can duplicate sends or cause free replies; deploying main triggers eight Edge Function deploy commands.
- **Verification:** staging scenarios above, then monitoring read-only credit/reply reconciliations, 0 unexpected duplicate provider IDs.
- **Rollback:** record currently active function version and commit, use approved Supabase CLI with the previously verified source, switch flag OFF, deploy that source version; verify incoming AI path and balances. Do not delete ledger rows.

Commands shown for **owner-authorized staging only**. Verify CLI help and project reference before execution:

```bash
npm ci
npm run typecheck
npm run test:unit
supabase --version
supabase functions deploy --help
# Stage to a dedicated non-production project only after owner GO:
# supabase functions deploy milan-api --project-ref "$STAGING_PROJECT_REF" --no-verify-jwt
```

Do not use `PROJECT_REF=nmhefwvhoholcjrbbila` without a separate production GO. No credentials or access tokens in shell history or repository.

## Read-only monitoring queries for the owner

First confirm the live schema columns using catalog queries and obtain explicit session permission. These queries read only aggregates and do not change credits:

```sql
select count(*) as total_ledger_records,
       count(distinct message_id) as distinct_message_ids
from public.reply_ledger;

select count(*) as messages_with_no_matching_ledger
from public.messages m
left join public.reply_ledger l on l.message_id=m.id
where m.direction='out' and m.is_auto=true and l.message_id is null;

select count(*) as ledger_ids_without_messages
from public.reply_ledger l
left join public.messages m on m.id=l.message_id
where m.id is null;
```

The second count is an **indicator**, not proof of fraud or billing loss: it can include historical messages from other paths and pre-migration records. Compare only a verified canary window and known channel/provider message IDs. Real payment operations, Meta sends and function redeploys are NOT tested in this work session.
