-- REVIEW ONLY. Rollback for 20261029150000_flow_takeover_resume.sql. NOT applied anywhere.
-- Restores flow_conversation_human_takeover and flow_lease_due_runs to the
-- exact 20261029130000 bodies (verbatim below) and drops the two functions
-- added by 150000. Run FIRST: required rollback order is 150000, then
-- 20261029140000_flow_outbox_ai_retry, then 20261029130000_flow_run_lifecycle
-- (both older rollbacks refuse while a 150000 object exists). If
-- 20261029160000_flow_credits_pause is installed, its rollback must run
-- before this one (refused while the 160000 marker is present), and the
-- 20261029170000_flow_canary_claim_durable rollback before that.
--
-- Worker builds do not need to be reverted first: they select only existing
-- columns (human_agent_expires_at, auto_paused_reason) and call no 150000
-- function. The restored 130000 helper reads human_agent_until again (absent
-- on production shapes: expiry ignored, transferred=true always a takeover).
--
-- Data note: runs already ended ('blocked', e.g. ended_reason 'stale') stay
-- terminal; nothing is resurrected. After this rollback, temporarily paused
-- sleeping runs are ENDED again ('ineligible') by the 130000 lease function on
-- the next tick: re-enable auto_reply/agent_enabled first if that matters.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $g$
DECLARE v_name text; v_fn regprocedure; v_seen integer := 0;
BEGIN
 -- Required rollback order: 20261029190000, 20261029180000, 20261029170000, 20261029160000, then this script.
 -- 20261029190000 (superseding begin; requires the 130000..180000 chain) is newer: roll it back first.
 IF to_regprocedure('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'Refusing takeover/resume rollback: 20261029190000 objects still exist; roll back 20261029190000_flow_begin_durable_run_superseding first'; END IF;
 IF split_part(coalesce(obj_description(to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
     ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
  OR split_part(coalesce(obj_description(to_regprocedure('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
     ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
 THEN RAISE EXCEPTION 'Refusing takeover/resume rollback: 20261029180000 objects still exist; roll back 20261029180000_flow_durable_button_run_guards first'; END IF;
 IF to_regprocedure('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)') IS NOT NULL
  OR to_regclass('public.automation_flow_canary_accounts') IS NOT NULL
  OR to_regclass('public.automation_flow_canary_claims') IS NOT NULL
 THEN RAISE EXCEPTION 'Refusing takeover/resume rollback: 20261029170000 objects still exist; roll back 20261029170000_flow_canary_claim_durable first'; END IF;
 IF obj_description(to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)'),'pg_proc')
    IS NOT DISTINCT FROM 'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE'
 THEN RAISE EXCEPTION 'Refusing takeover/resume rollback: 20261029160000 objects still exist; roll back 20261029160000_flow_credits_pause first'; END IF;
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_channel_temporarily_paused(uuid,uuid)',
  'public.flow_end_stale_paused_runs(integer,integer)'
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NOT NULL THEN
   IF obj_description(v_fn,'pg_proc') IS DISTINCT FROM
      'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME' THEN
    RAISE EXCEPTION 'Refusing to drop unrecognized function %', v_name;
   END IF;
   v_seen := v_seen+1;
  END IF;
 END LOOP;
 IF v_seen=0 THEN
  RAISE EXCEPTION '20261029150000_flow_takeover_resume not installed; nothing to roll back';
 END IF;
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_lease_due_runs(integer)',
  'public.flow_conversation_human_takeover(uuid,uuid)'
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM
     'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE' THEN
   RAISE EXCEPTION 'Unrecognized % (expected lifecycle marker); abort', v_name;
  END IF;
 END LOOP;
END $g$;

-- Original 20261029130000 implementations, verbatim.
CREATE OR REPLACE FUNCTION public.flow_conversation_human_takeover(
 p_tenant uuid,p_conversation uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=''
AS $takeover$
DECLARE j jsonb; v_until timestamptz;
BEGIN
 SELECT to_jsonb(c) INTO j FROM public.conversations c
 WHERE c.tenant_id=p_tenant AND c.id=p_conversation;
 IF j IS NULL THEN RETURN true; END IF;
 IF j ? 'transferred' AND jsonb_typeof(j->'transferred')<>'null'
    AND (j->>'transferred') IS DISTINCT FROM 'false' THEN RETURN true; END IF;
 IF j ? 'human_agent_until' AND jsonb_typeof(j->'human_agent_until')<>'null' THEN
  IF jsonb_typeof(j->'human_agent_until')<>'string' THEN RETURN true; END IF;
  BEGIN
   v_until := (j->>'human_agent_until')::timestamptz;
  EXCEPTION WHEN others THEN RETURN true;
  END;
  IF v_until>now() THEN RETURN true; END IF;
 END IF;
 RETURN false;
END
$takeover$;

CREATE OR REPLACE FUNCTION public.flow_lease_due_runs(p_limit integer DEFAULT 20)
RETURNS TABLE(tenant_id uuid,run_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $lease$
DECLARE r record; t uuid; v_attempts integer; v_leased integer := 0;
        v_reason text; j jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN
  RAISE EXCEPTION 'Invalid lease batch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch g
               WHERE g.singleton AND g.enabled)
 THEN RETURN; END IF;
 FOR r IN SELECT run.tenant_id AS t_id,run.id AS r_id,run.channel_account_id,
   run.conversation_id,run.platform,run.flow_key,run.publication_revision
  FROM public.automation_flow_runs run
  JOIN public.automation_flow_tenant_switches x
   ON x.tenant_id=run.tenant_id AND x.enabled
     AND (x.test_only OR (x.production_approved AND run.platform='instagram'))
  WHERE run.run_status='sleeping' AND run.wake_at<=now()
   AND NOT EXISTS(SELECT 1 FROM public.automation_flow_run_leases l
     WHERE l.tenant_id=run.tenant_id AND l.run_id=run.id AND l.expires_at>now())
  ORDER BY run.wake_at,run.id
  FOR UPDATE OF run SKIP LOCKED LIMIT least(p_limit*5,500)
 LOOP
  EXIT WHEN v_leased>=p_limit;
  v_reason := NULL;
  IF NOT EXISTS(SELECT 1 FROM public.automation_flow_activations a
    WHERE a.tenant_id=r.t_id AND a.channel_account_id=r.channel_account_id
     AND a.platform=r.platform AND a.flow_key=r.flow_key
     AND a.revision=r.publication_revision AND a.is_active)
  THEN v_reason := 'revision_inactive'; END IF;
  IF v_reason IS NULL THEN
   SELECT to_jsonb(tn) INTO j FROM public.tenants tn WHERE tn.id=r.t_id;
   IF j IS NULL OR (j ? 'is_active' AND (j->>'is_active') IS DISTINCT FROM 'true')
   THEN v_reason := 'ineligible'; END IF;
  END IF;
  IF v_reason IS NULL THEN
   SELECT to_jsonb(ca) INTO j FROM public.channel_accounts ca
   WHERE ca.tenant_id=r.t_id AND ca.id=r.channel_account_id;
   IF j IS NULL
    OR (j ? 'is_active' AND (j->>'is_active') IS DISTINCT FROM 'true')
    OR (j ? 'agent_enabled' AND (j->>'agent_enabled') IS DISTINCT FROM 'true')
    OR (j ? 'auto_reply' AND (j->>'auto_reply') IS DISTINCT FROM 'true')
   THEN v_reason := 'ineligible'; END IF;
  END IF;
  IF v_reason IS NULL THEN
   SELECT to_jsonb(c) INTO j FROM public.conversations c
   WHERE c.tenant_id=r.t_id AND c.id=r.conversation_id;
   IF j IS NULL OR (j->>'account_id') IS DISTINCT FROM r.channel_account_id::text
   THEN v_reason := 'ineligible';
   ELSIF public.flow_conversation_human_takeover(r.t_id,r.conversation_id)
   THEN v_reason := 'human_takeover';
   END IF;
  END IF;
  IF v_reason IS NOT NULL THEN
   PERFORM public.flow_cancel_run(r.t_id,r.r_id,v_reason,'sleeping');
   CONTINUE;
  END IF;

  t := NULL; v_attempts := NULL;
  INSERT INTO public.automation_flow_run_leases(tenant_id,run_id,token,expires_at,attempts)
  VALUES(r.t_id,r.r_id,gen_random_uuid(),now()+interval '2 minutes',1)
  ON CONFLICT ON CONSTRAINT automation_flow_run_leases_pkey DO UPDATE
  SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at,
      attempts=public.automation_flow_run_leases.attempts+1
  WHERE public.automation_flow_run_leases.expires_at<=now()
  RETURNING public.automation_flow_run_leases.token,
            public.automation_flow_run_leases.attempts INTO t,v_attempts;
  IF t IS NULL THEN CONTINUE; END IF;
  IF v_attempts>3 THEN
   PERFORM public.flow_cancel_run(r.t_id,r.r_id,'lease_exhausted','sleeping');
   CONTINUE;
  END IF;
  v_leased := v_leased+1;
  RETURN QUERY SELECT r.t_id,r.r_id,t;
 END LOOP;
END
$lease$;

COMMENT ON FUNCTION public.flow_conversation_human_takeover(uuid,uuid)
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
COMMENT ON FUNCTION public.flow_lease_due_runs(integer)
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
REVOKE ALL ON FUNCTION public.flow_conversation_human_takeover(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_lease_due_runs(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_conversation_human_takeover(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_lease_due_runs(integer) TO service_role;

DROP FUNCTION IF EXISTS public.flow_end_stale_paused_runs(integer,integer);
DROP FUNCTION IF EXISTS public.flow_channel_temporarily_paused(uuid,uuid);
COMMIT;
