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
-- reply from that path). Then run this rollback right after the
-- 20261029210000_flow_media_effects rollback (refused while a 210000 body is
-- installed); required rollback order: 210000, 190000, then 20261029180000,
-- 170000, 160000, 150000, 140000, 130000, 125000 (each of those rollbacks
-- refuses while this function exists).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING';
 v_fn regprocedure := to_regprocedure('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)');
BEGIN
 -- 20261029220000 (media stale sweep; requires 210000) is newer: roll it back first.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.flow_skip_blocked_outbox(integer,integer)')
  AND md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g')))='dacdf7bb582a7d380651d478f47c6b97')
 THEN RAISE EXCEPTION 'Refusing 20261029190000 rollback: 20261029220000 objects still exist; roll back 20261029220000_flow_media_stale_sweep first'; END IF;
 -- 20261029210000 (media effects; requires the 130000..190000 chain) is newer: roll it back first.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN(
   to_regprocedure('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)'),
   to_regprocedure('public.flow_reserve_outbox_delivery(uuid,uuid)'),
   to_regprocedure('public.flow_finish_outbox_delivery(uuid,uuid,text,text)'))
  AND md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) IN(
   '94a87bc016ad93e609897025d259bf3e','1b7a6fe3f6a9ee97203d50d5e0e0baa7','1c6ec477519f8c91c24fc2ab82d4b9c4'))
 THEN RAISE EXCEPTION 'Refusing 20261029190000 rollback: 20261029210000 objects still exist; roll back 20261029210000_flow_media_effects first'; END IF;
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
