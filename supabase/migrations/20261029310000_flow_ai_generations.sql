-- REVIEW ONLY: AI flow builder («مساعد الذكاء الاصطناعي») credits, paid BEFORE
-- the LLM call. NOT applied anywhere by this repository; apply only with an
-- explicit owner GO. Live state was NOT inspected; existing objects without
-- the marker are refused, never taken over.
--
-- Why a new table: the existing primitives cannot charge 5 credits once per
-- (tenant, request_id): widget_credit_reserve (20261029280000) debits exactly
-- ONE credit per key and stores no result; consume_reply / consume_flow_reply
-- need a persisted outgoing message; grant_credits is not idempotent.
--
-- Creates (all marked CREATED_BY_20261029310000_FLOW_AI_GENERATIONS):
--   table public.flow_ai_generations(tenant_id, request_id, prompt_sha256,
--     status reserved|committed|released, cost, charges, refunds, document,
--     reserved_at, updated_at), PRIMARY KEY (tenant_id, request_id).
--     prompt_sha256 = SHA-256 hex of the normalized prompt (no prompt text is
--     stored). document = the generated editor document, stored only when
--     committed (replayed for a duplicate request_id). State CHECK:
--       reserved  -> charges = refunds + 1, document NULL   (credits held)
--       committed -> charges = refunds + 1, document set    (paid, cached)
--       released  -> charges = refunds,     document NULL   (fully refunded)
--     so a row can never hold two charges or be refunded twice.
--     RLS enabled, NO policies; PUBLIC/anon/authenticated have no privilege;
--     service_role SELECT/INSERT/UPDATE/DELETE.
--   flow_ai_generation_reserve(p_tenant_id uuid, p_request_id uuid,
--     p_prompt_sha256 text, p_cost integer) RETURNS jsonb
--     Locks the tenant row (FOR UPDATE), then FIRST releases this tenant's
--     'reserved' rows older than 180 s (crashed / abandoned calls: refunded
--     exactly once, credits restored), then the row for p_request_id:
--       {"status":"reserved","remaining":n}   p_cost credits debited now
--       {"status":"in_flight"}                same request is running (< 180 s)
--       {"status":"cached","document":{..}}   already paid; no new debit
--       {"status":"mismatch"}                 request_id reused, other prompt
--       {"status":"no_credit"}                inactive or credits < p_cost (no change)
--       {"status":"invalid"}                  bad arguments / unknown tenant
--     A 'released' row is reserved again (retry after a refund is allowed).
--   flow_ai_generation_commit(p_tenant_id uuid, p_request_id uuid,
--     p_document jsonb) RETURNS text committed | already | not_reserved
--     Only a 'reserved' row becomes 'committed'; never debits.
--   flow_ai_generation_release(p_tenant_id uuid, p_request_id uuid)
--     RETURNS text released (cost given back once) | noop. Only a 'reserved'
--     row is released; never refunds a committed or released row.
--   All three: SECURITY DEFINER, SET search_path = '', EXECUTE revoked from
--   PUBLIC/anon/authenticated and granted to service_role only. Lock order is
--   always tenant row -> generation row (commit locks only the row).
--
-- Credits: public.tenants.credits_remaining, decremented with the same
-- "WHERE credits_remaining >= cost" guard as consume_reply / widget_credit_*,
-- so the balance never goes negative.
-- Idempotent: existing objects are accepted only with the marker; functions
-- are (re)created. Preflight refuses unless roles anon/authenticated/
-- service_role and public.tenants(id, credits_remaining, is_active) exist.
-- Order: independent of the flow-* chain and of 20261029240000..300000.
-- Apply BEFORE deploying generate-flow; without it the function fails CLOSED.
-- Rollback: supabase/rollbacks/20261029310000_flow_ai_generations.rollback.sql
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029310000_FLOW_AI_GENERATIONS';
 v_name text;
 v_sig text;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_name) THEN
   RAISE EXCEPTION 'flow ai generations prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 IF to_regclass('public.tenants') IS NULL THEN
  RAISE EXCEPTION 'flow ai generations prerequisite missing: table public.tenants';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['id','credits_remaining','is_active'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'public.tenants'::regclass AND attname = v_name AND attnum > 0 AND NOT attisdropped) THEN
   RAISE EXCEPTION 'flow ai generations prerequisite missing: column public.tenants.%', v_name;
  END IF;
 END LOOP;
 IF to_regclass('public.flow_ai_generations') IS NOT NULL
    AND obj_description(to_regclass('public.flow_ai_generations'),'pg_class') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'public.flow_ai_generations exists without marker %; refusing to take it over', v_marker;
 END IF;
 FOREACH v_sig IN ARRAY ARRAY['public.flow_ai_generation_reserve(uuid,uuid,text,integer)',
                              'public.flow_ai_generation_commit(uuid,uuid,jsonb)',
                              'public.flow_ai_generation_release(uuid,uuid)'] LOOP
  IF to_regprocedure(v_sig) IS NOT NULL
     AND obj_description(to_regprocedure(v_sig),'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION '% exists without marker %; refusing to replace it', v_sig, v_marker;
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc
            WHERE pronamespace='public'::regnamespace
              AND proname IN ('flow_ai_generation_reserve','flow_ai_generation_commit','flow_ai_generation_release')
              AND oid NOT IN (coalesce(to_regprocedure('public.flow_ai_generation_reserve(uuid,uuid,text,integer)'),0),
                              coalesce(to_regprocedure('public.flow_ai_generation_commit(uuid,uuid,jsonb)'),0),
                              coalesce(to_regprocedure('public.flow_ai_generation_release(uuid,uuid)'),0))) THEN
  RAISE EXCEPTION 'unexpected overload of flow_ai_generation_reserve/commit/release; refusing';
 END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.flow_ai_generations (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 prompt_sha256 text NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
 status text NOT NULL CHECK (status IN ('reserved','committed','released')),
 cost integer NOT NULL CHECK (cost BETWEEN 1 AND 100),
 charges integer NOT NULL DEFAULT 0 CHECK (charges >= 0),
 refunds integer NOT NULL DEFAULT 0 CHECK (refunds >= 0 AND refunds <= charges),
 document jsonb CHECK (document IS NULL OR (pg_catalog.jsonb_typeof(document) = 'object'
                       AND pg_catalog.octet_length(document::text) <= 1048576)),
 reserved_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, request_id),
 CONSTRAINT flow_ai_generations_state_chk CHECK (
  (status = 'reserved'  AND charges = refunds + 1 AND document IS NULL) OR
  (status = 'committed' AND charges = refunds + 1 AND document IS NOT NULL) OR
  (status = 'released'  AND charges = refunds     AND document IS NULL))
);
CREATE INDEX IF NOT EXISTS flow_ai_generations_reserved_idx
 ON public.flow_ai_generations (tenant_id, reserved_at) WHERE status = 'reserved';
COMMENT ON TABLE public.flow_ai_generations IS 'CREATED_BY_20261029310000_FLOW_AI_GENERATIONS';
ALTER TABLE public.flow_ai_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.flow_ai_generations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_ai_generations TO service_role;

CREATE OR REPLACE FUNCTION public.flow_ai_generation_reserve(
 p_tenant_id uuid, p_request_id uuid, p_prompt_sha256 text, p_cost integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $reserve$
DECLARE
 v_credits integer;
 v_active boolean;
 v_refund integer;
 v_row public.flow_ai_generations%ROWTYPE;
 v_remaining integer;
 v_n integer;
BEGIN
 IF p_tenant_id IS NULL OR p_request_id IS NULL OR p_prompt_sha256 IS NULL
    OR p_prompt_sha256 !~ '^[0-9a-f]{64}$' OR p_cost IS NULL OR p_cost < 1 OR p_cost > 100 THEN
  RETURN pg_catalog.jsonb_build_object('status', 'invalid');
 END IF;
 -- One tenant row lock serializes every reserve / release of this tenant,
 -- including concurrent duplicates of the same request_id.
 SELECT t.credits_remaining, t.is_active INTO v_credits, v_active
   FROM public.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN pg_catalog.jsonb_build_object('status', 'invalid');
 END IF;
 -- Stale sweep: a reservation older than 180 s outlived any generate-flow
 -- call (2 x 25 s LLM budget), so it crashed or was abandoned. Refund once.
 WITH swept AS (
  UPDATE public.flow_ai_generations g
     SET status = 'released', refunds = g.refunds + 1, updated_at = now()
   WHERE g.tenant_id = p_tenant_id AND g.status = 'reserved'
     AND g.reserved_at < now() - interval '180 seconds'
  RETURNING g.cost
 )
 SELECT coalesce(sum(s.cost), 0)::integer INTO v_refund FROM swept s;
 IF v_refund > 0 THEN
  UPDATE public.tenants t SET credits_remaining = t.credits_remaining + v_refund
   WHERE t.id = p_tenant_id RETURNING t.credits_remaining INTO v_credits;
 END IF;
 SELECT * INTO v_row FROM public.flow_ai_generations g
  WHERE g.tenant_id = p_tenant_id AND g.request_id = p_request_id FOR UPDATE;
 IF FOUND THEN
  IF v_row.prompt_sha256 <> p_prompt_sha256 THEN
   RETURN pg_catalog.jsonb_build_object('status', 'mismatch');
  END IF;
  IF v_row.status = 'reserved' THEN
   RETURN pg_catalog.jsonb_build_object('status', 'in_flight');
  END IF;
  IF v_row.status = 'committed' THEN
   RETURN pg_catalog.jsonb_build_object('status', 'cached', 'document', v_row.document);
  END IF;
  -- 'released': fully refunded earlier; a retry may reserve again.
 END IF;
 IF v_active IS NOT TRUE OR coalesce(v_credits, 0) < p_cost THEN
  RETURN pg_catalog.jsonb_build_object('status', 'no_credit');
 END IF;
 UPDATE public.tenants t SET credits_remaining = t.credits_remaining - p_cost
  WHERE t.id = p_tenant_id AND t.credits_remaining >= p_cost
  RETURNING t.credits_remaining INTO v_remaining;
 IF NOT FOUND THEN
  RETURN pg_catalog.jsonb_build_object('status', 'no_credit');
 END IF;
 INSERT INTO public.flow_ai_generations AS g
   (tenant_id, request_id, prompt_sha256, status, cost, charges, refunds, document, reserved_at, updated_at)
 VALUES (p_tenant_id, p_request_id, p_prompt_sha256, 'reserved', p_cost, 1, 0, NULL, now(), now())
 ON CONFLICT (tenant_id, request_id) DO UPDATE
   SET status = 'reserved', cost = EXCLUDED.cost, charges = g.charges + 1, document = NULL,
       reserved_at = now(), updated_at = now()
   WHERE g.status = 'released';
 GET DIAGNOSTICS v_n = ROW_COUNT;
 IF v_n <> 1 THEN
  -- Unreachable while the tenant row is locked; undo the debit if it ever is.
  RAISE EXCEPTION 'flow_ai_generation_reserve: reservation row changed unexpectedly' USING ERRCODE = '40001';
 END IF;
 RETURN pg_catalog.jsonb_build_object('status', 'reserved', 'remaining', v_remaining);
END
$reserve$;

CREATE OR REPLACE FUNCTION public.flow_ai_generation_commit(
 p_tenant_id uuid, p_request_id uuid, p_document jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $commit$
DECLARE
 v_status text;
BEGIN
 IF p_document IS NULL OR pg_catalog.jsonb_typeof(p_document) <> 'object'
    OR pg_catalog.jsonb_typeof(p_document -> 'nodes') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(p_document -> 'edges') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'flow_ai_generation_commit: invalid document' USING ERRCODE = '22023';
 END IF;
 UPDATE public.flow_ai_generations g
    SET status = 'committed', document = p_document, updated_at = now()
  WHERE g.tenant_id = p_tenant_id AND g.request_id = p_request_id AND g.status = 'reserved';
 IF FOUND THEN
  RETURN 'committed';
 END IF;
 SELECT g.status INTO v_status FROM public.flow_ai_generations g
  WHERE g.tenant_id = p_tenant_id AND g.request_id = p_request_id;
 RETURN CASE WHEN v_status = 'committed' THEN 'already' ELSE 'not_reserved' END;
END
$commit$;

CREATE OR REPLACE FUNCTION public.flow_ai_generation_release(p_tenant_id uuid, p_request_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $release$
DECLARE
 v_cost integer;
BEGIN
 -- Same lock order as flow_ai_generation_reserve: tenant row first.
 PERFORM 1 FROM public.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN 'noop';
 END IF;
 UPDATE public.flow_ai_generations g
    SET status = 'released', refunds = g.refunds + 1, updated_at = now()
  WHERE g.tenant_id = p_tenant_id AND g.request_id = p_request_id AND g.status = 'reserved'
  RETURNING g.cost INTO v_cost;
 IF NOT FOUND THEN
  RETURN 'noop';
 END IF;
 UPDATE public.tenants t SET credits_remaining = t.credits_remaining + v_cost WHERE t.id = p_tenant_id;
 RETURN 'released';
END
$release$;

COMMENT ON FUNCTION public.flow_ai_generation_reserve(uuid,uuid,text,integer) IS 'CREATED_BY_20261029310000_FLOW_AI_GENERATIONS';
COMMENT ON FUNCTION public.flow_ai_generation_commit(uuid,uuid,jsonb) IS 'CREATED_BY_20261029310000_FLOW_AI_GENERATIONS';
COMMENT ON FUNCTION public.flow_ai_generation_release(uuid,uuid) IS 'CREATED_BY_20261029310000_FLOW_AI_GENERATIONS';
REVOKE ALL ON FUNCTION public.flow_ai_generation_reserve(uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.flow_ai_generation_commit(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.flow_ai_generation_release(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flow_ai_generation_reserve(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_ai_generation_commit(uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_ai_generation_release(uuid,uuid) TO service_role;

COMMIT;
