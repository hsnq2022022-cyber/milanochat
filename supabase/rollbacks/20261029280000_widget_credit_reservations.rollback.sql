-- REVIEW ONLY rollback for 20261029280000_widget_credit_reservations.
-- NOT applied anywhere by this repository.
--
-- Roll back / redeploy milan-api WITHOUT widgetBilling.ts FIRST (or set
-- WIDGET_BILLING_V2_ENABLED=false): otherwise every Widget message fails
-- closed once these functions are gone.
--
-- Drops public.widget_credit_reserve(uuid,uuid,text,integer),
-- public.widget_credit_commit(uuid,text,uuid),
-- public.widget_credit_release(uuid,text) and
-- public.widget_credit_reservations, each ONLY when it carries the marker
-- CREATED_BY_20261029280000_WIDGET_CREDIT_RESERVATIONS (an unmarked object of
-- the same name makes the rollback REFUSE as a whole).
-- Data guard: the table is the Widget charge / refund audit trail. When it
-- holds rows the rollback REFUSES unless the session setting
-- milan.rollback_280000 = 'discard-widget-reservations' is set
-- (e.g. PGOPTIONS='-c milan.rollback_280000=discard-widget-reservations').
-- Credits already debited are NOT given back by the rollback.
-- Idempotent: absent objects are skipped.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $rb$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029280000_WIDGET_CREDIT_RESERVATIONS';
 v_sig text;
 v_rows boolean;
BEGIN
 FOREACH v_sig IN ARRAY ARRAY['public.widget_credit_reserve(uuid,uuid,text,integer)',
                              'public.widget_credit_commit(uuid,text,uuid)',
                              'public.widget_credit_release(uuid,text)'] LOOP
  IF to_regprocedure(v_sig) IS NOT NULL
     AND obj_description(to_regprocedure(v_sig),'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION '% exists without marker %; refusing to drop it', v_sig, v_marker;
  END IF;
 END LOOP;
 IF to_regclass('public.widget_credit_reservations') IS NOT NULL THEN
  IF obj_description(to_regclass('public.widget_credit_reservations'),'pg_class') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'public.widget_credit_reservations exists without marker %; refusing to drop it', v_marker;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.widget_credit_reservations)' INTO v_rows;
  IF v_rows AND current_setting('milan.rollback_280000', true) IS DISTINCT FROM 'discard-widget-reservations' THEN
   RAISE EXCEPTION 'public.widget_credit_reservations holds rows; set milan.rollback_280000=discard-widget-reservations to discard them';
  END IF;
 END IF;
END
$rb$;

DROP FUNCTION IF EXISTS public.widget_credit_reserve(uuid,uuid,text,integer);
DROP FUNCTION IF EXISTS public.widget_credit_commit(uuid,text,uuid);
DROP FUNCTION IF EXISTS public.widget_credit_release(uuid,text);
DROP TABLE IF EXISTS public.widget_credit_reservations;

COMMIT;
