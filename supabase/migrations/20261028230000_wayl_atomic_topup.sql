-- REVIEW ONLY. Atomic, idempotent Wayl credit grant. NEVER apply without separate SQL GO.
-- Compatible with existing payments(id,tenant_id,provider,amount,currency,status,
-- credits_granted,paid_at) and tenants(credits_remaining) schema.
BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('public.wayl_grant_topup_once(uuid,integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'Wayl atomic credit RPC already installed';END IF;
 IF to_regclass('public.payments') IS NULL OR to_regclass('public.tenants') IS NULL
 THEN RAISE EXCEPTION 'Required payment/tenant tables absent';END IF;
END $guard$;
CREATE FUNCTION public.wayl_grant_topup_once(p_payment uuid,p_paid_iqd integer)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $grant$
DECLARE p record; credits integer;
BEGIN
 IF p_payment IS NULL OR p_paid_iqd IS NULL OR p_paid_iqd<=0
 THEN RETURN 'invalid'; END IF;
 -- Serialize all callbacks for the same payment. Any failure rolls back
 -- BOTH credit increment and payment status within one transaction.
 SELECT id,tenant_id,provider,amount,currency,status,credits_granted INTO p
 FROM public.payments WHERE id=p_payment FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_found';END IF;
 IF p.provider IS DISTINCT FROM 'wayl' OR p.currency IS DISTINCT FROM 'IQD'
 THEN RETURN 'invalid';END IF;
 IF p.amount IS DISTINCT FROM p_paid_iqd THEN RETURN 'amount_mismatch';END IF;
 IF p.status='paid' AND p.credits_granted>0 THEN RETURN 'already_applied';END IF;
 IF p.status NOT IN ('creating','pending_payment','creation_uncertain')
    OR p.credits_granted<>0 THEN RETURN 'manual_review';END IF;
 credits:=CASE p.amount WHEN 35000 THEN 1000 WHEN 85000 THEN 3000
                    WHEN 225000 THEN 10000 ELSE NULL END;
 IF credits IS NULL THEN RETURN 'unknown_package';END IF;
 -- Do not override any administrator-disabled tenant.is_active status.
 UPDATE public.tenants SET credits_remaining=credits_remaining+credits
 WHERE id=p.tenant_id AND credits_remaining <= 2147483647-credits;
 IF NOT FOUND THEN RETURN 'tenant_unavailable';END IF;
 UPDATE public.payments SET status='paid',credits_granted=credits,paid_at=now()
 WHERE id=p_payment;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payment status update failed';END IF;
 RETURN 'applied';
END $grant$;
COMMENT ON FUNCTION public.wayl_grant_topup_once(uuid,integer)
 IS 'CREATED_BY_WAYL_ATOMIC_TOPUP_20261028230000';
REVOKE ALL ON FUNCTION public.wayl_grant_topup_once(uuid,integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.wayl_grant_topup_once(uuid,integer)
 TO service_role;
COMMIT;
