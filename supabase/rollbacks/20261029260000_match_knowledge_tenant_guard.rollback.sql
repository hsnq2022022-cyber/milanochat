-- REVIEW ONLY rollback for 20261029260000_match_knowledge_tenant_guard.
-- NOT applied anywhere by this repository.
--
-- WARNING: restores the VULNERABLE previous state (SECURITY DEFINER
-- match_knowledge callable with any tenant id by every role that had
-- EXECUTE). Use only to recover from an unexpected breakage.
--
-- Reads the state recorded by the migration in COMMENT ON FUNCTION
-- public.match_knowledge (marker prefix
-- CREATED_BY_20261029260000_MATCH_KNOWLEDGE_TENANT_GUARD) and:
--   - recreates exactly the schema.sql definition (SECURITY DEFINER,
--     SET search_path = public, same body text),
--   - restores the exact previous EXECUTE grants of PUBLIC / anon /
--     authenticated / service_role,
--   - removes the comment (schema.sql had none).
-- Refuses when the function carries no / another comment or is not unique.
-- Idempotent: without the marker it does nothing (NOTICE).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $rb$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029260000_MATCH_KNOWLEDGE_TENANT_GUARD';
 v_oid oid;
 v_schema text;
 v_state text;
 v_role text;
 v_prev text;
 v_have boolean;
 v_acl aclitem[];
 v_grantee text;
 v_n int;
BEGIN
 SELECT count(*) INTO v_n FROM pg_catalog.pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'match_knowledge';
 IF v_n = 0 THEN
  RAISE NOTICE 'public.match_knowledge is absent; nothing to roll back';
  RETURN;
 END IF;
 IF v_n <> 1 THEN
  RAISE EXCEPTION 'expected exactly one public.match_knowledge, found %; refusing', v_n;
 END IF;
 SELECT p.oid, tn.nspname INTO v_oid, v_schema
   FROM pg_catalog.pg_proc p
   JOIN pg_catalog.pg_type t ON t.oid = p.proargtypes[1]
   JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'match_knowledge';
 v_state := obj_description(v_oid, 'pg_proc');
 IF v_state IS NULL THEN
  RAISE NOTICE '20261029260000 not applied (no marker on public.match_knowledge); nothing to roll back';
  RETURN;
 END IF;
 IF v_state !~ ('^' || v_marker || '\|exec\.public=X?;exec\.anon=X?;exec\.authenticated=X?;exec\.service_role=X?;$') THEN
  RAISE EXCEPTION 'public.match_knowledge carries no recorded 20261029260000 state; refusing';
 END IF;

 EXECUTE format($def$
create or replace function public.match_knowledge(
  p_tenant_id uuid,
  p_query     %1$I.vector,
  p_limit     integer default 6,
  p_threshold real    default 0.25
)
returns table (id uuid, content text, similarity real)
language sql stable security definer set search_path = public
as $$
  select kc.id, kc.content, 1 - (kc.embedding <=> p_query)::real as similarity
    from public.knowledge_chunks kc
   where kc.tenant_id = p_tenant_id
     and kc.embedding is not null
     and 1 - (kc.embedding <=> p_query) > p_threshold
   order by kc.embedding <=> p_query
   limit p_limit;
$$
$def$, v_schema);

 SELECT coalesce(p.proacl, acldefault('f', p.proowner)) INTO v_acl FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
 FOREACH v_role IN ARRAY ARRAY['public','anon','authenticated','service_role'] LOOP
  v_prev := (regexp_match(v_state, '\|?exec\.' || v_role || '=(X?);'))[1];
  v_grantee := CASE WHEN v_role = 'public' THEN 'PUBLIC' ELSE quote_ident(v_role) END;
  v_have := EXISTS (SELECT 1 FROM aclexplode(v_acl) a
                     WHERE a.privilege_type = 'EXECUTE'
                       AND a.grantee = CASE WHEN v_role = 'public' THEN 0::oid
                                            ELSE (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) END);
  IF v_prev = 'X' AND NOT v_have THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.match_knowledge(uuid, %I.vector, integer, real) TO %s', v_schema, v_grantee);
  ELSIF v_prev = '' AND v_have THEN
   EXECUTE format('REVOKE EXECUTE ON FUNCTION public.match_knowledge(uuid, %I.vector, integer, real) FROM %s', v_schema, v_grantee);
  END IF;
 END LOOP;
 EXECUTE format('COMMENT ON FUNCTION public.match_knowledge(uuid, %I.vector, integer, real) IS NULL', v_schema);
END
$rb$;

COMMIT;
