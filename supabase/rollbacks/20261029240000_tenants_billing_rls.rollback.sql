-- REVIEW ONLY rollback for 20261029240000_tenants_billing_rls.
-- NOT applied anywhere by this repository.
--
-- WARNING: restores the VULNERABLE previous state (owner/anon writes of
-- tenant billing columns, client writes of wa_bindings / channel_accounts).
-- Use only to recover from an unexpected breakage.
--
-- Reads the state recorded by the migration in
-- COMMENT ON POLICY tenants_owner_select ON public.tenants (marker prefix
-- CREATED_BY_20261029240000_TENANTS_BILLING_RLS) and:
--   - drops tenants_owner_select / tenants_owner_update / tenants_owner_delete
--     (only when marked; an unmarked one makes the rollback REFUSE),
--   - recreates exactly the legacy policies that existed before
--     (tenants_owner_all, tenants_claim_link — schema.sql definitions),
--   - revokes the column grant UPDATE(business_name, source_url) from
--     authenticated,
--   - restores the exact previous table-level SELECT/INSERT/UPDATE/DELETE
--     grants of PUBLIC/anon/authenticated/service_role on tenants,
--     wa_bindings and channel_accounts, the previous EXECUTE grants of
--     grant_credits(uuid,integer), and the previous wa_bindings RLS flag.
-- Idempotent: without marked policies it does nothing (NOTICE).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $rb$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029240000_TENANTS_BILLING_RLS';
 v_state text;
 v_name text;
 v_note text;
 v_tab text;
 v_role text;
 v_priv text;
 v_prev text;
 v_have boolean;
 v_acl aclitem[];
 v_grantee text;
 v_rls text;
BEGIN
 IF to_regclass('public.tenants') IS NULL THEN
  RAISE EXCEPTION 'public.tenants is missing; refusing';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['tenants_owner_select','tenants_owner_update','tenants_owner_delete'] LOOP
  SELECT obj_description(oid,'pg_policy') INTO v_note FROM pg_catalog.pg_policy
   WHERE polrelid = 'public.tenants'::regclass AND polname = v_name;
  IF FOUND AND (v_note IS NULL OR left(v_note, length(v_marker)) <> v_marker) THEN
   RAISE EXCEPTION 'policy % exists without marker %; refusing', v_name, v_marker;
  END IF;
 END LOOP;
 SELECT obj_description(oid,'pg_policy') INTO v_state FROM pg_catalog.pg_policy
  WHERE polrelid = 'public.tenants'::regclass AND polname = 'tenants_owner_select';
 IF v_state IS NULL THEN
  RAISE NOTICE '20261029240000 not applied (no marked tenants_owner_select); nothing to roll back';
  RETURN;
 END IF;
 IF v_state !~ ('^' || v_marker || '\|legacy=[a-z_,]*;') THEN
  RAISE EXCEPTION 'tenants_owner_select carries no recorded state; refusing';
 END IF;

 DROP POLICY tenants_owner_select ON public.tenants;
 DROP POLICY IF EXISTS tenants_owner_update ON public.tenants;
 DROP POLICY IF EXISTS tenants_owner_delete ON public.tenants;
 IF v_state LIKE '%|legacy=%owner_all,%' THEN
  CREATE POLICY tenants_owner_all ON public.tenants
   FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
 END IF;
 IF v_state LIKE '%|legacy=%claim_link,%' THEN
  CREATE POLICY tenants_claim_link ON public.tenants
   FOR UPDATE USING (claim_token IS NOT NULL);
 END IF;
 REVOKE UPDATE (business_name, source_url) ON TABLE public.tenants FROM authenticated;

 FOREACH v_tab IN ARRAY ARRAY['tenants','wa_bindings','channel_accounts'] LOOP
  CONTINUE WHEN to_regclass('public.' || v_tab) IS NULL OR v_state LIKE '%;' || v_tab || '=absent;%';
  v_rls := (regexp_match(v_state, ';' || v_tab || '\.rls=([01]);'))[1];
  IF v_rls IS NULL THEN
   RAISE EXCEPTION 'recorded state for % is incomplete; refusing', v_tab;
  END IF;
  IF v_tab = 'wa_bindings' AND v_rls = '0' THEN
   ALTER TABLE public.wa_bindings DISABLE ROW LEVEL SECURITY;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['public','anon','authenticated','service_role'] LOOP
   v_prev := (regexp_match(v_state, ';' || v_tab || '\.' || v_role || '=([SIUD]*);'))[1];
   IF v_prev IS NULL THEN
    RAISE EXCEPTION 'recorded grants for %.% are missing; refusing', v_tab, v_role;
   END IF;
   SELECT coalesce(c.relacl, acldefault('r', c.relowner)) INTO v_acl
     FROM pg_catalog.pg_class c WHERE c.oid = ('public.' || v_tab)::regclass;
   v_grantee := CASE WHEN v_role = 'public' THEN 'PUBLIC' ELSE quote_ident(v_role) END;
   FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
    v_have := EXISTS (SELECT 1 FROM aclexplode(v_acl) a
                       WHERE a.privilege_type = v_priv
                         AND a.grantee = CASE WHEN v_role = 'public' THEN 0::oid
                                              ELSE (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) END);
    IF position(left(v_priv,1) IN v_prev) > 0 AND NOT v_have THEN
     EXECUTE format('GRANT %s ON TABLE public.%I TO %s', v_priv, v_tab, v_grantee);
    ELSIF position(left(v_priv,1) IN v_prev) = 0 AND v_have THEN
     EXECUTE format('REVOKE %s ON TABLE public.%I FROM %s', v_priv, v_tab, v_grantee);
    END IF;
   END LOOP;
  END LOOP;
 END LOOP;

 IF to_regprocedure('public.grant_credits(uuid,integer)') IS NOT NULL AND v_state NOT LIKE '%;grant_credits=absent;%' THEN
  SELECT coalesce(p.proacl, acldefault('f', p.proowner)) INTO v_acl
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.grant_credits(uuid,integer)');
  FOREACH v_role IN ARRAY ARRAY['public','anon','authenticated','service_role'] LOOP
   v_prev := (regexp_match(v_state, ';grant_credits\.' || v_role || '=(X?);'))[1];
   IF v_prev IS NULL THEN
    RAISE EXCEPTION 'recorded EXECUTE grants for grant_credits.% are missing; refusing', v_role;
   END IF;
   v_grantee := CASE WHEN v_role = 'public' THEN 'PUBLIC' ELSE quote_ident(v_role) END;
   v_have := EXISTS (SELECT 1 FROM aclexplode(v_acl) a
                      WHERE a.privilege_type = 'EXECUTE'
                        AND a.grantee = CASE WHEN v_role = 'public' THEN 0::oid
                                             ELSE (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) END);
   IF v_prev = 'X' AND NOT v_have THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.grant_credits(uuid,integer) TO %s', v_grantee);
   ELSIF v_prev = '' AND v_have THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.grant_credits(uuid,integer) FROM %s', v_grantee);
   END IF;
  END LOOP;
 END IF;
END
$rb$;

COMMIT;
