\set ON_ERROR_STOP on
SET ROLE service_role;
DO $test$
DECLARE tenant uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 first uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
 second uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
BEGIN
 IF public.flow_reserve_outbox_delivery(tenant,first) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'OFF gate bypassed'; END IF;
 UPDATE public.automation_flow_global_switch SET enabled=true;
 INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only)
 VALUES(tenant,true,true);
 IF public.flow_reserve_outbox_delivery(tenant,first) IS DISTINCT FROM true
 OR public.flow_reserve_outbox_delivery(tenant,first) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'Duplicate outbox provider reservation';END IF;
 IF public.flow_reserve_outbox_delivery(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',second) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'Cross tenant send reservation';END IF;
 IF public.flow_finish_outbox_delivery(tenant,first,'confirmed','mid.example.1') IS DISTINCT FROM true
 OR public.flow_finish_outbox_delivery(tenant,first,'confirmed','mid.example.1') IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'Duplicate delivery confirmed';END IF;
 IF (SELECT delivery_status FROM public.automation_flow_outbox WHERE id=first)<>'charge_pending'
 OR (SELECT provider_message_id FROM public.automation_flow_delivery_attempts WHERE outbox_id=first)
    <>'mid.example.1'
 THEN RAISE EXCEPTION 'Confirmation not durable';END IF;
 IF public.flow_reserve_outbox_delivery(tenant,second) IS DISTINCT FROM true
 OR public.flow_finish_outbox_delivery(tenant,second,'uncertain',NULL) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Uncertain provider acknowledgement not persisted';END IF;
 IF public.flow_reserve_outbox_delivery(tenant,second) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'Attempt retried after ambiguous response';END IF;
 UPDATE public.automation_flow_delivery_attempts
 SET uncertain_at=now()-interval '2 minutes'
 WHERE outbox_id=second AND status='uncertain';
 IF public.flow_queue_outbox_human_review(1,100)<>1
 OR public.flow_queue_outbox_human_review(1,100)<>0
 THEN RAISE EXCEPTION 'Human review non-idempotent';END IF;
 IF (SELECT review_status FROM public.automation_flow_delivery_attempts WHERE outbox_id=second)<>'queued'
 THEN RAISE EXCEPTION 'Failed to enqueue human review';END IF;
 IF (SELECT count(*) FROM public.automation_flow_delivery_attempts)<>2
 THEN RAISE EXCEPTION 'Unexpected attempt count';END IF;
END $test$;
RESET ROLE;
DO $acl$
BEGIN
 IF has_table_privilege('anon','public.automation_flow_delivery_attempts','SELECT')
 OR has_table_privilege('authenticated','public.automation_flow_delivery_attempts','INSERT')
 OR has_function_privilege('anon','public.flow_reserve_outbox_delivery(uuid,uuid)','EXECUTE')
 OR has_function_privilege('authenticated','public.flow_finish_outbox_delivery(uuid,uuid,text,text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.flow_reserve_outbox_delivery(uuid,uuid)','EXECUTE')
 OR NOT (SELECT relrowsecurity FROM pg_class
  WHERE oid='public.automation_flow_delivery_attempts'::regclass)
 THEN RAISE EXCEPTION 'Unsafe outbox delivery privileges'; END IF;
END $acl$;
SELECT 'PASS: OFF blocks, unique reserve, cross-tenant isolation, confirmed charge_pending, uncertain review without automatic resend, RLS' AS result;
