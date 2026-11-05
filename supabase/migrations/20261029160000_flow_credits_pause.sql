-- REVIEW ONLY: tenant credit exhaustion is a TEMPORARY pause for durable Flow
-- runs. NOT applied anywhere.
-- Depends on 20261029130000_flow_run_lifecycle.sql,
-- 20261029140000_flow_outbox_ai_retry.sql and
-- 20261029150000_flow_takeover_resume.sql (preflight refuses otherwise).
-- Rollback: supabase/rollbacks/20261029160000_flow_credits_pause.rollback.sql
-- (order: 160000, then 150000, then 140000, then 130000).
--
-- Defect fixed: milan-api (index.ts credits gate) and server/src/rag/reply.ts
-- stop all automatic replies while tenants.credits_remaining <= 0, and the
-- outbox worker never sends without credit (productionGate.ts). The 150000
-- flow_channel_temporarily_paused did not look at credits, so
-- flow_lease_due_runs still leased a sleeping run of an out-of-credit tenant;
-- flow-runtime-worker advanced it (next node, or 'completed') and queued its
-- messages, which the send gate kept 'pending' until flow_skip_blocked_outbox
-- cancelled them as 'stale' after 60 minutes. The customer never received
-- those steps, even after a top-up.
--
-- Change: flow_channel_temporarily_paused also returns true when the tenant
-- row has a credits_remaining value that is not a number > 0 (same rule as the
-- outbox gate; column read through to_jsonb, absent column = not paused).
-- Effects, all inherited from 150000 with no other change:
--  * flow_lease_due_runs does not lease (and never ends) such runs; they stay
--    'sleeping' and are leased again as soon as credits are positive;
--  * flow_end_stale_paused_runs ends them 'stale' only after the existing
--    24h bound past wake_at.
-- conversations.auto_paused_reason='credits' is deliberately NOT read here:
-- nothing clears it on top-up (only staff resume), and the tenant balance is
-- the authoritative condition.
--
-- Additive and idempotent: one CREATE OR REPLACE with the identical signature
-- and return type; no column, constraint, row or CHECK change. The function
-- carries the 160000 marker so the 150000/140000/130000 rollbacks and a
-- re-applied 150000 refuse while it is installed. No cron, Vault, secrets or
-- network calls.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_name text;
 v_fn regprocedure;
 v_lc constant text := 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
 v_ai constant text := 'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY';
 v_tk constant text := 'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME';
 v_marker constant text := 'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE';
BEGIN
 FOREACH v_name IN ARRAY ARRAY[
  'automation_flow_runs','automation_flow_run_leases','tenants','channel_accounts'
 ] LOOP
  IF to_regclass('public.'||v_name) IS NULL THEN
   RAISE EXCEPTION 'Credits pause prerequisite missing: %', v_name;
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
 -- 20261029150000 objects: stale sweep with its marker; the pause probe with
 -- the 150000 marker (first apply) or this migration's marker (re-apply).
 v_fn := to_regprocedure('public.flow_end_stale_paused_runs(integer,integer)');
 IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_tk THEN
  RAISE EXCEPTION 'Missing or unrecognized 20261029150000 object public.flow_end_stale_paused_runs(integer,integer); apply 20261029150000_flow_takeover_resume first';
 END IF;
 v_fn := to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)');
 IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS NULL
    OR obj_description(v_fn,'pg_proc') NOT IN (v_tk,v_marker) THEN
  RAISE EXCEPTION 'Missing or unrecognized 20261029150000 object public.flow_channel_temporarily_paused(uuid,uuid); apply 20261029150000_flow_takeover_resume first';
 END IF;
 -- The probe only matters if the installed lease function calls it (the
 -- 150000 body). A 130000 body here means 130000 was re-applied after 150000.
 IF position('flow_channel_temporarily_paused' IN
     (SELECT p.prosrc FROM pg_catalog.pg_proc p
      WHERE p.oid=to_regprocedure('public.flow_lease_due_runs(integer)')))=0
 THEN
  RAISE EXCEPTION 'flow_lease_due_runs is not the 20261029150000 version; apply 20261029150000_flow_takeover_resume first';
 END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- Temporary pause probe: true when the tenant row exists and is not active or
-- has no credit left, or the tenant's account row exists and is inactive /
-- agent_enabled off / auto_reply off. Missing rows return false (they are
-- PERMANENT conditions handled by flow_lease_due_runs). Optional live-only
-- columns read through to_jsonb(row); a present but non-true flag counts as
-- paused, and a present credits_remaining that is not a number > 0 (NULL,
-- non-numeric, zero, negative) counts as paused.
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
 IF j IS NOT NULL AND j ? 'credits_remaining' AND
    (CASE WHEN jsonb_typeof(j->'credits_remaining')='number'
     THEN (j->>'credits_remaining')::numeric<=0 ELSE true END)
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
 IS 'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE';
REVOKE ALL ON FUNCTION public.flow_channel_temporarily_paused(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_channel_temporarily_paused(uuid,uuid) TO service_role;
COMMIT;
