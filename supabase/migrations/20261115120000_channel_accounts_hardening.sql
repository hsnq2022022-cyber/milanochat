-- REVIEW ONLY: harden public.channel_accounts (client writes, token columns,
-- global external-id uniqueness).
-- NOT applied anywhere by this repository; apply only with an explicit owner GO.
--
-- Problem (live production, checked by the operator, not by this repo):
--   policy "users manage their channel accounts" FOR ALL TO authenticated
--     USING (tenant_id IN (SELECT tenants.id FROM tenants
--                          WHERE tenants.user_id = auth.uid()))   -- no WITH CHECK
--   + Supabase default table grants (anon/authenticated: every privilege)
--     -> a signed-in owner can INSERT / UPDATE / DELETE channel_accounts rows
--        of their own tenant through PostgREST, e.g. point external_id at a
--        FOREIGN page / Instagram account / WhatsApp phone_number_id and
--        hijack its webhook routing, or flip status / agent flags; and can
--        SELECT access_token / access_token_encrypted / metadata /
--        error_message / scope of their rows from the browser.
--   (channel, external_id) is only unique PER TENANT
--     (unique tenant_id, channel, external_id), so two tenants can register
--     the same Meta asset.
--
-- Changes (one transaction, no data change):
--   1. DROP POLICY "users manage their channel accounts" and, if present,
--      the repo-named channel_accounts_owner (supabase/omnichannel_*.sql;
--      production does not have it). Their exact definitions are recorded
--      for the rollback.
--      KEEP "users see their channel accounts" (FOR SELECT TO authenticated,
--      owner-scoped). It is created only when missing, as
--      USING (tenant_id IN (SELECT t.id FROM public.tenants t
--                           WHERE t.user_id = (SELECT auth.uid()))).
--   2. REVOKE ALL ON public.channel_accounts FROM PUBLIC, anon,
--      authenticated (table AND column privileges: SELECT, INSERT, UPDATE,
--      DELETE, TRUNCATE, REFERENCES, TRIGGER[, MAINTAIN]); then
--      GRANT SELECT (<safe columns>) TO authenticated. anon gets nothing.
--      Safe columns = every live column EXCEPT access_token,
--      access_token_encrypted, metadata, error_message, scope.
--      service_role privileges are NOT touched (connect / disconnect /
--      settings / webhooks all run server-side with the service role).
--   3. CREATE UNIQUE INDEX channel_accounts_channel_external_id_global_uq
--      ON public.channel_accounts (channel, external_id)
--      WHERE external_id IS NOT NULL
--        AND channel IN ('instagram','facebook','whatsapp')
--        AND status IS DISTINCT FROM 'disconnected'
--      (Salla and any other channel are excluded). Rows with status
--      'disconnected' (channels/index.ts "disconnect" is a soft delete that
--      keeps external_id) do NOT count, so a disconnected asset can be linked
--      again by any tenant; every other status (active, needs_reauth, NULL)
--      counts. A same-tenant reconnect upserts on (tenant_id, channel,
--      external_id) and flips the SAME row back to active; that UPDATE fails
--      with 23505 only while ANOTHER tenant holds a non-disconnected row
--      (meta-auth maps that to "account_already_linked" by the index NAME).
--      Plain CREATE INDEX inside this transaction (tiny table); CONCURRENTLY
--      is deliberately not used. Preflight refuses when duplicate
--      (channel, external_id) groups exist under the SAME predicate and
--      reports ONLY their number (no ids, no external ids).
--   4. Postconditions (same transaction, after the REVOKE / GRANT): the
--      migration RAISEs (everything rolls back) unless authenticated has no
--      INSERT / UPDATE / DELETE / TRUNCATE on the table, anon has no table
--      SELECT, authenticated cannot SELECT access_token,
--      access_token_encrypted, metadata, error_message, scope, can SELECT
--      every safe column, and service_role still has INSERT.
--
-- Dependents checked (repo): every SQL function reading channel_accounts
-- (flow_* in 20261028220000..20261029300000, incl. to_jsonb(ca)) is SECURITY
-- INVOKER with EXECUTE for service_role only; no view, no policy of another
-- table and no realtime publication reads channel_accounts; foreign keys to
-- channel_accounts(tenant_id,id,platform) are checked as the table owner;
-- src/ (browser) never queries channel_accounts; server/ and Edge Functions
-- use the service role. -> the column grants break none of them.
--
-- Interplay with 20261029240000_tenants_billing_rls (NOT applied in
-- production): it REVOKEs INSERT/UPDATE/DELETE from client roles and GRANTs
-- SELECT/INSERT/UPDATE/DELETE to service_role on this table; both are
-- compatible with this migration in either order (its re-revokes are no-ops,
-- its service_role grant is unchanged here). Its ROLLBACK restores the
-- table-level grants it recorded: run THIS migration's rollback first if
-- 240000 was applied before this one (rollbacks in reverse order).
--
-- Ownership marker: CREATED_BY_20261115120000_CHANNEL_ACCOUNTS_HARDENING
--   COMMENT ON INDEX channel_accounts_channel_external_id_global_uq =
--     marker || '|' || <jsonb of the previous state: table and column ACL
--     entries of PUBLIC/anon/authenticated, dropped policy definitions,
--     whether "users see their channel accounts" was created here>.
--   COMMENT ON POLICY "users see their channel accounts" = marker only when
--     this migration created it.
-- Idempotent: a re-run keeps the ORIGINAL recorded state and re-applies the
-- same privileges; the index / policy are created only when missing.
-- Preflight refuses when: roles, auth.uid(), public.tenants or the table are
-- missing; RLS is disabled on channel_accounts; a safe column is missing;
-- a policy other than the three known names exists; "users see their
-- channel accounts" is not an owner-scoped permissive SELECT policy for
-- authenticated; an index of the reserved name exists without the marker or
-- with another shape (columns or predicate); duplicate (channel,
-- external_id) groups exist among non-disconnected instagram / facebook /
-- whatsapp rows.
--
-- Rollback: supabase/rollbacks/20261115120000_channel_accounts_hardening.rollback.sql
--   (emergency only: it RE-OPENS the client write / token read hole).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path = '';

LOCK TABLE public.channel_accounts IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261115120000_CHANNEL_ACCOUNTS_HARDENING';
 v_safe constant text[] := ARRAY['id','tenant_id','platform','platform_account_id','account_name',
  'account_avatar','is_active','connected_at','created_at','updated_at','channel','name','status',
  'external_id','display_name','avatar_url','token_expires_at','last_sync_at','page_id','page_name',
  'agent_enabled','auto_reply_enabled','ai_enabled','notify_enabled','auto_reply','language',
  'handoff_rules','agent_config'];
 v_name text;
 v_pol record;
 v_idx oid;
 v_note text;
 v_norm text;
 v_dups bigint;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_name) THEN
   RAISE EXCEPTION 'channel_accounts hardening prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 IF to_regprocedure('auth.uid()') IS NULL THEN
  RAISE EXCEPTION 'channel_accounts hardening prerequisite missing: function auth.uid()';
 END IF;
 IF to_regclass('public.tenants') IS NULL THEN
  RAISE EXCEPTION 'channel_accounts hardening prerequisite missing: table public.tenants';
 END IF;
 IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.channel_accounts'::regclass) THEN
  RAISE EXCEPTION 'Row level security is not enabled on public.channel_accounts; unexpected state, refusing';
 END IF;
 FOREACH v_name IN ARRAY v_safe LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'public.channel_accounts'::regclass AND attname = v_name
                   AND attnum > 0 AND NOT attisdropped) THEN
   RAISE EXCEPTION 'channel_accounts hardening prerequisite missing: column public.channel_accounts.%', v_name;
  END IF;
 END LOOP;

 FOR v_pol IN SELECT p.policyname::text AS name, p.cmd::text AS cmd, p.roles::text AS roles,
                     p.permissive::text AS permissive, p.qual::text AS qual, p.with_check::text AS wc
                FROM pg_catalog.pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = 'channel_accounts' LOOP
  IF v_pol.name IN ('users manage their channel accounts','channel_accounts_owner') THEN
   CONTINUE; -- dropped below, definition recorded for the rollback
  ELSIF v_pol.name = 'users see their channel accounts' THEN
   -- Owner-scoped read only: tenant_id IN (tenants of auth.uid()), either the
   -- live form (auth.uid()) or the (SELECT auth.uid()) form.
   v_norm := lower(regexp_replace(coalesce(v_pol.qual,''), '[[:space:]()]+', '', 'g'));
   v_norm := replace(replace(v_norm, 'public.', ''), 'asuid', '');
   IF v_pol.cmd <> 'SELECT' OR v_pol.roles <> '{authenticated}' OR v_pol.permissive <> 'PERMISSIVE'
      OR v_pol.wc IS NOT NULL
      OR v_norm NOT IN ('tenant_idinselecttenants.idfromtenantswheretenants.user_id=auth.uid',
                        'tenant_idinselectt.idfromtenantstwheret.user_id=selectauth.uid') THEN
    RAISE EXCEPTION 'policy "users see their channel accounts" has an unexpected definition (cmd=%, roles=%, qual=%, check=%); refusing',
     v_pol.cmd, v_pol.roles, v_pol.qual, v_pol.wc;
   END IF;
  ELSE
   RAISE EXCEPTION 'unexpected policy % on public.channel_accounts (cmd=%, roles=%); review it before applying this migration',
    v_pol.name, v_pol.cmd, v_pol.roles;
  END IF;
 END LOOP;

 v_idx := to_regclass('public.channel_accounts_channel_external_id_global_uq');
 IF v_idx IS NOT NULL THEN
  v_note := obj_description(v_idx, 'pg_class');
  IF v_note IS NULL OR left(v_note, length(v_marker) + 1) <> v_marker || '|' THEN
   RAISE EXCEPTION 'index public.channel_accounts_channel_external_id_global_uq exists without marker %; refusing', v_marker;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                  WHERE i.indexrelid = v_idx AND i.indrelid = 'public.channel_accounts'::regclass
                    AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL
                    AND (SELECT array_agg(a.attname::text ORDER BY k.n)
                           FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n)
                           JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
                        = ARRAY['channel','external_id']
                    -- predicate, normalized (no blanks / parentheses / text casts)
                    AND regexp_replace(regexp_replace(lower(pg_get_expr(i.indpred, i.indrelid)),
                          '::(text|character varying)', '', 'g'), '[[:space:]()]+', '', 'g')
                        = 'external_idisnotnullandchannel=anyarray[''instagram'',''facebook'',''whatsapp'']'
                          'andstatusisdistinctfrom''disconnected''') THEN
   RAISE EXCEPTION 'index public.channel_accounts_channel_external_id_global_uq is marked but has an unexpected shape; refusing';
  END IF;
 END IF;

 SELECT count(*) INTO v_dups FROM (
  SELECT 1 FROM public.channel_accounts
   WHERE external_id IS NOT NULL AND channel IN ('instagram','facebook','whatsapp')
     AND status IS DISTINCT FROM 'disconnected'
   GROUP BY channel, external_id HAVING count(*) > 1) d;
 IF v_dups > 0 THEN
  RAISE EXCEPTION 'channel_accounts has % duplicate (channel, external_id) group(s) for instagram/facebook/whatsapp (status not disconnected); resolve them before applying 20261115120000', v_dups;
 END IF;
END
$preflight$;

DO $apply$
DECLARE
 v_marker constant text := 'CREATED_BY_20261115120000_CHANNEL_ACCOUNTS_HARDENING';
 v_idx oid := to_regclass('public.channel_accounts_channel_external_id_global_uq');
 v_state jsonb;
 v_see_created boolean := false;
BEGIN
 IF v_idx IS NOT NULL THEN
  -- Re-run: keep the ORIGINAL recorded state (validated by the preflight).
  v_state := substr(obj_description(v_idx, 'pg_class'), length(v_marker) + 2)::jsonb;
 ELSE
  -- First run: record the exact previous state (search_path is '', so the
  -- policy expressions below are deparsed fully schema-qualified).
  v_state := jsonb_build_object(
   'table_acl', coalesce((
     SELECT jsonb_agg(jsonb_build_array(
              CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname::text END,
              a.privilege_type, a.is_grantable) ORDER BY a.grantee, a.privilege_type)
       FROM pg_catalog.pg_class c
       CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
       LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE c.oid = 'public.channel_accounts'::regclass
        AND (a.grantee = 0 OR r.rolname IN ('anon','authenticated'))), '[]'::jsonb),
   'column_acl', coalesce((
     SELECT jsonb_agg(jsonb_build_array(
              CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname::text END,
              a.privilege_type, a.is_grantable, att.attname::text) ORDER BY att.attnum, a.grantee, a.privilege_type)
       FROM pg_catalog.pg_attribute att
       CROSS JOIN LATERAL aclexplode(att.attacl) a
       LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE att.attrelid = 'public.channel_accounts'::regclass AND att.attnum > 0
        AND NOT att.attisdropped AND att.attacl IS NOT NULL
        AND (a.grantee = 0 OR r.rolname IN ('anon','authenticated'))), '[]'::jsonb),
   'policies', coalesce((
     SELECT jsonb_agg(jsonb_build_object(
              'name', p.policyname::text, 'cmd', p.cmd::text, 'permissive', p.permissive::text,
              'roles', to_jsonb(p.roles::text[]), 'qual', p.qual, 'with_check', p.with_check)
              ORDER BY p.policyname)
       FROM pg_catalog.pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = 'channel_accounts'
        AND p.policyname IN ('users manage their channel accounts','channel_accounts_owner')), '[]'::jsonb),
   'see_created', NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy
                               WHERE polrelid = 'public.channel_accounts'::regclass
                                 AND polname = 'users see their channel accounts'));
 END IF;

 -- 1. no client write policy
 DROP POLICY IF EXISTS "users manage their channel accounts" ON public.channel_accounts;
 DROP POLICY IF EXISTS channel_accounts_owner ON public.channel_accounts;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy
                 WHERE polrelid = 'public.channel_accounts'::regclass
                   AND polname = 'users see their channel accounts') THEN
  CREATE POLICY "users see their channel accounts" ON public.channel_accounts
   FOR SELECT TO authenticated
   USING (tenant_id IN (SELECT t.id FROM public.tenants t WHERE t.user_id = (SELECT auth.uid())));
  v_see_created := true;
 END IF;
 IF v_see_created OR (v_state->>'see_created')::boolean THEN
  EXECUTE format('COMMENT ON POLICY %I ON public.channel_accounts IS %L',
   'users see their channel accounts', v_marker);
 END IF;

 -- 2. client roles: no write, no table-level read; safe columns only
 REVOKE ALL ON TABLE public.channel_accounts FROM PUBLIC, anon, authenticated;
 GRANT SELECT (id, tenant_id, platform, platform_account_id, account_name, account_avatar,
  is_active, connected_at, created_at, updated_at, channel, name, status, external_id,
  display_name, avatar_url, token_expires_at, last_sync_at, page_id, page_name,
  agent_enabled, auto_reply_enabled, ai_enabled, notify_enabled, auto_reply, language,
  handoff_rules, agent_config) ON TABLE public.channel_accounts TO authenticated;

 -- 3. one Meta asset (channel, external_id) belongs to at most one tenant
 CREATE UNIQUE INDEX IF NOT EXISTS channel_accounts_channel_external_id_global_uq
  ON public.channel_accounts (channel, external_id)
  WHERE external_id IS NOT NULL AND channel IN ('instagram','facebook','whatsapp')
    AND status IS DISTINCT FROM 'disconnected';
 EXECUTE format('COMMENT ON INDEX public.channel_accounts_channel_external_id_global_uq IS %L',
  v_marker || '|' || v_state::text);
END
$apply$;

-- 4. postconditions: any failure RAISEs and the whole transaction rolls back.
DO $post$
DECLARE
 v_t constant text := 'public.channel_accounts';
 v_safe constant text[] := ARRAY['id','tenant_id','platform','platform_account_id','account_name',
  'account_avatar','is_active','connected_at','created_at','updated_at','channel','name','status',
  'external_id','display_name','avatar_url','token_expires_at','last_sync_at','page_id','page_name',
  'agent_enabled','auto_reply_enabled','ai_enabled','notify_enabled','auto_reply','language',
  'handoff_rules','agent_config'];
 v_name text;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
  IF has_table_privilege('authenticated', v_t, v_name) THEN
   RAISE EXCEPTION '20261115120000 postcondition failed: authenticated still has % on public.channel_accounts', v_name;
  END IF;
 END LOOP;
 IF has_table_privilege('anon', v_t, 'SELECT') THEN
  RAISE EXCEPTION '20261115120000 postcondition failed: anon still has SELECT on public.channel_accounts';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['access_token','access_token_encrypted','metadata','error_message','scope'] LOOP
  IF has_column_privilege('authenticated', v_t, v_name, 'SELECT') THEN
   RAISE EXCEPTION '20261115120000 postcondition failed: authenticated can still SELECT public.channel_accounts.%', v_name;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY v_safe LOOP
  IF NOT has_column_privilege('authenticated', v_t, v_name, 'SELECT') THEN
   RAISE EXCEPTION '20261115120000 postcondition failed: authenticated cannot SELECT public.channel_accounts.%', v_name;
  END IF;
 END LOOP;
 IF NOT has_table_privilege('service_role', v_t, 'INSERT') THEN
  RAISE EXCEPTION '20261115120000 postcondition failed: service_role lost INSERT on public.channel_accounts';
 END IF;
END
$post$;

COMMIT;
