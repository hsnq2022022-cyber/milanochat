-- REVIEW ONLY: single-transaction, idempotent Wayl top-up grant for the
-- wayl-webhook Edge Function (supabase/functions/wayl-webhook/handler.ts).
-- NOT applied anywhere by this repository; apply only with an explicit owner GO.
--
-- Defect addressed: the handler claimed the payment (UPDATE payments SET
-- status='paid' ... WHERE status IN (...)), THEN called rpc grant_credits in a
-- SEPARATE request/transaction, and on a grant error tried to release the
-- claim with a third request. If grant_credits committed but its response was
-- lost, the release made the paid payment payable again and Wayl's retry
-- granted a second time; if the process died between claim and grant, the
-- payment stayed 'paid' without credits (a retry saw 'paid' and did nothing).
--
-- Adds ONE service-only function:
--   public.wayl_grant_topup_once(p_payment_id uuid, p_expected_amount integer,
--                                p_currency text, p_event jsonb) RETURNS jsonb
-- Everything happens in the caller's single transaction (one PostgREST RPC):
--  1. invalid arguments (NULL id/amount/currency, amount <= 0, p_event not a
--     JSON object) -> {granted:false, reason:'invalid_arguments'}, nothing read;
--  2. SELECT ... FOR UPDATE on the payments row (serialises every callback of
--     the same payment); missing -> 'not_found';
--  3. provider <> 'wayl' -> 'not_wayl'; status 'paid' -> 'already_paid'
--     (idempotent: nothing changes); any status other than the pre-payment
--     states created/creating/pending/pending_payment/creation_uncertain
--     (failed, refunded, cancelled, ...) -> 'not_payable';
--  4. stored currency must be 'IQD' and equal to upper(btrim(p_currency)),
--     else 'currency_mismatch'; stored amount must equal p_expected_amount,
--     else 'amount_mismatch'; credits_granted <> 0 on an unpaid row ->
--     'manual_review';
--  5. credits are taken ONLY from the locked, server-stored row, exactly like
--     the handler's creditsFor(): webhook_event.credits (written by the
--     server at creation, integer 1..1000000) when present, otherwise the
--     server package table 35000->1000, 85000->3000, 225000->10000 IQD;
--     none -> 'credits_unknown'. Nothing in p_event is ever read;
--  6. locks the payment's own tenants row FOR UPDATE (missing -> exception);
--     credits_remaining NULL or an int4 overflow -> 'manual_review' / 'credit_overflow';
--  7. UPDATE payments SET status='paid', paid_at=now(), credits_granted=<credits>,
--     webhook_event = <stored object> || {"wayl": p_event} (server keys such as
--     credits are preserved; the provider body is nested under "wayl");
--  8. PERFORM public.grant_credits(<row tenant>, <credits>) (the UNCHANGED live
--     function, so activation/side effects stay identical) and verifies the
--     tenant balance rose by exactly <credits>, else raises.
--  Any error in 6-8 raises and rolls back the WHOLE statement: the payment
--  stays in its previous state, so Wayl's retry can still grant exactly once.
--  Success -> {granted:true, reason:'granted', credits:<n>}.
-- Every non-granted result changes nothing.
--
-- Tenant isolation: the tenant is read only from the locked payments row;
-- the caller never supplies a tenant or a credit amount.
-- LANGUAGE plpgsql, SECURITY DEFINER (runs as the migration owner, which owns
-- grant_credits), SET search_path='' and every object schema-qualified;
-- EXECUTE revoked from PUBLIC, anon and authenticated, granted to
-- service_role only; a postcondition verifies it. No table, row, index,
-- trigger, policy, privilege of an existing object or existing function is
-- changed; no data is changed by this migration.
-- Additive and idempotent: CREATE OR REPLACE over this migration's own marked
-- body only; an unmarked function of this signature, a marked one with a
-- different body, or any other overload of this name is refused -- except the
-- REVIEW-ONLY 20261028230000_wayl_atomic_topup overload (uuid,integer) with
-- its own marker, which is left untouched (it has different parameter names,
-- so PostgREST named-argument resolution cannot confuse the two).
-- Ownership marker: CREATED_BY_20261115130000_WAYL_TOPUP_ATOMIC_GRANT
-- Body md5: md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))).
--
-- Deploy order: apply this migration FIRST, then deploy the wayl-webhook
-- build that calls it (that build fails closed with HTTP 500 -- Wayl retries --
-- while the function is missing; it never falls back to the old path).
-- Rollback: supabase/rollbacks/20261115130000_wayl_topup_atomic_grant.rollback.sql
-- (revert/redeploy wayl-webhook to a build that does not call this function
-- FIRST, then run the rollback).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path = '';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261115130000_WAYL_TOPUP_ATOMIC_GRANT';
 v_old_marker constant text := 'CREATED_BY_WAYL_ATOMIC_TOPUP_20261028230000';
 -- md5 of this migration's own normalized function body (same normalization).
 v_self_md5 constant text := '0ec288cd0a3ecdbbee673a8c703c8fe2';
 v_sig constant text := 'public.wayl_grant_topup_once(uuid,integer,text,jsonb)';
 v_name text;
 v_fn regprocedure;
 r record;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_name) THEN
   RAISE EXCEPTION 'Wayl atomic grant prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES
   ('payments','id','uuid'),('payments','tenant_id','uuid'),('payments','provider','text'),
   ('payments','amount','integer'),('payments','currency','text'),('payments','status','text'),
   ('payments','credits_granted','integer'),('payments','webhook_event','jsonb'),
   ('payments','paid_at','timestamp with time zone'),
   ('tenants','id','uuid'),('tenants','credits_remaining','integer')) t(rel,col,typ)
 LOOP
  IF to_regclass('public.'||r.rel) IS NULL THEN
   RAISE EXCEPTION 'Wayl atomic grant prerequisite missing: public.%', r.rel;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=to_regclass('public.'||r.rel) AND a.attname=r.col AND a.attnum>0
     AND NOT a.attisdropped AND pg_catalog.format_type(a.atttypid,a.atttypmod)=r.typ) THEN
   RAISE EXCEPTION 'Wayl atomic grant prerequisite missing: public.%.% %', r.rel, r.col, r.typ;
  END IF;
 END LOOP;
 -- payments.id must be unique (row lock by id targets exactly one row).
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='public.payments'::regclass AND c.contype IN ('p','u')
    AND c.conkey=ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='public.payments'::regclass AND a.attname='id')]::int2[]) THEN
  RAISE EXCEPTION 'Wayl atomic grant prerequisite missing: primary key public.payments(id)';
 END IF;
 v_fn := to_regprocedure('public.grant_credits(uuid,integer)');
 IF v_fn IS NULL THEN
  RAISE EXCEPTION 'Wayl atomic grant prerequisite missing: public.grant_credits(uuid,integer)';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=v_fn AND p.prosecdef
   AND p.prorettype='pg_catalog.void'::regtype) THEN
  RAISE EXCEPTION 'public.grant_credits(uuid,integer) is not the expected SECURITY DEFINER void function; refusing to install';
 END IF;
 -- Re-apply only over this migration's own function.
 v_fn := to_regprocedure(v_sig);
 IF v_fn IS NOT NULL THEN
  IF obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'Unrecognized existing function %; refusing to overwrite', v_sig;
  END IF;
  IF (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p WHERE p.oid=v_fn)
     IS DISTINCT FROM v_self_md5 THEN
   RAISE EXCEPTION 'Existing % carries the marker but not this migration''s body; refusing to overwrite', v_sig;
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='wayl_grant_topup_once'
    AND p.oid IS DISTINCT FROM v_fn
    AND NOT (p.oid=to_regprocedure('public.wayl_grant_topup_once(uuid,integer)')
             AND obj_description(p.oid,'pg_proc') IS NOT DISTINCT FROM v_old_marker)) THEN
  RAISE EXCEPTION 'Unrecognized overload of public.wayl_grant_topup_once exists; refusing to install';
 END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.wayl_grant_topup_once(
 p_payment_id uuid, p_expected_amount integer, p_currency text, p_event jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $waylgrant$
DECLARE
 v_pay record;
 v_prev jsonb;
 v_raw jsonb;
 v_credits integer;
 v_before integer;
 v_after integer;
BEGIN
 IF p_payment_id IS NULL OR p_expected_amount IS NULL OR p_expected_amount <= 0
    OR p_currency IS NULL OR p_event IS NULL OR pg_catalog.jsonb_typeof(p_event) IS DISTINCT FROM 'object' THEN
  RETURN pg_catalog.jsonb_build_object('granted',false,'reason','invalid_arguments','credits',0);
 END IF;
 -- Serialise every callback of this payment; the row is re-read after a wait.
 SELECT p.id, p.tenant_id, p.provider, p.amount, p.currency, p.status, p.credits_granted, p.webhook_event
   INTO v_pay
   FROM public.payments p
  WHERE p.id = p_payment_id
  FOR UPDATE;
 IF NOT FOUND THEN
  RETURN pg_catalog.jsonb_build_object('granted',false,'reason','not_found','credits',0);
 END IF;
 IF v_pay.provider IS DISTINCT FROM 'wayl' THEN
  RETURN pg_catalog.jsonb_build_object('granted',false,'reason','not_wayl','credits',0);
 END IF;
 IF v_pay.status = 'paid' THEN
  RETURN pg_catalog.jsonb_build_object('granted',false,'reason','already_paid','credits',0);
 END IF;
 IF v_pay.status IS NULL OR v_pay.status NOT IN ('created','creating','pending','pending_payment','creation_uncertain') THEN
  RETURN pg_catalog.jsonb_build_object('granted',false,'reason','not_payable','credits',0);
 END IF;
 IF v_pay.currency IS DISTINCT FROM 'IQD'
    OR pg_catalog.upper(pg_catalog.btrim(p_currency)) IS DISTINCT FROM v_pay.currency THEN
  RETURN pg_catalog.jsonb_build_object('granted',false,'reason','currency_mismatch','credits',0);
 END IF;
 IF v_pay.amount IS DISTINCT FROM p_expected_amount THEN
  RETURN pg_catalog.jsonb_build_object('granted',false,'reason','amount_mismatch','credits',0);
 END IF;
 IF v_pay.credits_granted IS NULL OR v_pay.credits_granted <> 0 THEN
  RETURN pg_catalog.jsonb_build_object('granted',false,'reason','manual_review','credits',0);
 END IF;
 -- Credits ONLY from the server-stored row (never from p_event).
 v_prev := CASE WHEN pg_catalog.jsonb_typeof(v_pay.webhook_event) = 'object'
                THEN v_pay.webhook_event ELSE '{}'::jsonb END;
 v_raw := v_prev -> 'credits';
 IF v_raw IS NOT NULL AND pg_catalog.jsonb_typeof(v_raw) <> 'null' THEN
  IF pg_catalog.jsonb_typeof(v_raw) IN ('number','string') AND (v_raw #>> '{}') ~ '^[0-9]{1,7}$' THEN
   v_credits := (v_raw #>> '{}')::integer;
  ELSE
   v_credits := 0;
  END IF;
 ELSE
  v_credits := CASE v_pay.amount WHEN 35000 THEN 1000 WHEN 85000 THEN 3000 WHEN 225000 THEN 10000 ELSE 0 END;
 END IF;
 IF v_credits IS NULL OR v_credits <= 0 OR v_credits > 1000000 THEN
  RETURN pg_catalog.jsonb_build_object('granted',false,'reason','credits_unknown','credits',0);
 END IF;
 -- Lock order: payments row, then the payment's own tenant row.
 SELECT t.credits_remaining INTO v_before
   FROM public.tenants t
  WHERE t.id = v_pay.tenant_id
  FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'wayl_grant_topup_once: tenant of payment not found';
 END IF;
 IF v_before IS NULL THEN
  RETURN pg_catalog.jsonb_build_object('granted',false,'reason','manual_review','credits',0);
 END IF;
 IF v_before > 2147483647 - v_credits THEN
  RETURN pg_catalog.jsonb_build_object('granted',false,'reason','credit_overflow','credits',0);
 END IF;
 UPDATE public.payments
    SET status = 'paid',
        paid_at = pg_catalog.now(),
        credits_granted = v_credits,
        webhook_event = v_prev || pg_catalog.jsonb_build_object('wayl', p_event)
  WHERE id = p_payment_id AND status = v_pay.status;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'wayl_grant_topup_once: payment claim failed';
 END IF;
 PERFORM public.grant_credits(v_pay.tenant_id, v_credits);
 SELECT t.credits_remaining INTO v_after FROM public.tenants t WHERE t.id = v_pay.tenant_id;
 IF v_after IS DISTINCT FROM v_before + v_credits THEN
  RAISE EXCEPTION 'wayl_grant_topup_once: tenant balance not credited';
 END IF;
 RETURN pg_catalog.jsonb_build_object('granted',true,'reason','granted','credits',v_credits);
END
$waylgrant$;
COMMENT ON FUNCTION public.wayl_grant_topup_once(uuid,integer,text,jsonb)
 IS 'CREATED_BY_20261115130000_WAYL_TOPUP_ATOMIC_GRANT';
REVOKE ALL ON FUNCTION public.wayl_grant_topup_once(uuid,integer,text,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.wayl_grant_topup_once(uuid,integer,text,jsonb)
 TO service_role;

DO $postcondition$
DECLARE
 v_fn regprocedure := to_regprocedure('public.wayl_grant_topup_once(uuid,integer,text,jsonb)');
BEGIN
 IF v_fn IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=v_fn AND p.prosecdef
   AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']) THEN
  RAISE EXCEPTION 'wayl_grant_topup_once was not installed as SECURITY DEFINER with search_path=''''';
 END IF;
 IF pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p,
              LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
              WHERE p.oid=v_fn AND a.grantee=0)
    OR NOT pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
  RAISE EXCEPTION 'wayl_grant_topup_once EXECUTE privileges are not service_role-only';
 END IF;
END
$postcondition$;
COMMIT;
