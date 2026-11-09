-- REVIEW ONLY: DB-backed fixed-window rate limiter for milan-api abuse guards
-- (S3 public widget_message, S4 qa_extract / qa_save / ingest_text / qa_test /
-- knowledge_add). NOT applied anywhere by this repository; apply only with an
-- explicit owner GO.
--
-- Creates (all marked CREATED_BY_20261029250000_MILAN_RATE_LIMITS):
--   table    public.milan_rate_limits(bucket_key text, window_start timestamptz,
--            hits integer, PRIMARY KEY(bucket_key, window_start)) + index on
--            window_start; RLS enabled, NO policies; anon/authenticated/PUBLIC
--            have no privilege; service_role has SELECT/INSERT/UPDATE/DELETE.
--   function public.milan_rate_limit_hit(p_key text, p_limit integer,
--            p_window_seconds integer) RETURNS jsonb
--            {allowed, hits, retry_after}: one atomic
--            INSERT .. ON CONFLICT DO UPDATE hits=hits+1 per call.
--   function public.milan_rate_limit_prune(p_max integer) RETURNS integer:
--            deletes at most p_max windows older than 2 days (the hit
--            function calls it with probability 1/50, max 500 rows).
--   Both functions: SECURITY INVOKER, SET search_path = '', EXECUTE revoked
--   from PUBLIC/anon/authenticated and granted to service_role only.
-- Keys are opaque strings built by abuseGuards.ts (client IPs are SHA-256
-- hashed before they reach the DB; no customer text is stored).
--
-- Idempotent: an existing table/function is accepted only when it carries the
-- marker (otherwise refused, never taken over); functions are (re)created.
-- Preflight refuses unless roles anon / authenticated / service_role exist.
--
-- Order: independent of the flow-* chain and of 20261029240000; may be
-- applied before or after it. Deploy milan-api only AFTER this migration
-- (otherwise every limiter call fails and the stricter in-memory fallback is
-- used).
-- Rollback: supabase/rollbacks/20261029250000_milan_rate_limits.rollback.sql
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029250000_MILAN_RATE_LIMITS';
 v_name text;
 v_sig text;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_name) THEN
   RAISE EXCEPTION 'milan_rate_limits prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 IF to_regclass('public.milan_rate_limits') IS NOT NULL
    AND obj_description(to_regclass('public.milan_rate_limits'),'pg_class') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'public.milan_rate_limits exists without marker %; refusing to take it over', v_marker;
 END IF;
 FOREACH v_sig IN ARRAY ARRAY['public.milan_rate_limit_hit(text,integer,integer)','public.milan_rate_limit_prune(integer)'] LOOP
  IF to_regprocedure(v_sig) IS NOT NULL
     AND obj_description(to_regprocedure(v_sig),'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION '% exists without marker %; refusing to replace it', v_sig, v_marker;
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc
            WHERE pronamespace='public'::regnamespace AND proname IN ('milan_rate_limit_hit','milan_rate_limit_prune')
              AND oid NOT IN (coalesce(to_regprocedure('public.milan_rate_limit_hit(text,integer,integer)'),0),
                              coalesce(to_regprocedure('public.milan_rate_limit_prune(integer)'),0))) THEN
  RAISE EXCEPTION 'unexpected overload of milan_rate_limit_hit/milan_rate_limit_prune; refusing';
 END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.milan_rate_limits (
 bucket_key text NOT NULL CHECK (length(bucket_key) BETWEEN 1 AND 200),
 window_start timestamptz NOT NULL,
 hits integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
 PRIMARY KEY (bucket_key, window_start)
);
CREATE INDEX IF NOT EXISTS milan_rate_limits_window_idx ON public.milan_rate_limits (window_start);
COMMENT ON TABLE public.milan_rate_limits IS 'CREATED_BY_20261029250000_MILAN_RATE_LIMITS';
ALTER TABLE public.milan_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.milan_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.milan_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.milan_rate_limit_prune(p_max integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $prune$
DECLARE
 v_n integer;
BEGIN
 IF p_max IS NULL OR p_max < 1 OR p_max > 10000 THEN
  RAISE EXCEPTION 'milan_rate_limit_prune: p_max out of range' USING ERRCODE = '22023';
 END IF;
 DELETE FROM public.milan_rate_limits r
  WHERE r.ctid IN (SELECT o.ctid FROM public.milan_rate_limits o
                    WHERE o.window_start < now() - interval '2 days'
                    LIMIT p_max);
 GET DIAGNOSTICS v_n = ROW_COUNT;
 RETURN v_n;
END
$prune$;

CREATE OR REPLACE FUNCTION public.milan_rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $hit$
DECLARE
 v_start timestamptz;
 v_hits integer;
 v_retry integer;
BEGIN
 IF p_key IS NULL OR length(p_key) < 1 OR length(p_key) > 200 THEN
  RAISE EXCEPTION 'milan_rate_limit_hit: invalid key' USING ERRCODE = '22023';
 END IF;
 IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
  RAISE EXCEPTION 'milan_rate_limit_hit: p_limit out of range' USING ERRCODE = '22023';
 END IF;
 IF p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
  RAISE EXCEPTION 'milan_rate_limit_hit: p_window_seconds out of range' USING ERRCODE = '22023';
 END IF;
 v_start := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
 INSERT INTO public.milan_rate_limits AS r (bucket_key, window_start, hits)
 VALUES (p_key, v_start, 1)
 ON CONFLICT (bucket_key, window_start) DO UPDATE SET hits = r.hits + 1
 RETURNING r.hits INTO v_hits;
 v_retry := greatest(1, pg_catalog.ceil(extract(epoch FROM (v_start + pg_catalog.make_interval(secs => p_window_seconds) - now())))::integer);
 IF pg_catalog.random() < 0.02 THEN
  PERFORM public.milan_rate_limit_prune(500);
 END IF;
 RETURN pg_catalog.jsonb_build_object('allowed', v_hits <= p_limit, 'hits', v_hits, 'retry_after', v_retry);
END
$hit$;

COMMENT ON FUNCTION public.milan_rate_limit_prune(integer) IS 'CREATED_BY_20261029250000_MILAN_RATE_LIMITS';
COMMENT ON FUNCTION public.milan_rate_limit_hit(text,integer,integer) IS 'CREATED_BY_20261029250000_MILAN_RATE_LIMITS';
REVOKE ALL ON FUNCTION public.milan_rate_limit_prune(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.milan_rate_limit_hit(text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.milan_rate_limit_prune(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.milan_rate_limit_hit(text,integer,integer) TO service_role;

COMMIT;
