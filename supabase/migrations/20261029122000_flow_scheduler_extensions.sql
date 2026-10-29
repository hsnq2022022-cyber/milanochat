-- Production prerequisite for gated durable Flow wake-up and Outbox jobs.
-- Installation adds no cron jobs, network requests or new permissions
-- to the app's publicly exposed API schema.
-- Actual scheduling MUST follow separate Vault secret provisioning.
BEGIN;
DO $preflight$
BEGIN
 IF EXISTS(
  SELECT 1 FROM pg_extension
  WHERE extname IN ('pg_cron','pg_net')
 ) THEN
  RAISE EXCEPTION 'Cron/network extension present; review existing config';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='extensions')
 THEN RAISE EXCEPTION 'Supabase extensions schema missing';END IF;
END $preflight$;
CREATE EXTENSION pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION pg_net WITH SCHEMA extensions;
COMMIT;
