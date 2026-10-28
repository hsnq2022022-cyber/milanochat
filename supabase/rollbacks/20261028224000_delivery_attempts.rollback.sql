-- REVIEW ONLY: claims must remain durable; tracking cannot be dropped with data.
BEGIN;
DO $g$
BEGIN
 IF to_regclass('public.automation_delivery_attempts') IS NULL OR
    obj_description('public.automation_delivery_attempts'::regclass) IS DISTINCT FROM
     'CREATED_BY_20261028224000_DELIVERY_ATTEMPTS'
 THEN RAISE EXCEPTION 'Unrecognized delivery tracking table'; END IF;
 IF EXISTS(SELECT 1 FROM public.automation_delivery_attempts) THEN
  RAISE EXCEPTION 'Refusing to drop nonempty delivery history'; END IF;
END $g$;
DROP FUNCTION public.flow_queue_uncertain_deliveries(integer,integer);
DROP FUNCTION public.flow_finish_delivery(uuid,text,text);
DROP FUNCTION public.flow_begin_delivery(uuid,text);
DROP TABLE public.automation_delivery_attempts;
COMMIT;
