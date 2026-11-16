-- REVIEW ONLY rollback for 20261115130000_wayl_topup_atomic_grant.
-- NOT applied anywhere by this repository.
--
-- Drops ONLY public.wayl_grant_topup_once(uuid,integer,text,jsonb) and only
-- while it carries the marker CREATED_BY_20261115130000_WAYL_TOPUP_ATOMIC_GRANT
-- AND the exact normalized body of that migration (an unmarked function, or a
-- marked one with a foreign body, is refused, never dropped). Nothing else is
-- touched: payments rows, tenants balances, grant_credits, privileges and the
-- REVIEW-ONLY 20261028230000 overload wayl_grant_topup_once(uuid,integer) stay
-- exactly as they are. Running it a second time is refused (nothing to roll
-- back) and changes nothing.
--
-- Order: redeploy wayl-webhook to a build that does not call this function
-- FIRST (the current build fails closed with HTTP 500 while it is missing, so
-- Wayl keeps retrying and no top-up is granted), then run this rollback.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path = '';

DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261115130000_WAYL_TOPUP_ATOMIC_GRANT';
 v_self_md5 constant text := '0ec288cd0a3ecdbbee673a8c703c8fe2';
 v_fn regprocedure := to_regprocedure('public.wayl_grant_topup_once(uuid,integer,text,jsonb)');
BEGIN
 IF v_fn IS NULL THEN
  RAISE EXCEPTION '20261115130000_wayl_topup_atomic_grant not installed; nothing to roll back';
 END IF;
 IF obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Refusing to drop unrecognized function public.wayl_grant_topup_once (marker=%)',
   coalesce(obj_description(v_fn,'pg_proc'),'-');
 END IF;
 IF (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p WHERE p.oid=v_fn)
    IS DISTINCT FROM v_self_md5 THEN
  RAISE EXCEPTION 'Refusing to drop public.wayl_grant_topup_once: marked but its body is not the 20261115130000 definition';
 END IF;
END
$g$;

DROP FUNCTION public.wayl_grant_topup_once(uuid,integer,text,jsonb);
COMMIT;
