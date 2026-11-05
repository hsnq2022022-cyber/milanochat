-- REVIEW ONLY rollback for 20261029190000_flow_begin_durable_run_superseding.
-- NOT applied anywhere by this repository.
--
-- Drops ONLY public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
-- and only while it carries the marker
-- CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING (an unmarked
-- function of that name is refused, never dropped). Nothing else is touched:
-- flow_begin_durable_run / flow_resume_button_run (180000 bodies),
-- flow_cancel_run, the one-active-run trigger, runs, outbox rows, receipts
-- and claims stay exactly as they are. Billing/credits are not referenced.
--
-- Order: revert milan-api to the build that does not call this function
-- FIRST (the new build's durable start fails closed without it: no run, no
-- reply from that path). Then run this rollback FIRST (190000 is the newest
-- migration); required rollback order: 190000, then 20261029180000, 170000,
-- 160000, 150000, 140000, 130000, 125000 (each of those rollbacks refuses
-- while this function exists).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING';
 v_fn regprocedure := to_regprocedure('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)');
BEGIN
 -- 20261029190000 is the newest migration: no later rollback must run first.
 IF v_fn IS NULL THEN
  RAISE EXCEPTION '20261029190000_flow_begin_durable_run_superseding not installed; nothing to roll back';
 END IF;
 IF obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Refusing to drop unrecognized function public.flow_begin_durable_run_superseding (marker=%)',
   coalesce(obj_description(v_fn,'pg_proc'),'-');
 END IF;
END
$g$;

DROP FUNCTION public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb);
COMMIT;
