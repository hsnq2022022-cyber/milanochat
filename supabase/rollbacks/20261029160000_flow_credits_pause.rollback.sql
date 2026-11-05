-- REVIEW ONLY. Rollback for 20261029160000_flow_credits_pause.sql. NOT applied anywhere.
-- Restores flow_channel_temporarily_paused to the exact 20261029150000 body
-- (verbatim below) and its 150000 ownership marker. Run FIRST: required
-- rollback order is 160000, then 20261029150000_flow_takeover_resume, then
-- 20261029140000_flow_outbox_ai_retry, then 20261029130000_flow_run_lifecycle
-- (the older rollbacks refuse while the 160000 marker is present). If
-- 20261029170000_flow_canary_claim_durable is installed, its rollback must run
-- before this one (refused while any 170000 object exists).
--
-- Worker builds do not need to be reverted: they call no 160000 object.
-- Data note: no row is changed. After this rollback, sleeping runs of tenants
-- with credits_remaining <= 0 are leased again; their messages stay pending
-- (outbox send gate) and are cancelled as 'stale' after 60 minutes.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $g$
DECLARE v_fn regprocedure;
BEGIN
 -- Required rollback order: 20261029180000, 20261029170000, then this script.
 IF split_part(coalesce(obj_description(to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
     ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
  OR split_part(coalesce(obj_description(to_regprocedure('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
     ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
 THEN RAISE EXCEPTION 'Refusing credits pause rollback: 20261029180000 objects still exist; roll back 20261029180000_flow_durable_button_run_guards first'; END IF;
 IF to_regprocedure('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)') IS NOT NULL
  OR to_regclass('public.automation_flow_canary_accounts') IS NOT NULL
  OR to_regclass('public.automation_flow_canary_claims') IS NOT NULL
 THEN RAISE EXCEPTION 'Refusing credits pause rollback: 20261029170000 objects still exist; roll back 20261029170000_flow_canary_claim_durable first'; END IF;
 v_fn := to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)');
 IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS NOT DISTINCT FROM
    'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME' THEN
  RAISE EXCEPTION '20261029160000_flow_credits_pause not installed; nothing to roll back';
 END IF;
 IF obj_description(v_fn,'pg_proc') IS DISTINCT FROM
    'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE' THEN
  RAISE EXCEPTION 'Refusing to replace unrecognized function public.flow_channel_temporarily_paused(uuid,uuid)';
 END IF;
END $g$;

-- Original 20261029150000 implementation, verbatim.
CREATE OR REPLACE FUNCTION public.flow_channel_temporarily_paused(
 p_tenant uuid,p_account uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=''
AS $paused$
DECLARE j jsonb;
BEGIN
 SELECT to_jsonb(tn) INTO j FROM public.tenants tn WHERE tn.id=p_tenant;
 IF j IS NOT NULL AND j ? 'is_active' AND (j->>'is_active') IS DISTINCT FROM 'true'
 THEN RETURN true; END IF;
 SELECT to_jsonb(ca) INTO j FROM public.channel_accounts ca
 WHERE ca.tenant_id=p_tenant AND ca.id=p_account;
 IF j IS NOT NULL AND (
     (j ? 'is_active' AND (j->>'is_active') IS DISTINCT FROM 'true')
  OR (j ? 'agent_enabled' AND (j->>'agent_enabled') IS DISTINCT FROM 'true')
  OR (j ? 'auto_reply' AND (j->>'auto_reply') IS DISTINCT FROM 'true'))
 THEN RETURN true; END IF;
 RETURN false;
END
$paused$;

COMMENT ON FUNCTION public.flow_channel_temporarily_paused(uuid,uuid)
 IS 'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME';
REVOKE ALL ON FUNCTION public.flow_channel_temporarily_paused(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_channel_temporarily_paused(uuid,uuid) TO service_role;
COMMIT;
