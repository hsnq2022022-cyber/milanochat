-- REVIEW ONLY rollback for 20261029220000_flow_media_stale_sweep.
-- NOT applied anywhere by this repository.
--
-- Restores the exact 20261029130000 body of public.flow_skip_blocked_outbox
-- (verbatim below; CREATE OR REPLACE keeps the OID, the service_role-only
-- privileges and the 20261029130000 marker, which 220000 never changed). Only
-- the 20261029220000 body (by hash) is replaced; any other body is refused. No
-- row is inserted, updated or deleted. Billing/credits are not referenced.
-- Privileges are not changed.
--
-- Data guard: the restored sweep never cancels 'message_image' effects. The
-- rollback therefore REFUSES while any message_image effect is still pending,
-- retry_wait or leased (it would depend on this sweep to be cancelled when its
-- run ends, its revision is deactivated, its conversation is taken over or it
-- goes stale). Cancel pending/retry_wait ones first, e.g.
--   SELECT public.flow_skip_outbox_effect(tenant_id,id,'manual')
--   FROM public.automation_flow_outbox
--   WHERE effect_kind='message_image' AND delivery_status IN('pending','retry_wait');
-- (per tenant/row as appropriate), and let leased ones finish (the worker's
-- finish turns them into charge_pending / uncertain / dead_letter). Terminal
-- image rows (sent, uncertain, dead_letter, cancelled) do not block.
--
-- Order: turn FLOW_MEDIA_SEND_ENABLED off and revert worker/ingress builds that
-- emit message_image FIRST. Then run this rollback FIRST (20261029220000 is the
-- newest flow migration); required rollback order: 220000, then 20261029210000,
-- 190000, 180000, 170000, 160000, 150000, 140000, 130000, 125000; each of those
-- refuses while the 220000 body is installed.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029220000_FLOW_MEDIA_STALE_SWEEP';
 v_sig constant text := 'public.flow_skip_blocked_outbox(integer,integer)';
 v_h_old constant text := 'dd51c2c354790475e1c840db4084caef';
 v_h_new constant text := 'dacdf7bb582a7d380651d478f47c6b97';
 v_h text;
 v_open bigint := 0;
BEGIN
 -- 20261029220000 is the newest flow migration: no later rollback must run first.
 IF to_regprocedure(v_sig) IS NULL
 OR obj_description(to_regprocedure(v_sig),'pg_proc') IS DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE' THEN
  RAISE EXCEPTION 'Refusing 20261029220000 rollback: % missing or unrecognized', v_sig;
 END IF;
 SELECT md5(btrim(regexp_replace(x.prosrc,'[[:space:]]+',' ','g'))) INTO v_h
 FROM pg_catalog.pg_proc x WHERE x.oid=to_regprocedure(v_sig);
 IF v_h=v_h_old THEN
  RAISE EXCEPTION '20261029220000_flow_media_stale_sweep not installed; nothing to roll back (% has the 20261029130000 body)', v_sig;
 END IF;
 IF v_h IS DISTINCT FROM v_h_new THEN
  RAISE EXCEPTION 'Refusing 20261029220000 rollback: % has neither the 20261029220000 (%) nor the previous body', v_sig, v_marker;
 END IF;
 SELECT count(*) INTO v_open FROM public.automation_flow_outbox
 WHERE effect_kind='message_image' AND delivery_status IN('pending','retry_wait','leased');
 IF v_open>0 THEN
  RAISE EXCEPTION 'Refusing 20261029220000 rollback: % message_image effect(s) still pending/retry_wait/leased depend on this sweep; cancel them first (flow_skip_outbox_effect ... ''manual'') or let leased ones finish', v_open;
 END IF;
END
$g$;

-- 20261029130000 body (verbatim).
CREATE OR REPLACE FUNCTION public.flow_skip_blocked_outbox(
 p_max_age_minutes integer DEFAULT 60,p_limit integer DEFAULT 200)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $skip_many$
DECLARE r record; n integer := 0;
BEGIN
 IF p_max_age_minutes IS NULL OR p_max_age_minutes NOT BETWEEN 5 AND 10080
  OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
 THEN RAISE EXCEPTION 'invalid outbox skip bounds'; END IF;
 FOR r IN
  SELECT q.tenant_id,q.id,q.reason FROM (
   SELECT o.tenant_id,o.id,o.created_at,
    CASE
     WHEN run.ended_reason IS NOT NULL THEN run.ended_reason
     WHEN NOT EXISTS(SELECT 1 FROM public.automation_flow_activations a
       WHERE a.tenant_id=run.tenant_id AND a.channel_account_id=run.channel_account_id
        AND a.platform=run.platform AND a.flow_key=run.flow_key
        AND a.revision=run.publication_revision AND a.is_active)
      THEN 'revision_inactive'
     WHEN public.flow_conversation_human_takeover(run.tenant_id,run.conversation_id)
      THEN 'human_takeover'
     WHEN o.created_at<=now()-make_interval(mins=>p_max_age_minutes) THEN 'stale'
    END AS reason
   FROM public.automation_flow_outbox o
   JOIN public.automation_flow_runs run
    ON run.tenant_id=o.tenant_id AND run.id=o.run_id
   WHERE o.delivery_status IN('pending','retry_wait')
    AND o.effect_kind IN('message','question')
  ) q
  WHERE q.reason IS NOT NULL
  ORDER BY q.created_at,q.id
  LIMIT p_limit
 LOOP
  IF public.flow_skip_outbox_effect(r.tenant_id,r.id,r.reason) THEN
   n := n+1;
  END IF;
 END LOOP;
 RETURN n;
END
$skip_many$;
COMMIT;
