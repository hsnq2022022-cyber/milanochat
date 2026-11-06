-- REVIEW ONLY, refuses deleting attempt history.
BEGIN;
DO $g$
BEGIN
 -- 20261029210000 (media effects; requires the 130000..190000 chain) is newer: roll it back first.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN(
   to_regprocedure('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)'),
   to_regprocedure('public.flow_reserve_outbox_delivery(uuid,uuid)'),
   to_regprocedure('public.flow_finish_outbox_delivery(uuid,uuid,text,text)'))
  AND md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) IN(
   '94a87bc016ad93e609897025d259bf3e','1b7a6fe3f6a9ee97203d50d5e0e0baa7','1c6ec477519f8c91c24fc2ab82d4b9c4'))
 THEN RAISE EXCEPTION 'Refusing 20261028226000 rollback: 20261029210000 objects still exist; roll back 20261029210000_flow_media_effects first'; END IF;
 IF to_regclass('public.automation_flow_delivery_attempts') IS NULL
  OR obj_description('public.automation_flow_delivery_attempts'::regclass)
    IS DISTINCT FROM 'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY'
 THEN RAISE EXCEPTION 'Unrecognized table';END IF;
 IF EXISTS(SELECT 1 FROM public.automation_flow_delivery_attempts)
 THEN RAISE EXCEPTION 'Cannot drop nonempty delivery history';END IF;
END $g$;
DROP FUNCTION public.flow_queue_outbox_human_review(integer,integer);
DROP FUNCTION public.flow_finish_outbox_delivery(uuid,uuid,text,text);
DROP FUNCTION public.flow_reserve_outbox_delivery(uuid,uuid);
DROP TABLE public.automation_flow_delivery_attempts;
COMMIT;
