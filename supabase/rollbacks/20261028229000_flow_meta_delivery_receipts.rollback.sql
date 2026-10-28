BEGIN;
DO $guard$
BEGIN
 IF to_regclass('public.flow_meta_delivery_receipts') IS NULL OR
  obj_description('public.flow_meta_delivery_receipts'::regclass)
   IS DISTINCT FROM 'CREATED_BY_20261028229000_META_RECEIPTS'
 THEN RAISE EXCEPTION 'Unknown receipt table';END IF;
 IF EXISTS(SELECT 1 FROM public.flow_meta_delivery_receipts)
 THEN RAISE EXCEPTION 'Receipt history must not be dropped';END IF;
END $guard$;
DROP FUNCTION public.flow_record_meta_delivery(uuid,uuid,text,text,text);
DROP TABLE public.flow_meta_delivery_receipts;
DROP INDEX public.flow_meta_attempt_provider_uq;
COMMIT;
