-- Owner-GO-only rollback. Do not drop customer-related switch state.
-- Preserves any pre-existing tables and refuses deletion if enabled or
-- if tenant-specific rows exist, even when no live messages were sent.
BEGIN;
DO $rollback$
DECLARE global_marker text;tenant_marker text;
BEGIN
  IF to_regclass('public.automation_flow_global_switch') IS NULL OR
     to_regclass('public.automation_flow_tenant_switches') IS NULL THEN
    RAISE NOTICE 'No complete switch schema to rollback';
    RETURN;
  END IF;
  global_marker:=obj_description('public.automation_flow_global_switch'::regclass);
  tenant_marker:=obj_description('public.automation_flow_tenant_switches'::regclass);
  IF global_marker IS DISTINCT FROM 'CREATED_BY_20261028170000_automation_flow_switches'
     OR tenant_marker IS DISTINCT FROM 'CREATED_BY_20261028170000_automation_flow_switches'
  THEN
    RAISE EXCEPTION 'Pre-existing switch tables; preserve them during rollback';
  END IF;
  IF EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches LIMIT 1) OR
     EXISTS(SELECT 1 FROM public.automation_flow_global_switch WHERE enabled)
  THEN RAISE EXCEPTION 'Nonempty or enabled switch state; refusing destructive rollback';
  END IF;
  DROP TABLE public.automation_flow_tenant_switches;
  DROP TABLE public.automation_flow_global_switch;
END
$rollback$;
COMMIT;
