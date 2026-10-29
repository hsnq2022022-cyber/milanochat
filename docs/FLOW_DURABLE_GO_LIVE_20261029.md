# Durable Instagram scheduler — controlled production release (2026-10-29)

## Verified baseline
- The real Instagram text+condition flow is active at revision 2. Do not silently replace it.
- `milan-api` v108 has the server-only durable ingress adapter, **default OFF**.
- `flow-publication` v5 has the independent advanced activation gate, **default OFF**.
- `flow-runtime-worker` and `flow-outbox-worker` are deployed but their independent send/scheduler secrets default OFF.
- The production DB has `flow_begin_durable_run`, `flow_resume_button_run`, `flow_commit_run_step`, a tenant-scoped Outbox, immutable publications, confirmed provider attempt journal and Meta delivery receipts. All are service-only.
- The reviewed Outbox billing recovery patch must be deployed before enabling any sender.
- Payment is separately owned and deliberately outside this release.

## Preconditions (not yet met)
1. Apply the reviewed additive extension migration `20261029122000_flow_scheduler_extensions.sql`; verify `pg_cron` and `pg_net` installed. It does not create a job.
2. The owner creates one Vault secret **named** `flow_worker_service_role_key` with the existing legacy Supabase service-role key. Never send the value in chat or commit it. The new `sb_secret_` key is not interchangeable until both workers are adapted.
3. The owner checks the Edge Function secrets for both workers and `milan-api` and explicitly arms each default-OFF flag on the *selected account only*: `FLOW_DURABLE_INGRESS_ENABLED`, `FLOW_DURABLE_CANARY_ACCOUNT_ID`, `FLOW_DURABLE_ACTIVATION_READY`, `FLOW_OUTBOX_SEND_ENABLED`, `FLOW_ATOMIC_CONSUME_READY`, `FLOW_RICH_BUTTONS_ENABLED`, `FLOW_DURABLE_SCHEDULER_ENABLED`. Do not arm any without the tested graph and bill/on-send parity.
4. Apply the Vault-backed `flow_scheduler_vault_jobs.review.sql` only after exact Vault-secret presence is checked, worker source/deployment parity is verified, the source review is approved, and the owner authorizes scheduled invocations. Jobs are named and refuse overwrite.
5. Publish a *new immutable revision* of a two-choice Instagram question or 1-step delay graph, activate only the one approved canary account, then send a fresh message from another Instagram user; confirm provider MID, exactly one outgoing row/debit and no duplicate on replay. Test both button branches and the delayed wake separately.
6. Revoke advanced flags on any mismatch. The existing v2 text/conditions production document should remain available for rollback without deleting customer history.

## Scheduler properties
- Two 1-minute `pg_cron` jobs invoke authenticated Edge endpoints only when due rows exist; `pg_net` sends the HTTP calls after transaction commit.
- The HTTP Authorization header obtains the legacy service-role token from Vault *at execution time*. No token appears in SQL source or cron.job text.
- The Edge Functions independently check a service-role Bearer and default-OFF environment switches before accessing any tenant records.
- Provider sends are reserved in a per-effect immutable journal before contacting Meta; unknown acknowledgements are marked uncertain, never retried automatically.
- Confirmed `charge_pending` effects are persisted and billed without any extra Meta send; outgoing MID and identity must match the prior attempt.
- Cron does not guarantee exact second precision; sleep/wake latency is bounded by the configured tick interval and networking delays.

## Safe inspection commands
```sql
SELECT extname FROM pg_extension WHERE extname IN ('pg_cron','pg_net');
SELECT name FROM vault.secrets WHERE name='flow_worker_service_role_key';
SELECT jobname,active FROM cron.job WHERE jobname LIKE 'milanochat-flow-%';
SELECT delivery_status,count(*) FROM public.automation_flow_outbox GROUP BY 1;
SELECT run_status,count(*) FROM public.automation_flow_runs GROUP BY 1;
```

**Never execute new provider sends or flip the production switches as an automatic migration side effect.** The payment integration remains excluded.
