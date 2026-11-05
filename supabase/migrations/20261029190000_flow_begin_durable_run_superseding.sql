-- REVIEW ONLY: atomic supersede + start for the V3 durable Instagram path.
-- NOT applied anywhere by this repository; apply only with an explicit owner GO.
--
-- Defect addressed (audit B4): milan-api flowDurableIngress.ts used to cancel
-- every active run of the conversation ('superseded', one committed
-- flow_cancel_run call per run) and only THEN call flow_begin_durable_run.
-- When begin returned NULL (its eligibility re-checks: claim, live flags,
-- switches, activation, receipt) or raised, the older runs were already
-- ended (wake_at cleared, pending/retry_wait outbox rows cancelled, leases
-- deleted) and no new run replaced them: the customer got no reply at all.
-- Begin-first is impossible (flow_guard_one_active_run, 20261029130000,
-- refuses a second active run with flow_active_run_exists) and a supersede
-- cannot be undone after commit.
--
-- Adds ONE service-only function, same arguments and result as
-- flow_begin_durable_run (20261029125000/180000):
--   public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
-- In the caller's single transaction it
--  1. takes the transaction-scoped advisory lock of this tenant conversation,
--     with the SAME key as flow_guard_one_active_run
--     ('flow_active_run:<tenant>:<conversation>' via hashtextextended(..,0)),
--     so concurrent superseding starts of one conversation run one after the
--     other (the trigger re-takes the same lock re-entrantly);
--  2. supersedes exactly what the TypeScript did: every run of this tenant
--     and conversation (any channel account) in ready / awaiting_input /
--     sleeping, each through public.flow_cancel_run(p_tenant, run, 'superseded',
--     <its observed status>); a false result (the run already left that
--     state) is ignored, as before. (The TypeScript read at most 20 rows;
--     with the one-active-run trigger there is at most one in practice, so
--     no bound is applied here.)
--  3. calls public.flow_begin_durable_run with the unchanged arguments.
-- Atomicity: steps 2-3 run inside a PL/pgSQL block with an exception handler
-- (an implicit SAVEPOINT). If begin returns NULL, the block raises the private
-- SQLSTATE 'FB190', which only that handler catches: the subtransaction is
-- rolled back (every supersede undone: run status, wake_at, outbox rows and
-- leases exactly as before the call) and the function returns NULL. If begin
-- (or a cancel) RAISES, the error is NOT caught: it propagates and the whole
-- statement/transaction rolls back, so again no run is superseded; the caller
-- sees the same error it saw from flow_begin_durable_run (e.g. 23505
-- flow_active_run_exists, "First durable step rejected"). A run is
-- superseded only when the new run is committed with it.
-- Tenant isolation: every statement is scoped by p_tenant (and
-- p_conversation); flow_begin_durable_run re-verifies that the conversation,
-- account, inbound message and route='flow' claim belong to p_tenant, so a
-- call with foreign or inconsistent ids returns NULL and changes nothing.
-- LANGUAGE plpgsql, SECURITY INVOKER, SET search_path='' and every object
-- schema-qualified (like the sibling RPCs); EXECUTE revoked from PUBLIC, anon
-- and authenticated, granted to service_role only (which also holds EXECUTE
-- on flow_cancel_run and flow_begin_durable_run).
--
-- No table, row, index, trigger or existing function is changed; the 180000
-- bodies of flow_begin_durable_run / flow_resume_button_run are only called.
-- Billing/credits are not referenced. Additive and idempotent: CREATE OR
-- REPLACE; a function of this name without the marker below, or another
-- overload, is refused (never overwritten).
-- Ownership marker: CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING
-- Preflight refuses unless 20261029130000 (flow_cancel_run,
-- flow_guard_one_active_run and its trigger) and 20261029180000 (both durable
-- RPCs carry its marker and flow_begin_durable_run has its exact body) are
-- installed; 20261029180000 itself requires 20261029125000..170000.
--
-- Order: after 20261029180000 (newest). Deploy milan-api (which calls this
-- function) only AFTER this migration. Rollback:
-- supabase/rollbacks/20261029190000_flow_begin_durable_run_superseding.rollback.sql
-- (revert milan-api to the previous build FIRST: without this function the new
-- build's durable start fails closed and sends nothing; then run this rollback
-- FIRST, before 180000, 170000, 160000, 150000, 140000, 130000, 125000; the
-- older rollbacks refuse while this function exists).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING';
 v_lc constant text := 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
 v_gd constant text := 'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS';
 -- md5 of the whitespace-normalized 20261029180000 flow_begin_durable_run body
 -- (same normalization and value as the read-only pre-deploy checks).
 v_begin_180_md5 constant text := '80953ca6c0b52e627699748b59f383f9';
 v_name text;
 v_fn regprocedure;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_name) THEN
   RAISE EXCEPTION 'Superseding begin prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 IF to_regclass('public.automation_flow_runs') IS NULL THEN
  RAISE EXCEPTION 'Superseding begin prerequisite missing: public.automation_flow_runs';
 END IF;
 -- 20261029130000: cancel function and the one-active-run guard (lock key owner).
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_cancel_run(uuid,uuid,text,text)','public.flow_guard_one_active_run()'
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_lc THEN
   RAISE EXCEPTION 'Missing or unrecognized 20261029130000 object %; apply 20261029130000_flow_run_lifecycle first', v_name;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid='public.automation_flow_runs'::regclass AND t.tgname='flow_one_active_run_guard'
    AND t.tgfoid='public.flow_guard_one_active_run()'::regprocedure AND t.tgenabled<>'D'
    AND obj_description(t.oid,'pg_trigger') IS NOT DISTINCT FROM v_lc) THEN
  RAISE EXCEPTION 'Missing or disabled 20261029130000 trigger flow_one_active_run_guard; apply 20261029130000_flow_run_lifecycle first';
 END IF;
 -- 20261029180000: both durable RPCs carry its marker; begin has its exact body.
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
  'public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)'
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NULL OR split_part(coalesce(obj_description(v_fn,'pg_proc'),''),' ',1) IS DISTINCT FROM v_gd THEN
   RAISE EXCEPTION 'Missing or unrecognized 20261029180000 object %; apply 20261029180000_flow_durable_button_run_guards first', v_name;
  END IF;
 END LOOP;
 v_fn := to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)');
 IF (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p WHERE p.oid=v_fn)
    IS DISTINCT FROM v_begin_180_md5
 OR (SELECT p.prorettype FROM pg_catalog.pg_proc p WHERE p.oid=v_fn)<>'uuid'::regtype THEN
  RAISE EXCEPTION 'public.flow_begin_durable_run does not have the 20261029180000 definition; apply 20261029180000_flow_durable_button_run_guards first';
 END IF;
 -- Re-apply only over this migration's own function.
 v_fn := to_regprocedure('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)');
 IF v_fn IS NOT NULL AND obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Unrecognized existing function public.flow_begin_durable_run_superseding; refusing to overwrite';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='flow_begin_durable_run_superseding'
    AND p.oid IS DISTINCT FROM v_fn) THEN
  RAISE EXCEPTION 'Unrecognized overload of public.flow_begin_durable_run_superseding exists; refusing to install';
 END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.flow_begin_durable_run_superseding(
 p_tenant uuid,p_account uuid,p_conversation uuid,p_inbound uuid,
 p_event text,p_flow text,p_revision bigint,p_start text,p_next text,
 p_next_step integer,p_status text,p_variables jsonb,p_wake timestamptz,
 p_effects jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $superseding$
DECLARE v_run uuid; r record;
BEGIN
 IF p_tenant IS NULL OR p_conversation IS NULL THEN RETURN NULL; END IF;
 -- Same key as flow_guard_one_active_run: one superseding start per
 -- tenant conversation at a time; held until the transaction ends.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  'flow_active_run:'||p_tenant::text||':'||p_conversation::text,0));
 BEGIN
  FOR r IN
   SELECT run.id,run.run_status FROM public.automation_flow_runs run
   WHERE run.tenant_id=p_tenant AND run.conversation_id=p_conversation
    AND run.run_status IN('ready','awaiting_input','sleeping')
   ORDER BY run.id
  LOOP
   -- false = the run already left that state: ignored (the trigger still guards).
   PERFORM public.flow_cancel_run(p_tenant,r.id,'superseded',r.run_status);
  END LOOP;
  v_run := public.flow_begin_durable_run(
   p_tenant,p_account,p_conversation,p_inbound,p_event,p_flow,p_revision,
   p_start,p_next,p_next_step,p_status,p_variables,p_wake,p_effects);
  IF v_run IS NULL THEN
   RAISE EXCEPTION 'flow_begin_durable_run_superseding: start refused'
    USING ERRCODE='FB190';
  END IF;
 EXCEPTION WHEN SQLSTATE 'FB190' THEN
  -- Start refused: the savepoint is rolled back, every supersede is undone.
  RETURN NULL;
 END;
 RETURN v_run;
END
$superseding$;
COMMENT ON FUNCTION public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
 IS 'CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING';
REVOKE ALL ON FUNCTION public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
 TO service_role;
COMMIT;
