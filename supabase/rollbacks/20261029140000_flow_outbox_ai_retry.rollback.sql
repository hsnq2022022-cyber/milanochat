-- REVIEW ONLY rollback for 20261029140000_flow_outbox_ai_retry.sql. NOT applied anywhere.
-- Run AFTER rolling back 20261029150000_flow_takeover_resume.sql (refused while
-- a 150000 object exists) and BEFORE rolling back
-- 20261029130000_flow_run_lifecycle.sql, and only after
-- the outbox worker build that calls flow_claim_outbox_ai is disabled/reverted
-- (without these functions that build reports knowledge_ai effects as
-- "blocked" and never sends them; non-AI effects are unaffected).
--
-- Data handling (no row is deleted):
--  * retry_wait rows that were waiting on an AI backoff go back to 'pending'
--    (retry_at cleared) so the previous worker can process them again.
--  * cancel_reason values introduced here are mapped to 'manual' so the
--    original lifecycle CHECK can be restored; delivery_status is unchanged
--    (dead_letter stays dead_letter, cancelled stays cancelled).
--  * the ai_* columns (attempt count, last error code, claim lease, encrypted
--    cached answer) are dropped. retry_at is pre-existing and kept.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $guard$
DECLARE v_name text; v_fn regprocedure;
BEGIN
 -- Required rollback order: 20261029190000, 20261029180000, 20261029170000, 20261029160000, 20261029150000, then this script, then 130000.
 -- 20261029220000 (media stale sweep; requires 210000) is newer: roll it back first.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.flow_skip_blocked_outbox(integer,integer)')
  AND md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g')))='dacdf7bb582a7d380651d478f47c6b97')
 THEN RAISE EXCEPTION 'Refusing AI retry rollback: 20261029220000 objects still exist; roll back 20261029220000_flow_media_stale_sweep first'; END IF;
 -- 20261029210000 (media effects; requires the 130000..190000 chain) is newer: roll it back first.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN(
   to_regprocedure('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)'),
   to_regprocedure('public.flow_reserve_outbox_delivery(uuid,uuid)'),
   to_regprocedure('public.flow_finish_outbox_delivery(uuid,uuid,text,text)'))
  AND md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) IN(
   '94a87bc016ad93e609897025d259bf3e','1b7a6fe3f6a9ee97203d50d5e0e0baa7','1c6ec477519f8c91c24fc2ab82d4b9c4'))
 THEN RAISE EXCEPTION 'Refusing AI retry rollback: 20261029210000 objects still exist; roll back 20261029210000_flow_media_effects first'; END IF;
 -- 20261029190000 (superseding begin; requires the 130000..180000 chain) is newer: roll it back first.
 IF to_regprocedure('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'Refusing AI retry rollback: 20261029190000 objects still exist; roll back 20261029190000_flow_begin_durable_run_superseding first'; END IF;
 IF split_part(coalesce(obj_description(to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
     ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
  OR split_part(coalesce(obj_description(to_regprocedure('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
     ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
 THEN RAISE EXCEPTION 'Refusing AI retry rollback: 20261029180000 objects still exist; roll back 20261029180000_flow_durable_button_run_guards first'; END IF;
 IF to_regprocedure('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)') IS NOT NULL
  OR to_regclass('public.automation_flow_canary_accounts') IS NOT NULL
  OR to_regclass('public.automation_flow_canary_claims') IS NOT NULL
 THEN RAISE EXCEPTION 'Refusing AI retry rollback: 20261029170000 objects still exist; roll back 20261029170000_flow_canary_claim_durable first'; END IF;
 IF obj_description(to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)'),'pg_proc')
    IS NOT DISTINCT FROM 'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE'
 THEN RAISE EXCEPTION 'Refusing AI retry rollback: 20261029160000 objects still exist; roll back 20261029160000_flow_credits_pause first'; END IF;
 IF to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)') IS NOT NULL
  OR to_regprocedure('public.flow_end_stale_paused_runs(integer,integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'Refusing AI retry rollback: 20261029150000 objects still exist; roll back 20261029150000_flow_takeover_resume first'; END IF;
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_claim_outbox_ai(uuid,uuid,integer,integer)',
  'public.flow_store_outbox_ai_answer(uuid,uuid,uuid,text)',
  'public.flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer)'
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NOT NULL AND obj_description(v_fn,'pg_proc') IS DISTINCT FROM
     'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY' THEN
   RAISE EXCEPTION 'Refusing to drop unrecognized function %', v_name;
  END IF;
 END LOOP;
END
$guard$;

DROP FUNCTION IF EXISTS public.flow_claim_outbox_ai(uuid,uuid,integer,integer);
DROP FUNCTION IF EXISTS public.flow_store_outbox_ai_answer(uuid,uuid,uuid,text);
DROP FUNCTION IF EXISTS public.flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer);

DO $data$
BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
   AND table_name='automation_flow_outbox' AND column_name='ai_attempts') THEN
  UPDATE public.automation_flow_outbox
  SET delivery_status='pending',retry_at=NULL
  WHERE delivery_status='retry_wait' AND ai_attempts>0;
 END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
   AND table_name='automation_flow_outbox' AND column_name='cancel_reason') THEN
  UPDATE public.automation_flow_outbox SET cancel_reason='manual'
  WHERE cancel_reason IN('no_knowledge','ai_unavailable','ai_retries_exhausted');
  ALTER TABLE public.automation_flow_outbox
   DROP CONSTRAINT IF EXISTS automation_flow_outbox_cancel_reason_chk;
  ALTER TABLE public.automation_flow_outbox
   ADD CONSTRAINT automation_flow_outbox_cancel_reason_chk CHECK(
    cancel_reason IS NULL OR cancel_reason IN(
     'input_timeout','stale','free_text','revision_inactive','superseded',
     'ineligible','human_takeover','lease_exhausted','duplicate_active','manual'));
 END IF;
END
$data$;

ALTER TABLE public.automation_flow_outbox
 DROP CONSTRAINT IF EXISTS automation_flow_outbox_ai_state_chk;
ALTER TABLE public.automation_flow_outbox
 DROP COLUMN IF EXISTS ai_answer_encrypted,
 DROP COLUMN IF EXISTS ai_lease_expires_at,
 DROP COLUMN IF EXISTS ai_lease_token,
 DROP COLUMN IF EXISTS ai_last_error_code,
 DROP COLUMN IF EXISTS ai_attempts;
COMMIT;
