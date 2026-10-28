-- REVIEW ONLY: durable Phase-4 runner, metric and wake-up leases. NOT installed.
BEGIN;
DO $g$
BEGIN
 IF to_regclass('public.automation_flow_run_leases') IS NOT NULL OR
    to_regprocedure('public.flow_lease_due_runs(integer)') IS NOT NULL OR
    to_regprocedure('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)') IS NOT NULL
 THEN RAISE EXCEPTION 'Run advancement objects already exist'; END IF;
 IF to_regclass('public.automation_flow_outbox') IS NULL OR
    to_regclass('public.automation_flow_metrics') IS NULL
 THEN RAISE EXCEPTION 'Existing runtime tables required'; END IF;
END $g$;
CREATE TABLE public.automation_flow_run_leases(
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 token uuid NOT NULL DEFAULT gen_random_uuid(),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,run_id),
 FOREIGN KEY(tenant_id,run_id)
 REFERENCES public.automation_flow_runs(tenant_id,id) ON DELETE CASCADE
);
COMMENT ON TABLE public.automation_flow_run_leases IS 'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE';
ALTER TABLE public.automation_flow_run_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.automation_flow_run_leases FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.automation_flow_run_leases TO service_role;

CREATE FUNCTION public.flow_lease_due_runs(p_limit integer DEFAULT 20)
RETURNS TABLE(tenant_id uuid,run_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $lease$
DECLARE r record; t uuid;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN
  RAISE EXCEPTION 'Invalid lease batch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch WHERE singleton AND enabled)
 THEN RETURN; END IF;
 FOR r IN SELECT run.tenant_id,run.id
  FROM public.automation_flow_runs run
  JOIN public.automation_flow_tenant_switches x
   ON x.tenant_id=run.tenant_id AND x.enabled AND x.test_only
  WHERE run.run_status='sleeping' AND run.wake_at<=now()
  ORDER BY run.wake_at,run.id
  FOR UPDATE OF run SKIP LOCKED LIMIT p_limit
 LOOP
  t:=NULL;
  INSERT INTO public.automation_flow_run_leases(tenant_id,run_id,token,expires_at)
  VALUES(r.tenant_id,r.id,gen_random_uuid(),now()+interval '2 minutes')
  ON CONFLICT ON CONSTRAINT automation_flow_run_leases_pkey DO UPDATE
  SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at
  WHERE public.automation_flow_run_leases.expires_at<=now()
  RETURNING token INTO t;
  IF t IS NOT NULL THEN
   RETURN QUERY SELECT r.tenant_id,r.id,t;
  END IF;
 END LOOP;
END $lease$;

-- Transaction boundary: lock one run, validate generation, transition state,
-- append idempotent effects, and record a metric. Any failure rolls back all.
CREATE FUNCTION public.flow_commit_run_step(
 p_tenant uuid,p_run uuid,p_expect_step integer,p_expect_status text,
 p_next_node text,p_next_step integer,p_next_status text,
 p_variables jsonb,p_wake_at timestamptz,p_effects jsonb,p_metric text,
 p_lease_token uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $advance$
DECLARE old record; e jsonb; k text; kind text; payload jsonb;
BEGIN
 IF p_tenant IS NULL OR p_run IS NULL OR p_expect_step IS NULL OR
  p_expect_status IS NULL OR p_next_node IS NULL OR
  length(p_next_node) NOT BETWEEN 1 AND 128 OR
  p_next_step IS NULL OR p_next_step NOT BETWEEN 0 AND 150 OR
  p_next_step<p_expect_step OR p_next_status IS NULL OR
  p_next_status NOT IN('ready','awaiting_input','sleeping','handoff','completed','blocked') OR
  p_variables IS NULL OR jsonb_typeof(p_variables)<>'object' OR
  octet_length(p_variables::text)>32768 OR
  p_effects IS NULL OR jsonb_typeof(p_effects)<>'array' OR
  jsonb_array_length(p_effects)>5 OR
  p_metric NOT IN('started','transition','button','completed','handoff','failed')
 THEN RETURN false; END IF;
 IF (p_next_status='sleeping') IS DISTINCT FROM (p_wake_at IS NOT NULL)
 THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch WHERE singleton AND enabled)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches
   WHERE tenant_id=p_tenant AND enabled AND test_only)
 THEN RETURN false; END IF;
 SELECT run_status,step_count,wake_at INTO old
 FROM public.automation_flow_runs WHERE id=p_run AND tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND OR old.run_status<>p_expect_status OR old.step_count<>p_expect_step OR
    old.run_status IN('completed','handoff','blocked')
 THEN RETURN false; END IF;
 IF old.run_status='sleeping' THEN
  IF old.wake_at>now() OR NOT EXISTS(
    SELECT 1 FROM public.automation_flow_run_leases WHERE
      tenant_id=p_tenant AND run_id=p_run AND token=p_lease_token AND expires_at>now())
  THEN RETURN false; END IF;
 END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p_effects)
 LOOP
  IF jsonb_typeof(e)<>'object' THEN RETURN false; END IF;
  k:=e->>'idempotencyKey';
  kind:=e->>'kind';
  payload:=e->'payload';
  IF k IS NULL OR length(k) NOT BETWEEN 1 AND 1024 OR
     kind NOT IN('message','question','delay','handoff','tag','untag','staff_notification') OR
     payload IS NULL OR jsonb_typeof(payload)<>'object' OR octet_length(payload::text)>65536
  THEN RETURN false; END IF;
  INSERT INTO public.automation_flow_outbox(
    tenant_id,run_id,idempotency_key,effect_kind,payload)
  VALUES(p_tenant,p_run,k,kind,payload)
  ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
 END LOOP;
 UPDATE public.automation_flow_runs
 SET current_node_id=p_next_node,step_count=p_next_step,run_status=p_next_status,
     variables=p_variables,wake_at=p_wake_at,updated_at=now()
 WHERE id=p_run AND tenant_id=p_tenant;
 INSERT INTO public.automation_flow_metrics(tenant_id,run_id,event_key)
 VALUES(p_tenant,p_run,p_metric);
 IF old.run_status='sleeping' THEN
  DELETE FROM public.automation_flow_run_leases WHERE tenant_id=p_tenant AND run_id=p_run;
 END IF;
 RETURN true;
END $advance$;
COMMENT ON FUNCTION public.flow_lease_due_runs(integer) IS 'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE';
COMMENT ON FUNCTION public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)
 IS 'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE';
REVOKE ALL ON FUNCTION public.flow_lease_due_runs(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_lease_due_runs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid) TO service_role;
COMMIT;
