-- REVIEW ONLY. Rollback for 20261029130000_flow_run_lifecycle.sql.
-- Restores flow_lease_due_runs to the exact 20261028225000 body and removes
-- every object added by the lifecycle migration.
--
-- Data note: runs already ended ('blocked') and outbox rows already skipped
-- ('cancelled') STAY terminal; they are intentionally not resurrected, so
-- no stale message can be sent because of a rollback. Dropping the added
-- columns discards only the audit fields ended_reason/ended_at,
-- cancel_reason/cancelled_at and the lease attempts counter.
--
-- Order: 20261029140000_flow_outbox_ai_retry depends on this migration
-- (cancel_reason, flow_skip_outbox_effect). Its rollback must run FIRST; this
-- script refuses to run while any 140000 object is still present.
-- 20261029150000_flow_takeover_resume depends on both; full order is 150000,
-- then 140000, then this script (refused while a 150000 object exists).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $g$
DECLARE v_fn regprocedure;
BEGIN
 -- Required rollback order: 20261029190000, 20261029180000, 20261029170000, 20261029160000, 20261029150000, then 20261029140000, then this.
 -- 20261029190000 (superseding begin; requires the 130000..180000 chain) is newer: roll it back first.
 IF to_regprocedure('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'Refusing lifecycle rollback: 20261029190000 objects still exist; roll back 20261029190000_flow_begin_durable_run_superseding first'; END IF;
 IF split_part(coalesce(obj_description(to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
     ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
  OR split_part(coalesce(obj_description(to_regprocedure('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
     ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
 THEN RAISE EXCEPTION 'Refusing lifecycle rollback: 20261029180000 objects still exist; roll back 20261029180000_flow_durable_button_run_guards first'; END IF;
 IF to_regprocedure('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)') IS NOT NULL
  OR to_regclass('public.automation_flow_canary_accounts') IS NOT NULL
  OR to_regclass('public.automation_flow_canary_claims') IS NOT NULL
 THEN RAISE EXCEPTION 'Refusing lifecycle rollback: 20261029170000 objects still exist; roll back 20261029170000_flow_canary_claim_durable first'; END IF;
 IF obj_description(to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)'),'pg_proc')
    IS NOT DISTINCT FROM 'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE'
 THEN RAISE EXCEPTION 'Refusing lifecycle rollback: 20261029160000 objects still exist; roll back 20261029160000_flow_credits_pause first'; END IF;
 IF to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)') IS NOT NULL
  OR to_regprocedure('public.flow_end_stale_paused_runs(integer,integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'Refusing lifecycle rollback: 20261029150000 objects still exist; roll back 20261029150000_flow_takeover_resume first'; END IF;
 IF to_regprocedure('public.flow_claim_outbox_ai(uuid,uuid,integer,integer)') IS NOT NULL
  OR to_regprocedure('public.flow_store_outbox_ai_answer(uuid,uuid,uuid,text)') IS NOT NULL
  OR to_regprocedure('public.flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer)') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid=to_regclass('public.automation_flow_outbox') AND NOT attisdropped
    AND attname IN('ai_attempts','ai_last_error_code','ai_lease_token','ai_lease_expires_at','ai_answer_encrypted'))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint
   WHERE conrelid=to_regclass('public.automation_flow_outbox') AND conname='automation_flow_outbox_ai_state_chk')
 THEN RAISE EXCEPTION 'Refusing lifecycle rollback: 20261029140000 objects still exist; roll back 20261029140000_flow_outbox_ai_retry first'; END IF;
 v_fn := to_regprocedure('public.flow_lease_due_runs(integer)');
 IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM
    'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'
 THEN RAISE EXCEPTION 'Lifecycle migration not installed or unrecognized; abort'; END IF;
 IF to_regclass('public.flow_one_active_run_per_conversation') IS NOT NULL AND
    obj_description(to_regclass('public.flow_one_active_run_per_conversation'))
     IS DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'
 THEN RAISE EXCEPTION 'Unrecognized active-run index; abort'; END IF;
END $g$;

DROP TRIGGER IF EXISTS flow_one_active_run_guard ON public.automation_flow_runs;
DROP INDEX IF EXISTS public.flow_one_active_run_per_conversation;
DROP INDEX IF EXISTS public.automation_flow_runs_waiting_idx;

-- Original 20261028225000 implementation, verbatim.
CREATE OR REPLACE FUNCTION public.flow_lease_due_runs(p_limit integer DEFAULT 20)
RETURNS TABLE(tenant_id uuid,run_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $lease$
DECLARE r record; t uuid;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN
  RAISE EXCEPTION 'Invalid lease batch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch WHERE singleton AND enabled)
 THEN RETURN; END IF;
 FOR r IN SELECT run.tenant_id,run.id
  FROM public.automation_flow_runs run
  JOIN public.automation_flow_tenant_switches x
   ON x.tenant_id=run.tenant_id AND x.enabled
     AND (x.test_only OR (x.production_approved AND run.platform='instagram'))
  WHERE run.run_status='sleeping' AND run.wake_at<=now()
  ORDER BY run.wake_at,run.id
  FOR UPDATE OF run SKIP LOCKED LIMIT p_limit
 LOOP
  t:=NULL;
  INSERT INTO public.automation_flow_run_leases(tenant_id,run_id,token,expires_at)
  VALUES(r.tenant_id,r.id,gen_random_uuid(),now()+interval '2 minutes')
  ON CONFLICT ON CONSTRAINT automation_flow_run_leases_pkey DO UPDATE
  SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at
  WHERE public.automation_flow_run_leases.expires_at<=now()
  RETURNING token INTO t;
  IF t IS NOT NULL THEN
   RETURN QUERY SELECT r.tenant_id,r.id,t;
  END IF;
 END LOOP;
END $lease$;
COMMENT ON FUNCTION public.flow_lease_due_runs(integer) IS 'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE';
REVOKE ALL ON FUNCTION public.flow_lease_due_runs(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_lease_due_runs(integer) TO service_role;

DROP FUNCTION IF EXISTS public.flow_resolve_duplicate_active_runs(integer);
DROP FUNCTION IF EXISTS public.flow_skip_blocked_outbox(integer,integer);
DROP FUNCTION IF EXISTS public.flow_skip_outbox_effect(uuid,uuid,text);
DROP FUNCTION IF EXISTS public.flow_expire_waiting_runs(integer,integer);
DROP FUNCTION IF EXISTS public.flow_cancel_run(uuid,uuid,text,text);
DROP FUNCTION IF EXISTS public.flow_conversation_human_takeover(uuid,uuid);
DROP FUNCTION IF EXISTS public.flow_guard_one_active_run();

ALTER TABLE public.automation_flow_outbox
 DROP CONSTRAINT IF EXISTS automation_flow_outbox_cancel_reason_chk,
 DROP COLUMN IF EXISTS cancel_reason,
 DROP COLUMN IF EXISTS cancelled_at;
ALTER TABLE public.automation_flow_runs
 DROP CONSTRAINT IF EXISTS automation_flow_runs_ended_reason_chk,
 DROP COLUMN IF EXISTS ended_reason,
 DROP COLUMN IF EXISTS ended_at;
ALTER TABLE public.automation_flow_run_leases
 DROP COLUMN IF EXISTS attempts;
COMMIT;
