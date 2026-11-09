-- REVIEW ONLY rollback for 20261029290000_wa_bindings_verification.
-- NOT applied anywhere by this repository.
--
-- WARNING: removes the interim anti-squatting control. Roll back / redeploy
-- milan-api WITHOUT the is_verified reads FIRST: otherwise the binding lookup
-- errors and every wa_bindings-routed WhatsApp number stays silent.
-- Every binding (including unapproved ones) is then answered again.
--
-- Drops constraint wa_bindings_verified_by_chk and the columns is_verified,
-- verified_at, verified_by of public.wa_bindings, ONLY when all three columns
-- carry the marker CREATED_BY_20261029290000_WA_BINDINGS_VERIFICATION
-- (otherwise REFUSE). The approval trail in those columns is lost.
-- Idempotent: without the columns it does nothing (NOTICE).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $rb$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029290000_WA_BINDINGS_VERIFICATION';
 v_marked int;
 v_present int;
BEGIN
 IF to_regclass('public.wa_bindings') IS NULL THEN
  RAISE NOTICE 'public.wa_bindings is absent; nothing to roll back';
  RETURN;
 END IF;
 SELECT count(*), count(*) FILTER (WHERE col_description(attrelid, attnum) IS NOT DISTINCT FROM v_marker)
   INTO v_present, v_marked
   FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.wa_bindings'::regclass AND attnum > 0 AND NOT attisdropped
    AND attname IN ('is_verified','verified_at','verified_by');
 IF v_present = 0 THEN
  RAISE NOTICE '20261029290000 not applied; nothing to roll back';
  RETURN;
 END IF;
 IF v_present <> 3 OR v_marked <> 3 THEN
  RAISE EXCEPTION 'wa_bindings verification columns are incomplete or unmarked (% present, % marked); refusing', v_present, v_marked;
 END IF;
 ALTER TABLE public.wa_bindings DROP CONSTRAINT IF EXISTS wa_bindings_verified_by_chk;
 ALTER TABLE public.wa_bindings DROP COLUMN is_verified, DROP COLUMN verified_at, DROP COLUMN verified_by;
END
$rb$;

COMMIT;
