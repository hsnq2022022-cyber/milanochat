-- Verify disabled-by-default, privacy, and tenant isolation.
\set ON_ERROR_STOP on
DO $assert$
BEGIN
 IF (SELECT enabled FROM public.automation_flow_global_switch WHERE singleton)
  THEN RAISE EXCEPTION 'Global switch was ON by default'; END IF;
 IF (SELECT count(*) FROM public.automation_flow_tenant_switches)<>0
  THEN RAISE EXCEPTION 'Migration unexpectedly enabled/configured tenants'; END IF;
 IF has_table_privilege('anon','public.automation_flow_global_switch','UPDATE')
  OR has_table_privilege('authenticated','public.automation_flow_tenant_switches','UPDATE')
  OR NOT has_table_privilege('service_role','public.automation_flow_tenant_switches','UPDATE')
  THEN RAISE EXCEPTION 'Untrusted role can modify kill switches'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.automation_flow_global_switch'::regclass)
  OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.automation_flow_tenant_switches'::regclass)
  THEN RAISE EXCEPTION 'RLS disabled'; END IF;
END
$assert$;

SET ROLE service_role;
INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
DO $assert$
BEGIN
  IF EXISTS(
   SELECT 1 FROM public.automation_flow_global_switch g
     JOIN public.automation_flow_tenant_switches t
       ON t.tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
   WHERE g.enabled AND t.enabled
  ) THEN RAISE EXCEPTION 'Tenant can run while global flag is OFF'; END IF;
END
$assert$;
UPDATE public.automation_flow_global_switch SET enabled=true WHERE singleton;
DO $assert$
BEGIN
 IF NOT EXISTS(
   SELECT 1 FROM public.automation_flow_global_switch g
     JOIN public.automation_flow_tenant_switches t
       ON t.tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
   WHERE g.enabled AND t.enabled AND t.test_only
 ) THEN RAISE EXCEPTION 'Explicitly enabled test tenant could not opt in'; END IF;
 IF EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches
   WHERE tenant_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' AND enabled)
 THEN RAISE EXCEPTION 'Another tenant implicitly enabled'; END IF;
END
$assert$;
UPDATE public.automation_flow_global_switch SET enabled=false WHERE singleton;
RESET ROLE;
SELECT 'PASS: default OFF, private RLS, tenant opt-in, global kill switch' AS result;
