-- REVIEW ONLY rollback for 20261029200000_flow_media_storage.
-- NOT applied anywhere by this repository.
--
-- Drops ONLY the storage.objects policies flow_media_insert_own,
-- flow_media_select_own, flow_media_update_own, flow_media_delete_own, and
-- only those carrying the marker CREATED_BY_20261029200000_FLOW_MEDIA_STORAGE
-- (an unmarked policy of the same name is left in place, with a NOTICE).
-- Deletes the `flow-media` bucket only when it is ours (at least one marked
-- policy present and the exact 20261029200000 configuration) AND EMPTY.
-- If any object exists in `flow-media` the rollback REFUSES as a whole
-- (nothing changed); objects are never deleted here. Empty the bucket
-- deliberately (Storage API/dashboard) first if a full rollback is wanted.
-- Other buckets, their objects and their policies are not touched.
--
-- HOSTED SUPABASE: storage.buckets may carry a protect_delete trigger that
-- rejects direct SQL DELETE ("use the Storage API"). This rollback does NOT
-- work around it: when an enabled user DELETE trigger exists on
-- storage.buckets, the policies are still dropped but the bucket row is left
-- and a WARNING is raised; the bucket must then be removed via the Storage
-- API (DELETE /storage/v1/bucket/flow-media) or the dashboard after this
-- rollback. A re-run after that point finds no marked policy and therefore
-- will not delete the bucket either (ownership can no longer be proven).
--
-- Order: 20261029200000 is the newest migration; independent of the flow-*
-- rollbacks. Revert any frontend build that uploads to flow-media FIRST.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029200000_FLOW_MEDIA_STORAGE';
 v_names constant text[] := ARRAY['flow_media_insert_own','flow_media_select_own',
                                  'flow_media_update_own','flow_media_delete_own'];
 v_pol record;
 v_marked integer := 0;
 v_bucket_found boolean := false;
 v_public boolean;
 v_limit bigint;
 v_mimes text[];
 v_objects bigint;
 v_delete_blocked boolean;
BEGIN
 IF to_regclass('storage.objects') IS NULL OR to_regclass('storage.buckets') IS NULL THEN
  RAISE EXCEPTION 'storage.buckets/storage.objects not found; nothing to roll back';
 END IF;

 SELECT count(*) INTO v_marked
   FROM pg_catalog.pg_policy p
  WHERE p.polrelid = 'storage.objects'::regclass
    AND p.polname = ANY (v_names)
    AND obj_description(p.oid, 'pg_policy') IS NOT DISTINCT FROM v_marker;

 SELECT true, b.public, b.file_size_limit::bigint, b.allowed_mime_types::text[]
   INTO v_bucket_found, v_public, v_limit, v_mimes
   FROM storage.buckets b WHERE b.id = 'flow-media';
 v_bucket_found := coalesce(v_bucket_found, false);

 IF v_marked = 0 AND NOT v_bucket_found THEN
  RAISE EXCEPTION '20261029200000_flow_media_storage not installed (no marked policy, no flow-media bucket); nothing to roll back';
 END IF;

 -- All refusals happen before any change.
 IF v_bucket_found AND v_marked > 0 THEN
  IF v_public IS DISTINCT FROM true
     OR v_limit IS DISTINCT FROM 2097152
     OR v_mimes IS NULL
     OR NOT (v_mimes @> ARRAY['image/jpeg','image/png','image/webp']
             AND v_mimes <@ ARRAY['image/jpeg','image/png','image/webp']) THEN
   RAISE EXCEPTION 'Bucket flow-media no longer has the 20261029200000 configuration (public=%, file_size_limit=%, allowed_mime_types=%); refusing to roll back',
    v_public, v_limit, v_mimes;
  END IF;
  SELECT count(*) INTO v_objects FROM storage.objects o WHERE o.bucket_id = 'flow-media';
  IF v_objects > 0 THEN
   RAISE EXCEPTION 'Bucket flow-media still contains % object(s); refusing to roll back (objects are never deleted here: empty the bucket via the Storage API/dashboard first)',
    v_objects;
  END IF;
 END IF;

 -- Drop only marked policies.
 FOR v_pol IN
  SELECT p.polname, obj_description(p.oid, 'pg_policy') AS cmt
    FROM pg_catalog.pg_policy p
   WHERE p.polrelid = 'storage.objects'::regclass AND p.polname = ANY (v_names)
 LOOP
  IF v_pol.cmt IS NOT DISTINCT FROM v_marker THEN
   EXECUTE format('DROP POLICY %I ON storage.objects', v_pol.polname);
  ELSE
   RAISE NOTICE 'policy % on storage.objects is not marked by 20261029200000 (marker=%); left in place',
    v_pol.polname, coalesce(v_pol.cmt, '-');
  END IF;
 END LOOP;

 IF NOT v_bucket_found THEN
  RAISE NOTICE 'bucket flow-media does not exist; only marked policies were dropped';
 ELSIF v_marked = 0 THEN
  RAISE NOTICE 'bucket flow-media exists but no marked 20261029200000 policy was found; ownership cannot be proven, bucket left in place';
 ELSE
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = 'storage.buckets'::regclass
       AND NOT t.tgisinternal
       AND t.tgenabled <> 'D'
       AND (t.tgtype::integer & 8) <> 0)   -- TRIGGER_TYPE_DELETE
    INTO v_delete_blocked;
  IF v_delete_blocked THEN
   RAISE WARNING 'storage.buckets has a DELETE trigger (e.g. storage.protect_delete); bucket flow-media was NOT deleted. Remove it via the Storage API (DELETE /storage/v1/bucket/flow-media) or the dashboard.';
  ELSE
   -- storage.objects.bucket_id references storage.buckets(id): a concurrently
   -- inserted object makes this DELETE fail (no cascade), never deletes objects.
   DELETE FROM storage.buckets b
    WHERE b.id = 'flow-media'
      AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'flow-media');
  END IF;
 END IF;
END
$g$;

COMMIT;
