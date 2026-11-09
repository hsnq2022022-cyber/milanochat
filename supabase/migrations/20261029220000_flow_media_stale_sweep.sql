-- REVIEW ONLY: the stale/blocked Outbox sweep also covers 'message_image'
-- effects (Instagram image attachment). NOT applied anywhere by this
-- repository; apply only with an explicit owner GO. Sending stays OFF behind
-- FLOW_MEDIA_SEND_ENABLED (default OFF) in milan-api and flow-outbox-worker:
-- this migration never sends anything by itself.
--
-- Why: 20261029210000 lets the database store, reserve and finish
-- 'message_image' effects, but public.flow_skip_blocked_outbox (20261029130000
-- body; no later migration redefines it) only sweeps effect_kind 'message' and
-- 'question'. An unsent image effect whose run ended, whose revision is
-- inactive, whose conversation is under human takeover, or that is older than
-- p_max_age_minutes would otherwise stay 'pending' / 'retry_wait' forever (and
-- hold the later effects of its run).
--
-- Change (nothing else is touched): public.flow_skip_blocked_outbox(integer,
-- integer) is replaced by the exact 20261029130000 body with one difference:
-- the swept effect kinds are ('message','question','message_image'). Same
-- reasons (the run's ended_reason, e.g. 'ineligible'; 'revision_inactive';
-- 'human_takeover'; 'stale'), same order, same bounds, same per-row cancel via
-- public.flow_skip_outbox_effect (pending/retry_wait only, keyed by tenant_id
-- and id). Internal effects (tag/untag/staff_notification/handoff) stay
-- untouched. Header (signature, defaults, RETURNS integer), LANGUAGE plpgsql,
-- SECURITY INVOKER, SET search_path='', the service_role-only privileges and
-- the 20261029130000 ownership comment are unchanged: CREATE OR REPLACE keeps
-- the OID, privileges and comment on purpose (the 150000 / 160000 preflights
-- and the read-only pre-deploy checks pin the exact 130000 marker of this
-- function). Ownership of the replaced body is proven by body hash (md5 of the
-- whitespace-normalized prosrc, as 190000 / 210000).
-- Ownership marker (body hash, not a comment): CREATED_BY_20261029220000_FLOW_MEDIA_STALE_SWEEP
-- Billing/credits are not referenced; no row is inserted, updated or deleted by
-- this script.
--
-- Preflight refuses unless: roles anon/authenticated/service_role exist;
-- flow_skip_blocked_outbox, flow_skip_outbox_effect and
-- flow_conversation_human_takeover carry the 20261029130000 marker;
-- flow_skip_blocked_outbox has its attributes and either the exact
-- 20261029130000 body or this migration's body (any other body is refused,
-- never overwritten) and no other overload exists; 20261029210000 is installed
-- (its three function bodies by hash and the marked effect_kind CHECK
-- allowing 'message_image').
-- Lock impact: none on tables (function replacement only).
-- lock_timeout 3s / statement_timeout 60s.
--
-- Order: after 20261029210000 (newest flow migration before this one;
-- 20261029200000 flow-media storage is independent). Rollback:
-- supabase/rollbacks/20261029220000_flow_media_stale_sweep.rollback.sql FIRST,
-- before 210000, 190000, 180000, 170000, 160000, 150000, 140000, 130000 and
-- 125000 (each refuses while the 220000 body is installed).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029220000_FLOW_MEDIA_STALE_SWEEP';
 v_lc constant text := 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
 v_media constant text := 'CREATED_BY_20261029210000_FLOW_MEDIA_EFFECTS';
 v_sig constant text := 'public.flow_skip_blocked_outbox(integer,integer)';
 -- md5 of the whitespace-normalized body: 20261029130000, then 20261029220000.
 v_h_old constant text := 'dd51c2c354790475e1c840db4084caef';
 v_h_new constant text := 'dacdf7bb582a7d380651d478f47c6b97';
 v_name text;
 v_fn regprocedure;
 p record;
 r record;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_name) THEN
   RAISE EXCEPTION 'Media stale sweep prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY['automation_flow_outbox','automation_flow_runs'] LOOP
  IF to_regclass('public.'||v_name) IS NULL THEN
   RAISE EXCEPTION 'Media stale sweep prerequisite missing: public.%', v_name;
  END IF;
 END LOOP;
 -- 20261029130000 objects (exact ownership marker).
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_skip_outbox_effect(uuid,uuid,text)',
  'public.flow_conversation_human_takeover(uuid,uuid)',
  v_sig
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_lc THEN
   RAISE EXCEPTION 'Missing or unrecognized 20261029130000 object %; apply 20261029130000_flow_run_lifecycle first', v_name;
  END IF;
 END LOOP;
 -- 20261029210000 installed: its three bodies (hash) and the marked effect_kind CHECK.
 FOR r IN SELECT * FROM (VALUES
  ('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)','94a87bc016ad93e609897025d259bf3e'),
  ('public.flow_reserve_outbox_delivery(uuid,uuid)','1b7a6fe3f6a9ee97203d50d5e0e0baa7'),
  ('public.flow_finish_outbox_delivery(uuid,uuid,text,text)','1c6ec477519f8c91c24fc2ab82d4b9c4')
 ) f(sig,h) LOOP
  IF (SELECT md5(btrim(regexp_replace(x.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc x
      WHERE x.oid=to_regprocedure(r.sig)) IS DISTINCT FROM r.h THEN
   RAISE EXCEPTION '% does not have the 20261029210000 definition; apply 20261029210000_flow_media_effects first', r.sig;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='public.automation_flow_outbox'::regclass AND c.contype='c'
    AND split_part(coalesce(obj_description(c.oid,'pg_constraint'),''),' ',1)=v_media
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''message_image''%') THEN
  RAISE EXCEPTION 'Marked effect_kind CHECK allowing message_image missing; apply 20261029210000_flow_media_effects first';
 END IF;
 -- The function replaced here: no other overload, exact attributes, previous or this body.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc x
   WHERE x.pronamespace='public'::regnamespace AND x.proname='flow_skip_blocked_outbox'
    AND x.oid IS DISTINCT FROM to_regprocedure(v_sig)) THEN
  RAISE EXCEPTION 'Unrecognized overload of public.flow_skip_blocked_outbox exists; refusing to replace %', v_sig;
 END IF;
 SELECT x.* INTO p FROM pg_catalog.pg_proc x WHERE x.oid=to_regprocedure(v_sig);
 IF p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
 OR p.prorettype IS DISTINCT FROM 'integer'::regtype OR p.proretset OR p.prokind<>'f'
 OR p.prosecdef OR p.proisstrict OR p.provolatile<>'v' OR p.pronargdefaults<>2
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
 OR p.proargnames IS DISTINCT FROM ARRAY['p_max_age_minutes','p_limit']
 OR md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) NOT IN(v_h_old,v_h_new) THEN
  RAISE EXCEPTION 'Existing % differs from both the 20261029130000 and the 20261029220000 definition; refusing to overwrite', v_sig;
 END IF;
 IF md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g')))=v_h_new THEN
  RAISE NOTICE '% already has the 20261029220000 definition (%); re-apply is a no-op', v_sig, v_marker;
 END IF;
END
$preflight$;

-- 20261029130000 body; only change: 'message_image' is swept like text.
-- Sweep customer-visible effects (message/question/message_image) still unsent
-- whose run ended, whose revision is inactive, whose conversation is under
-- human takeover, or that are older than p_max_age_minutes. Internal effects
-- (tag/untag/staff_notification) are left alone: a handoff notification is
-- precisely what staff need during a takeover.
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
    AND o.effect_kind IN('message','question','message_image')
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

-- Same service_role-only privileges as 20261029130000 (CREATE OR REPLACE keeps them;
-- restated so the end state is explicit).
REVOKE ALL ON FUNCTION public.flow_skip_blocked_outbox(integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_skip_blocked_outbox(integer,integer) TO service_role;
COMMIT;
