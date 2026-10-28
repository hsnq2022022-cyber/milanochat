-- Disposable PostgreSQL 17 test; no customer data or real sends.
\set ON_ERROR_STOP on
GRANT SELECT ON public.tenants,public.channel_accounts TO service_role;
GRANT UPDATE(is_active) ON public.channel_accounts TO service_role;

SET ROLE service_role;
DO $test$
DECLARE
 t uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 other uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 a uuid:='11111111-1111-4111-8111-111111111111';
 wrong uuid:='22222222-2222-4222-8222-222222222222';
 owner uuid:='99999999-9999-4999-8999-999999999999';
 other_owner uuid:='88888888-8888-4888-8888-888888888888';
 doc jsonb:='{"version":3,"name":"Test","nodes":[{"id":"start","data":{"kind":"trigger"}}],"edges":[]}'::jsonb;
 rev bigint;
BEGIN
 rev:=public.flow_publish_revision(t,a,'instagram','welcome',owner,doc);
 IF rev IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FIRST_PUBLISH_FAILED %',rev;END IF;
 rev:=public.flow_publish_revision(t,a,'instagram','welcome',owner,doc);
 IF rev IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'SECOND_PUBLISH_FAILED %',rev;END IF;
 IF public.flow_publish_revision(t,wrong,'facebook','foreign',owner,doc) IS NOT NULL
   OR public.flow_publish_revision(other,wrong,'facebook','foreign',owner,doc) IS NOT NULL
   OR public.flow_publish_revision(t,a,'instagram','wrong_owner',other_owner,doc) IS NOT NULL
   OR public.flow_publish_revision(t,a,'facebook','wrong_platform',owner,doc) IS NOT NULL
   OR public.flow_publish_revision(t,a,'instagram','invalid',owner,'{}'::jsonb) IS NOT NULL
 THEN RAISE EXCEPTION 'BAD_PUBLISH_ACCEPTED';END IF;
 IF public.flow_publish_revision(t,wrong,'facebook','welcome',owner,doc) IS NOT NULL
 THEN RAISE EXCEPTION 'EXISTING_KEY_REASSIGNED_ACCOUNT';END IF;

 IF public.flow_activate_revision(t,a,'instagram','welcome',2,owner)
 THEN RAISE EXCEPTION 'ACTIVATED_WITH_GLOBAL_OFF'; END IF;
 INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only)
 VALUES(t,true,true);
 IF public.flow_activate_revision(t,a,'instagram','welcome',2,owner)
 THEN RAISE EXCEPTION 'ACTIVATED_WITH_GLOBAL_OFF_AND_TENANT_ON';END IF;
 UPDATE public.automation_flow_global_switch SET enabled=true WHERE singleton;

 IF public.flow_activate_revision(t,a,'instagram','welcome',99,owner)
  OR public.flow_activate_revision(t,a,'instagram','welcome',2,other_owner)
  OR public.flow_activate_revision(t,wrong,'facebook','welcome',2,owner)
 THEN RAISE EXCEPTION 'BAD_ACTIVATION_ACCEPTED';END IF;

 IF NOT public.flow_activate_revision(t,a,'instagram','welcome',2,owner)
 THEN RAISE EXCEPTION 'CANARY_ACTIVATION_FAILED';END IF;
 IF NOT (SELECT is_active AND revision=2 FROM public.automation_flow_activations
  WHERE tenant_id=t AND flow_key='welcome') THEN
  RAISE EXCEPTION 'ACTIVE_REVISION_WRONG';END IF;

 IF NOT public.flow_activate_revision(t,a,'instagram','welcome',1,owner)
 THEN RAISE EXCEPTION 'ROLLBACK_TO_PRIOR_VERSION_FAILED';END IF;
 IF NOT (SELECT is_active AND revision=1 FROM public.automation_flow_activations
  WHERE tenant_id=t AND flow_key='welcome')
  OR (SELECT COUNT(*) FROM public.automation_flow_publications
      WHERE tenant_id=t AND flow_key='welcome')<>2
 THEN RAISE EXCEPTION 'ROLLBACK_MODIFIED_IMMUTABLE_HISTORY';END IF;

 UPDATE public.automation_flow_global_switch SET enabled=false WHERE singleton;
 UPDATE public.automation_flow_tenant_switches SET enabled=false WHERE tenant_id=t;
 UPDATE public.channel_accounts SET is_active=false WHERE id=a;
 IF NOT public.flow_deactivate_revision(t,a,'instagram','welcome',owner)
 THEN RAISE EXCEPTION 'DEACTIVATE_WHILE_ACCOUNT_DISABLED_FAILED';END IF;
 IF (SELECT is_active FROM public.automation_flow_activations
  WHERE tenant_id=t AND flow_key='welcome') THEN
  RAISE EXCEPTION 'FLOW_STILL_ACTIVE';END IF;
 IF public.flow_deactivate_revision(t,a,'instagram','welcome',other_owner)
 THEN RAISE EXCEPTION 'FOREIGN_OWNER_DEACTIVATED';END IF;

END
$test$;
RESET ROLE;
DO $rights$
DECLARE r record;
BEGIN
 FOR r IN SELECT p.oid,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN
  ('flow_publish_revision','flow_activate_revision','flow_deactivate_revision')
 LOOP
  IF r.prosecdef OR has_function_privilege('anon',r.oid,'EXECUTE')
   OR has_function_privilege('authenticated',r.oid,'EXECUTE')
   OR NOT has_function_privilege('service_role',r.oid,'EXECUTE')
  THEN RAISE EXCEPTION 'PUBLISH_RPC_PRIVILEGE_MISMATCH';END IF;
 END LOOP;
END
$rights$;
SELECT 'PASS: immutable versions, owner isolation, canary OFF, rollback and disabled-account deactivation' AS result;
