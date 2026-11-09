-- REVIEW ONLY rollback for 20261029330000_flow_claim_begin_durable_run.
-- NOT applied anywhere by this repository.
--
-- Drops ONLY public.flow_claim_begin_durable_run(boolean,uuid,uuid,text,text,uuid,uuid,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
-- and only while it carries the marker
-- CREATED_BY_20261029330000_FLOW_CLAIM_BEGIN_DURABLE_RUN AND the exact
-- normalized body of that migration (an unmarked function, or a marked one
-- with a foreign body, is refused, never dropped). Nothing else is touched:
-- flow_claim_inbound, flow_claim_inbound_durable,
-- flow_begin_durable_run_superseding, flow_begin_durable_run, claims, canary
-- audit rows, receipts, runs and outbox rows stay exactly as they are.
-- Billing/credits are not referenced; privileges are not changed.
--
-- Order: revert milan-api to the build that does not call this function
-- FIRST (without it the new build's durable start always falls back to V2).
-- Then run this rollback BEFORE the 20261029230000 / 20261029190000 / 170000
-- rollbacks (this function calls their objects).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029330000_FLOW_CLAIM_BEGIN_DURABLE_RUN';
 v_self_md5 constant text := '81a36b5162803ced5e86b95aafe8a63f';
 v_fn regprocedure := to_regprocedure('public.flow_claim_begin_durable_run(boolean,uuid,uuid,text,text,uuid,uuid,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)');
BEGIN
 IF v_fn IS NULL THEN
  RAISE EXCEPTION '20261029330000_flow_claim_begin_durable_run not installed; nothing to roll back';
 END IF;
 IF obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Refusing to drop unrecognized function public.flow_claim_begin_durable_run (marker=%)',
   coalesce(obj_description(v_fn,'pg_proc'),'-');
 END IF;
 IF (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p WHERE p.oid=v_fn)
    IS DISTINCT FROM v_self_md5 THEN
  RAISE EXCEPTION 'Refusing to drop public.flow_claim_begin_durable_run: marked but its body is not the 20261029330000 definition';
 END IF;
END
$g$;

DROP FUNCTION public.flow_claim_begin_durable_run(boolean,uuid,uuid,text,text,uuid,uuid,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb);
COMMIT;
