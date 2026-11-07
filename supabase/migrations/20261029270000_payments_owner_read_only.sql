-- REVIEW ONLY: S7 — clients must not write payments rows, nor tamper with
-- another tenant's usage counters. NOT applied anywhere by this repository;
-- apply only with an explicit owner GO. Live state was NOT inspected: this
-- migration is defensive and REFUSES on any unexpected definition.
--
-- Problem (supabase/schema.sql):
--   payments_owner FOR ALL (role PUBLIC) USING (owner of tenant_id), no WITH
--   CHECK (= USING) -> with Supabase default grants a tenant owner can
--   INSERT 'paid' payments with any credits_granted, UPDATE status /
--   credits_granted / amount / webhook_event, or DELETE their payment trail
--   via PostgREST.
--   public.record_ai_usage(uuid,text) and
--   public.increment_widget_responses(uuid) (supabase/widgets_phase2_migration.sql,
--   supabase/widgets_quota_migration.sql) are SECURITY DEFINER, take the
--   tenant / widget as a parameter and never had EXECUTE revoked -> anyone
--   with the anon key can exhaust another tenant's daily AI quota or widget
--   response counter.
--
-- Writers (all service role): milan-api pay_create / pay_webhook (sbAdmin),
-- wayl-webhook, wayl-topup-webhook, topup-create (SUPABASE_SERVICE_ROLE_KEY),
-- server/src/routes/payments.ts (db = service-role client),
-- wayl_grant_topup_once (SECURITY DEFINER, service_role only). src/ performs no
-- direct payments access. record_ai_usage: server/src/routes/widgets.ts via
-- the service-role db client. increment_widget_responses: no caller.
--
-- Changes:
--   public.payments
--     DROP POLICY payments_owner (only with EXACTLY the schema.sql definition)
--     CREATE POLICY payments_owner_select FOR SELECT TO authenticated
--       USING (owner of tenant_id)  -> owners read their own rows only
--     REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.payments
--       FROM PUBLIC, anon, authenticated
--     GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments TO service_role
--   public.record_ai_usage(uuid,text), public.increment_widget_responses(uuid)
--     (if present): REVOKE EXECUTE FROM PUBLIC, anon, authenticated;
--     GRANT EXECUTE TO service_role. Bodies unchanged.
--
-- Rollback bookkeeping: the exact previous table-level SELECT/INSERT/UPDATE/
-- DELETE/TRUNCATE grants of PUBLIC/anon/authenticated/service_role on
-- payments, the previous EXECUTE grants of both functions and whether the
-- legacy policy existed are recorded in COMMENT ON POLICY
-- payments_owner_select (marker prefix CREATED_BY_20261029270000_PAYMENTS_OWNER_READ_ONLY).
--
-- Idempotent: a re-run with the marked policy present keeps the ORIGINAL
-- recorded state and re-applies the same definitions.
-- Preflight refuses when: payments is missing or has RLS disabled; column
-- tenant_id is missing; roles anon/authenticated/service_role or auth.uid()
-- are missing; payments carries ANY policy other than payments_owner (exact
-- schema.sql definition) or the marked payments_owner_select; both coexist.
--
-- Order: independent of the flow-* chain and of 20261029240000..260000.
-- Deploy-safe before or after any function deploy (all writers use the
-- service role; nothing to redeploy).
-- Rollback: supabase/rollbacks/20261029270000_payments_owner_read_only.rollback.sql
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029270000_PAYMENTS_OWNER_READ_ONLY';
 v_legacy_qual constant text := '(EXISTS ( SELECT 1 FROM tenants t WHERE ((t.id = payments.tenant_id) AND (t.user_id = auth.uid()))))';
 v_name text;
 v_pol record;
 v_new int := 0;
 v_legacy int := 0;
BEGIN
 IF to_regclass('public.payments') IS NULL OR to_regclass('public.tenants') IS NULL THEN
  RAISE EXCEPTION 'payments read-only prerequisite missing: public.payments / public.tenants';
 END IF;
 IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.payments'::regclass) THEN
  RAISE EXCEPTION 'Row level security is not enabled on public.payments; unexpected state, refusing';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                WHERE attrelid = 'public.payments'::regclass AND attname = 'tenant_id' AND attnum > 0 AND NOT attisdropped) THEN
  RAISE EXCEPTION 'payments read-only prerequisite missing: column public.payments.tenant_id';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_name) THEN
   RAISE EXCEPTION 'payments read-only prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 IF to_regprocedure('auth.uid()') IS NULL THEN
  RAISE EXCEPTION 'payments read-only prerequisite missing: function auth.uid()';
 END IF;
 FOR v_pol IN SELECT p.policyname::text AS name, p.cmd::text AS cmd, p.roles::text AS roles, p.permissive::text AS permissive,
                     replace(regexp_replace(p.qual, '\s+', ' ', 'g'), 'public.tenants', 'tenants') AS qual,
                     p.with_check AS wc,
                     obj_description(pp.oid, 'pg_policy') AS note
                FROM pg_catalog.pg_policies p
                JOIN pg_catalog.pg_policy pp ON pp.polrelid = 'public.payments'::regclass AND pp.polname = p.policyname
               WHERE p.schemaname = 'public' AND p.tablename = 'payments' LOOP
  IF v_pol.name = 'payments_owner' THEN
   IF v_pol.cmd <> 'ALL' OR v_pol.roles <> '{public}' OR v_pol.permissive <> 'PERMISSIVE'
      OR v_pol.qual IS DISTINCT FROM v_legacy_qual OR v_pol.wc IS NOT NULL THEN
    RAISE EXCEPTION 'policy payments_owner has an unexpected definition (cmd=%, roles=%, qual=%, check=%); refusing', v_pol.cmd, v_pol.roles, v_pol.qual, v_pol.wc;
   END IF;
   v_legacy := v_legacy + 1;
  ELSIF v_pol.name = 'payments_owner_select' THEN
   IF v_pol.note IS NULL OR left(v_pol.note, length(v_marker)) <> v_marker THEN
    RAISE EXCEPTION 'policy payments_owner_select exists without marker %; refusing to replace it', v_marker;
   END IF;
   v_new := v_new + 1;
  ELSE
   RAISE EXCEPTION 'unexpected policy % on public.payments (cmd=%, roles=%); review it before applying this migration', v_pol.name, v_pol.cmd, v_pol.roles;
  END IF;
 END LOOP;
 IF v_new > 0 AND v_legacy > 0 THEN
  RAISE EXCEPTION 'legacy and 20261029270000 payments policies coexist; unexpected state, refusing';
 END IF;
END
$preflight$;

DO $apply$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029270000_PAYMENTS_OWNER_READ_ONLY';
 v_state text;
 v_role text;
 v_priv text;
 v_letters text;
 v_acl aclitem[];
 v_fn text;
BEGIN
 SELECT obj_description(oid, 'pg_policy') INTO v_state
   FROM pg_catalog.pg_policy WHERE polrelid = 'public.payments'::regclass AND polname = 'payments_owner_select';
 IF v_state IS NULL THEN
  -- First run: record the exact previous state.
  v_state := v_marker || '|legacy=' ||
   CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public.payments'::regclass AND polname='payments_owner')
        THEN 'owner,' ELSE '' END || ';';
  SELECT coalesce(c.relacl, acldefault('r', c.relowner)) INTO v_acl
    FROM pg_catalog.pg_class c WHERE c.oid = 'public.payments'::regclass;
  FOREACH v_role IN ARRAY ARRAY['public','anon','authenticated','service_role'] LOOP
   v_letters := '';
   FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
    IF EXISTS (SELECT 1 FROM aclexplode(v_acl) a
                WHERE a.privilege_type = v_priv
                  AND a.grantee = CASE WHEN v_role = 'public' THEN 0::oid
                                       ELSE (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) END) THEN
     v_letters := v_letters || left(v_priv, 1);
    END IF;
   END LOOP;
   v_state := v_state || 'payments.' || v_role || '=' || v_letters || ';';
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['record_ai_usage(uuid,text)','increment_widget_responses(uuid)'] LOOP
   IF to_regprocedure('public.' || v_fn) IS NULL THEN
    v_state := v_state || split_part(v_fn, '(', 1) || '=absent;';
    CONTINUE;
   END IF;
   SELECT coalesce(p.proacl, acldefault('f', p.proowner)) INTO v_acl
     FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.' || v_fn);
   FOREACH v_role IN ARRAY ARRAY['public','anon','authenticated','service_role'] LOOP
    v_state := v_state || split_part(v_fn, '(', 1) || '.' || v_role || '=' ||
     CASE WHEN EXISTS (SELECT 1 FROM aclexplode(v_acl) a
                        WHERE a.privilege_type = 'EXECUTE'
                          AND a.grantee = CASE WHEN v_role = 'public' THEN 0::oid
                                               ELSE (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) END)
          THEN 'X' ELSE '' END || ';';
   END LOOP;
  END LOOP;
 END IF;

 DROP POLICY IF EXISTS payments_owner ON public.payments;
 DROP POLICY IF EXISTS payments_owner_select ON public.payments;
 CREATE POLICY payments_owner_select ON public.payments
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = payments.tenant_id AND t.user_id = auth.uid()));
 EXECUTE format('COMMENT ON POLICY payments_owner_select ON public.payments IS %L', v_state);

 REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.payments FROM PUBLIC, anon, authenticated;
 GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payments TO service_role;

 FOREACH v_fn IN ARRAY ARRAY['record_ai_usage(uuid,text)','increment_widget_responses(uuid)'] LOOP
  IF to_regprocedure('public.' || v_fn) IS NOT NULL THEN
   EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', v_fn);
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', v_fn);
  END IF;
 END LOOP;
END
$apply$;

COMMIT;
