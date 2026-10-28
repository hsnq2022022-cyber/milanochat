\set ON_ERROR_STOP on
SET ROLE service_role;
DO $test$
DECLARE a uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        b uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        answer uuid:='a0000000-0000-4000-8000-000000000003';
BEGIN
 UPDATE public.tenants SET credits_remaining=3 WHERE id=a;
 IF public.consume_widget_reply(a,answer) IS DISTINCT FROM 2 THEN
  RAISE EXCEPTION 'FIRST_WIDGET_DEBIT_FAILED'; END IF;
 IF public.consume_widget_reply(a,answer) IS DISTINCT FROM -2 THEN
  RAISE EXCEPTION 'DUPLICATE_WIDGET_DEBIT'; END IF;
 IF public.consume_widget_reply(b,answer) IS DISTINCT FROM -3 THEN
  RAISE EXCEPTION 'CROSS_TENANT_WIDGET_BILLED'; END IF;
 IF public.consume_widget_reply(a,'a0000000-0000-4000-8000-000000000005') IS DISTINCT FROM -3
 OR public.consume_widget_reply(a,'a0000000-0000-4000-8000-000000000006') IS DISTINCT FROM -3
 THEN RAISE EXCEPTION 'INCOMING_OR_REFUSAL_BILLED';END IF;
 UPDATE public.tenants SET credits_remaining=0 WHERE id=a;
 IF public.consume_widget_reply(a,'a0000000-0000-4000-8000-000000000004') IS DISTINCT FROM -1
 THEN RAISE EXCEPTION 'NO_CREDIT_NOT_REJECTED'; END IF;
 IF EXISTS(SELECT 1 FROM public.widget_reply_ledger
  WHERE widget_message_id='a0000000-0000-4000-8000-000000000004')
 THEN RAISE EXCEPTION 'GHOST_WIDGET_LEDGER';END IF;
 IF (SELECT count(*) FROM public.widget_reply_ledger)<>1 THEN
  RAISE EXCEPTION 'INCORRECT_LEDGER_COUNT'; END IF;
END $test$;
RESET ROLE;
DO $priv$
BEGIN
 IF has_function_privilege('anon','public.consume_widget_reply(uuid,uuid)','EXECUTE')
 OR has_function_privilege('authenticated','public.consume_widget_reply(uuid,uuid)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.consume_widget_reply(uuid,uuid)','EXECUTE')
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.widget_reply_ledger'::regclass)
 THEN RAISE EXCEPTION 'WIDGET_SECURITY_FAILED'; END IF;
END $priv$;
SELECT 'PASS: Widget 1 charge; duplicate -2; cross-tenant/inbound/refusal -3; zero-credit -1 with no ghost; RLS service-only' AS result;
