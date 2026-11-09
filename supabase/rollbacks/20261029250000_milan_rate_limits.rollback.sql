-- REVIEW ONLY rollback for 20261029250000_milan_rate_limits.
-- NOT applied anywhere by this repository.
--
-- Drops public.milan_rate_limit_hit(text,integer,integer),
-- public.milan_rate_limit_prune(integer) and public.milan_rate_limits, each
-- ONLY when it carries the marker CREATED_BY_20261029250000_MILAN_RATE_LIMITS
-- (an unmarked object of the same name makes the rollback REFUSE as a whole).
-- The counters are disposable (fixed windows); nothing else is touched.
-- Idempotent: absent objects are skipped.
--
-- Order: roll back / redeploy milan-api without the abuse guards FIRST, or
-- accept that the guards then run on the stricter in-memory fallback only.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $rb$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029250000_MILAN_RATE_LIMITS';
 v_sig text;
BEGIN
 FOREACH v_sig IN ARRAY ARRAY['public.milan_rate_limit_hit(text,integer,integer)','public.milan_rate_limit_prune(integer)'] LOOP
  IF to_regprocedure(v_sig) IS NOT NULL
     AND obj_description(to_regprocedure(v_sig),'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION '% exists without marker %; refusing to drop it', v_sig, v_marker;
  END IF;
 END LOOP;
 IF to_regclass('public.milan_rate_limits') IS NOT NULL
    AND obj_description(to_regclass('public.milan_rate_limits'),'pg_class') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'public.milan_rate_limits exists without marker %; refusing to drop it', v_marker;
 END IF;
END
$rb$;

DROP FUNCTION IF EXISTS public.milan_rate_limit_hit(text,integer,integer);
DROP FUNCTION IF EXISTS public.milan_rate_limit_prune(integer);
DROP TABLE IF EXISTS public.milan_rate_limits;

COMMIT;
