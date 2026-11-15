-- REVIEW ONLY rollback for 20261029360000_flow_inbound_recovery.
-- NOT applied anywhere by this repository.
--
-- Drops ONLY what 20261029360000 created, and only while each object carries
-- the marker CREATED_BY_20261029360000_FLOW_INBOUND_RECOVERY (functions: AND
-- the exact normalized body of that migration). An unmarked object, a marked
-- function with a foreign body, or a foreign overload is refused, never
-- dropped. Nothing else is touched (messages, claims, routing retries, runs,
-- outbox, billing, privileges of other objects).
--
-- DATA: both tables hold operator opt-in rows and diagnostic recovery rows
-- only (no message text). The rollback refuses while any recovery row holds
-- an unexpired lease (a sweeper tick may be re-driving that event right now)
-- unless the operator sets
--   SET flow.inbound_recovery_rollback_ack = 'drop_inflight_leases';
-- in the same session. 'waiting'/'resolved'/'exhausted' rows and the opt-in
-- rows are dropped with the tables (export them first if they are needed).
--
-- Order: turn FLOW_INBOUND_RECOVERY_ENABLED off and unschedule the recovery
-- cron job FIRST (a milan-api build that still exposes inbound_recovery_tick
-- answers "recovery state unavailable" without these objects), then run this.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029360000_FLOW_INBOUND_RECOVERY';
 r record;
 v_fn regprocedure;
 v_name text;
BEGIN
 IF to_regclass('public.automation_inbound_recovery') IS NULL THEN
  RAISE EXCEPTION '20261029360000_flow_inbound_recovery not installed; nothing to roll back';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['automation_inbound_recovery_tenants','automation_inbound_recovery',
   'automation_inbound_recovery_status'] LOOP
  IF to_regclass('public.'||v_name) IS NULL THEN
   RAISE EXCEPTION 'Missing public.%; refusing a partial rollback', v_name;
  END IF;
  IF obj_description(to_regclass('public.'||v_name),'pg_class') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'Refusing to drop unrecognized object public.%', v_name;
  END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES
   ('flow_inbound_recovery_lease','public.flow_inbound_recovery_lease(integer,integer,integer,integer,integer,uuid)','407b44aceb8afd6c7674d28c1d89cc0b'),
   ('flow_inbound_recovery_finish','public.flow_inbound_recovery_finish(uuid,uuid,uuid,text,text,integer)','cf208534b81d64a7dd0fd7e1768d0142')) t(name,sig,body_md5)
 LOOP
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL THEN
   RAISE EXCEPTION 'Missing %; refusing a partial rollback', r.sig;
  END IF;
  IF obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'Refusing to drop unrecognized function % (marker=%)', r.sig, coalesce(obj_description(v_fn,'pg_proc'),'-');
  END IF;
  IF (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p WHERE p.oid=v_fn)
     IS DISTINCT FROM r.body_md5 THEN
   RAISE EXCEPTION 'Refusing to drop %: marked but its body is not the 20261029360000 definition', r.sig;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname=r.name AND p.oid<>v_fn) THEN
   RAISE EXCEPTION 'Refusing: foreign overload of public.% exists', r.name;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.automation_inbound_recovery
     WHERE status='leased' AND lease_expires_at>now())
    AND coalesce(current_setting('flow.inbound_recovery_rollback_ack',true),'') <> 'drop_inflight_leases' THEN
  RAISE EXCEPTION 'Refusing: in-flight recovery leases exist; set flow.inbound_recovery_rollback_ack = ''drop_inflight_leases'' to confirm';
 END IF;
END
$g$;

DROP VIEW public.automation_inbound_recovery_status;
DROP FUNCTION public.flow_inbound_recovery_lease(integer,integer,integer,integer,integer,uuid);
DROP FUNCTION public.flow_inbound_recovery_finish(uuid,uuid,uuid,text,text,integer);
DROP TABLE public.automation_inbound_recovery;
DROP TABLE public.automation_inbound_recovery_tenants;
COMMIT;
