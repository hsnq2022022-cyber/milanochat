-- REVIEW ONLY. Separate production GO required.
-- No destructive table DROP: preserve historical request counts if any.
BEGIN;
DO $guard$
BEGIN
 IF to_regprocedure('public.flow_publication_rate_allow(uuid)') IS NULL OR
  obj_description(to_regprocedure('public.flow_publication_rate_allow(uuid)'),'pg_proc')
    IS DISTINCT FROM 'CREATED_BY_20261028200000_FLOW_PUBLICATION_RATE_LIMIT'
 THEN RAISE EXCEPTION 'Unrecognized rate limiter RPC; rollback refused'; END IF;
END
$guard$;
DROP FUNCTION public.flow_publication_rate_allow(uuid);
-- The existing table remains private, with RLS and service-only privileges.
COMMIT;
