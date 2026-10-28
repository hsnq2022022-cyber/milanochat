-- READ ONLY: checks that no flow can activate by default.
SELECT
  to_regclass('public.automation_flow_global_switch') IS NOT NULL AS global_table_exists,
  to_regclass('public.automation_flow_tenant_switches') IS NOT NULL AS tenant_table_exists,
  (SELECT NOT enabled FROM public.automation_flow_global_switch WHERE singleton) AS global_default_off,
  (SELECT count(*) FROM public.automation_flow_tenant_switches) AS configured_tenants,
  (SELECT count(*) FROM public.automation_flow_tenant_switches WHERE enabled) AS enabled_tenants,
  has_table_privilege('anon','public.automation_flow_global_switch','UPDATE') AS anon_can_update_global,
  has_table_privilege('authenticated','public.automation_flow_tenant_switches','UPDATE') AS auth_can_update_tenant,
  has_table_privilege('service_role','public.automation_flow_tenant_switches','UPDATE') AS service_can_update_tenant;
-- Expected immediately after migration on this project:
-- both tables exist, global_default_off=true, configured_tenants=0,
-- enabled_tenants=0, anon_can_update_global=false,
-- auth_can_update_tenant=false, service_can_update_tenant=true.
