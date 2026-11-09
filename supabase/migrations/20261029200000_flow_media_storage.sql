-- REVIEW ONLY: Supabase Storage bucket + storage.objects RLS for flow editor media.
-- NOT applied anywhere by this repository; apply only with an explicit owner GO.
-- Not wired to CI / pre-deploy checks yet.
--
-- Creates bucket `flow-media`:
--   public = true (Meta must fetch flow images by plain URL),
--   file_size_limit = 2097152 (2 MB),
--   allowed_mime_types = {image/jpeg,image/png,image/webp}
--   (the editor re-encodes to WebP <= 1000px; PDF is NOT allowed).
-- PUBLIC BUCKET: every object is readable by anyone who knows its URL.
-- Objects MUST therefore use unguessable paths:
--   <auth.uid()>/<random uuid>.<ext>
-- Never store secrets or customer data that must stay private in this bucket.
--
-- Policies on storage.objects (all scoped bucket_id = 'flow-media'):
--   flow_media_insert_own  INSERT  authenticated        WITH CHECK first path
--                          segment = auth.uid()::text (own folder only)
--   flow_media_select_own  SELECT  authenticated        own objects only
--                          (owner_id/owner = auth.uid() OR first path segment
--                          = auth.uid()::text)
--   flow_media_update_own  UPDATE  authenticated        own objects only
--                          (owner_id/owner = auth.uid() OR first segment =
--                          auth.uid()::text); WITH CHECK keeps the object in the
--                          uploader's own folder
--   flow_media_delete_own  DELETE  authenticated        own objects only (same)
-- anon has NO SELECT policy on this bucket and cannot list objects through
-- the Storage API. The owner-only SELECT policy is still required because
-- Postgres applies SELECT policies to rows read by UPDATE/DELETE, so owner
-- update/delete via the Storage API keeps working.
-- TRADEOFF: a public bucket serves known object URLs WITHOUT any SELECT
-- policy, so every object stays readable by anyone who knows its URL; objects
-- therefore still need unguessable paths. Authenticated users can only see
-- and list their own objects through the API (no cross-user listing).
-- TENANT SCOPING IS NOT ENFORCED HERE: isolation is per user folder only
-- (auth.uid()), not per tenant_id. Tenant-level checks must stay in the app.
--
-- No grants are issued; no other bucket and no other policy is touched.
-- Ownership marker (COMMENT ON POLICY of each policy above):
--   CREATED_BY_20261029200000_FLOW_MEDIA_STORAGE
-- Idempotent: an existing `flow-media` bucket is accepted only when its
-- configuration is identical to the above (otherwise refused, never
-- overwritten); a same-named policy is skipped only when it carries the
-- marker (otherwise refused, never dropped/replaced).
-- Preflight refuses unless schema storage, storage.buckets, storage.objects
-- (with RLS enabled), storage.foldername(text), auth.uid() and roles anon /
-- authenticated exist.
--
-- Order: after 20261029190000 (newest). Independent of the flow-* migrations.
-- Rollback: supabase/rollbacks/20261029200000_flow_media_storage.rollback.sql
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_name text;
BEGIN
 IF to_regnamespace('storage') IS NULL THEN
  RAISE EXCEPTION 'flow-media storage prerequisite missing: schema storage (Supabase Storage not installed)';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['storage.buckets','storage.objects'] LOOP
  IF to_regclass(v_name) IS NULL THEN
   RAISE EXCEPTION 'flow-media storage prerequisite missing: table %', v_name;
  END IF;
 END LOOP;
 IF to_regprocedure('storage.foldername(text)') IS NULL THEN
  RAISE EXCEPTION 'flow-media storage prerequisite missing: function storage.foldername(text)';
 END IF;
 IF to_regprocedure('auth.uid()') IS NULL THEN
  RAISE EXCEPTION 'flow-media storage prerequisite missing: function auth.uid()';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_name) THEN
   RAISE EXCEPTION 'flow-media storage prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY['id','name','public','file_size_limit','allowed_mime_types'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'storage.buckets'::regclass AND attname = v_name
                   AND attnum > 0 AND NOT attisdropped) THEN
   RAISE EXCEPTION 'flow-media storage prerequisite missing: column storage.buckets.%', v_name;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY['bucket_id','name'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'storage.objects'::regclass AND attname = v_name
                   AND attnum > 0 AND NOT attisdropped) THEN
   RAISE EXCEPTION 'flow-media storage prerequisite missing: column storage.objects.%', v_name;
  END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                WHERE attrelid = 'storage.objects'::regclass AND attname IN ('owner_id','owner')
                  AND attnum > 0 AND NOT attisdropped) THEN
  RAISE EXCEPTION 'flow-media storage prerequisite missing: column storage.objects.owner_id or owner';
 END IF;
 IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'storage.objects'::regclass) THEN
  RAISE EXCEPTION 'Row level security is not enabled on storage.objects; refusing to rely on flow-media policies';
 END IF;
END
$preflight$;

-- Bucket: create, or accept an identically configured one; never overwrite.
DO $bucket$
DECLARE
 v_public boolean;
 v_limit bigint;
 v_mimes text[];
 v_found boolean := false;
BEGIN
 SELECT true, b.public, b.file_size_limit::bigint, b.allowed_mime_types::text[]
   INTO v_found, v_public, v_limit, v_mimes
   FROM storage.buckets b WHERE b.id = 'flow-media';
 IF coalesce(v_found,false) THEN
  IF v_public IS DISTINCT FROM true
     OR v_limit IS DISTINCT FROM 2097152
     OR v_mimes IS NULL
     OR NOT (v_mimes @> ARRAY['image/jpeg','image/png','image/webp']
             AND v_mimes <@ ARRAY['image/jpeg','image/png','image/webp']) THEN
   RAISE EXCEPTION 'Existing storage bucket flow-media has a different configuration (public=%, file_size_limit=%, allowed_mime_types=%); refusing to take it over',
    v_public, v_limit, v_mimes;
  END IF;
  RAISE NOTICE 'storage bucket flow-media already exists with the expected configuration; left unchanged';
 ELSE
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('flow-media', 'flow-media', true, 2097152,
          ARRAY['image/jpeg','image/png','image/webp'])
  ON CONFLICT (id) DO NOTHING;
 END IF;
END
$bucket$;

-- Policies: create each one unless a marked policy of that name exists;
-- an unmarked same-named policy is refused (never dropped or replaced).
DO $policies$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029200000_FLOW_MEDIA_STORAGE';
 v_owner_expr text;
 v_own text;
 v_folder constant text := '(storage.foldername(name))[1] = (select auth.uid())::text';
 v_pol record;
 v_existing_comment text;
 v_exists boolean;
BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
            WHERE attrelid = 'storage.objects'::regclass AND attname = 'owner_id'
              AND attnum > 0 AND NOT attisdropped) THEN
  v_owner_expr := 'owner_id = (select auth.uid())::text';
 ELSE
  v_owner_expr := 'owner = (select auth.uid())';
 END IF;
 v_own := format('bucket_id = %L AND (%s OR %s)', 'flow-media', v_owner_expr, v_folder);

 FOR v_pol IN
  SELECT * FROM (VALUES
   ('flow_media_insert_own', 'INSERT', 'authenticated', NULL::text,
    format('bucket_id = %L AND %s', 'flow-media', v_folder)),
   ('flow_media_select_own', 'SELECT', 'authenticated', v_own, NULL::text),
   ('flow_media_update_own', 'UPDATE', 'authenticated', v_own,
    format('bucket_id = %L AND %s', 'flow-media', v_folder)),
   ('flow_media_delete_own', 'DELETE', 'authenticated', v_own, NULL::text)
  ) AS t(polname, cmd, roles, using_expr, check_expr)
 LOOP
  SELECT true, obj_description(p.oid, 'pg_policy')
    INTO v_exists, v_existing_comment
    FROM pg_catalog.pg_policy p
   WHERE p.polrelid = 'storage.objects'::regclass AND p.polname = v_pol.polname;
  IF coalesce(v_exists,false) THEN
   IF v_existing_comment IS DISTINCT FROM v_marker THEN
    RAISE EXCEPTION 'Unrecognized existing policy % on storage.objects (marker=%); refusing to overwrite',
     v_pol.polname, coalesce(v_existing_comment,'-');
   END IF;
   RAISE NOTICE 'policy % already installed by 20261029200000; left unchanged', v_pol.polname;
  ELSE
   EXECUTE format('CREATE POLICY %I ON storage.objects AS PERMISSIVE FOR %s TO %s%s%s',
    v_pol.polname, v_pol.cmd, v_pol.roles,
    CASE WHEN v_pol.using_expr IS NOT NULL THEN ' USING (' || v_pol.using_expr || ')' ELSE '' END,
    CASE WHEN v_pol.check_expr IS NOT NULL THEN ' WITH CHECK (' || v_pol.check_expr || ')' ELSE '' END);
   EXECUTE format('COMMENT ON POLICY %I ON storage.objects IS %L', v_pol.polname, v_marker);
  END IF;
  v_exists := NULL;
  v_existing_comment := NULL;
 END LOOP;
END
$policies$;

COMMIT;
