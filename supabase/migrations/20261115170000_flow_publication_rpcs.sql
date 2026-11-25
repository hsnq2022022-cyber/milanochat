-- REVIEW ONLY: Flow publication database RPCs. NOT applied anywhere by this repository; apply only
-- with an explicit owner GO. Never `supabase db push`.
--
-- WHY. flow-publication calls four SQL functions that no repository migration defined (their
-- definitions existed only on the unmerged branches feature/flows-live-publication-api and
-- review/flow-publication-security-gates: 285c9521 and abdda831). A database built from this repository
-- therefore could not publish or activate a Flow, and nothing pinned what production runs.
--
-- SOURCE OF TRUTH (verified, read only). On 2026-11-25 the production catalog was read with SELECT
-- statements only (pg_get_functiondef, pg_proc, pg_class, pg_constraint; no data table was read, nothing
-- was written). All four functions exist, once each (no overloads), owner postgres, SECURITY INVOKER,
-- VOLATILE, not STRICT, search_path="", EXECUTE for postgres and service_role only. Their bodies equal
-- (md5 of prosrc, raw and normalised) the historical review versions, with ONE difference:
--   flow_activate_revision: the tenant switch gate is `(s.test_only OR s.production_approved)`, i.e. the
--   historical `s.test_only` gate patched by supabase/proposals/automation_flow_production_approval.sql
--   (verified byte for byte: the historical body with exactly that replacement equals the live body).
-- The definitions below are those live bodies. The production approval gate is preserved; a test_only
-- only restriction is never reintroduced.
--
-- WHAT THIS DOES.
--  * Adopt or create. A function that already exists must be EXACTLY the verified definition (attributes
--    and body md5); then it is adopted untouched in meaning (the statement below re-states the identical
--    body). A missing one is created and given this migration's marker. Anything else (another body,
--    SECURITY DEFINER, another search_path, another overload) aborts the whole migration.
--  * flow_publication_rate_windows (the table flow_publication_rate_allow counts in): created only when
--    absent, with the installed shape; an existing one must have that exact shape and a known marker.
--  * The installed Flow runtime, switch and tenant tables are PREREQUISITES: checked, never changed.
--  * Grants: EXECUTE only for service_role (PUBLIC, anon, authenticated revoked); the rate table keeps
--    row level security and no client privilege.
-- IDEMPOTENT: a second run passes the guards and changes nothing. PRODUCTION: every object already
-- exists identically, so applying it there creates nothing and changes no behaviour.
-- ROLLBACK (rollbacks/20261115170000_flow_publication_rpcs.rollback.sql) removes only what this migration
-- created (marker CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS). Adopted production objects stay.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE r record; v_fn regprocedure; p record; v_rel regclass; v_created text := '|';
BEGIN
 -- (1) The installed tables and columns the four functions read and write must exist. This migration
 -- never creates or alters them (production-installed objects; fixtures mirror them for tests).
 FOR r IN SELECT * FROM (VALUES
  ('tenants','id'),('tenants','user_id'),('tenants','is_active'),
  ('channel_accounts','id'),('channel_accounts','tenant_id'),('channel_accounts','platform'),
  ('channel_accounts','is_active'),('channel_accounts','agent_enabled'),('channel_accounts','auto_reply'),
  ('automation_flow_global_switch','singleton'),('automation_flow_global_switch','enabled'),
  ('automation_flow_tenant_switches','tenant_id'),('automation_flow_tenant_switches','enabled'),
  ('automation_flow_tenant_switches','test_only'),('automation_flow_tenant_switches','production_approved'),
  ('automation_flow_publications','tenant_id'),('automation_flow_publications','flow_key'),
  ('automation_flow_publications','revision'),('automation_flow_publications','channel_account_id'),
  ('automation_flow_publications','platform'),('automation_flow_publications','document'),
  ('automation_flow_publications','published_by'),
  ('automation_flow_activations','tenant_id'),('automation_flow_activations','channel_account_id'),
  ('automation_flow_activations','platform'),('automation_flow_activations','flow_key'),
  ('automation_flow_activations','revision'),('automation_flow_activations','is_active'),
  ('automation_flow_activations','activated_at'),('automation_flow_activations','updated_at')
 ) c(t,col) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=to_regclass('public.'||r.t) AND a.attname=r.col AND a.attnum>0 AND NOT a.attisdropped) THEN
   RAISE EXCEPTION 'Missing public.%.%; the installed Flow runtime, switch and tenant tables are required first', r.t, r.col;
  END IF;
 END LOOP;
 -- flow_activate_revision upserts on this exact unique key.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
   WHERE i.indrelid='public.automation_flow_activations'::regclass AND i.indisunique
    AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
         JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)
        = ARRAY['tenant_id','channel_account_id','platform','flow_key']) THEN
  RAISE EXCEPTION 'public.automation_flow_activations lacks its unique (tenant_id,channel_account_id,platform,flow_key) key';
 END IF;
 -- (2) The rate window table: absent (created below) or exactly the installed shape; anything else is refused.
 v_rel := to_regclass('public.flow_publication_rate_windows');
 IF v_rel IS NULL THEN
  v_created := v_created||'rate_windows|';
 ELSE
  IF split_part(coalesce(obj_description(v_rel,'pg_class'),''),' ',1) NOT IN('CREATED_BY_20261028200000_FLOW_PUBLICATION_RATE_LIMIT','CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS')
   OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid=v_rel)
   OR (SELECT string_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||CASE WHEN a.attnotnull THEN ' NN' ELSE '' END,',' ORDER BY a.attnum)
       FROM pg_catalog.pg_attribute a WHERE a.attrelid=v_rel AND a.attnum>0 AND NOT a.attisdropped)
      IS DISTINCT FROM 'tenant_id uuid NN,window_start timestamp with time zone NN,request_count integer NN'
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=v_rel AND k.contype='p'
      AND pg_catalog.pg_get_constraintdef(k.oid)='PRIMARY KEY (tenant_id, window_start)')
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=v_rel AND k.contype='c'
      AND pg_catalog.pg_get_constraintdef(k.oid)='CHECK (((request_count >= 1) AND (request_count <= 30)))') THEN
   RAISE EXCEPTION 'Existing public.flow_publication_rate_windows is not the recognised rate limiter table; refusing to use it';
  END IF;
 END IF;
 -- (3) The four functions: no other overload; absent (created below) or exactly the verified production
 -- definition (attributes and body md5 of the whitespace-normalised prosrc). The comment may be empty,
 -- this migration's marker or the historical rate limiter marker. Anything else is drift: refuse.
 FOR r IN SELECT * FROM (VALUES
  ('flow_publish_revision','public.flow_publish_revision(uuid,uuid,text,text,uuid,jsonb)','p_tenant_id uuid, p_account_id uuid, p_platform text, p_flow_key text, p_actor_id uuid, p_document jsonb','bigint','0af572406d18d48d737d89fe4aa6b4db'),
  ('flow_activate_revision','public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid)','p_tenant_id uuid, p_account_id uuid, p_platform text, p_flow_key text, p_revision bigint, p_actor_id uuid','boolean','3b11ae1b179956791b1d13a663b03b03'),
  ('flow_deactivate_revision','public.flow_deactivate_revision(uuid,uuid,text,text,uuid)','p_tenant_id uuid, p_account_id uuid, p_platform text, p_flow_key text, p_actor_id uuid','boolean','c24977b58a9873b3946c25d186fad9d4'),
  ('flow_publication_rate_allow','public.flow_publication_rate_allow(uuid)','p_tenant_id uuid','boolean','539eecaaa05b083eda3b402e5b8b2193')
 ) f(name,sig,args,res,h) LOOP
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc x
    WHERE x.pronamespace='public'::regnamespace AND x.proname=r.name
     AND x.oid IS DISTINCT FROM to_regprocedure(r.sig)) THEN
   RAISE EXCEPTION 'Unrecognized overload of public.% exists; refusing to replace it', r.name;
  END IF;
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL THEN
   v_created := v_created||r.name||'|';
  ELSE
   SELECT x.* INTO p FROM pg_catalog.pg_proc x WHERE x.oid=v_fn;
   IF coalesce(obj_description(v_fn,'pg_proc'),'CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS') NOT IN('CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS','CREATED_BY_20261028200000_FLOW_PUBLICATION_RATE_LIMIT')
   OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
   OR p.prokind<>'f' OR p.prosecdef OR p.proisstrict OR p.provolatile<>'v'
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
   OR pg_catalog.pg_get_function_arguments(v_fn) IS DISTINCT FROM r.args
   OR pg_catalog.pg_get_function_result(v_fn) IS DISTINCT FROM r.res
   OR md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) IS DISTINCT FROM r.h THEN
    RAISE EXCEPTION 'Existing public.% differs from the verified production definition; refusing to replace it', r.name;
   END IF;
  END IF;
 END LOOP;
 -- What THIS migration creates (as opposed to adopts): only those get its marker and are removed by its rollback.
 PERFORM set_config('flow.publication_rpcs_created',v_created,true);
END
$guard$;

CREATE TABLE IF NOT EXISTS public.flow_publication_rate_windows (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 window_start timestamptz NOT NULL,
 request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 30),
 PRIMARY KEY (tenant_id,window_start),
 CHECK (window_start = date_trunc('minute',window_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
);
ALTER TABLE public.flow_publication_rate_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.flow_publication_rate_windows FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.flow_publication_rate_windows TO service_role;

CREATE OR REPLACE FUNCTION public.flow_publish_revision(
  p_tenant_id uuid,
  p_account_id uuid,
  p_platform text,
  p_flow_key text,
  p_actor_id uuid,
  p_document jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $publish$
DECLARE
  v_revision bigint;
  v_existing_account uuid;
BEGIN
  IF p_tenant_id IS NULL OR p_account_id IS NULL
    OR p_actor_id IS NULL OR p_platform IS NULL
    OR p_flow_key IS NULL OR p_flow_key !~ '^[A-Za-z0-9_-]{1,128}$'
    OR p_document IS NULL OR jsonb_typeof(p_document) IS DISTINCT FROM 'object'
    OR p_document->>'version' IS DISTINCT FROM '3'
    OR jsonb_typeof(p_document->'nodes') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_document->'edges') IS DISTINCT FROM 'array'
    OR octet_length(p_document::text)>4194304
  THEN RETURN NULL; END IF;

  -- Lock owner row BEFORE revision allocation, so parallel publishes cannot
  -- select the same MAX(revision)+1. This is a trusted service-role RPC.
  PERFORM 1 FROM public.tenants t
    WHERE t.id=p_tenant_id AND t.user_id=p_actor_id AND t.is_active
    FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.channel_accounts a
    WHERE a.id=p_account_id AND a.tenant_id=p_tenant_id
      AND a.platform=p_platform AND a.is_active IS TRUE
  ) THEN RETURN NULL; END IF;

  -- A flow key is bound to its original account/platform. A new revision
  -- cannot silently take over another Meta account of the same tenant.
  SELECT p.channel_account_id INTO v_existing_account
    FROM public.automation_flow_publications p
    WHERE p.tenant_id=p_tenant_id AND p.flow_key=p_flow_key
    LIMIT 1;
  IF v_existing_account IS NOT NULL AND
    (v_existing_account<>p_account_id OR EXISTS(
      SELECT 1 FROM public.automation_flow_publications p
      WHERE p.tenant_id=p_tenant_id AND p.flow_key=p_flow_key
        AND p.platform<>p_platform
    ))
  THEN RETURN NULL; END IF;

  SELECT COALESCE(MAX(p.revision),0)+1 INTO v_revision
  FROM public.automation_flow_publications p
  WHERE p.tenant_id=p_tenant_id AND p.flow_key=p_flow_key;

  INSERT INTO public.automation_flow_publications
  (tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
  VALUES(p_tenant_id,p_flow_key,v_revision,p_account_id,p_platform,p_document,p_actor_id);
  RETURN v_revision;
END
$publish$;

CREATE OR REPLACE FUNCTION public.flow_activate_revision(
  p_tenant_id uuid,
  p_account_id uuid,
  p_platform text,
  p_flow_key text,
  p_revision bigint,
  p_actor_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $activate$
BEGIN
  IF p_tenant_id IS NULL OR p_actor_id IS NULL OR p_account_id IS NULL OR
     p_revision IS NULL OR p_revision<1 OR p_flow_key IS NULL
  THEN RETURN FALSE; END IF;

  -- Serialize with any update to the global kill switch (row lock). Without
  -- both explicit ON flags and a test-only tenant, activate is impossible.
  PERFORM 1 FROM public.automation_flow_global_switch s
  WHERE s.singleton AND s.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  PERFORM 1 FROM public.automation_flow_tenant_switches s
  WHERE s.tenant_id=p_tenant_id AND s.enabled AND (s.test_only OR s.production_approved) FOR SHARE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenants t
      JOIN public.channel_accounts a ON a.tenant_id=t.id
    WHERE t.id=p_tenant_id AND t.user_id=p_actor_id AND t.is_active
      AND a.id=p_account_id AND a.platform=p_platform
      AND a.is_active IS TRUE AND a.agent_enabled IS TRUE
      AND a.auto_reply IS TRUE
  ) THEN RETURN FALSE; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.automation_flow_publications p
    WHERE p.tenant_id=p_tenant_id AND p.channel_account_id=p_account_id
      AND p.platform=p_platform AND p.flow_key=p_flow_key
      AND p.revision=p_revision
  ) THEN RETURN FALSE; END IF;

  INSERT INTO public.automation_flow_activations
    (tenant_id,channel_account_id,platform,flow_key,revision,is_active,activated_at)
  VALUES(p_tenant_id,p_account_id,p_platform,p_flow_key,p_revision,TRUE,now())
  ON CONFLICT(tenant_id,channel_account_id,platform,flow_key)
  DO UPDATE SET revision=EXCLUDED.revision,is_active=TRUE,
    activated_at=now(),updated_at=now();

  RETURN TRUE;
END
$activate$;

CREATE OR REPLACE FUNCTION public.flow_deactivate_revision(
  p_tenant_id uuid,
  p_account_id uuid,
  p_platform text,
  p_flow_key text,
  p_actor_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $deactivate$
BEGIN
  IF p_tenant_id IS NULL OR p_actor_id IS NULL OR p_account_id IS NULL
    OR p_flow_key IS NULL THEN RETURN FALSE; END IF;

  IF NOT EXISTS(SELECT 1 FROM public.tenants t
    WHERE t.id=p_tenant_id AND t.user_id=p_actor_id) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.automation_flow_activations a
  SET is_active=FALSE,updated_at=now()
  WHERE a.tenant_id=p_tenant_id AND a.channel_account_id=p_account_id
    AND a.platform=p_platform AND a.flow_key=p_flow_key;
  RETURN FOUND;
END
$deactivate$;

CREATE OR REPLACE FUNCTION public.flow_publication_rate_allow(p_tenant_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $limit$
DECLARE
 v_bucket timestamptz := date_trunc('minute',now());
 v_count integer;
BEGIN
 IF p_tenant_id IS NULL OR NOT EXISTS
  (SELECT 1 FROM public.tenants WHERE id=p_tenant_id) THEN
  RETURN FALSE;
 END IF;
 -- The PK row lock serializes increments across every Edge instance.
 INSERT INTO public.flow_publication_rate_windows(tenant_id,window_start,request_count)
 VALUES(p_tenant_id,v_bucket,1)
 ON CONFLICT(tenant_id,window_start) DO UPDATE
    SET request_count=public.flow_publication_rate_windows.request_count+1
    WHERE public.flow_publication_rate_windows.request_count < 30
 RETURNING request_count INTO v_count;
 -- Tenant-scoped retention: no global scan, no old customer rows changed.
 DELETE FROM public.flow_publication_rate_windows
 WHERE tenant_id=p_tenant_id AND window_start < v_bucket - interval '48 hours';
 RETURN v_count IS NOT NULL;
END
$limit$;

-- Marker only on what this migration created in this run (adopted objects keep their comment).
DO $finish$
DECLARE c text := current_setting('flow.publication_rpcs_created',true);
BEGIN
 IF c LIKE '%|rate_windows|%' THEN
  COMMENT ON TABLE public.flow_publication_rate_windows IS 'CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS';
 END IF;
 IF c LIKE '%|flow_publish_revision|%' THEN
  COMMENT ON FUNCTION public.flow_publish_revision(uuid,uuid,text,text,uuid,jsonb) IS 'CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS';
 END IF;
 IF c LIKE '%|flow_activate_revision|%' THEN
  COMMENT ON FUNCTION public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid) IS 'CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS';
 END IF;
 IF c LIKE '%|flow_deactivate_revision|%' THEN
  COMMENT ON FUNCTION public.flow_deactivate_revision(uuid,uuid,text,text,uuid) IS 'CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS';
 END IF;
 IF c LIKE '%|flow_publication_rate_allow|%' THEN
  COMMENT ON FUNCTION public.flow_publication_rate_allow(uuid) IS 'CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS';
 END IF;
END
$finish$;

REVOKE ALL ON FUNCTION public.flow_publish_revision(uuid,uuid,text,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_deactivate_revision(uuid,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_publication_rate_allow(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_publish_revision(uuid,uuid,text,text,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_deactivate_revision(uuid,uuid,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_publication_rate_allow(uuid) TO service_role;
COMMIT;
