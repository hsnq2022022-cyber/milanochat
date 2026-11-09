-- REVIEW ONLY: S6 — match_knowledge must never return another tenant's
-- knowledge chunks. NOT applied anywhere by this repository; apply only with
-- an explicit owner GO. Live state was NOT inspected: this migration is
-- defensive and REFUSES on any definition other than the exact schema.sql one.
--
-- Problem (supabase/schema.sql, public.match_knowledge):
--   LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, tenant taken
--   from the p_tenant_id PARAMETER, EXECUTE never revoked from PUBLIC
--   -> anyone holding the anon key can POST /rest/v1/rpc/match_knowledge with
--      any tenant id and read that tenant's knowledge chunks (owner rights
--      bypass the chunks_owner RLS policy).
--
-- Callers (all service role): milan-api answerFromKnowledge + qa_test
-- (sbAdmin), flow-outbox-worker flowKnowledge.ts (service-role client),
-- server/src/rag/qa.ts (db = service-role client). src/ never calls it.
--
-- Changes (signature, argument names, defaults and result shape unchanged):
--   CREATE OR REPLACE FUNCTION public.match_knowledge(uuid, <s>.vector, integer, real)
--     LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
--     body fully schema-qualified (OPERATOR(<s>.<=>), where <s> is the schema
--     of the existing p_query type, read from the catalog) with an in-function
--     tenant guard: rows are returned only when the caller is service_role
--     (current_user, exact under SECURITY INVOKER) OR p_tenant_id belongs to
--     auth.uid() (public.tenants.user_id). Any other caller gets NO rows.
--     As SECURITY INVOKER the knowledge_chunks RLS (chunks_owner) also applies
--     to every non-BYPASSRLS caller.
--   REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ... TO service_role.
--
-- knowledge_chunks / knowledge_sources RLS (chunks_owner / sources_owner,
-- FOR ALL, owner-only USING) has no cross-tenant read path and is NOT changed.
--
-- Rollback bookkeeping: the previous EXECUTE grants of PUBLIC / anon /
-- authenticated / service_role are recorded in COMMENT ON FUNCTION
-- public.match_knowledge (marker prefix
-- CREATED_BY_20261029260000_MATCH_KNOWLEDGE_TENANT_GUARD). The rollback
-- restores the exact schema.sql body/attributes and those grants.
--
-- Idempotent: a re-run with the marked function keeps the ORIGINAL recorded
-- state and re-applies the same definition and grants.
-- Preflight refuses when: roles anon/authenticated/service_role, auth.uid(),
-- public.tenants or public.knowledge_chunks are missing; there is not exactly
-- one public.match_knowledge; its arguments/result/language/volatility/
-- security/search_path/body differ from schema.sql (e.g. a variant with a
-- double precision p_threshold); it carries any comment other than the marker;
-- the <=> operator is missing in the vector type's schema.
--
-- Order: independent of the flow-* chain and of 20261029240000/250000.
-- Deploy-safe before or after any function deploy (all callers use the
-- service role; nothing to redeploy).
-- Rollback: supabase/rollbacks/20261029260000_match_knowledge_tenant_guard.rollback.sql
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029260000_MATCH_KNOWLEDGE_TENANT_GUARD';
 v_legacy_src constant text := E'\n  select kc.id, kc.content, 1 - (kc.embedding <=> p_query)::real as similarity\n    from public.knowledge_chunks kc\n   where kc.tenant_id = p_tenant_id\n     and kc.embedding is not null\n     and 1 - (kc.embedding <=> p_query) > p_threshold\n   order by kc.embedding <=> p_query\n   limit p_limit;\n';
 v_name text;
 v_n int;
 v_p record;
 v_note text;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_name) THEN
   RAISE EXCEPTION 'match_knowledge guard prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 IF to_regprocedure('auth.uid()') IS NULL THEN
  RAISE EXCEPTION 'match_knowledge guard prerequisite missing: function auth.uid()';
 END IF;
 IF to_regclass('public.tenants') IS NULL OR to_regclass('public.knowledge_chunks') IS NULL THEN
  RAISE EXCEPTION 'match_knowledge guard prerequisite missing: public.tenants / public.knowledge_chunks';
 END IF;
 SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'match_knowledge';
 IF v_n <> 1 THEN
  RAISE EXCEPTION 'expected exactly one public.match_knowledge, found %; refusing', v_n;
 END IF;
 SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig, p.provolatile, l.lanname AS lang,
        regexp_replace(pg_catalog.pg_get_function_arguments(p.oid), '([a-z_]+\.)?vector', 'vector', 'g') AS args,
        pg_catalog.pg_get_function_result(p.oid) AS res,
        tn.nspname AS vschema, t.typname AS vtype
   INTO v_p
   FROM pg_catalog.pg_proc p
   JOIN pg_catalog.pg_language l ON l.oid = p.prolang
   JOIN pg_catalog.pg_type t ON t.oid = p.proargtypes[1]
   JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'match_knowledge';
 IF v_p.args IS DISTINCT FROM 'p_tenant_id uuid, p_query vector, p_limit integer DEFAULT 6, p_threshold real DEFAULT 0.25'
    OR v_p.res IS DISTINCT FROM 'TABLE(id uuid, content text, similarity real)'
    OR v_p.vtype <> 'vector' OR v_p.lang <> 'sql' OR v_p.provolatile <> 's' THEN
  RAISE EXCEPTION 'public.match_knowledge has an unexpected signature (args=%, result=%, lang=%); refusing', v_p.args, v_p.res, v_p.lang;
 END IF;
 IF to_regoperator(format('%I.<=>(%I.vector,%I.vector)', v_p.vschema, v_p.vschema, v_p.vschema)) IS NULL THEN
  RAISE EXCEPTION 'operator %.<=>(vector,vector) not found; refusing', v_p.vschema;
 END IF;
 v_note := obj_description(v_p.oid, 'pg_proc');
 IF v_note IS NULL THEN
  -- not applied yet: must be EXACTLY the schema.sql definition
  IF NOT v_p.prosecdef OR v_p.proconfig IS DISTINCT FROM ARRAY['search_path=public']
     OR v_p.prosrc IS DISTINCT FROM v_legacy_src THEN
   RAISE EXCEPTION 'public.match_knowledge differs from the schema.sql definition (prosecdef=%, config=%); refusing', v_p.prosecdef, v_p.proconfig;
  END IF;
 ELSIF left(v_note, length(v_marker)) <> v_marker THEN
  RAISE EXCEPTION 'public.match_knowledge carries an unexpected comment; refusing';
 ELSIF v_p.prosecdef OR v_p.proconfig IS DISTINCT FROM ARRAY['search_path=""'] THEN
  RAISE EXCEPTION 'marked public.match_knowledge was altered after 20261029260000; refusing';
 END IF;
END
$preflight$;

DO $apply$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029260000_MATCH_KNOWLEDGE_TENANT_GUARD';
 v_oid oid;
 v_state text;
 v_role text;
 v_acl aclitem[];
 v_schema text;
BEGIN
 SELECT p.oid, tn.nspname INTO v_oid, v_schema
   FROM pg_catalog.pg_proc p
   JOIN pg_catalog.pg_type t ON t.oid = p.proargtypes[1]
   JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'match_knowledge';
 v_state := obj_description(v_oid, 'pg_proc');
 IF v_state IS NULL THEN
  -- First run: record the exact previous EXECUTE grants.
  SELECT coalesce(p.proacl, acldefault('f', p.proowner)) INTO v_acl FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  v_state := v_marker || '|';
  FOREACH v_role IN ARRAY ARRAY['public','anon','authenticated','service_role'] LOOP
   v_state := v_state || 'exec.' || v_role || '=' ||
    CASE WHEN EXISTS (SELECT 1 FROM aclexplode(v_acl) a
                       WHERE a.privilege_type = 'EXECUTE'
                         AND a.grantee = CASE WHEN v_role = 'public' THEN 0::oid
                                              ELSE (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) END)
         THEN 'X' ELSE '' END || ';';
  END LOOP;
 END IF;

 EXECUTE format($def$
CREATE OR REPLACE FUNCTION public.match_knowledge(
  p_tenant_id uuid,
  p_query     %1$I.vector,
  p_limit     integer default 6,
  p_threshold real    default 0.25
)
RETURNS TABLE (id uuid, content text, similarity real)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $body$
  select kc.id, kc.content, 1 - (kc.embedding OPERATOR(%1$I.<=>) p_query)::real as similarity
    from public.knowledge_chunks kc
   where kc.tenant_id = p_tenant_id
     and kc.embedding is not null
     and 1 - (kc.embedding OPERATOR(%1$I.<=>) p_query) > p_threshold
     -- S6 tenant guard: service role, or the authenticated owner of p_tenant_id.
     and (current_user = 'service_role'
          or exists (select 1 from public.tenants t
                      where t.id = p_tenant_id
                        and t.user_id is not null
                        and t.user_id = auth.uid()))
   order by kc.embedding OPERATOR(%1$I.<=>) p_query
   limit p_limit;
$body$
$def$, v_schema);

 EXECUTE format('COMMENT ON FUNCTION public.match_knowledge(uuid, %I.vector, integer, real) IS %L', v_schema, v_state);
 EXECUTE format('REVOKE ALL ON FUNCTION public.match_knowledge(uuid, %I.vector, integer, real) FROM PUBLIC, anon, authenticated', v_schema);
 EXECUTE format('GRANT EXECUTE ON FUNCTION public.match_knowledge(uuid, %I.vector, integer, real) TO service_role', v_schema);
END
$apply$;

COMMIT;
