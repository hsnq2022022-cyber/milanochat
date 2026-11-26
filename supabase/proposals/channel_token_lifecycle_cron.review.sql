-- STAGED: DO NOT APPLY. Requires, in order and each with explicit owner approval:
--   1. deploy Edge function channel-token-lifecycle (verify_jwt=false),
--   2. the Vault secret flow_worker_service_role_key (already used by the Flow workers),
--   3. then this job. Until then no token is refreshed automatically and the dashboard
--      still warns from token_expires_at / status.
-- One daily tick; Instagram tokens are only refreshed inside their last 21 days.
BEGIN;
DO $guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron')
 OR NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_net')
 THEN RAISE EXCEPTION 'Scheduler extensions are not installed';END IF;
 IF (SELECT COUNT(*) FROM vault.secrets WHERE name='flow_worker_service_role_key')<>1
 THEN RAISE EXCEPTION 'Missing unique flow_worker_service_role_key Vault secret';END IF;
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='milanochat-channel-token-lifecycle-v1')
 THEN RAISE EXCEPTION 'Job already exists; refusing overwrite';END IF;
END $guard$;

SELECT cron.schedule(
 'milanochat-channel-token-lifecycle-v1','17 3 * * *',
 $job$
 SELECT net.http_post(
  url:='https://nmhefwvhoholcjrbbila.supabase.co/functions/v1/channel-token-lifecycle',
  headers:=jsonb_build_object(
   'Content-Type','application/json',
   'Authorization','Bearer '||(SELECT decrypted_secret
     FROM vault.decrypted_secrets
     WHERE name='flow_worker_service_role_key')),
  body:='{"mode":"tick"}'::jsonb,
  timeout_milliseconds:=60000
 )
 WHERE EXISTS (
  SELECT 1 FROM public.channel_accounts
  WHERE channel IN ('instagram','facebook') AND (status IS NULL OR status='active')
 );
 $job$
);
COMMIT;
