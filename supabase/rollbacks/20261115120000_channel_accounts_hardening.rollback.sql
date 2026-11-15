-- REVIEW ONLY rollback for 20261115120000_channel_accounts_hardening.
-- NOT applied anywhere by this repository.
--
-- EMERGENCY USE ONLY: this RE-OPENS the hole the migration closed. Signed-in
-- owners can again INSERT / UPDATE / DELETE their channel_accounts rows
-- through PostgREST (incl. pointing external_id at a foreign Meta asset) and
-- read access_token / access_token_encrypted / metadata / error_message /
-- scope from the browser, and two tenants can again register the same
-- (channel, external_id) (the index being dropped is
-- UNIQUE (channel, external_id) WHERE external_id IS NOT NULL AND channel IN
-- ('instagram','facebook','whatsapp') AND status IS DISTINCT FROM
-- 'disconnected').
--
-- Restores EXACTLY the state recorded by the migration in the comment of
-- index public.channel_accounts_channel_external_id_global_uq (marker
-- CREATED_BY_20261115120000_CHANNEL_ACCOUNTS_HARDENING|<jsonb>):
--   * REVOKE ALL from PUBLIC / anon / authenticated (removes the column-level
--     SELECT grants of the migration), then re-GRANT the recorded table- and
--     column-level privileges of PUBLIC / anon / authenticated (live: every
--     table privilege to anon and authenticated, no column grants);
--   * re-creates the dropped policies with their recorded definitions (live:
--     "users manage their channel accounts" FOR ALL TO authenticated
--      USING (tenant_id IN (SELECT tenants.id FROM public.tenants
--                           WHERE tenants.user_id = auth.uid())), no WITH CHECK);
--   * drops "users see their channel accounts" ONLY if the migration created
--     it (recorded) and it still carries the marker; a pre-existing one stays;
--   * drops the unique index LAST, only while it carries the marker AND has
--     the migration's shape (unique, columns (channel, external_id), the
--     predicate above).
-- service_role privileges are not touched. No row is changed.
-- Refuses: an index of that name without the marker or with another shape
-- (columns or predicate), an unreadable recorded state, a policy created by
-- the migration that lost its marker.
-- Idempotent: with the index already gone it is a no-op (NOTICE only).
--
-- Order: revert any application build that depends on the hardening first
-- (none in this repo: all channel_accounts writes use the service role).
-- If 20261029240000_tenants_billing_rls was applied BEFORE 20261115120000,
-- run THIS rollback before the 240000 rollback (reverse order). The
-- migration can be re-applied after this rollback.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path = '';

LOCK TABLE public.channel_accounts IN ACCESS EXCLUSIVE MODE;

DO $rollback$
DECLARE
 v_marker constant text := 'CREATED_BY_20261115120000_CHANNEL_ACCOUNTS_HARDENING';
 v_idx oid := to_regclass('public.channel_accounts_channel_external_id_global_uq');
 v_note text;
 v_state jsonb;
 v_e jsonb;
 v_roles text;
 v_sql text;
BEGIN
 IF v_idx IS NULL THEN
  RAISE NOTICE '20261115120000_channel_accounts_hardening not installed (or already rolled back); nothing to do';
  RETURN;
 END IF;
 v_note := obj_description(v_idx, 'pg_class');
 IF v_note IS NULL OR left(v_note, length(v_marker) + 1) <> v_marker || '|' THEN
  RAISE EXCEPTION 'Refusing to drop unrecognized index public.channel_accounts_channel_external_id_global_uq (marker=%)',
   coalesce(left(v_note, 80), '-');
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                 WHERE i.indexrelid = v_idx AND i.indrelid = 'public.channel_accounts'::regclass
                   AND i.indisunique AND i.indpred IS NOT NULL
                   AND (SELECT array_agg(a.attname::text ORDER BY k.n)
                          FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n)
                          JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
                       = ARRAY['channel','external_id']
                   -- predicate, normalized exactly like the migration's preflight
                   AND regexp_replace(regexp_replace(lower(pg_get_expr(i.indpred, i.indrelid)),
                         '::(text|character varying)', '', 'g'), '[[:space:]()]+', '', 'g')
                       = 'external_idisnotnullandchannel=anyarray[''instagram'',''facebook'',''whatsapp'']'
                         'andstatusisdistinctfrom''disconnected''') THEN
  RAISE EXCEPTION 'Refusing to drop public.channel_accounts_channel_external_id_global_uq: marked but has an unexpected shape';
 END IF;
 BEGIN
  v_state := substr(v_note, length(v_marker) + 2)::jsonb;
 EXCEPTION WHEN others THEN
  RAISE EXCEPTION 'recorded state of 20261115120000 is unreadable; refusing';
 END;
 IF jsonb_typeof(v_state->'table_acl') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_state->'column_acl') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_state->'policies') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_state->'see_created') IS DISTINCT FROM 'boolean' THEN
  RAISE EXCEPTION 'recorded state of 20261115120000 is incomplete; refusing';
 END IF;

 -- privileges of the client roles: back to the recorded ones
 REVOKE ALL ON TABLE public.channel_accounts FROM PUBLIC, anon, authenticated;
 FOR v_e IN SELECT * FROM jsonb_array_elements(v_state->'table_acl') LOOP
  EXECUTE format('GRANT %s ON TABLE public.channel_accounts TO %s%s',
   v_e->>1,
   CASE WHEN v_e->>0 = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(v_e->>0) END,
   CASE WHEN (v_e->>2)::boolean THEN ' WITH GRANT OPTION' ELSE '' END);
 END LOOP;
 FOR v_e IN SELECT * FROM jsonb_array_elements(v_state->'column_acl') LOOP
  EXECUTE format('GRANT %s (%I) ON TABLE public.channel_accounts TO %s%s',
   v_e->>1, v_e->>3,
   CASE WHEN v_e->>0 = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(v_e->>0) END,
   CASE WHEN (v_e->>2)::boolean THEN ' WITH GRANT OPTION' ELSE '' END);
 END LOOP;

 -- dropped policies: recreated with their recorded (schema-qualified) definitions
 FOR v_e IN SELECT * FROM jsonb_array_elements(v_state->'policies') LOOP
  CONTINUE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_policy
                         WHERE polrelid = 'public.channel_accounts'::regclass AND polname = v_e->>'name');
  SELECT string_agg(CASE WHEN r = 'public' THEN 'PUBLIC' ELSE quote_ident(r) END, ', ')
    INTO v_roles FROM jsonb_array_elements_text(v_e->'roles') r;
  v_sql := format('CREATE POLICY %I ON public.channel_accounts AS %s FOR %s TO %s',
   v_e->>'name', v_e->>'permissive', v_e->>'cmd', v_roles);
  IF v_e->>'qual' IS NOT NULL THEN v_sql := v_sql || ' USING (' || (v_e->>'qual') || ')'; END IF;
  IF v_e->>'with_check' IS NOT NULL THEN v_sql := v_sql || ' WITH CHECK (' || (v_e->>'with_check') || ')'; END IF;
  EXECUTE v_sql;
 END LOOP;

 -- the read policy: only if this migration created it
 IF (v_state->>'see_created')::boolean
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy
                 WHERE polrelid = 'public.channel_accounts'::regclass
                   AND polname = 'users see their channel accounts') THEN
  IF (SELECT obj_description(oid, 'pg_policy') FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.channel_accounts'::regclass
         AND polname = 'users see their channel accounts') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'Refusing to drop policy "users see their channel accounts": recorded as created by 20261115120000 but its marker is missing';
  END IF;
  DROP POLICY "users see their channel accounts" ON public.channel_accounts;
 END IF;

 -- the state carrier goes last
 DROP INDEX public.channel_accounts_channel_external_id_global_uq;
END
$rollback$;

COMMIT;
