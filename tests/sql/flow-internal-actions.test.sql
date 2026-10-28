\set ON_ERROR_STOP on
INSERT INTO public.tenant_staff_memberships(tenant_id,user_id,role,status)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '77777777-7777-4777-8777-777777777777','agent','active');
INSERT INTO public.tenant_conversation_assignments(tenant_id,conversation_id,user_id)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '44444444-4444-4444-8444-444444444444',
 '77777777-7777-4777-8777-777777777777');
INSERT INTO public.automation_flow_outbox(
 tenant_id,id,run_id,idempotency_key,effect_kind,payload)
VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'ffffffff-ffff-4fff-8fff-fffffffffff1',
 '77777777-7777-4777-8777-7777777777a4','internal-tag','tag',
 '{"kind":"tag","tag":"VIP"}'::jsonb),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'ffffffff-ffff-4fff-8fff-fffffffffff2',
 '77777777-7777-4777-8777-7777777777a4','internal-untag','untag',
 '{"kind":"untag","tag":"VIP"}'::jsonb),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'ffffffff-ffff-4fff-8fff-fffffffffff3',
 '77777777-7777-4777-8777-7777777777a4','internal-notify','staff_notification',
 '{"kind":"staff_notification","text":"Please take over."}'::jsonb);
SET ROLE service_role;
DO $check$
DECLARE t uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 tag_id uuid:='ffffffff-ffff-4fff-8fff-fffffffffff1';
 untag_id uuid:='ffffffff-ffff-4fff-8fff-fffffffffff2';
 notify_id uuid:='ffffffff-ffff-4fff-8fff-fffffffffff3';
BEGIN
 IF public.flow_apply_internal_effect(t,tag_id) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'OFF gate bypassed';END IF;
 UPDATE public.automation_flow_global_switch SET enabled=true;
 INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only)
 VALUES(t,true,true);
 -- NEVER combine stateful RPC calls with OR: SQL may evaluate OR terms
 -- in a different order and inspect the row before the side effect.
 IF public.flow_apply_internal_effect(t,tag_id) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Tag action failed';END IF;
 IF public.flow_apply_internal_effect(t,tag_id) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'Duplicate tag action executed';END IF;
 IF (SELECT count(*) FROM public.flow_conversation_tags WHERE tenant_id=t AND tag='VIP')<>1
 THEN RAISE EXCEPTION 'Tag not stored exactly once';END IF;
 IF public.flow_apply_internal_effect(t,untag_id) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Untag RPC failed';END IF;
 IF EXISTS(SELECT 1 FROM public.flow_conversation_tags WHERE tenant_id=t)
 THEN RAISE EXCEPTION 'Untag left a tag behind';END IF;
 IF public.flow_apply_internal_effect(t,notify_id) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Notification RPC failed';END IF;
 IF public.flow_apply_internal_effect(t,notify_id) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'Duplicate notification executed';END IF;
 IF (SELECT count(*) FROM public.flow_staff_notifications WHERE tenant_id=t)<>1
 OR (SELECT recipient_user_id FROM public.flow_staff_notifications
    WHERE outbox_id=notify_id)<>
      '77777777-7777-4777-8777-777777777777'::uuid
 THEN RAISE EXCEPTION 'Staff queue recipient or one-time event mismatch';END IF;
 IF public.flow_apply_internal_effect('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',tag_id)
 THEN RAISE EXCEPTION 'Cross tenant internal action';END IF;
END $check$;
RESET ROLE;
DO $private$
BEGIN
 IF has_table_privilege('anon','public.flow_staff_notifications','SELECT')
 OR has_table_privilege('authenticated','public.flow_conversation_tags','SELECT')
 OR has_function_privilege('authenticated',
   'public.flow_apply_internal_effect(uuid,uuid)','EXECUTE')
 OR NOT has_function_privilege('service_role',
   'public.flow_apply_internal_effect(uuid,uuid)','EXECUTE')
 OR NOT (SELECT relrowsecurity FROM pg_class
   WHERE oid='public.flow_staff_notifications'::regclass)
 THEN RAISE EXCEPTION 'Unsafe internal inbox grants';END IF;
END $private$;
SELECT 'PASS: OFF gate, tag once, untag, assigned staff queue once, cross-tenant denied, private RLS' AS result;
