\set ON_ERROR_STOP on
SET ROLE service_role;
INSERT INTO public.tenant_staff_memberships(tenant_id,user_id,role,status,invited_by)
VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '77777777-7777-4777-8777-777777777777','agent','active',
  '99999999-9999-4999-8999-999999999999'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '66666666-6666-4666-8666-666666666666','admin','active',
  '99999999-9999-4999-8999-999999999999'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '55555555-5555-4555-8555-555555555555','auditor','active',
  '99999999-9999-4999-8999-999999999999'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '44444444-4444-4444-8444-444444444444','agent','suspended',
  '99999999-9999-4999-8999-999999999999');
INSERT INTO public.tenant_conversation_assignments(
 tenant_id,conversation_id,user_id,assigned_by)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '44444444-4444-4444-8444-444444444444',
 '77777777-7777-4777-8777-777777777777',
 '99999999-9999-4999-8999-999999999999');
DO $roles$
DECLARE a uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 b uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 own uuid:='99999999-9999-4999-8999-999999999999';
 agent uuid:='77777777-7777-4777-8777-777777777777';
 adm uuid:='66666666-6666-4666-8666-666666666666';
 aud uuid:='55555555-5555-4555-8555-555555555555';
 suspended uuid:='44444444-4444-4444-8444-444444444444';
 ac uuid:='44444444-4444-4444-8444-444444444444';
 bc uuid:='55555555-5555-4555-8555-555555555555';
BEGIN
 IF NOT public.flow_staff_can(a,own,'publish_flow',null)
 OR public.flow_staff_can(b,own,'review_read',bc)
 OR NOT public.flow_staff_can(a,adm,'review_resolve',null)
 OR public.flow_staff_can(a,adm,'publish_flow',null)
 OR public.flow_staff_can(a,adm,'credit_manage',null)
 OR NOT public.flow_staff_can(a,agent,'reply',ac)
 OR public.flow_staff_can(a,agent,'reply',bc)
 OR public.flow_staff_can(b,agent,'review_read',bc)
 OR public.flow_staff_can(a,agent,'review_resolve',ac)
 OR NOT public.flow_staff_can(a,aud,'metrics',null)
 OR public.flow_staff_can(a,aud,'reply',ac)
 OR public.flow_staff_can(a,suspended,'reply',ac)
 OR public.flow_staff_can(a,agent,'secrets',ac)
 THEN RAISE EXCEPTION 'Server capability matrix violated';END IF;
 BEGIN
  INSERT INTO public.tenant_conversation_assignments(tenant_id,conversation_id,user_id)
  VALUES(b,ac,agent);
  RAISE EXCEPTION 'Should have rejected foreign conversation assignment';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO public.tenant_staff_memberships(tenant_id,user_id,role,status)
  VALUES(a,agent,'admin','active');
  RAISE EXCEPTION 'Should have rejected duplicate tenant/user';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 UPDATE public.tenant_staff_memberships
 SET status='suspended' WHERE tenant_id=a AND user_id=agent;
 IF public.flow_staff_can(a,agent,'reply',ac)
 THEN RAISE EXCEPTION 'Suspended member still authorized'; END IF;
END $roles$;
RESET ROLE;
DO $acl$
BEGIN
 IF has_table_privilege('anon','public.tenant_staff_memberships','SELECT')
 OR has_table_privilege('authenticated','public.tenant_staff_memberships','INSERT')
 OR has_table_privilege('authenticated','public.tenant_conversation_assignments','SELECT')
 OR has_function_privilege('anon','public.flow_staff_can(uuid,uuid,text,uuid)','EXECUTE')
 OR has_function_privilege('authenticated','public.flow_staff_can(uuid,uuid,text,uuid)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.flow_staff_can(uuid,uuid,text,uuid)','EXECUTE')
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.tenant_staff_memberships'::regclass)
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.tenant_conversation_assignments'::regclass)
 THEN RAISE EXCEPTION 'RBAC table or function privileges unsafe';END IF;
END $acl$;
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='55555555-5555-4555-8555-555555555555';
DO $member$
BEGIN
 IF (SELECT count(*) FROM public.tenant_staff_memberships)<>1
 OR EXISTS(SELECT 1 FROM public.tenant_staff_memberships WHERE role='admin')
 THEN RAISE EXCEPTION 'Authenticated user can see other memberships';END IF;
END $member$;
COMMIT;
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='88888888-8888-4888-8888-888888888888';
DO $owner$
BEGIN
 IF EXISTS(SELECT 1 FROM public.tenant_staff_memberships)
 THEN RAISE EXCEPTION 'Other owner can enumerate memberships';END IF;
END $owner$;
COMMIT;
SELECT 'PASS: owner/admin/agent/auditor scoped, suspend immediate, cross-tenant FK, no browser RPC, own-row RLS' AS test;
