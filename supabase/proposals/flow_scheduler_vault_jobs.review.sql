-- STAGED: DO NOT APPLY until the operator creates one Vault secret
-- named flow_worker_service_role_key containing the project's legacy
-- SUPABASE_SERVICE_ROLE_KEY. Never put the key in migrations, GitHub or chat.
-- The installed workers have independent default-OFF server flags.
BEGIN;
DO $guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron')
 OR NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net')
 THEN RAISE EXCEPTION 'Scheduler extensions are not installed';END IF;
 IF (SELECT COUNT(*) FROM vault.secrets
     WHERE name='flow_worker_service_role_key')<>1
 THEN RAISE EXCEPTION 'Missing unique flow_worker_service_role_key Vault secret';END IF;
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname IN(
    'milanochat-flow-durable-wake-v1','milanochat-flow-outbox-v1'))
 THEN RAISE EXCEPTION 'Flow job already exists; refusing overwrite';END IF;
END $guard$;

-- Cron stores only a SQL reference to the secret, never the secret itself.
-- Calls the worker only if the database has overdue sleeping runs.
SELECT cron.schedule(
 'milanochat-flow-durable-wake-v1','* * * * *',
 $job$
 SELECT net.http_post(
  url:='https://nmhefwvhoholcjrbbila.supabase.co/functions/v1/flow-runtime-worker',
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'Authorization','Bearer '||(SELECT decrypted_secret
     FROM vault.decrypted_secrets
     WHERE name='flow_worker_service_role_key')),
  body:='{"mode":"tick"}'::jsonb,
  timeout_milliseconds:=15000
 )
 WHERE EXISTS (
  SELECT 1 FROM public.automation_flow_runs
  WHERE run_status='sleeping' AND wake_at<=now()
 );
 $job$
);
-- Charge-pending messages MUST be settled without replaying Meta sends.
SELECT cron.schedule(
 'milanochat-flow-outbox-v1','* * * * *',
 $job$
 SELECT net.http_post(
  url:='https://nmhefwvhoholcjrbbila.supabase.co/functions/v1/flow-outbox-worker',
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'Authorization','Bearer '||(SELECT decrypted_secret
     FROM vault.decrypted_secrets
     WHERE name='flow_worker_service_role_key')),
  body:='{"mode":"tick"}'::jsonb,
  timeout_milliseconds:=15000
 )
 WHERE EXISTS (
  SELECT 1 FROM public.automation_flow_outbox
  WHERE delivery_status IN ('pending','charge_pending')
    AND effect_kind IN ('message','question')
 );
 $job$
);
COMMIT;
