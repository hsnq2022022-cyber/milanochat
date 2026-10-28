-- REVIEW ONLY, refuses deleting attempt history.
BEGIN;
DO $g$
BEGIN
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
