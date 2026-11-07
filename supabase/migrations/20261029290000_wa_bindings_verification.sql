-- REVIEW ONLY: S9 — interim control against WhatsApp number squatting.
-- NOT applied anywhere by this repository; apply only with an explicit owner
-- GO. Live state was NOT inspected; unexpected definitions are refused.
--
-- Problem: bind_number (milan-api) accepts any free phone_number_id without
-- proving that the tenant controls it (Meta ownership verification needs the
-- tenant's WhatsApp Business token, which the bind flow does not have). A
-- tenant could bind someone else's not-yet-bound number and have the
-- whatsapp_webhook answer that number's customers with its own bot.
--
-- Changes (public.wa_bindings):
--   ADD COLUMN is_verified boolean NOT NULL DEFAULT false
--   ADD COLUMN verified_at timestamptz
--   ADD COLUMN verified_by text
--   ADD CONSTRAINT wa_bindings_verified_by_chk CHECK (NOT is_verified OR verified_by IS NOT NULL)
--   GRANDFATHERING (first run only, i.e. only when the columns are added
--   here): every EXISTING row is set is_verified = true, verified_at = now(),
--   verified_by = 'migration-grandfathered' so current customers keep their
--   auto-replies. A number squatted BEFORE this migration cannot be told apart
--   and is grandfathered too (review those rows manually).
--   Rows created afterwards (bind_number) start UNVERIFIED: milan-api
--   whatsapp_webhook ignores them (no auto-reply) until an operator approves.
--
-- Operator approval (service role / SQL editor only; clients have no
-- privilege on wa_bindings since 20261029240000):
--   UPDATE public.wa_bindings
--      SET is_verified = true, verified_at = now(), verified_by = '<operator>:<ticket>'
--    WHERE phone_id = '<phone_number_id>' AND tenant_id = '<tenant uuid>'
--      AND NOT is_verified;
--
-- Idempotent: columns that already carry the marker comment
-- CREATED_BY_20261029290000_WA_BINDINGS_VERIFICATION are accepted and the
-- backfill is NOT repeated (a re-run never verifies newer bindings).
-- Preflight refuses when: wa_bindings or its phone_id / tenant_id columns are
-- missing; roles are missing; 20261029240000 is not applied (RLS disabled or
-- anon/authenticated/PUBLIC still hold INSERT/UPDATE/DELETE on wa_bindings);
-- any of the three columns exists without the marker or with another
-- type / nullability / default.
--
-- Order: after 20261029240000. Apply BEFORE deploying the milan-api version
-- that reads is_verified (otherwise the binding lookup errors and every
-- wa_bindings-routed number stays silent until this migration is applied;
-- channel_accounts-routed WhatsApp accounts are unaffected either way).
-- Rollback: supabase/rollbacks/20261029290000_wa_bindings_verification.rollback.sql
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029290000_WA_BINDINGS_VERIFICATION';
 v_name text;
 v_col record;
 v_present int := 0;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_name) THEN
   RAISE EXCEPTION 'wa_bindings verification prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 IF to_regclass('public.wa_bindings') IS NULL THEN
  RAISE EXCEPTION 'wa_bindings verification prerequisite missing: table public.wa_bindings';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['phone_id','tenant_id'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'public.wa_bindings'::regclass AND attname = v_name AND attnum > 0 AND NOT attisdropped) THEN
   RAISE EXCEPTION 'wa_bindings verification prerequisite missing: column public.wa_bindings.%', v_name;
  END IF;
 END LOOP;
 IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.wa_bindings'::regclass)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                WHERE c.oid = 'public.wa_bindings'::regclass
                  AND a.privilege_type IN ('INSERT','UPDATE','DELETE')
                  AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated')))) THEN
  RAISE EXCEPTION 'apply 20261029240000_tenants_billing_rls first (wa_bindings must be service-role only)';
 END IF;
 FOR v_col IN SELECT a.attname::text AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS nn,
                     pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS def,
                     col_description(a.attrelid, a.attnum) AS note
                FROM pg_catalog.pg_attribute a
                LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
               WHERE a.attrelid = 'public.wa_bindings'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                 AND a.attname IN ('is_verified','verified_at','verified_by') LOOP
  IF v_col.note IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'column public.wa_bindings.% exists without marker %; refusing', v_col.name, v_marker;
  END IF;
  IF (v_col.name = 'is_verified' AND (v_col.typ <> 'boolean' OR NOT v_col.nn OR v_col.def IS DISTINCT FROM 'false'))
     OR (v_col.name = 'verified_at' AND (v_col.typ <> 'timestamp with time zone' OR v_col.nn OR v_col.def IS NOT NULL))
     OR (v_col.name = 'verified_by' AND (v_col.typ <> 'text' OR v_col.nn OR v_col.def IS NOT NULL)) THEN
   RAISE EXCEPTION 'column public.wa_bindings.% has an unexpected definition (%, not null=%, default=%); refusing', v_col.name, v_col.typ, v_col.nn, v_col.def;
  END IF;
  v_present := v_present + 1;
 END LOOP;
 IF v_present NOT IN (0, 3) THEN
  RAISE EXCEPTION 'only % of the 3 wa_bindings verification columns exist; refusing', v_present;
 END IF;
 IF v_present = 3 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                                  WHERE conrelid = 'public.wa_bindings'::regclass AND conname = 'wa_bindings_verified_by_chk') THEN
  RAISE EXCEPTION 'marked wa_bindings verification columns exist without wa_bindings_verified_by_chk; refusing';
 END IF;
 IF v_present = 0 AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                              WHERE conrelid = 'public.wa_bindings'::regclass AND conname = 'wa_bindings_verified_by_chk') THEN
  RAISE EXCEPTION 'constraint wa_bindings_verified_by_chk exists without the verification columns; refusing';
 END IF;
END
$preflight$;

DO $apply$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029290000_WA_BINDINGS_VERIFICATION';
BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
            WHERE attrelid = 'public.wa_bindings'::regclass AND attname = 'is_verified' AND attnum > 0 AND NOT attisdropped) THEN
  RAISE NOTICE '20261029290000 already applied; no backfill';
  RETURN;
 END IF;
 ALTER TABLE public.wa_bindings
  ADD COLUMN is_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN verified_by text;
 -- Grandfather the bindings that exist right now (first run only).
 UPDATE public.wa_bindings
    SET is_verified = true, verified_at = now(), verified_by = 'migration-grandfathered';
 ALTER TABLE public.wa_bindings
  ADD CONSTRAINT wa_bindings_verified_by_chk CHECK (NOT is_verified OR verified_by IS NOT NULL);
 EXECUTE format('COMMENT ON COLUMN public.wa_bindings.is_verified IS %L', v_marker);
 EXECUTE format('COMMENT ON COLUMN public.wa_bindings.verified_at IS %L', v_marker);
 EXECUTE format('COMMENT ON COLUMN public.wa_bindings.verified_by IS %L', v_marker);
END
$apply$;

COMMIT;
