-- 20261126100000_manual_credit_admin
-- Manual commercial administration for the launch without a payment gateway.
-- NEW objects only; nothing existing is altered, no data is written:
--   public.tenant_admin_actions                       append-only audit + credit ledger
--   public.admin_adjust_credits(uuid,uuid,integer,text,text)
--   public.admin_set_tenant_active(uuid,uuid,boolean,text,text)
-- Both functions are SECURITY DEFINER with an empty search_path, EXECUTE for service_role ONLY
-- (the tenant-admin Edge Function authenticates and authorises the operator first).
-- Atomic: one tenants row lock serialises every change of a tenant; a repeated
-- idempotency key can never apply twice; a deduction can never take the balance below zero.
-- Owners may read their own rows (reason, amount, balance, time) but never the operator id.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $guard$
BEGIN
  IF to_regclass('public.tenants') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.tenants'::regclass AND attname='credits_remaining' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.tenants'::regclass AND attname='is_active' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.tenants'::regclass AND attname='activated_at' AND NOT attisdropped)
  THEN RAISE EXCEPTION 'Refusing: public.tenants(credits_remaining,is_active,activated_at) missing'; END IF;
  IF to_regclass('public.tenant_admin_actions') IS NOT NULL
     AND coalesce(obj_description(to_regclass('public.tenant_admin_actions'),'pg_class'),'')<>'CREATED_BY_20261126100000_MANUAL_CREDIT_ADMIN'
  THEN RAISE EXCEPTION 'Refusing: public.tenant_admin_actions exists and is not owned by this migration'; END IF;
  IF to_regprocedure('public.admin_adjust_credits(uuid,uuid,integer,text,text)') IS NOT NULL
     AND coalesce(obj_description(to_regprocedure('public.admin_adjust_credits(uuid,uuid,integer,text,text)'),'pg_proc'),'')<>'CREATED_BY_20261126100000_MANUAL_CREDIT_ADMIN'
  THEN RAISE EXCEPTION 'Refusing: admin_adjust_credits exists and is not owned by this migration'; END IF;
  IF to_regprocedure('public.admin_set_tenant_active(uuid,uuid,boolean,text,text)') IS NOT NULL
     AND coalesce(obj_description(to_regprocedure('public.admin_set_tenant_active(uuid,uuid,boolean,text,text)'),'pg_proc'),'')<>'CREATED_BY_20261126100000_MANUAL_CREDIT_ADMIN'
  THEN RAISE EXCEPTION 'Refusing: admin_set_tenant_active exists and is not owned by this migration'; END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.tenant_admin_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  operator_id     uuid NOT NULL,
  action          text NOT NULL CHECK (action IN ('credit_grant','credit_deduct','activate','suspend')),
  amount          integer CHECK (amount IS NULL OR amount > 0),
  balance_after   integer,
  reason          text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((action IN ('credit_grant','credit_deduct')) = (amount IS NOT NULL))
);
COMMENT ON TABLE public.tenant_admin_actions IS 'CREATED_BY_20261126100000_MANUAL_CREDIT_ADMIN';
CREATE INDEX IF NOT EXISTS tenant_admin_actions_tenant_created_idx
  ON public.tenant_admin_actions (tenant_id, created_at DESC);

ALTER TABLE public.tenant_admin_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_admin_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, tenant_id, action, amount, balance_after, reason, created_at)
  ON public.tenant_admin_actions TO authenticated;
DROP POLICY IF EXISTS tenant_admin_actions_owner_read ON public.tenant_admin_actions;
CREATE POLICY tenant_admin_actions_owner_read ON public.tenant_admin_actions
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT t.id FROM public.tenants AS t WHERE t.user_id = (SELECT auth.uid())));

CREATE OR REPLACE FUNCTION public.admin_adjust_credits(
  p_tenant uuid, p_operator uuid, p_delta integer, p_reason text, p_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $adjust$
DECLARE
  v_bal  integer;
  v_new  integer;
  v_kind text;
  v_prev public.tenant_admin_actions%ROWTYPE;
  v_id   uuid;
BEGIN
  IF p_tenant IS NULL OR p_operator IS NULL OR p_delta IS NULL OR p_delta = 0 OR abs(p_delta) > 1000000
     OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500
     OR p_key IS NULL OR char_length(p_key) NOT BETWEEN 8 AND 100
  THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_arguments'); END IF;

  SELECT t.credits_remaining INTO v_bal FROM public.tenants AS t WHERE t.id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'tenant_not_found'); END IF;

  v_kind := CASE WHEN p_delta > 0 THEN 'credit_grant' ELSE 'credit_deduct' END;
  SELECT * INTO v_prev FROM public.tenant_admin_actions AS a
   WHERE a.tenant_id = p_tenant AND a.idempotency_key = p_key;
  IF FOUND THEN
    IF v_prev.operator_id IS DISTINCT FROM p_operator OR v_prev.action IS DISTINCT FROM v_kind
       OR v_prev.amount IS DISTINCT FROM abs(p_delta)
    THEN RETURN jsonb_build_object('ok', false, 'error', 'idempotency_conflict'); END IF;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'balance', v_prev.balance_after, 'action_id', v_prev.id);
  END IF;

  v_new := coalesce(v_bal, 0) + p_delta;
  IF v_new < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'insufficient_balance', 'balance', coalesce(v_bal, 0));
  END IF;
  UPDATE public.tenants SET credits_remaining = v_new WHERE id = p_tenant;
  INSERT INTO public.tenant_admin_actions (tenant_id, operator_id, action, amount, balance_after, reason, idempotency_key)
  VALUES (p_tenant, p_operator, v_kind, abs(p_delta), v_new, btrim(p_reason), p_key)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'balance', v_new, 'action_id', v_id);
END
$adjust$;
COMMENT ON FUNCTION public.admin_adjust_credits(uuid,uuid,integer,text,text) IS 'CREATED_BY_20261126100000_MANUAL_CREDIT_ADMIN';

CREATE OR REPLACE FUNCTION public.admin_set_tenant_active(
  p_tenant uuid, p_operator uuid, p_active boolean, p_reason text, p_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $active$
DECLARE
  v_cur  boolean;
  v_bal  integer;
  v_kind text;
  v_prev public.tenant_admin_actions%ROWTYPE;
  v_id   uuid;
BEGIN
  IF p_tenant IS NULL OR p_operator IS NULL OR p_active IS NULL
     OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500
     OR p_key IS NULL OR char_length(p_key) NOT BETWEEN 8 AND 100
  THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_arguments'); END IF;

  SELECT t.is_active, t.credits_remaining INTO v_cur, v_bal FROM public.tenants AS t WHERE t.id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'tenant_not_found'); END IF;

  v_kind := CASE WHEN p_active THEN 'activate' ELSE 'suspend' END;
  SELECT * INTO v_prev FROM public.tenant_admin_actions AS a
   WHERE a.tenant_id = p_tenant AND a.idempotency_key = p_key;
  IF FOUND THEN
    IF v_prev.operator_id IS DISTINCT FROM p_operator OR v_prev.action IS DISTINCT FROM v_kind
    THEN RETURN jsonb_build_object('ok', false, 'error', 'idempotency_conflict'); END IF;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'active', p_active, 'action_id', v_prev.id);
  END IF;
  IF v_cur IS NOT DISTINCT FROM p_active THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', false, 'unchanged', true, 'active', p_active);
  END IF;

  UPDATE public.tenants
     SET is_active = p_active,
         activated_at = CASE WHEN p_active THEN coalesce(activated_at, now()) ELSE activated_at END
   WHERE id = p_tenant;
  INSERT INTO public.tenant_admin_actions (tenant_id, operator_id, action, balance_after, reason, idempotency_key)
  VALUES (p_tenant, p_operator, v_kind, coalesce(v_bal, 0), btrim(p_reason), p_key)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'unchanged', false, 'active', p_active, 'action_id', v_id);
END
$active$;
COMMENT ON FUNCTION public.admin_set_tenant_active(uuid,uuid,boolean,text,text) IS 'CREATED_BY_20261126100000_MANUAL_CREDIT_ADMIN';

REVOKE ALL ON FUNCTION public.admin_adjust_credits(uuid,uuid,integer,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_tenant_active(uuid,uuid,boolean,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(uuid,uuid,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_tenant_active(uuid,uuid,boolean,text,text) TO service_role;
COMMIT;
