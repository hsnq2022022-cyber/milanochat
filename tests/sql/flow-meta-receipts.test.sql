\set ON_ERROR_STOP on
SET ROLE service_role;
DO $check$
DECLARE a uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 own uuid:='11111111-1111-4111-8111-111111111111';
 effect uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
BEGIN
 IF public.flow_reserve_outbox_delivery(a,effect) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Send attempt was not reserved';END IF;
 IF public.flow_finish_outbox_delivery(a,effect,'confirmed','mid-verified-001') IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Provider confirmation not stored';END IF;
 IF public.flow_record_meta_delivery(a,own,'instagram','mid-verified-001','delivered')
  IS DISTINCT FROM true OR
   public.flow_record_meta_delivery(a,own,'instagram','mid-verified-001','delivered')
  IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'Duplicate delivered receipt was recorded';END IF;
 IF public.flow_record_meta_delivery(a,own,'instagram','mid-verified-001','read')
  IS DISTINCT FROM true OR
    public.flow_record_meta_delivery(a,own,'instagram','mid-verified-001','read')
  IS DISTINCT FROM false THEN RAISE EXCEPTION 'Duplicate read receipt';END IF;
 IF public.flow_record_meta_delivery(
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   '22222222-2222-4222-8222-222222222222',
   'facebook','mid-verified-001','read')
 THEN RAISE EXCEPTION 'Cross tenant Meta receipt';END IF;
 IF (SELECT count(*) FROM public.flow_meta_delivery_receipts WHERE tenant_id=a)<>2
 OR (SELECT count(*) FROM public.automation_flow_metrics
      WHERE tenant_id=a AND event_key='delivered')<>1
 THEN RAISE EXCEPTION 'Receipt ledger or one-time metric mismatch';END IF;
END $check$;
RESET ROLE;
DO $privileges$
BEGIN
 IF has_table_privilege('anon','public.flow_meta_delivery_receipts','SELECT')
 OR has_table_privilege('authenticated','public.flow_meta_delivery_receipts','INSERT')
 OR has_function_privilege('authenticated',
  'public.flow_record_meta_delivery(uuid,uuid,text,text,text)','EXECUTE')
 OR NOT has_function_privilege('service_role',
  'public.flow_record_meta_delivery(uuid,uuid,text,text,text)','EXECUTE')
 OR NOT (SELECT relrowsecurity FROM pg_class
   WHERE oid='public.flow_meta_delivery_receipts'::regclass)
 THEN RAISE EXCEPTION 'Meta receipt authorization not private'; END IF;
END $privileges$;
SELECT 'PASS: provider MID match, delivered/read idempotency, cross-tenant rejection, one metric, RLS' AS result;
