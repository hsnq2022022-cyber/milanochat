-- REVIEW ONLY. Rollback for 20261029170000_flow_canary_claim_durable.sql. NOT applied anywhere.
-- Drops flow_claim_inbound_durable and the tables automation_flow_canary_claims
-- and automation_flow_canary_accounts. Nothing else is touched:
-- flow_claim_inbound, automation_message_claims (including every claim the
-- canary function wrote), runs, outbox and V2 stay exactly as they are.
--
-- Order: run right after the 20261029180000_flow_durable_button_run_guards
-- rollback (refused while a 180000-marked function exists), then this one.
-- Required rollback order is 20261029190000, 180000, 170000, then
-- 20261029160000_flow_credits_pause, 20261029150000_flow_takeover_resume,
-- 20261029140000_flow_outbox_ai_retry, 20261029130000_flow_run_lifecycle
-- (the older rollbacks refuse while any 170000 object exists).
--
-- milan-api does not need to be reverted first: if flow_claim_inbound_durable
-- is missing, the production canary path in flowDurableIngress.ts treats the
-- RPC error as "fallback" (no claim was written), so V2 answers. test_only
-- tenants never call it.
--
-- Data guard: dropping the tables discards the operator canary registrations
-- and the provenance audit of claims made through the canary function (the
-- claims themselves are kept). If any such row exists the rollback REFUSES
-- unless the operator opts in explicitly for this session, e.g.:
--   PGOPTIONS='-c lock_timeout=3s -c statement_timeout=60s -c flow.rollback_170000=discard-canary-data' \
--     psql -X -v ON_ERROR_STOP=1 -f supabase/rollbacks/20261029170000_flow_canary_claim_durable.rollback.sql "<conn>"
-- Export the rows first if they must be kept (SELECT * FROM each table).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE';
 v_fn regprocedure := to_regprocedure('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)');
 v_reg regclass := to_regclass('public.automation_flow_canary_accounts');
 v_aud regclass := to_regclass('public.automation_flow_canary_claims');
 v_n_reg bigint := 0;
 v_n_aud bigint := 0;
BEGIN
 -- 20261029210000 (media effects; requires the 130000..190000 chain) is newer: roll it back first.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN(
   to_regprocedure('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)'),
   to_regprocedure('public.flow_reserve_outbox_delivery(uuid,uuid)'),
   to_regprocedure('public.flow_finish_outbox_delivery(uuid,uuid,text,text)'))
  AND md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) IN(
   '94a87bc016ad93e609897025d259bf3e','1b7a6fe3f6a9ee97203d50d5e0e0baa7','1c6ec477519f8c91c24fc2ab82d4b9c4'))
 THEN RAISE EXCEPTION 'Refusing canary claim rollback: 20261029210000 objects still exist; roll back 20261029210000_flow_media_effects first'; END IF;
 -- 20261029190000 (superseding begin; requires the 130000..180000 chain) is newer: roll it back first.
 IF to_regprocedure('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'Refusing canary claim rollback: 20261029190000 objects still exist; roll back 20261029190000_flow_begin_durable_run_superseding first'; END IF;
 -- 20261029180000 (durable button run guards) requires 170000: roll it back first.
 IF split_part(coalesce(obj_description(to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
     ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
  OR split_part(coalesce(obj_description(to_regprocedure('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
     ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
 THEN RAISE EXCEPTION 'Refusing canary claim rollback: 20261029180000 objects still exist; roll back 20261029180000_flow_durable_button_run_guards first'; END IF;
 IF v_fn IS NULL AND v_reg IS NULL AND v_aud IS NULL THEN
  RAISE EXCEPTION '20261029170000_flow_canary_claim_durable not installed; nothing to roll back';
 END IF;
 IF v_fn IS NOT NULL AND obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Refusing to drop unrecognized function public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)';
 END IF;
 IF v_reg IS NOT NULL AND obj_description(v_reg,'pg_class') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Refusing to drop unrecognized table public.automation_flow_canary_accounts';
 END IF;
 IF v_aud IS NOT NULL AND obj_description(v_aud,'pg_class') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Refusing to drop unrecognized table public.automation_flow_canary_claims';
 END IF;
 IF v_reg IS NOT NULL THEN SELECT count(*) INTO v_n_reg FROM public.automation_flow_canary_accounts; END IF;
 IF v_aud IS NOT NULL THEN SELECT count(*) INTO v_n_aud FROM public.automation_flow_canary_claims; END IF;
 IF (v_n_reg>0 OR v_n_aud>0) AND
    current_setting('flow.rollback_170000',true) IS DISTINCT FROM 'discard-canary-data' THEN
  RAISE EXCEPTION 'Refusing canary claim rollback: % canary registration(s) and % canary claim audit row(s) would be lost; export them, then re-run with PGOPTIONS ''-c flow.rollback_170000=discard-canary-data''',
   v_n_reg,v_n_aud;
 END IF;
END $g$;

DROP FUNCTION IF EXISTS public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid);
DROP TABLE IF EXISTS public.automation_flow_canary_claims;
DROP TABLE IF EXISTS public.automation_flow_canary_accounts;
COMMIT;
