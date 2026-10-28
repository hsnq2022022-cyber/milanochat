-- READ ONLY verification for proposed 20261028220000 (do not execute write).
SELECT jsonb_build_object(
 'claim_table',to_regclass('public.automation_message_claims') IS NOT NULL,
 'claim_rpc',to_regprocedure('public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)') IS NOT NULL,
 'global_enabled',(SELECT enabled FROM public.automation_flow_global_switch WHERE singleton),
 'enabled_tenants',(SELECT count(*) FROM public.automation_flow_tenant_switches WHERE enabled),
 'outbox',(SELECT count(*) FROM public.automation_flow_outbox),
 'milan_api_expected_previous_version','101'
) AS claim_readonly_summary;
-- Detailed table RLS/ACL check requires that the migration is installed;
-- no dynamic SQL or DDL is run in this verification file.
SELECT c.relname,c.relrowsecurity,
 has_table_privilege('anon',c.oid,'SELECT') AS anon_select,
 has_table_privilege('authenticated',c.oid,'SELECT') AS authenticated_select,
 has_table_privilege('service_role',c.oid,'INSERT') AS service_insert
FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid
WHERE n.nspname='public' AND c.relname='automation_message_claims';
