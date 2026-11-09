-- REVIEW ONLY: canonical human-takeover column and resumable pauses for durable
-- Flow runs. NOT applied anywhere.
-- Depends on 20261029130000_flow_run_lifecycle.sql and
-- 20261029140000_flow_outbox_ai_retry.sql (preflight refuses otherwise).
-- Rollback: supabase/rollbacks/20261029150000_flow_takeover_resume.rollback.sql
-- (order: 150000, then 140000, then 130000).
--
-- (1) Canonical takeover expiry is conversations.human_agent_expires_at
--     (supabase/human_agent_migration.sql, human_agent_timeout_migration.sql,
--     milan-api, server dashboard). No schema file creates human_agent_until;
--     human_agent_migration.sql documents the name mismatch. The 130000 helper
--     read human_agent_until, so a takeover expiry was never honoured.
--     flow_conversation_human_takeover now follows milan-api's rule
--     (index.ts lazy expiry): active while transferred is true, except once
--     human_agent_expires_at has passed for a 'manual_takeover' (the only case
--     milan-api releases automatically; e.g. 'ai_handoff' stays a takeover
--     until a human releases it). Missing conversation or malformed values
--     fail closed (true), as before.
-- (2) flow_lease_due_runs no longer ENDS runs on TEMPORARY conditions
--     (tenants.is_active, channel_accounts.is_active/agent_enabled/auto_reply
--     false). Those runs stay 'sleeping', are not leased, are excluded from the
--     scan window (no head-of-line blocking) and resume when re-enabled.
--     PERMANENT conditions still end the run: revision inactive/gone, tenant or
--     account row gone, conversation gone or owned by another account, and
--     human takeover ('human_takeover', unchanged by design: a run is not
--     resumed behind an agent who took over).
-- (3) Bounded safeguard: flow_end_stale_paused_runs ends runs that stayed
--     paused (temporary condition or tenant switch/approval gate) longer than
--     p_max_age_minutes (default 1440, clamped to 60..10080) past wake_at, with
--     reason 'stale'. flow_lease_due_runs calls it with the default on every
--     tick while the global switch is on (global OFF freezes everything).
--
-- Additive and idempotent: CREATE OR REPLACE functions only, same signatures
-- and return shapes; no column, constraint, row or status CHECK is changed
-- by the migration itself. The two replaced functions keep their 130000
-- ownership marker (the 140000/130000 rollbacks recognise them by it); the
-- two new functions carry the 150000 marker, which the older rollbacks use to
-- refuse running out of order. No cron, Vault, secrets or network calls.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_name text;
 v_fn regprocedure;
 v_lc constant text := 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
 v_ai constant text := 'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY';
 v_marker constant text := 'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME';
BEGIN
 FOREACH v_name IN ARRAY ARRAY[
  'automation_flow_runs','automation_flow_outbox','automation_flow_run_leases',
  'automation_flow_activations','automation_flow_global_switch',
  'automation_flow_tenant_switches','tenants','channel_accounts','conversations'
 ] LOOP
  IF to_regclass('public.'||v_name) IS NULL THEN
   RAISE EXCEPTION 'Takeover/resume prerequisite missing: %', v_name;
  END IF;
 END LOOP;
 -- 20261029130000 objects (exact ownership marker).
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_lease_due_runs(integer)',
  'public.flow_conversation_human_takeover(uuid,uuid)',
  'public.flow_cancel_run(uuid,uuid,text,text)',
  'public.flow_skip_blocked_outbox(integer,integer)'
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_lc THEN
   RAISE EXCEPTION 'Missing or unrecognized 20261029130000 object %; apply 20261029130000_flow_run_lifecycle first', v_name;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='automation_flow_runs'
      AND column_name IN ('ended_reason','ended_at'))<>2
  OR NOT EXISTS(SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='automation_flow_run_leases'
      AND column_name='attempts')
  OR NOT EXISTS(SELECT 1 FROM pg_constraint
     WHERE conrelid='public.automation_flow_runs'::regclass
      AND conname='automation_flow_runs_ended_reason_chk'
      AND position('''stale''' IN pg_get_constraintdef(oid))>0
      AND position('''human_takeover''' IN pg_get_constraintdef(oid))>0)
 THEN RAISE EXCEPTION 'Missing 20261029130000 columns/constraints; apply 20261029130000_flow_run_lifecycle first';
 END IF;
 -- 20261029140000 objects.
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_claim_outbox_ai(uuid,uuid,integer,integer)',
  'public.flow_store_outbox_ai_answer(uuid,uuid,uuid,text)',
  'public.flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer)'
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_ai THEN
   RAISE EXCEPTION 'Missing or unrecognized 20261029140000 object %; apply 20261029140000_flow_outbox_ai_retry first', v_name;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='automation_flow_outbox'
     AND column_name='ai_attempts')
 THEN RAISE EXCEPTION 'Missing 20261029140000 columns; apply 20261029140000_flow_outbox_ai_retry first';
 END IF;
 -- Never take over unrelated objects that merely share a name.
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_channel_temporarily_paused(uuid,uuid)',
  'public.flow_end_stale_paused_runs(integer,integer)'
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NOT NULL AND obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'Unrecognized existing function %', v_name;
  END IF;
 END LOOP;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- (1) Human takeover probe on the canonical columns. Optional columns are
-- read dynamically through to_jsonb(row). Missing conversation, non-boolean
-- transferred, or a non-string/unparsable expiry fail closed (true).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flow_conversation_human_takeover(
 p_tenant uuid,p_conversation uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=''
AS $takeover$
DECLARE j jsonb; v_until timestamptz;
BEGIN
 SELECT to_jsonb(c) INTO j FROM public.conversations c
 WHERE c.tenant_id=p_tenant AND c.id=p_conversation;
 IF j IS NULL THEN RETURN true; END IF;
 IF NOT (j ? 'transferred') OR jsonb_typeof(j->'transferred')='null' THEN RETURN false; END IF;
 IF jsonb_typeof(j->'transferred')<>'boolean' THEN RETURN true; END IF;
 IF (j->>'transferred')='false' THEN RETURN false; END IF;
 -- transferred = true
 IF NOT (j ? 'human_agent_expires_at')
    OR jsonb_typeof(j->'human_agent_expires_at')='null' THEN RETURN true; END IF;
 IF jsonb_typeof(j->'human_agent_expires_at')<>'string' THEN RETURN true; END IF;
 BEGIN
  v_until := (j->>'human_agent_expires_at')::timestamptz;
 EXCEPTION WHEN others THEN RETURN true;
 END;
 IF v_until IS NULL OR v_until>now() THEN RETURN true; END IF;
 -- Expired: released only where milan-api releases it lazily.
 RETURN (j->>'auto_paused_reason') IS DISTINCT FROM 'manual_takeover';
END
$takeover$;

-- ---------------------------------------------------------------------------
-- Temporary pause probe: true when the tenant row exists and is not active,
-- or the tenant's account row exists and is inactive / agent_enabled off /
-- auto_reply off. Missing rows return false (they are PERMANENT conditions
-- handled by flow_lease_due_runs). Optional live-only columns read through
-- to_jsonb(row); a present but non-true value counts as paused.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- (3) Bounded safeguard: end sleeping runs paused for longer than the
-- maximum age past their wake time. "Paused" = temporary pause above, or the
-- tenant switch/approval gate does not admit the run. Bounds are clamped
-- (60..10080 minutes, 1..500 rows). Runs holding a live lease are skipped.
-- ---------------------------------------------------------------------------
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
    OR NOT EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches x
     WHERE x.tenant_id=run.tenant_id AND x.enabled
      AND (x.test_only OR (x.production_approved AND run.platform='instagram'))))
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

-- ---------------------------------------------------------------------------
-- (2) Lease due runs. Same signature and return shape as 20261029130000.
-- Changes vs 130000: temporarily paused runs are excluded before LIMIT and
-- left untouched (re-checked per row: a pause that appears mid-batch also
-- skips without ending); the stale safeguard runs first. Everything else
-- (live-lease exclusion, permanent endings, lease_exhausted) is unchanged.
-- ---------------------------------------------------------------------------
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
     AND (x.test_only OR (x.production_approved AND run.platform='instagram'))
  WHERE run.run_status='sleeping' AND run.wake_at<=now()
   AND NOT EXISTS(SELECT 1 FROM public.automation_flow_run_leases l
     WHERE l.tenant_id=run.tenant_id AND l.run_id=run.id AND l.expires_at>now())
   AND NOT public.flow_channel_temporarily_paused(run.tenant_id,run.channel_account_id)
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

-- ---------------------------------------------------------------------------
-- Ownership markers and privileges: service_role only.
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION public.flow_conversation_human_takeover(uuid,uuid)
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
COMMENT ON FUNCTION public.flow_lease_due_runs(integer)
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
COMMENT ON FUNCTION public.flow_channel_temporarily_paused(uuid,uuid)
 IS 'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME';
COMMENT ON FUNCTION public.flow_end_stale_paused_runs(integer,integer)
 IS 'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME';

REVOKE ALL ON FUNCTION public.flow_conversation_human_takeover(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_lease_due_runs(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_channel_temporarily_paused(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_end_stale_paused_runs(integer,integer) FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION public.flow_conversation_human_takeover(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_lease_due_runs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_channel_temporarily_paused(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_end_stale_paused_runs(integer,integer) TO service_role;
COMMIT;
