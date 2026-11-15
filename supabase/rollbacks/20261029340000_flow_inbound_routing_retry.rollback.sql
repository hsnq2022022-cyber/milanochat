-- REVIEW ONLY rollback for 20261029340000_flow_inbound_routing_retry.
-- NOT applied anywhere by this repository.
--
-- Drops ONLY what 20261029340000 created, and only while each object carries
-- the marker CREATED_BY_20261029340000_FLOW_INBOUND_ROUTING_RETRY (functions:
-- AND the exact normalized body of that migration). An unmarked object, a
-- marked function with a foreign body, or a foreign overload is refused,
-- never dropped. Nothing else is touched (claims, messages, runs, outbox,
-- billing, privileges of other objects).
--
-- DATA: the table holds diagnostic retry rows only (no message text). The
-- rollback refuses while any row is still 'retrying' (an event a provider
-- redelivery could still recover) unless the operator sets
--   SET flow.inbound_retry_rollback_ack = 'drop_retrying_rows';
-- in the same session; 'exhausted'/'resolved' rows are dropped with the table
-- (export them first if they are needed for investigation).
--
-- Order: revert milan-api to the build that does not call these functions
-- FIRST (the new build without them logs "retry state unavailable" and
-- answers nothing for an unknown-eligibility event), then run this rollback.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029340000_FLOW_INBOUND_ROUTING_RETRY';
 r record;
 v_fn regprocedure;
BEGIN
 IF to_regclass('public.automation_inbound_routing_retries') IS NULL THEN
  RAISE EXCEPTION '20261029340000_flow_inbound_routing_retry not installed; nothing to roll back';
 END IF;
 IF obj_description(to_regclass('public.automation_inbound_routing_retries'),'pg_class') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Refusing to drop unrecognized table public.automation_inbound_routing_retries';
 END IF;
 FOR r IN SELECT * FROM (VALUES
   ('flow_inbound_routing_failed','public.flow_inbound_routing_failed(uuid,uuid,text,text,uuid,uuid,integer)','0fd176d432d9a7008bacf8cd75dcb4d2'),
   ('flow_inbound_routing_resolved','public.flow_inbound_routing_resolved(uuid,uuid,text,text)','762b7e1a84df93bd0e3331314ffd5e22')) t(name,sig,body_md5)
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
   RAISE EXCEPTION 'Refusing to drop %: marked but its body is not the 20261029340000 definition', r.sig;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname=r.name AND p.oid<>v_fn) THEN
   RAISE EXCEPTION 'Refusing: foreign overload of public.% exists', r.name;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.automation_inbound_routing_retries WHERE status='retrying')
    AND coalesce(current_setting('flow.inbound_retry_rollback_ack',true),'') <> 'drop_retrying_rows' THEN
  RAISE EXCEPTION 'Refusing: retrying inbound events exist; set flow.inbound_retry_rollback_ack = ''drop_retrying_rows'' to confirm';
 END IF;
END
$g$;

DROP FUNCTION public.flow_inbound_routing_failed(uuid,uuid,text,text,uuid,uuid,integer);
DROP FUNCTION public.flow_inbound_routing_resolved(uuid,uuid,text,text);
DROP TABLE public.automation_inbound_routing_retries;
COMMIT;
