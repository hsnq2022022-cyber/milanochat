-- REVIEW ONLY: Registry-held durable wakes must not consume lease attempts.
-- NOT applied anywhere by this repository; apply only with an explicit owner GO.
-- Never `supabase db push`.
--
-- Problem. flow_lease_due_runs leases a due sleeping run BEFORE the worker checks the
-- operator registry (automation_flow_canary_accounts). A production run whose registry
-- row is missing was leased, refused by the worker, and its lease left to expire; every
-- re-lease adds 1 to automation_flow_run_leases.attempts and the 4th lease ends the run
-- as 'lease_exhausted' (about 6 minutes), and the Outbox sweep then cancels its pending
-- messages with that reason. Removing the registry row therefore CANCELLED work instead of
-- holding it, and held runs also occupied the lease batch (head-of-line blocking).
--
-- Change (two functions replaced, one added; no table, column, constraint or row changes):
--  1. NEW public.flow_registry_blocks_run(p_tenant,p_account,p_platform) RETURNS boolean,
--     STABLE, SECURITY INVOKER: true only for a PRODUCTION run (the tenant switch is not
--     test_only) on instagram/facebook whose exact (tenant, account, platform) is NOT in
--     automation_flow_canary_accounts. Same question flow_claim_inbound_durable asks.
--     Every other platform (whatsapp) and every test_only tenant: false (unchanged).
--  2. flow_lease_due_runs: the candidate scan also excludes registry-blocked runs, so they
--     are never leased, never consume attempts, and never occupy the batch (the same way
--     temporarily paused channels already are). They stay 'sleeping' and resume on the
--     first tick after the row is registered again.
--  3. flow_end_stale_paused_runs: a registry-blocked run counts as paused, so the existing
--     24 hour bound (wake_at + p_max_age_minutes) still ends it as 'stale' instead of
--     leaving it forever.
-- Everything else in both bodies is byte-for-byte the 20261029230000 body.
--
-- Guards: each replaced function must be the recognised 20261029230000 body (md5 of the
-- whitespace-normalised prosrc) or this migration's own body (idempotent re-run); a
-- drifted body (for example a different production definition) aborts the migration.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $guard$
DECLARE r record; v_fn regprocedure; p record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.flow_end_stale_paused_runs(integer,integer)','c7a764911307aefeb1f593312364d440','3c73a9a945101b64b6fcf7696546bb25'),
  ('public.flow_lease_due_runs(integer)','7cddbd9a4964716eec402f399e878a78','71ad64971138c2b5dd24d785df20aec6')
 ) f(sig,h_old,h_new) LOOP
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL THEN
   RAISE EXCEPTION 'Missing %; apply 20261029230000_flow_multichannel_support first', r.sig;
  END IF;
  SELECT x.* INTO p FROM pg_catalog.pg_proc x WHERE x.oid=v_fn;
  IF md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) NOT IN(r.h_old,r.h_new) THEN
   RAISE EXCEPTION 'Unrecognized body of %; refusing to replace it', r.sig;
  END IF;
 END LOOP;
 IF to_regclass('public.automation_flow_canary_accounts') IS NULL THEN
  RAISE EXCEPTION 'Missing public.automation_flow_canary_accounts; apply 20261029170000 first';
 END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.flow_registry_blocks_run(
 p_tenant uuid,p_account uuid,p_platform text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $blocks$
 SELECT p_platform IN('instagram','facebook')
  AND NOT coalesce((SELECT x.test_only FROM public.automation_flow_tenant_switches x
                     WHERE x.tenant_id=p_tenant),false)
  AND NOT EXISTS(SELECT 1 FROM public.automation_flow_canary_accounts g
                  WHERE g.tenant_id=p_tenant AND g.channel_account_id=p_account
                    AND g.platform=p_platform)
$blocks$;
COMMENT ON FUNCTION public.flow_registry_blocks_run(uuid,uuid,text)
 IS 'CREATED_BY_20261115160000_FLOW_REGISTRY_WAKE_HOLD';

-- flow_end_stale_paused_runs: 20261029230000 body plus one predicate (registry-blocked counts as paused).
CREATE OR REPLACE FUNCTION public.flow_end_stale_paused_runs(
 p_max_age_minutes integer DEFAULT 1440,p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $stale$
DECLARE r record; n integer := 0; v_age integer; v_limit integer;
BEGIN
 v_age := least(greatest(coalesce(p_max_age_minutes,1440),60),10080);
 v_limit := least(greatest(coalesce(p_limit,100),1),500);
 FOR r IN
  SELECT run.tenant_id,run.id
  FROM public.automation_flow_runs run
  WHERE run.run_status='sleeping'
   AND run.wake_at<=now()-make_interval(mins=>v_age)
   AND NOT EXISTS(SELECT 1 FROM public.automation_flow_run_leases l
     WHERE l.tenant_id=run.tenant_id AND l.run_id=run.id AND l.expires_at>now())
   AND (public.flow_channel_temporarily_paused(run.tenant_id,run.channel_account_id)
    OR public.flow_registry_blocks_run(run.tenant_id,run.channel_account_id,run.platform)
    OR NOT EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches x
     WHERE x.tenant_id=run.tenant_id AND x.enabled
      AND (x.test_only OR (x.production_approved AND run.platform IN('instagram','whatsapp','facebook')))))
  ORDER BY run.wake_at,run.id
  FOR UPDATE OF run SKIP LOCKED
  LIMIT v_limit
 LOOP
  IF public.flow_cancel_run(r.tenant_id,r.id,'stale','sleeping') THEN
   n := n+1;
  END IF;
 END LOOP;
 RETURN n;
END
$stale$;

-- flow_lease_due_runs: 20261029230000 body plus one predicate (registry-blocked runs are never leased).
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
 PERFORM public.flow_end_stale_paused_runs(1440,100);
 FOR r IN SELECT run.tenant_id AS t_id,run.id AS r_id,run.channel_account_id,
   run.conversation_id,run.platform,run.flow_key,run.publication_revision
  FROM public.automation_flow_runs run
  JOIN public.automation_flow_tenant_switches x
   ON x.tenant_id=run.tenant_id AND x.enabled
     AND (x.test_only OR (x.production_approved AND run.platform IN('instagram','whatsapp','facebook')))
  WHERE run.run_status='sleeping' AND run.wake_at<=now()
   AND NOT EXISTS(SELECT 1 FROM public.automation_flow_run_leases l
     WHERE l.tenant_id=run.tenant_id AND l.run_id=run.id AND l.expires_at>now())
   AND NOT public.flow_channel_temporarily_paused(run.tenant_id,run.channel_account_id)
   AND NOT public.flow_registry_blocks_run(run.tenant_id,run.channel_account_id,run.platform)
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
  IF v_reason IS NULL AND NOT EXISTS(SELECT 1 FROM public.tenants tn WHERE tn.id=r.t_id)
  THEN v_reason := 'ineligible'; END IF;
  IF v_reason IS NULL AND NOT EXISTS(SELECT 1 FROM public.channel_accounts ca
    WHERE ca.tenant_id=r.t_id AND ca.id=r.channel_account_id)
  THEN v_reason := 'ineligible'; END IF;
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
  -- Temporary pause that appeared after the scan: leave sleeping, no lease.
  IF public.flow_channel_temporarily_paused(r.t_id,r.channel_account_id) THEN
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

-- Ownership markers of the two replaced functions are unchanged (150000 / 130000 markers).
REVOKE ALL ON FUNCTION public.flow_registry_blocks_run(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_end_stale_paused_runs(integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_lease_due_runs(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_registry_blocks_run(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_end_stale_paused_runs(integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_lease_due_runs(integer) TO service_role;
COMMIT;
