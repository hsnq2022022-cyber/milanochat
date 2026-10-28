-- REVIEW-ONLY rollback for 20261028180000_flow_runtime_tenant_bound.
-- Never run on a live project without its own GO. Preserves all data by
-- refusing to drop any nonempty flow table or a table not created here.
BEGIN;
DO $rollback$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'automation_flow_publications','automation_flow_activations',
    'automation_flow_event_receipts','automation_flow_runs',
    'automation_flow_outbox','automation_flow_metrics'
  ] LOOP
    IF to_regclass('public.'||name) IS NULL OR
       obj_description(to_regclass('public.'||name)) IS DISTINCT FROM
         'CREATED_BY_20261028180000_FLOW_RUNTIME' THEN
      RAISE EXCEPTION 'Missing/unrecognized runtime table %: refusing rollback',name;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.automation_flow_metrics LIMIT 1)
    OR EXISTS(SELECT 1 FROM public.automation_flow_outbox LIMIT 1)
    OR EXISTS(SELECT 1 FROM public.automation_flow_runs LIMIT 1)
    OR EXISTS(SELECT 1 FROM public.automation_flow_event_receipts LIMIT 1)
    OR EXISTS(SELECT 1 FROM public.automation_flow_activations LIMIT 1)
    OR EXISTS(SELECT 1 FROM public.automation_flow_publications LIMIT 1)
  THEN RAISE EXCEPTION 'Refusing to delete saved flow runtime/publications';END IF;
END
$rollback$;
DROP TABLE public.automation_flow_metrics;
DROP TABLE public.automation_flow_outbox;
DROP TABLE public.automation_flow_runs;
DROP TABLE public.automation_flow_event_receipts;
DROP TABLE public.automation_flow_activations;
DROP TABLE public.automation_flow_publications;
DROP FUNCTION public.reject_automation_flow_revision_mutation();
-- Preserve the two non-destructive composite indexes on existing tables:
-- other features may already depend on them when this rollback is used.
-- Removing them would require independent dependency review and owner GO.
COMMIT;
