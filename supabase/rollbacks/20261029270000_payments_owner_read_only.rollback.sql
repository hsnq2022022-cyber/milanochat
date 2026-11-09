-- REVIEW ONLY rollback for 20261029270000_payments_owner_read_only.
-- NOT applied anywhere by this repository.
--
-- WARNING: restores the VULNERABLE previous state (owners can INSERT /
-- UPDATE / DELETE their payments rows; anyone can call record_ai_usage /
-- increment_widget_responses for any tenant). Use only to recover from an
-- unexpected breakage.
--
-- Reads the state recorded by the migration in COMMENT ON POLICY
-- payments_owner_select ON public.payments (marker prefix
-- CREATED_BY_20261029270000_PAYMENTS_OWNER_READ_ONLY) and:
--   - drops payments_owner_select (only when marked; unmarked -> REFUSE),
--   - recreates payments_owner (schema.sql definition) if it existed before,
--   - restores the exact previous table-level SELECT/INSERT/UPDATE/DELETE/
--     TRUNCATE grants of PUBLIC/anon/authenticated/service_role on payments
--     and the previous EXECUTE grants of record_ai_usage(uuid,text) and
--     increment_widget_responses(uuid).
-- Idempotent: without the marked policy it does nothing (NOTICE).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $rb$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029270000_PAYMENTS_OWNER_READ_ONLY';
 v_state text;
 v_role text;
 v_priv text;
 v_prev text;
 v_have boolean;
 v_acl aclitem[];
 v_grantee text;
 v_fn text;
 v_short text;
BEGIN
 IF to_regclass('public.payments') IS NULL THEN
  RAISE EXCEPTION 'public.payments is missing; refusing';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = 'public.payments'::regclass AND polname = 'payments_owner_select') THEN
  RAISE NOTICE '20261029270000 not applied (no payments_owner_select); nothing to roll back';
  RETURN;
 END IF;
 SELECT obj_description(oid,'pg_policy') INTO v_state FROM pg_catalog.pg_policy
  WHERE polrelid = 'public.payments'::regclass AND polname = 'payments_owner_select';
 IF v_state IS NULL OR v_state !~ ('^' || v_marker || '\|legacy=(owner,)?;') THEN
  RAISE EXCEPTION 'payments_owner_select exists without marker / recorded state %; refusing', v_marker;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = 'public.payments'::regclass AND polname = 'payments_owner') THEN
  RAISE EXCEPTION 'payments_owner and payments_owner_select coexist; refusing';
 END IF;

 DROP POLICY payments_owner_select ON public.payments;
 IF v_state LIKE '%|legacy=owner,;%' THEN
  create policy payments_owner on public.payments
    for all using (exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid()));
 END IF;

 SELECT coalesce(c.relacl, acldefault('r', c.relowner)) INTO v_acl
   FROM pg_catalog.pg_class c WHERE c.oid = 'public.payments'::regclass;
 FOREACH v_role IN ARRAY ARRAY['public','anon','authenticated','service_role'] LOOP
  v_prev := (regexp_match(v_state, ';payments\.' || v_role || '=([SIUDT]*);'))[1];
  IF v_prev IS NULL THEN
   RAISE EXCEPTION 'recorded grants for payments.% are missing; refusing', v_role;
  END IF;
  v_grantee := CASE WHEN v_role = 'public' THEN 'PUBLIC' ELSE quote_ident(v_role) END;
  FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
   v_have := EXISTS (SELECT 1 FROM aclexplode(v_acl) a
                      WHERE a.privilege_type = v_priv
                        AND a.grantee = CASE WHEN v_role = 'public' THEN 0::oid
                                             ELSE (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) END);
   IF position(left(v_priv,1) IN v_prev) > 0 AND NOT v_have THEN
    EXECUTE format('GRANT %s ON TABLE public.payments TO %s', v_priv, v_grantee);
   ELSIF position(left(v_priv,1) IN v_prev) = 0 AND v_have THEN
    EXECUTE format('REVOKE %s ON TABLE public.payments FROM %s', v_priv, v_grantee);
   END IF;
  END LOOP;
 END LOOP;

 FOREACH v_fn IN ARRAY ARRAY['record_ai_usage(uuid,text)','increment_widget_responses(uuid)'] LOOP
  v_short := split_part(v_fn, '(', 1);
  CONTINUE WHEN to_regprocedure('public.' || v_fn) IS NULL OR v_state LIKE '%;' || v_short || '=absent;%';
  SELECT coalesce(p.proacl, acldefault('f', p.proowner)) INTO v_acl
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.' || v_fn);
  FOREACH v_role IN ARRAY ARRAY['public','anon','authenticated','service_role'] LOOP
   v_prev := (regexp_match(v_state, ';' || v_short || '\.' || v_role || '=(X?);'))[1];
   IF v_prev IS NULL THEN
    RAISE EXCEPTION 'recorded EXECUTE grants for %.% are missing; refusing', v_short, v_role;
   END IF;
   v_grantee := CASE WHEN v_role = 'public' THEN 'PUBLIC' ELSE quote_ident(v_role) END;
   v_have := EXISTS (SELECT 1 FROM aclexplode(v_acl) a
                      WHERE a.privilege_type = 'EXECUTE'
                        AND a.grantee = CASE WHEN v_role = 'public' THEN 0::oid
                                             ELSE (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) END);
   IF v_prev = 'X' AND NOT v_have THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO %s', v_fn, v_grantee);
   ELSIF v_prev = '' AND v_have THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM %s', v_fn, v_grantee);
   END IF;
  END LOOP;
 END LOOP;
END
$rb$;

COMMIT;
