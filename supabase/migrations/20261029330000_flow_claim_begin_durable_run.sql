-- REVIEW ONLY: atomic claim + start for a NEW durable Flow run (milan-api
-- flowDurableIngress.ts attemptDurableInstagram, new-start path only).
-- NOT applied anywhere by this repository; apply only with an explicit owner GO.
--
-- Defect addressed (orphaned durable claim): the new-start path called the
-- inbound claim RPC (flow_claim_inbound_durable in production canary mode,
-- flow_claim_inbound in test mode) and THEN, as a separate RPC and a separate
-- transaction, flow_begin_durable_run_superseding. When the start returned
-- NULL (begin's eligibility re-checks), raised (e.g. 23505
-- flow_active_run_exists, "First durable step rejected") or the request
-- failed, the committed route='flow' claim (and, in canary mode, its
-- automation_flow_canary_claims audit row) stayed, the Edge returned
-- "handled", V2's own claim then saw a duplicate and the customer got no
-- reply. A Meta redelivery of the same mid cannot repair it: the inbound
-- messages row (unique idx_messages_wa_message_id) is already committed and
-- the redelivery is dropped before any claim. The only working compensation
-- is to never commit the claim without the run, in the SAME invocation.
--
-- Adds ONE service-only function:
--   public.flow_claim_begin_durable_run(boolean,uuid,uuid,text,text,uuid,uuid,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
--   RETURNS TABLE(acquired boolean,run_id uuid)
-- In the caller's single transaction it
--  1. validates the arguments (any NULL except p_wake: no row, nothing written);
--  2. inside ONE PL/pgSQL block with an exception handler (an implicit
--     SAVEPOINT) claims the inbound with the UNCHANGED claim function:
--     p_canary=true  -> public.flow_claim_inbound_durable(...) (claim + audit row),
--     p_canary=false -> public.flow_claim_inbound(...,p_engine_ready=>true) (test mode);
--     * no row returned: nothing was written -> returns no row;
--     * acquired=false: another delivery owns the event (nothing written
--       here) -> returns exactly (false,NULL);
--     * acquired=true but route<>'flow' (e.g. test-mode 'legacy_ai'):
--       raises the private SQLSTATE 'FB330' -> claim rolled back, no row;
--  3. calls public.flow_begin_durable_run_superseding (20261029190000) with
--     the unchanged arguments; NULL -> raises 'FB330': the claim, the canary
--     audit row and every supersede are rolled back -> no row.
--  Only the handler for SQLSTATE 'FB330' exists (no WHEN OTHERS): any other
--  error (23505, P0001, FK, lock/statement timeout, ...) PROPAGATES and the
--  whole statement rolls back (claim, audit row, supersede, receipt, run).
--  Only a complete success returns (true,<run id>).
-- No row, an error or a thrown request is ambiguous to the Edge (a commit may
-- have happened before the response was lost), so it repeats the identical
-- call ONCE: a committed first attempt then returns (false,NULL) ("handled");
-- a rolled-back one lets the retry acquire. A retry with no row returns
-- "fallback": nothing was committed, so V2's own flow_claim_inbound acquires
-- the event normally in the same invocation. A retry that fails again also
-- returns "fallback" but is logged ambiguous_after_retry (manual review).
--
-- Lock ordering (no deadlock with V2 or another start):
--  a. claim: the unique-index entry of automation_message_claims
--     (tenant,account,platform,provider_event_id) via INSERT .. ON CONFLICT;
--  b. then the transaction advisory lock 'flow_active_run:<tenant>:<conv>'
--     inside flow_begin_durable_run_superseding (and re-entrantly in the
--     one-active-run trigger), then run/outbox/lease rows of THIS conversation.
--  V2's flow_claim_inbound is a single statement that takes only (a) for its
--  own key and no advisory lock, so it can wait for this function but this
--  function never waits for it. Two starts for the SAME event serialize on
--  (a) before either takes (b): the loser gets (false,NULL) or, if the winner
--  rolled back, acquires itself. Two starts for DIFFERENT events of one
--  conversation hold different (a) keys and serialize on (b); while holding
--  (b) a start only reads claims (never waits on another key's entry) and
--  inserts its own receipt/run, so no cycle exists.
--
-- Tenant isolation: every check is done by the called functions, which are
-- scoped by p_tenant (claim ownership: message/conversation/account of the
-- tenant; begin re-verifies the route='flow' claim, account binding, live
-- flags, switches, activation, trigger node). Forged or cross-tenant ids
-- return no row and change nothing.
-- LANGUAGE plpgsql, SECURITY INVOKER, SET search_path='' and every object
-- schema-qualified; EXECUTE revoked from PUBLIC, anon and authenticated,
-- granted to service_role only (which already holds EXECUTE on the called
-- functions). No row removal, no compensation, no table, row, index, trigger,
-- privilege of an existing object or existing function is changed;
-- billing/credits are not referenced. flow_claim_inbound (V2) and the
-- resume path (claim + flow_resume_button_run) are untouched.
-- Additive and idempotent: CREATE OR REPLACE over this migration's own
-- marked body only; an unmarked function of this name, a marked function
-- with a different body, or another overload is refused.
-- Ownership marker: CREATED_BY_20261029330000_FLOW_CLAIM_BEGIN_DURABLE_RUN
-- Preflight refuses unless the roles, the four tables, and EXACTLY one
-- overload of each called function exist with their marker, plpgsql,
-- volatile, invoker, non-strict, search_path='' and the pinned normalized
-- body md5 (md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g')))):
--   flow_claim_inbound         cced049e635e02b5a0be1353704b5020 (PRODUCTION body)
--   flow_claim_inbound_durable c9299f42239a6a4f275ba4be61e04b9d (20261029230000)
--   flow_begin_durable_run_superseding 08d4eccd3e8c2acdccbd1bef59d39c73 (20261029190000)
--   flow_begin_durable_run     d0fea89cd85053ee62276bccf4156d43 (20261029230000)
-- It also refuses unless service_role holds EXECUTE on each of those four
-- functions (has_function_privilege), and unless these foreign keys exist,
-- matched structurally in pg_constraint (exact ordered columns, not by name):
--   automation_flow_runs(tenant_id,channel_account_id,platform,provider_event_id)
--    -> automation_flow_event_receipts(same four columns);
--   automation_flow_canary_claims(tenant_id,channel_account_id,platform,provider_event_id)
--    -> automation_message_claims(same four columns), NO ACTION (no cascade);
--   automation_flow_runs(tenant_id) -> tenants(id);
-- plus the enabled flow_one_active_run_guard trigger.
--
-- Order: after 20261029190000 and 20261029230000. Deploy the milan-api build
-- that calls this function only AFTER this migration (the new build falls
-- back to V2 on every start while the function is missing). Rollback:
-- supabase/rollbacks/20261029330000_flow_claim_begin_durable_run.rollback.sql
-- (revert milan-api to the previous build FIRST, then run the rollback).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029330000_FLOW_CLAIM_BEGIN_DURABLE_RUN';
 -- md5 of this migration's own normalized function body (same normalization).
 v_self_md5 constant text := '81a36b5162803ced5e86b95aafe8a63f';
 v_sig constant text := 'public.flow_claim_begin_durable_run(boolean,uuid,uuid,text,text,uuid,uuid,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)';
 v_claim_result constant text := 'TABLE(acquired boolean, route text, claim_id uuid, outgoing_message_id uuid)';
 v_name text;
 v_fn regprocedure;
 r record;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_name) THEN
   RAISE EXCEPTION 'Claim+begin prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES
   ('automation_message_claims','CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM'),
   ('automation_flow_canary_claims','CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE'),
   ('automation_flow_event_receipts',NULL),
   ('automation_flow_runs',NULL)) t(rel,marker)
 LOOP
  IF to_regclass('public.'||r.rel) IS NULL THEN
   RAISE EXCEPTION 'Claim+begin prerequisite missing: public.%', r.rel;
  END IF;
  IF r.marker IS NOT NULL AND
     obj_description(to_regclass('public.'||r.rel),'pg_class') IS DISTINCT FROM r.marker THEN
   RAISE EXCEPTION 'Unrecognized table public.% (marker %); refusing to install', r.rel, r.marker;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid='public.automation_flow_runs'::regclass AND t.tgname='flow_one_active_run_guard'
    AND t.tgenabled<>'D') THEN
  RAISE EXCEPTION 'Missing or disabled trigger flow_one_active_run_guard; apply 20261029130000_flow_run_lifecycle first';
 END IF;
 -- Critical foreign keys, matched structurally (constraint names differ
 -- between environments): exact ordered column lists; the canary audit FK
 -- must be NO ACTION (confdeltype 'a'), never a cascade.
 FOR r IN SELECT * FROM (VALUES
   ('automation_flow_runs','automation_flow_event_receipts',
    ARRAY['tenant_id','channel_account_id','platform','provider_event_id'],
    ARRAY['tenant_id','channel_account_id','platform','provider_event_id'],NULL::"char"),
   ('automation_flow_canary_claims','automation_message_claims',
    ARRAY['tenant_id','channel_account_id','platform','provider_event_id'],
    ARRAY['tenant_id','channel_account_id','platform','provider_event_id'],'a'::"char"),
   ('automation_flow_runs','tenants',ARRAY['tenant_id'],ARRAY['id'],NULL::"char"))
   t(rel,ref,cols,refcols,deltype)
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.contype='f' AND c.conrelid=to_regclass('public.'||r.rel)
     AND c.confrelid=to_regclass('public.'||r.ref)
     AND ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY k(n,o)
       JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.o)=r.cols
     AND ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY k(n,o)
       JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.o)=r.refcols
     AND (r.deltype IS NULL OR c.confdeltype=r.deltype)) THEN
   RAISE EXCEPTION 'Claim+begin prerequisite missing: foreign key public.%(%) -> public.%(%)%',
    r.rel, array_to_string(r.cols,','), r.ref, array_to_string(r.refcols,','),
    CASE WHEN r.deltype='a' THEN ' with NO ACTION (no cascade)' ELSE '' END;
  END IF;
 END LOOP;
 -- Called functions: exactly one overload each, exact definition.
 FOR r IN SELECT * FROM (VALUES
   ('flow_claim_inbound','public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)',
    'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM',false,'cced049e635e02b5a0be1353704b5020',v_claim_result,
    '20261028220000_webhook_exclusive_claim (production body)'),
   ('flow_claim_inbound_durable','public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)',
    'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE',false,'c9299f42239a6a4f275ba4be61e04b9d',v_claim_result,
    '20261029230000_flow_multichannel_support'),
   ('flow_begin_durable_run_superseding',
    'public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
    'CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING',false,'08d4eccd3e8c2acdccbd1bef59d39c73','uuid',
    '20261029190000_flow_begin_durable_run_superseding'),
   ('flow_begin_durable_run',
    'public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
    'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS',true,'d0fea89cd85053ee62276bccf4156d43','uuid',
    '20261029230000_flow_multichannel_support'))
   t(name,sig,marker,prefix,body_md5,result,mig)
 LOOP
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL THEN
   RAISE EXCEPTION 'Missing function %; apply % first', r.sig, r.mig;
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
      WHERE p.pronamespace='public'::regnamespace AND p.proname=r.name)<>1 THEN
   RAISE EXCEPTION 'Unrecognized overload of public.%; refusing to install', r.name;
  END IF;
  IF (CASE WHEN r.prefix THEN split_part(coalesce(obj_description(v_fn,'pg_proc'),''),' ',1)
           ELSE obj_description(v_fn,'pg_proc') END) IS DISTINCT FROM r.marker THEN
   RAISE EXCEPTION 'Function % lacks marker %; apply % first', r.sig, r.marker, r.mig;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE p.oid=v_fn AND l.lanname='plpgsql' AND p.provolatile='v' AND NOT p.prosecdef
     AND NOT p.proisstrict AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']
     AND pg_catalog.pg_get_function_result(p.oid)=r.result
     AND md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g')))=r.body_md5) THEN
   RAISE EXCEPTION 'Function % does not have the expected definition (%); refusing to install', r.sig, r.mig;
  END IF;
  -- SECURITY INVOKER: service_role must be able to execute every callee.
  IF NOT pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
   RAISE EXCEPTION 'Claim+begin prerequisite missing: EXECUTE on % for service_role', r.sig;
  END IF;
 END LOOP;
 -- Re-apply only over this migration's own function.
 v_fn := to_regprocedure(v_sig);
 IF v_fn IS NOT NULL THEN
  IF obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'Unrecognized existing function public.flow_claim_begin_durable_run; refusing to overwrite';
  END IF;
  IF (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p WHERE p.oid=v_fn)
     IS DISTINCT FROM v_self_md5 THEN
   RAISE EXCEPTION 'Existing public.flow_claim_begin_durable_run carries the marker but not this migration''s body; refusing to overwrite';
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='flow_claim_begin_durable_run'
    AND p.oid IS DISTINCT FROM v_fn) THEN
  RAISE EXCEPTION 'Unrecognized overload of public.flow_claim_begin_durable_run exists; refusing to install';
 END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.flow_claim_begin_durable_run(
 p_canary boolean,p_tenant uuid,p_account uuid,p_platform text,p_event text,
 p_conversation uuid,p_inbound uuid,p_flow text,p_revision bigint,p_start text,
 p_next text,p_next_step integer,p_status text,p_variables jsonb,p_wake timestamptz,
 p_effects jsonb
) RETURNS TABLE(acquired boolean,run_id uuid) LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $claimbegin$
DECLARE v_outcome text:='none'; v_acquired boolean; v_route text; v_run uuid;
BEGIN
 IF p_canary IS NULL OR p_tenant IS NULL OR p_account IS NULL OR p_platform IS NULL OR
    p_event IS NULL OR p_conversation IS NULL OR p_inbound IS NULL OR p_flow IS NULL OR
    p_revision IS NULL OR p_start IS NULL OR p_next IS NULL OR p_next_step IS NULL OR
    p_status IS NULL OR p_variables IS NULL OR p_effects IS NULL
 THEN RETURN; END IF;
 BEGIN
  -- (a) exclusive claim: unique entry of automation_message_claims first.
  IF p_canary THEN
   SELECT c.acquired,c.route INTO v_acquired,v_route
   FROM public.flow_claim_inbound_durable(
    p_tenant,p_account,p_platform,p_event,p_conversation,p_inbound) c;
  ELSE
   SELECT c.acquired,c.route INTO v_acquired,v_route
   FROM public.flow_claim_inbound(
    p_tenant,p_account,p_platform,p_event,p_conversation,p_inbound,true) c;
  END IF;
  IF NOT FOUND THEN
   v_outcome:='none';                -- not eligible: nothing was written
  ELSIF v_acquired IS NOT TRUE THEN
   v_outcome:='lost';                -- another delivery owns it: nothing written here
  ELSE
   IF v_route IS DISTINCT FROM 'flow' THEN
    RAISE EXCEPTION 'flow_claim_begin_durable_run: claim not routed to flow'
     USING ERRCODE='FB330';
   END IF;
   -- (b) advisory lock + supersede + begin, one transaction (20261029190000).
   v_run := public.flow_begin_durable_run_superseding(
    p_tenant,p_account,p_conversation,p_inbound,p_event,p_flow,p_revision,
    p_start,p_next,p_next_step,p_status,p_variables,p_wake,p_effects);
   IF v_run IS NULL THEN
    RAISE EXCEPTION 'flow_claim_begin_durable_run: start refused'
     USING ERRCODE='FB330';
   END IF;
   v_outcome:='started';
  END IF;
 EXCEPTION WHEN SQLSTATE 'FB330' THEN
  -- Savepoint rolled back: claim, canary audit row and supersede undone.
  -- Values assigned in the block are never returned.
  RETURN;
 END;
 IF v_outcome='lost' THEN
  acquired:=false; run_id:=NULL; RETURN NEXT;
 ELSIF v_outcome='started' THEN
  acquired:=true; run_id:=v_run; RETURN NEXT;
 END IF;
 RETURN;
END
$claimbegin$;
COMMENT ON FUNCTION public.flow_claim_begin_durable_run(boolean,uuid,uuid,text,text,uuid,uuid,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
 IS 'CREATED_BY_20261029330000_FLOW_CLAIM_BEGIN_DURABLE_RUN';
REVOKE ALL ON FUNCTION public.flow_claim_begin_durable_run(boolean,uuid,uuid,text,text,uuid,uuid,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_claim_begin_durable_run(boolean,uuid,uuid,text,text,uuid,uuid,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
 TO service_role;
COMMIT;
