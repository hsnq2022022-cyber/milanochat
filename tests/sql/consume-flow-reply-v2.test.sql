-- Disposable PostgreSQL17 test. All UUIDs are synthetic.
\set ON_ERROR_STOP on
BEGIN;
SET ROLE service_role;
DO $test$
DECLARE
  tenant_a uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  tenant_b uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  conv_a uuid := '44444444-4444-4444-8444-444444444444';
  msg_a uuid := '80000000-0000-4000-8000-000000000001';
  msg_b uuid := '80000000-0000-4000-8000-000000000002';
  msg_c uuid := '80000000-0000-4000-8000-000000000003';
  inbound uuid := '77777777-7777-4777-8777-777777777771';
BEGIN
  IF to_regprocedure('public.consume_reply(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Legacy reply RPC was replaced';
  END IF;
  INSERT INTO public.messages(id,tenant_id,conversation_id,direction)
  VALUES (msg_a,tenant_a,conv_a,'out'),(msg_b,tenant_a,conv_a,'out'),
         (msg_c,tenant_a,conv_a,'out');
  UPDATE public.tenants SET credits_remaining=0 WHERE id=tenant_a;
  IF public.consume_flow_reply(tenant_a,msg_a) IS DISTINCT FROM -1 THEN
    RAISE EXCEPTION 'No credits should return -1';
  END IF;
  IF EXISTS(SELECT 1 FROM public.reply_ledger WHERE message_id=msg_a) THEN
    RAISE EXCEPTION 'Ghost ledger created with zero credits';
  END IF;
  UPDATE public.tenants SET credits_remaining=2 WHERE id=tenant_a;
  IF public.consume_flow_reply(tenant_b,msg_a) IS DISTINCT FROM -3 OR
     public.consume_flow_reply(tenant_a,inbound) IS DISTINCT FROM -3 THEN
    RAISE EXCEPTION 'Cross-tenant or inbound billing allowed';
  END IF;
  IF public.consume_flow_reply(tenant_a,msg_a) IS DISTINCT FROM 1 OR
     public.consume_flow_reply(tenant_a,msg_a) IS DISTINCT FROM -2 OR
     public.consume_flow_reply(tenant_a,msg_b) IS DISTINCT FROM 0 OR
     public.consume_flow_reply(tenant_a,msg_c) IS DISTINCT FROM -1 THEN
    RAISE EXCEPTION 'Not atomic, idempotent, or exhausted correctly';
  END IF;
  IF (SELECT count(*) FROM public.reply_ledger WHERE message_id IN(msg_a,msg_b,msg_c))<>2 THEN
    RAISE EXCEPTION 'Unexpected ledger entries';
  END IF;
END $test$;
RESET ROLE;
DO $acl$
BEGIN
  IF has_function_privilege('anon','public.consume_flow_reply(uuid,uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.consume_flow_reply(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.consume_flow_reply(uuid,uuid)','EXECUTE')
  THEN RAISE EXCEPTION 'Unsafe RPC grant'; END IF;
END $acl$;
ROLLBACK;
SELECT 'PASS: versioned flow debit, idempotency, no ghost ledger, role isolation' AS result;
