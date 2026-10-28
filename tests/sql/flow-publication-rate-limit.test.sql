-- Disposable PostgreSQL only: cross-instance-safe atomic tenant rate budget.
\set ON_ERROR_STOP on
BEGIN;
GRANT SELECT ON public.tenants TO service_role;
SET ROLE service_role;
DO $test$
DECLARE i integer;
 tenant_a uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 tenant_b uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
BEGIN
 FOR i IN 1..30 LOOP
  IF public.flow_publication_rate_allow(tenant_a) IS DISTINCT FROM TRUE
  THEN RAISE EXCEPTION 'A_EARLY_LIMIT_%',i;END IF;
 END LOOP;
 IF public.flow_publication_rate_allow(tenant_a) IS DISTINCT FROM FALSE
 THEN RAISE EXCEPTION 'A_31ST_REQUEST_ALLOWED';END IF;
 IF public.flow_publication_rate_allow(tenant_b) IS DISTINCT FROM TRUE
 THEN RAISE EXCEPTION 'TENANT_B_LIMIT_INHERITED_FROM_A'; END IF;
 IF public.flow_publication_rate_allow(NULL) IS DISTINCT FROM FALSE
 THEN RAISE EXCEPTION 'NULL_TENANT_ALLOWED'; END IF;
 IF (SELECT request_count FROM public.flow_publication_rate_windows
     WHERE tenant_id=tenant_a AND window_start=date_trunc('minute',now())) <> 30
 THEN RAISE EXCEPTION 'A_COUNTER_INCORRECT'; END IF;
 IF (SELECT request_count FROM public.flow_publication_rate_windows
     WHERE tenant_id=tenant_b AND window_start=date_trunc('minute',now())) <> 1
 THEN RAISE EXCEPTION 'B_COUNTER_INCORRECT'; END IF;
END
$test$;
RESET ROLE;
DO $check$
DECLARE f oid:=to_regprocedure('public.flow_publication_rate_allow(uuid)');
BEGIN
 IF f IS NULL OR (SELECT prosecdef FROM pg_proc WHERE oid=f)
 OR has_function_privilege('anon',f,'EXECUTE')
 OR has_function_privilege('authenticated',f,'EXECUTE')
 OR NOT has_function_privilege('service_role',f,'EXECUTE')
 OR has_table_privilege('anon','public.flow_publication_rate_windows','SELECT')
 OR has_table_privilege('authenticated','public.flow_publication_rate_windows','INSERT')
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.flow_publication_rate_windows'::regclass)
 THEN RAISE EXCEPTION 'RATE_LIMITER_PRIVILEGES_OR_RLS_WRONG'; END IF;
END
$check$;
ROLLBACK;
SELECT 'PASS: tenant A requests 1..30 allowed, 31 denied; B independent; private RLS limiter' AS result;
