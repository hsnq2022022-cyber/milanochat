-- Read-only verification of the 20261028180000 runtime schema.
-- No tenant records, credits, messages or tokens are returned.
SELECT c.relname AS runtime_table,
  c.relrowsecurity AS rls_enabled,
  has_table_privilege('anon',c.oid,'SELECT') AS anon_select,
  has_table_privilege('authenticated',c.oid,'INSERT') AS authenticated_insert,
  has_table_privilege('service_role',c.oid,'SELECT') AS service_select,
  obj_description(c.oid) = 'CREATED_BY_20261028180000_FLOW_RUNTIME' AS migration_marker
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN (
 'automation_flow_publications','automation_flow_activations',
 'automation_flow_event_receipts','automation_flow_runs',
 'automation_flow_outbox','automation_flow_metrics'
) ORDER BY c.relname;
-- Expected: 6 rows, RLS=true, anon=false, auth=false, service=true, marker=true.

SELECT c.relname AS table_name,con.conname AS constraint_name,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
WHERE c.relname IN (
 'automation_flow_publications','automation_flow_activations',
 'automation_flow_event_receipts','automation_flow_runs',
 'automation_flow_outbox'
) AND con.contype IN ('f','p','u')
ORDER BY c.relname,con.conname;

SELECT
 (SELECT NOT enabled FROM public.automation_flow_global_switch WHERE singleton) AS global_disabled,
 (SELECT count(*) FROM public.automation_flow_activations WHERE is_active) AS activated_flows,
 (SELECT count(*) FROM public.automation_flow_outbox) AS queued_effects;
-- Expected on a new installation: global_disabled=true,
-- activated_flows=0, queued_effects=0.
