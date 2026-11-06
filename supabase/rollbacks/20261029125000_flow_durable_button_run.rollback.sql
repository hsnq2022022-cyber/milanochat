-- REVIEW ONLY rollback for 20261029125000_flow_durable_button_run.
-- NOT applied anywhere by this repository.
--
-- Order: run LAST, after the 20261029190000, 180000, 170000, 160000, 150000,
-- 140000 and 130000 rollbacks (20261029170000 requires these functions in its
-- preflight). Refuses while any object carrying a 130000..190000 ownership
-- marker exists.
--
-- Drops ONLY functions carrying the CREATED_BY_20261029125000_FLOW_DURABLE_BUTTON_RUN
-- marker. Functions installed earlier from
-- supabase/proposals/flow_durable_button_ingress.review.sql (no marker; the
-- migration leaves them unchanged) are never dropped, and neither is the
-- proposal's index flow_one_awaiting_input_per_conversation.
-- No rows are touched: runs/receipts/outbox effects written through these
-- functions are kept (an awaiting_input run simply cannot be resumed until the
-- migration is re-applied). Billing/credits are not referenced.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $rollback$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029125000_FLOW_DURABLE_BUTTON_RUN';
 v_later text;
 v_sig text;
 v_fn regprocedure;
 v_dropped integer := 0;
BEGIN
 -- 20261029210000 (media effects; requires the 130000..190000 chain) is newer: roll it back first.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN(
   to_regprocedure('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)'),
   to_regprocedure('public.flow_reserve_outbox_delivery(uuid,uuid)'),
   to_regprocedure('public.flow_finish_outbox_delivery(uuid,uuid,text,text)'))
  AND md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) IN(
   '94a87bc016ad93e609897025d259bf3e','1b7a6fe3f6a9ee97203d50d5e0e0baa7','1c6ec477519f8c91c24fc2ab82d4b9c4'))
 THEN RAISE EXCEPTION 'Refusing durable button run rollback: 20261029210000 objects still exist; roll back 20261029210000_flow_media_effects first'; END IF;
 -- 20261029190000 (superseding begin; requires the 130000..180000 chain) is newer: roll it back first.
 IF to_regprocedure('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'Refusing durable button run rollback: 20261029190000 objects still exist; roll back 20261029190000_flow_begin_durable_run_superseding first'; END IF;
 -- 20261029180000 replaced these functions' bodies; its rollback restores the 125000 bodies first.
 IF split_part(coalesce(obj_description(to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
     ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
  OR split_part(coalesce(obj_description(to_regprocedure('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
     ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
 THEN RAISE EXCEPTION 'Refusing durable button run rollback: 20261029180000 objects still exist; roll back 20261029180000_flow_durable_button_run_guards first'; END IF;
 SELECT string_agg(DISTINCT d.description,', ' ORDER BY d.description) INTO v_later
 FROM pg_catalog.pg_description d
 WHERE d.description IN(
  'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE',
  'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY',
  'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME',
  'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE',
  'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE');
 IF v_later IS NOT NULL THEN
  RAISE EXCEPTION 'Dependent migrations still installed (%); roll back 20261029170000, 160000, 150000, 140000 and 130000 first', v_later;
 END IF;

 FOREACH v_sig IN ARRAY ARRAY[
  'public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)',
  'public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)'
 ] LOOP
  v_fn := to_regprocedure(v_sig);
  IF v_fn IS NULL THEN
   RAISE NOTICE '% not present; nothing to drop', v_sig;
  ELSIF obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE NOTICE '% was not created by 20261029125000 (marker=%); left in place',
    v_sig, coalesce(obj_description(v_fn,'pg_proc'),'-');
  ELSE
   EXECUTE 'DROP FUNCTION '||v_sig;
   v_dropped := v_dropped+1;
  END IF;
 END LOOP;
 RAISE NOTICE '20261029125000 rollback: % owned function(s) dropped', v_dropped;
END
$rollback$;
COMMIT;
