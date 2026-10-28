-- READ ONLY: require private, service-only, invoker RPCs and zero starts.
SELECT p.oid::regprocedure::text AS function_name,
 p.prosecdef AS security_definer,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN
 ('flow_publish_revision','flow_activate_revision','flow_deactivate_revision')
ORDER BY p.proname;
-- Expected: 3 rows, security_definer=false, anon/auth=false, service=true.

SELECT (SELECT enabled FROM public.automation_flow_global_switch
 WHERE singleton) AS global_enabled,
 (SELECT COUNT(*) FROM public.automation_flow_tenant_switches
 WHERE enabled) AS tenant_enabled,
 (SELECT COUNT(*) FROM public.automation_flow_activations
 WHERE is_active) AS flow_activations;
-- After install with no canary: false, 0, 0. Existing preapproved test data
-- may cause nonzero counts; inspect before ANY activation.
