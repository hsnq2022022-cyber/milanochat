-- Disposable PostgreSQL: run twice in parallel from separate psql connections.
\set ON_ERROR_STOP on
SET ROLE service_role;
SELECT CASE WHEN public.flow_publication_rate_allow(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid)
 THEN 1 ELSE 0 END FROM generate_series(1,20);
RESET ROLE;
