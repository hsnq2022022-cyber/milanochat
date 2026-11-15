-- STAGED / REVIEW ONLY: DO NOT APPLY without a separate explicit owner GO.
-- Never installed by this repository. Schedules the B-3/B-4 inbound recovery
-- tick (milan-api ?action=inbound_recovery_tick, inboundRecovery.ts).
--
-- Prerequisites, in order:
--  1. migration 20261029360000_flow_inbound_recovery applied;
--  2. the milan-api build exposing inbound_recovery_tick deployed;
--  3. the Vault secret flow_worker_service_role_key exists (same secret and
--     same bearer rule as milanochat-flow-durable-wake-v1; flowWorkerAuth.ts)
--     AND the Edge secret of the same name holds the same value (otherwise
--     every tick answers 401, exactly like the flow workers today);
--  4. FLOW_INBOUND_RECOVERY_ENABLED=true (Edge secret, default unset = OFF)
--     and FLOW_WORKERS_OPERATOR_RELEASE as for the flow workers;
--  5. at least one tenant opted in (automation_inbound_recovery_tenants,
--     enabled=true). Without an opted-in tenant the job never calls out.
-- With the flag off the endpoint answers 423 and does nothing.
--
-- Cadence: every 5 minutes (the sweeper's backoff is 1m/5m/15m/60m and its
-- grace 5 minutes; a faster cadence adds nothing). Bounded: 5 events/tick.
-- Rollback: SELECT cron.unschedule('milanochat-inbound-recovery-v1');
BEGIN;
DO $guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron')
 OR NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net')
 THEN RAISE EXCEPTION 'Scheduler extensions are not installed';END IF;
 IF to_regclass('public.automation_inbound_recovery_tenants') IS NULL OR
    obj_description(to_regclass('public.automation_inbound_recovery_tenants'),'pg_class')
     IS DISTINCT FROM 'CREATED_BY_20261029360000_FLOW_INBOUND_RECOVERY'
 THEN RAISE EXCEPTION 'Migration 20261029360000_flow_inbound_recovery is not installed';END IF;
 IF (SELECT COUNT(*) FROM vault.secrets
     WHERE name='flow_worker_service_role_key')<>1
 THEN RAISE EXCEPTION 'Missing unique flow_worker_service_role_key Vault secret';END IF;
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='milanochat-inbound-recovery-v1')
 THEN RAISE EXCEPTION 'Recovery job already exists; refusing overwrite';END IF;
END $guard$;

-- Cron stores only a SQL reference to the secret, never the secret itself.
-- Calls milan-api only while some tenant is opted in.
SELECT cron.schedule(
 'milanochat-inbound-recovery-v1','*/5 * * * *',
 $job$
 SELECT net.http_post(
  url:='https://nmhefwvhoholcjrbbila.supabase.co/functions/v1/milan-api?action=inbound_recovery_tick',
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'Authorization','Bearer '||(SELECT decrypted_secret
     FROM vault.decrypted_secrets
     WHERE name='flow_worker_service_role_key')),
  body:='{"mode":"tick"}'::jsonb,
  timeout_milliseconds:=30000
 )
 WHERE EXISTS (
  SELECT 1 FROM public.automation_inbound_recovery_tenants
  WHERE enabled AND enabled_at IS NOT NULL
 );
 $job$
);
COMMIT;
