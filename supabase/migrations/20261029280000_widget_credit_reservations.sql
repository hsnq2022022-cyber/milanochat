-- REVIEW ONLY: S8 — public Widget answers are paid for BEFORE the LLM call.
-- NOT applied anywhere by this repository; apply only with an explicit owner
-- GO. Live state was NOT inspected; existing objects without the marker are
-- refused, never taken over.
--
-- Problem (supabase/functions/milan-api/index.ts widget_message): the only
-- debit (consume_widget_reply, behind WIDGET_BILLING_V2_ENABLED, default OFF)
-- ran AFTER the answer was saved, so with the flag off a tenant with credits
-- 1 got unlimited free answers (only credits <= 0 was refused).
-- consume_widget_reply needs an already-saved outgoing widget message id
-- (its SQL is not in this repository), so it cannot reserve before the LLM.
--
-- Creates (all marked CREATED_BY_20261029280000_WIDGET_CREDIT_RESERVATIONS):
--   table public.widget_credit_reservations(tenant_id, idem_key, session_id,
--     status reserved|committed|released, charges, refunds,
--     answer_message_id, reserved_at, updated_at), PRIMARY KEY
--     (tenant_id, idem_key). idem_key = 'w1:' + SHA-256 hex built by
--     milan-api widgetBilling.ts from the widget session id + client message
--     id (or message hash); no customer text is stored. RLS enabled, NO
--     policies; PUBLIC/anon/authenticated have no privilege; service_role
--     SELECT/INSERT/UPDATE/DELETE.
--   widget_credit_reserve(p_tenant_id uuid, p_session_id uuid, p_key text,
--     p_replay_seconds integer) RETURNS jsonb {status, remaining,
--     answer_message_id}. Locks the tenant row (FOR UPDATE) then the
--     reservation row. status:
--       reserved   one credit debited now (inactive / credits <= 0 -> no_credit)
--       resumed    a reservation older than 300 s that never finished is
--                  reused WITHOUT a new debit (net one charge)
--       in_flight  the same key is being answered right now (no debit)
--       duplicate  the same key was answered within p_replay_seconds (no
--                  debit; answer_message_id returned for replay)
--       no_credit  tenant inactive or credits_remaining <= 0 (no change)
--       invalid    unknown tenant / key bound to another session
--     A released key, or a committed key older than p_replay_seconds, is
--     debited again (a new question).
--   widget_credit_commit(p_tenant_id uuid, p_key text, p_answer_message_id uuid)
--     RETURNS text committed|already|not_reserved
--   widget_credit_release(p_tenant_id uuid, p_key text) RETURNS text
--     released (credit given back, refunds+1) | noop. Never refunds a
--     committed reservation.
--   All three: SECURITY INVOKER, SET search_path = '', EXECUTE revoked from
--   PUBLIC/anon/authenticated and granted to service_role only.
--
-- Idempotent: existing objects are accepted only with the marker; functions
-- are (re)created.
-- Preflight refuses unless roles anon/authenticated/service_role and
-- public.tenants(id, credits_remaining, is_active) exist; refuses unmarked
-- objects of the same names and unexpected overloads.
--
-- Order: independent of the flow-* chain and of 20261029240000..270000.
-- Apply BEFORE deploying milan-api with widgetBilling.ts: without these
-- functions the Widget fails CLOSED (no LLM call, polite error reply).
-- Rollback: supabase/rollbacks/20261029280000_widget_credit_reservations.rollback.sql
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029280000_WIDGET_CREDIT_RESERVATIONS';
 v_name text;
 v_sig text;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_name) THEN
   RAISE EXCEPTION 'widget credit reservations prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 IF to_regclass('public.tenants') IS NULL THEN
  RAISE EXCEPTION 'widget credit reservations prerequisite missing: table public.tenants';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['id','credits_remaining','is_active'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'public.tenants'::regclass AND attname = v_name AND attnum > 0 AND NOT attisdropped) THEN
   RAISE EXCEPTION 'widget credit reservations prerequisite missing: column public.tenants.%', v_name;
  END IF;
 END LOOP;
 IF to_regclass('public.widget_credit_reservations') IS NOT NULL
    AND obj_description(to_regclass('public.widget_credit_reservations'),'pg_class') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'public.widget_credit_reservations exists without marker %; refusing to take it over', v_marker;
 END IF;
 FOREACH v_sig IN ARRAY ARRAY['public.widget_credit_reserve(uuid,uuid,text,integer)',
                              'public.widget_credit_commit(uuid,text,uuid)',
                              'public.widget_credit_release(uuid,text)'] LOOP
  IF to_regprocedure(v_sig) IS NOT NULL
     AND obj_description(to_regprocedure(v_sig),'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION '% exists without marker %; refusing to replace it', v_sig, v_marker;
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc
            WHERE pronamespace='public'::regnamespace
              AND proname IN ('widget_credit_reserve','widget_credit_commit','widget_credit_release')
              AND oid NOT IN (coalesce(to_regprocedure('public.widget_credit_reserve(uuid,uuid,text,integer)'),0),
                              coalesce(to_regprocedure('public.widget_credit_commit(uuid,text,uuid)'),0),
                              coalesce(to_regprocedure('public.widget_credit_release(uuid,text)'),0))) THEN
  RAISE EXCEPTION 'unexpected overload of widget_credit_reserve/commit/release; refusing';
 END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.widget_credit_reservations (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 idem_key text NOT NULL CHECK (idem_key ~ '^w1:[0-9a-f]{64}$'),
 session_id uuid NOT NULL,
 status text NOT NULL CHECK (status IN ('reserved','committed','released')),
 charges integer NOT NULL DEFAULT 0 CHECK (charges >= 0),
 refunds integer NOT NULL DEFAULT 0 CHECK (refunds >= 0 AND refunds <= charges),
 answer_message_id uuid,
 reserved_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, idem_key)
);
CREATE INDEX IF NOT EXISTS widget_credit_reservations_updated_idx ON public.widget_credit_reservations (updated_at);
COMMENT ON TABLE public.widget_credit_reservations IS 'CREATED_BY_20261029280000_WIDGET_CREDIT_RESERVATIONS';
ALTER TABLE public.widget_credit_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.widget_credit_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.widget_credit_reservations TO service_role;

CREATE OR REPLACE FUNCTION public.widget_credit_reserve(
 p_tenant_id uuid, p_session_id uuid, p_key text, p_replay_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $reserve$
DECLARE
 v_credits integer;
 v_active boolean;
 v_row public.widget_credit_reservations%ROWTYPE;
 v_remaining integer;
BEGIN
 IF p_key IS NULL OR p_key !~ '^w1:[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'widget_credit_reserve: invalid key' USING ERRCODE = '22023';
 END IF;
 IF p_replay_seconds IS NULL OR p_replay_seconds < 1 OR p_replay_seconds > 86400 THEN
  RAISE EXCEPTION 'widget_credit_reserve: p_replay_seconds out of range' USING ERRCODE = '22023';
 END IF;
 IF p_tenant_id IS NULL OR p_session_id IS NULL THEN
  RETURN pg_catalog.jsonb_build_object('status', 'invalid');
 END IF;
 -- One tenant row lock serializes every reserve / release of this tenant.
 SELECT t.credits_remaining, t.is_active INTO v_credits, v_active
   FROM public.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN pg_catalog.jsonb_build_object('status', 'invalid');
 END IF;
 SELECT * INTO v_row FROM public.widget_credit_reservations r
  WHERE r.tenant_id = p_tenant_id AND r.idem_key = p_key FOR UPDATE;
 IF FOUND THEN
  IF v_row.session_id <> p_session_id THEN
   RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF v_row.status = 'reserved' THEN
   IF v_row.reserved_at > now() - interval '300 seconds' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'in_flight');
   END IF;
   UPDATE public.widget_credit_reservations r SET reserved_at = now(), updated_at = now()
    WHERE r.tenant_id = p_tenant_id AND r.idem_key = p_key;
   RETURN pg_catalog.jsonb_build_object('status', 'resumed', 'remaining', v_credits);
  END IF;
  IF v_row.status = 'committed'
     AND v_row.updated_at > now() - pg_catalog.make_interval(secs => p_replay_seconds) THEN
   RETURN pg_catalog.jsonb_build_object('status', 'duplicate', 'answer_message_id', v_row.answer_message_id);
  END IF;
 END IF;
 IF v_active IS NOT TRUE OR coalesce(v_credits, 0) <= 0 THEN
  RETURN pg_catalog.jsonb_build_object('status', 'no_credit');
 END IF;
 UPDATE public.tenants t SET credits_remaining = t.credits_remaining - 1
  WHERE t.id = p_tenant_id AND t.credits_remaining > 0
  RETURNING t.credits_remaining INTO v_remaining;
 IF NOT FOUND THEN
  RETURN pg_catalog.jsonb_build_object('status', 'no_credit');
 END IF;
 INSERT INTO public.widget_credit_reservations AS r
   (tenant_id, idem_key, session_id, status, charges, refunds, answer_message_id, reserved_at, updated_at)
 VALUES (p_tenant_id, p_key, p_session_id, 'reserved', 1, 0, NULL, now(), now())
 ON CONFLICT (tenant_id, idem_key) DO UPDATE
   SET status = 'reserved', charges = r.charges + 1, answer_message_id = NULL,
       reserved_at = now(), updated_at = now();
 RETURN pg_catalog.jsonb_build_object('status', 'reserved', 'remaining', v_remaining);
END
$reserve$;

CREATE OR REPLACE FUNCTION public.widget_credit_commit(
 p_tenant_id uuid, p_key text, p_answer_message_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $commit$
DECLARE
 v_status text;
BEGIN
 UPDATE public.widget_credit_reservations r
    SET status = 'committed', answer_message_id = p_answer_message_id, updated_at = now()
  WHERE r.tenant_id = p_tenant_id AND r.idem_key = p_key AND r.status = 'reserved';
 IF FOUND THEN
  RETURN 'committed';
 END IF;
 SELECT r.status INTO v_status FROM public.widget_credit_reservations r
  WHERE r.tenant_id = p_tenant_id AND r.idem_key = p_key;
 RETURN CASE WHEN v_status = 'committed' THEN 'already' ELSE 'not_reserved' END;
END
$commit$;

CREATE OR REPLACE FUNCTION public.widget_credit_release(p_tenant_id uuid, p_key text)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $release$
BEGIN
 -- Same lock order as widget_credit_reserve: tenant row first.
 PERFORM 1 FROM public.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN 'noop';
 END IF;
 UPDATE public.widget_credit_reservations r
    SET status = 'released', refunds = r.refunds + 1, updated_at = now()
  WHERE r.tenant_id = p_tenant_id AND r.idem_key = p_key AND r.status = 'reserved';
 IF NOT FOUND THEN
  RETURN 'noop';
 END IF;
 UPDATE public.tenants t SET credits_remaining = t.credits_remaining + 1 WHERE t.id = p_tenant_id;
 RETURN 'released';
END
$release$;

COMMENT ON FUNCTION public.widget_credit_reserve(uuid,uuid,text,integer) IS 'CREATED_BY_20261029280000_WIDGET_CREDIT_RESERVATIONS';
COMMENT ON FUNCTION public.widget_credit_commit(uuid,text,uuid) IS 'CREATED_BY_20261029280000_WIDGET_CREDIT_RESERVATIONS';
COMMENT ON FUNCTION public.widget_credit_release(uuid,text) IS 'CREATED_BY_20261029280000_WIDGET_CREDIT_RESERVATIONS';
REVOKE ALL ON FUNCTION public.widget_credit_reserve(uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.widget_credit_commit(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.widget_credit_release(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.widget_credit_reserve(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.widget_credit_commit(uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.widget_credit_release(uuid,text) TO service_role;

COMMIT;
