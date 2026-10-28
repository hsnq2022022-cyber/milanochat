-- Post-migration verification, disposable PostgreSQL only.
\set ON_ERROR_STOP on
SET ROLE service_role;
DO $test$
DECLARE
 a uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 b uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 m1 uuid:='10000000-0000-4000-8000-000000000001';
 m2 uuid:='10000000-0000-4000-8000-000000000002';
 m3 uuid:='10000000-0000-4000-8000-000000000003';
 incoming uuid:='10000000-0000-4000-8000-000000000004';
 other uuid:='20000000-0000-4000-8000-000000000001';
BEGIN
 IF public.consume_reply(a,m1) IS DISTINCT FROM -1 THEN
   RAISE EXCEPTION 'No-credit must return -1'; END IF;
 IF EXISTS(SELECT 1 FROM public.reply_ledger WHERE message_id=m1) THEN
   RAISE EXCEPTION 'Ghost ledger after no-credit refusal'; END IF;
 UPDATE public.tenants SET credits_remaining=2 WHERE id=a;
 IF public.consume_reply(a,m1) IS DISTINCT FROM 1 THEN
   RAISE EXCEPTION 'First debit must leave exactly one credit'; END IF;
 IF public.consume_reply(a,m1) IS DISTINCT FROM -2 THEN
   RAISE EXCEPTION 'Retry must be idempotent'; END IF;
 IF public.consume_reply(a,m2) IS DISTINCT FROM 0 THEN
   RAISE EXCEPTION 'Second debit must reduce balance to 0'; END IF;
 IF public.consume_reply(a,m3) IS DISTINCT FROM -1 THEN
   RAISE EXCEPTION 'Exhausted balance must block new ledger'; END IF;
 IF EXISTS(SELECT 1 FROM public.reply_ledger WHERE message_id=m3) THEN
   RAISE EXCEPTION 'No-credit attempt created ghost row'; END IF;
 UPDATE public.tenants SET credits_remaining=1 WHERE id=a;
 IF public.consume_reply(a,m3) IS DISTINCT FROM 0 THEN
   RAISE EXCEPTION 'Previous no-credit send could not be reconciled after top-up'; END IF;
 IF public.consume_reply(a,incoming) IS DISTINCT FROM -3
   OR public.consume_reply(b,m1) IS DISTINCT FROM -3
   OR public.consume_reply(a,other) IS DISTINCT FROM -3
   OR public.consume_reply(a,'99999999-9999-4999-8999-999999999999') IS DISTINCT FROM -3
 THEN RAISE EXCEPTION 'Invalid tenant, incoming direction, or UUID billed'; END IF;
 IF (SELECT COUNT(*) FROM public.reply_ledger WHERE tenant_id=a)<>3 THEN
   RAISE EXCEPTION 'Unexpected ledger rows for tenant A'; END IF;
 IF (SELECT credits_remaining FROM public.tenants WHERE id=a)<>0
   OR (SELECT credits_remaining FROM public.tenants WHERE id=b)<>5
 THEN RAISE EXCEPTION 'Tenant credit accounting changed incorrectly'; END IF;
END
$test$;
RESET ROLE;

DO $permissions$
BEGIN
 IF has_function_privilege('anon','public.consume_reply(uuid,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.consume_reply(uuid,uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.consume_reply(uuid,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'Credit RPC role grants unsafe'; END IF;
END
$permissions$;
SELECT 'PASS: no ghost ledger, retry idempotent, tenant-owned outgoing message, correct credits' AS result;
