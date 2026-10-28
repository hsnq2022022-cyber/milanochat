\set ON_ERROR_STOP on
SET ROLE service_role;
DO $test$
DECLARE a uuid; b uuid; c uuid; n integer;
BEGIN
 SELECT id INTO a FROM public.automation_message_claims WHERE provider_event_id='meta-a1';
 SELECT id INTO b FROM public.automation_message_claims WHERE provider_event_id='meta-a2';
 SELECT id INTO c FROM public.automation_message_claims WHERE provider_event_id='meta-b1';
 IF a IS NULL OR b IS NULL OR c IS NULL THEN RAISE EXCEPTION 'CLAIM_FIXTURES_MISSING'; END IF;
 IF public.flow_begin_delivery(a,repeat('a',64)) IS DISTINCT FROM true OR
    public.flow_begin_delivery(a,repeat('a',64)) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'DOUBLE_RESERVATION'; END IF;
 IF public.flow_finish_delivery(a,'confirmed','mid.test.1') IS DISTINCT FROM true OR
    public.flow_finish_delivery(a,'uncertain',null) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'CONFIRMED_STATE_MUTATED'; END IF;
 IF public.flow_begin_delivery(b,repeat('b',64)) IS DISTINCT FROM true OR
    public.flow_finish_delivery(b,'uncertain',null) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'FAILED_TO_MARK_UNCERTAIN'; END IF;
 IF public.flow_begin_delivery(c,repeat('c',64)) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'FAILED_TO_RESERVE_B'; END IF;
 UPDATE public.automation_delivery_attempts SET attempted_at=now()-interval '40 minutes',
  uncertain_at=CASE WHEN status='uncertain' THEN now()-interval '40 minutes' ELSE uncertain_at END
 WHERE claim_id IN (b,c);
 n:=public.flow_queue_uncertain_deliveries(15,10);
 IF n<>2 THEN RAISE EXCEPTION 'RECONCILIATION_COUNT_BAD %',n; END IF;
 IF public.flow_queue_uncertain_deliveries(15,10)<>0 THEN
  RAISE EXCEPTION 'REVIEW_REQUEUED'; END IF;
 IF (SELECT count(*) FROM public.automation_delivery_attempts
     WHERE review_status='queued' AND status='uncertain')<>2
 OR (SELECT count(*) FROM public.automation_delivery_attempts
     WHERE status='confirmed' AND provider_message_id='mid.test.1')<>1
 THEN RAISE EXCEPTION 'DELIVERY_STATES_WRONG'; END IF;
END $test$;
RESET ROLE;
DO $priv$
BEGIN
 IF has_table_privilege('anon','public.automation_delivery_attempts','SELECT')
 OR has_table_privilege('authenticated','public.automation_delivery_attempts','INSERT')
 OR has_function_privilege('authenticated','public.flow_begin_delivery(uuid,text)','EXECUTE')
 OR has_function_privilege('anon','public.flow_queue_uncertain_deliveries(integer,integer)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.flow_finish_delivery(uuid,text,text)','EXECUTE')
 OR NOT (SELECT relrowsecurity FROM pg_class
  WHERE oid='public.automation_delivery_attempts'::regclass)
 THEN RAISE EXCEPTION 'DELIVERY_RLS_OR_ACL_WRONG'; END IF;
END $priv$;
SELECT 'PASS: one attempt, immutable confirmed, uncertain queued after 15 min, stale attempting queued, no retries or repeated review' AS result;
