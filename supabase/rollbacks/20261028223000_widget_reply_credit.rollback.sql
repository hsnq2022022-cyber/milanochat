-- REVIEW ONLY. Never remove history after any real Widget bill.
BEGIN;
DO $g$
BEGIN
 IF to_regclass('public.widget_reply_ledger') IS NULL OR
    obj_description('public.widget_reply_ledger'::regclass) IS DISTINCT FROM
      'CREATED_BY_20261028223000_WIDGET_CREDIT_V2' OR
    obj_description(to_regprocedure('public.consume_widget_reply(uuid,uuid)'),'pg_proc')
      IS DISTINCT FROM 'CREATED_BY_20261028223000_WIDGET_CREDIT_V2'
 THEN RAISE EXCEPTION 'Unrecognized Widget billing objects'; END IF;
 IF EXISTS(SELECT 1 FROM public.widget_reply_ledger) THEN
  RAISE EXCEPTION 'Widget billing ledger not empty: refusing destructive rollback';
 END IF;
END $g$;
DROP FUNCTION public.consume_widget_reply(uuid,uuid);
DROP TABLE public.widget_reply_ledger;
COMMIT;
