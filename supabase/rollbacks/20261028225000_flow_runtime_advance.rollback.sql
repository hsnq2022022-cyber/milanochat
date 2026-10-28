-- REVIEW ONLY. Destructive rollback refused if any lease exists.
BEGIN;
DO $g$
BEGIN
 IF to_regclass('public.automation_flow_run_leases') IS NULL OR
  obj_description('public.automation_flow_run_leases'::regclass) IS DISTINCT FROM
     'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE'
 THEN RAISE EXCEPTION 'Unrecognized run lease schema';END IF;
 IF EXISTS(SELECT 1 FROM public.automation_flow_run_leases)
 THEN RAISE EXCEPTION 'Active leases: cannot remove safely'; END IF;
END $g$;
DROP FUNCTION public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid);
DROP FUNCTION public.flow_lease_due_runs(integer);
DROP TABLE public.automation_flow_run_leases;
COMMIT;
