-- REVIEW ONLY: S2 — clients must not write tenant billing / state columns.
-- NOT applied anywhere by this repository; apply only with an explicit owner GO.
-- Live state was NOT inspected: this migration is defensive and REFUSES on
-- any unexpected definition instead of guessing.
--
-- Problem (supabase/schema.sql):
--   tenants_owner_all  FOR ALL (role PUBLIC) USING/WITH CHECK user_id = auth.uid()
--     -> an owner can UPDATE credits_remaining / is_active / activated_at /
--        claim_token and INSERT tenants with any credits via PostgREST.
--   tenants_claim_link FOR UPDATE (role PUBLIC, i.e. also anon)
--        USING (claim_token IS NOT NULL) and no WITH CHECK
--     -> claim_token is NOT NULL on every row, so ANY client (anon too) can
--        UPDATE ANY tenant (credits, is_active, user_id takeover).
--   wa_bindings has no RLS at all -> with Supabase default grants any client
--     can INSERT/UPDATE/DELETE phone bindings directly (bypasses S1).
--   channel_accounts_owner FOR ALL -> an owner could insert a WhatsApp /
--     Instagram account row for a foreign external_id (routing / S1 bypass).
--   public.grant_credits(uuid,integer) is SECURITY DEFINER and (schema.sql)
--     never had EXECUTE revoked from PUBLIC -> anyone with the anon key can
--     POST /rest/v1/rpc/grant_credits and add credits + activate any tenant.
--
-- Changes:
--   public.tenants
--     DROP POLICY tenants_claim_link (claims go through the server
--       claim_account action, service role)  — only if it has EXACTLY the
--       schema.sql definition, otherwise REFUSE
--     DROP POLICY tenants_owner_all — same exact-definition rule
--     CREATE POLICY tenants_owner_select  FOR SELECT TO authenticated USING (user_id = auth.uid())
--     CREATE POLICY tenants_owner_update  FOR UPDATE TO authenticated USING/WITH CHECK (user_id = auth.uid())
--     CREATE POLICY tenants_owner_delete  FOR DELETE TO authenticated USING (user_id = auth.uid())
--       (same reach as the old FOR ALL minus INSERT; DELETE kept for parity)
--     REVOKE INSERT, UPDATE ON public.tenants FROM PUBLIC, anon, authenticated
--     GRANT UPDATE (business_name, source_url) ON public.tenants TO authenticated
--       (the only client-editable columns; the frontend currently performs
--        no direct tenants write at all — src/ only SELECTs id by user_id)
--     -> credits_remaining, is_active, activated_at, claim_token, user_id,
--        source_type, *_encrypted, agent prompt etc. are writable only by
--        service_role and SECURITY DEFINER functions (grant_credits,
--        consume_*, wayl_grant_topup_once), which are unaffected.
--   public.wa_bindings (if present)
--     ENABLE ROW LEVEL SECURITY (no policies) and REVOKE SELECT, INSERT,
--     UPDATE, DELETE FROM PUBLIC, anon, authenticated (service role only).
--   public.channel_accounts (if present)
--     REVOKE INSERT, UPDATE, DELETE FROM PUBLIC, anon, authenticated
--     (SELECT and its RLS policies untouched; writes go through edge
--      functions with the service role).
--   service_role gets SELECT, INSERT, UPDATE, DELETE on the three tables.
--   public.grant_credits(uuid,integer) (if present)
--     REVOKE EXECUTE FROM PUBLIC, anon, authenticated; GRANT to service_role
--     (its callers — milan-api pay_webhook, wayl-webhook, server payments —
--      all use the service role).
--
-- Rollback bookkeeping: the exact previous table-level SELECT/INSERT/UPDATE/
-- DELETE grants of PUBLIC/anon/authenticated/service_role on the three
-- tables, the EXECUTE grants of grant_credits(uuid,integer), the
-- wa_bindings RLS flag and which legacy tenants policies existed
-- are recorded in COMMENT ON POLICY tenants_owner_select (marker prefix
-- CREATED_BY_20261029240000_TENANTS_BILLING_RLS). The rollback restores
-- exactly that. Pre-existing column-level grants are not recorded.
--
-- Idempotent: a re-run with the marked policies present keeps the ORIGINAL
-- recorded state and re-applies the same definitions.
-- Preflight refuses when: tenants is missing or has RLS disabled; a required
-- column is missing; roles anon/authenticated/service_role or auth.uid() are
-- missing; tenants carries ANY policy other than the two legacy ones (exact
-- definitions) or the three marked new ones; legacy and new policies coexist.
--
-- Order: independent of the flow-* chain and of 20261029250000.
-- Deploy-safe before or after the milan-api / channels / meta-auth updates
-- (all of them use the service role).
-- Rollback: supabase/rollbacks/20261029240000_tenants_billing_rls.rollback.sql
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029240000_TENANTS_BILLING_RLS';
 v_name text;
 v_pol record;
 v_new int := 0;
 v_legacy int := 0;
BEGIN
 IF to_regclass('public.tenants') IS NULL THEN
  RAISE EXCEPTION 'tenants billing RLS prerequisite missing: table public.tenants';
 END IF;
 IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.tenants'::regclass) THEN
  RAISE EXCEPTION 'Row level security is not enabled on public.tenants; unexpected state, refusing';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['id','user_id','claim_token','business_name','source_url','credits_remaining','is_active'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'public.tenants'::regclass AND attname = v_name AND attnum > 0 AND NOT attisdropped) THEN
   RAISE EXCEPTION 'tenants billing RLS prerequisite missing: column public.tenants.%', v_name;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_name) THEN
   RAISE EXCEPTION 'tenants billing RLS prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 IF to_regprocedure('auth.uid()') IS NULL THEN
  RAISE EXCEPTION 'tenants billing RLS prerequisite missing: function auth.uid()';
 END IF;
 FOR v_pol IN SELECT p.policyname::text AS name, p.cmd::text AS cmd, p.roles::text AS roles, p.permissive::text AS permissive,
                     p.qual::text AS qual, p.with_check::text AS wc,
                     obj_description(pp.oid, 'pg_policy') AS note
                FROM pg_catalog.pg_policies p
                JOIN pg_catalog.pg_policy pp ON pp.polrelid = 'public.tenants'::regclass AND pp.polname = p.policyname
               WHERE p.schemaname = 'public' AND p.tablename = 'tenants' LOOP
  IF v_pol.name = 'tenants_owner_all' THEN
   IF v_pol.cmd <> 'ALL' OR v_pol.roles <> '{public}' OR v_pol.permissive <> 'PERMISSIVE'
      OR v_pol.qual IS DISTINCT FROM '(user_id = auth.uid())' OR v_pol.wc IS DISTINCT FROM '(user_id = auth.uid())' THEN
    RAISE EXCEPTION 'policy tenants_owner_all has an unexpected definition (cmd=%, roles=%, qual=%, check=%); refusing', v_pol.cmd, v_pol.roles, v_pol.qual, v_pol.wc;
   END IF;
   v_legacy := v_legacy + 1;
  ELSIF v_pol.name = 'tenants_claim_link' THEN
   IF v_pol.cmd <> 'UPDATE' OR v_pol.roles <> '{public}' OR v_pol.permissive <> 'PERMISSIVE'
      OR v_pol.qual IS DISTINCT FROM '(claim_token IS NOT NULL)' OR v_pol.wc IS NOT NULL THEN
    RAISE EXCEPTION 'policy tenants_claim_link has an unexpected definition (cmd=%, roles=%, qual=%, check=%); refusing', v_pol.cmd, v_pol.roles, v_pol.qual, v_pol.wc;
   END IF;
   v_legacy := v_legacy + 1;
  ELSIF v_pol.name IN ('tenants_owner_select','tenants_owner_update','tenants_owner_delete') THEN
   IF v_pol.note IS NULL OR left(v_pol.note, length(v_marker)) <> v_marker THEN
    RAISE EXCEPTION 'policy % exists without marker %; refusing to replace it', v_pol.name, v_marker;
   END IF;
   v_new := v_new + 1;
  ELSE
   RAISE EXCEPTION 'unexpected policy % on public.tenants (cmd=%, roles=%); review it before applying this migration', v_pol.name, v_pol.cmd, v_pol.roles;
  END IF;
 END LOOP;
 IF v_new > 0 AND v_legacy > 0 THEN
  RAISE EXCEPTION 'legacy and 20261029240000 tenants policies coexist; unexpected state, refusing';
 END IF;
 IF v_new > 0 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = 'public.tenants'::regclass AND polname = 'tenants_owner_select') THEN
  RAISE EXCEPTION 'marked tenants policies present but tenants_owner_select (rollback bookkeeping) is missing; refusing';
 END IF;
END
$preflight$;

DO $apply$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029240000_TENANTS_BILLING_RLS';
 v_state text;
 v_tab text;
 v_role text;
 v_priv text;
 v_letters text;
 v_rls boolean;
 v_acl aclitem[];
 v_legacy text := '';
BEGIN
 SELECT obj_description(oid, 'pg_policy') INTO v_state
   FROM pg_catalog.pg_policy WHERE polrelid = 'public.tenants'::regclass AND polname = 'tenants_owner_select';
 IF v_state IS NULL THEN
  -- First run: record the exact previous state.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public.tenants'::regclass AND polname='tenants_owner_all') THEN
   v_legacy := v_legacy || 'owner_all,';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public.tenants'::regclass AND polname='tenants_claim_link') THEN
   v_legacy := v_legacy || 'claim_link,';
  END IF;
  v_state := v_marker || '|legacy=' || v_legacy || ';';
  FOREACH v_tab IN ARRAY ARRAY['tenants','wa_bindings','channel_accounts'] LOOP
   IF to_regclass('public.' || v_tab) IS NULL THEN
    v_state := v_state || v_tab || '=absent;';
    CONTINUE;
   END IF;
   SELECT c.relrowsecurity, coalesce(c.relacl, acldefault('r', c.relowner)) INTO v_rls, v_acl
     FROM pg_catalog.pg_class c WHERE c.oid = ('public.' || v_tab)::regclass;
   v_state := v_state || v_tab || '.rls=' || CASE WHEN v_rls THEN '1' ELSE '0' END || ';';
   FOREACH v_role IN ARRAY ARRAY['public','anon','authenticated','service_role'] LOOP
    v_letters := '';
    FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
     IF EXISTS (SELECT 1 FROM aclexplode(v_acl) a
                 WHERE a.privilege_type = v_priv
                   AND a.grantee = CASE WHEN v_role = 'public' THEN 0::oid
                                        ELSE (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) END) THEN
      v_letters := v_letters || left(v_priv, 1);
     END IF;
    END LOOP;
    v_state := v_state || v_tab || '.' || v_role || '=' || v_letters || ';';
   END LOOP;
  END LOOP;
  IF to_regprocedure('public.grant_credits(uuid,integer)') IS NULL THEN
   v_state := v_state || 'grant_credits=absent;';
  ELSE
   SELECT coalesce(p.proacl, acldefault('f', p.proowner)) INTO v_acl
     FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.grant_credits(uuid,integer)');
   FOREACH v_role IN ARRAY ARRAY['public','anon','authenticated','service_role'] LOOP
    v_state := v_state || 'grant_credits.' || v_role || '=' ||
     CASE WHEN EXISTS (SELECT 1 FROM aclexplode(v_acl) a
                        WHERE a.privilege_type = 'EXECUTE'
                          AND a.grantee = CASE WHEN v_role = 'public' THEN 0::oid
                                               ELSE (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) END)
          THEN 'X' ELSE '' END || ';';
   END LOOP;
  END IF;
 END IF;

 -- tenants policies
 DROP POLICY IF EXISTS tenants_claim_link ON public.tenants;
 DROP POLICY IF EXISTS tenants_owner_all ON public.tenants;
 DROP POLICY IF EXISTS tenants_owner_select ON public.tenants;
 DROP POLICY IF EXISTS tenants_owner_update ON public.tenants;
 DROP POLICY IF EXISTS tenants_owner_delete ON public.tenants;
 CREATE POLICY tenants_owner_select ON public.tenants
  FOR SELECT TO authenticated USING (user_id = auth.uid());
 CREATE POLICY tenants_owner_update ON public.tenants
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
 CREATE POLICY tenants_owner_delete ON public.tenants
  FOR DELETE TO authenticated USING (user_id = auth.uid());
 EXECUTE format('COMMENT ON POLICY tenants_owner_select ON public.tenants IS %L', v_state);
 EXECUTE format('COMMENT ON POLICY tenants_owner_update ON public.tenants IS %L', v_marker);
 EXECUTE format('COMMENT ON POLICY tenants_owner_delete ON public.tenants IS %L', v_marker);

 -- tenants column-level write privileges
 REVOKE INSERT, UPDATE ON TABLE public.tenants FROM PUBLIC, anon, authenticated;
 GRANT UPDATE (business_name, source_url) ON TABLE public.tenants TO authenticated;
 GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenants TO service_role;

 -- wa_bindings: service role only
 IF to_regclass('public.wa_bindings') IS NOT NULL THEN
  ALTER TABLE public.wa_bindings ENABLE ROW LEVEL SECURITY;
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.wa_bindings FROM PUBLIC, anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.wa_bindings TO service_role;
 END IF;

 -- channel_accounts: no direct client writes
 IF to_regclass('public.channel_accounts') IS NOT NULL THEN
  REVOKE INSERT, UPDATE, DELETE ON TABLE public.channel_accounts FROM PUBLIC, anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_accounts TO service_role;
 END IF;

 -- grant_credits: server (service role) only
 IF to_regprocedure('public.grant_credits(uuid,integer)') IS NOT NULL THEN
  REVOKE EXECUTE ON FUNCTION public.grant_credits(uuid,integer) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.grant_credits(uuid,integer) TO service_role;
 END IF;
END
$apply$;

COMMIT;
