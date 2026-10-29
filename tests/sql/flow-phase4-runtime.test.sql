\set ON_ERROR_STOP on
SET ROLE service_role;
DO $test$
DECLARE tenant uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 run uuid:='77777777-7777-4777-8777-7777777777a4';
 effects jsonb:='[{"kind":"message","idempotencyKey":"msg-1","payload":{"text":"Hi"}},{"kind":"tag","idempotencyKey":"tag-1","payload":{"tag":"lead"}}]';
BEGIN
 IF public.flow_commit_run_step(tenant,run,0,'ready','msg',1,'ready',
  '{}'::jsonb,NULL,effects,'transition',NULL) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'OFF SWITCH SHOULD PREVENT TRANSITION'; END IF;
 UPDATE public.automation_flow_global_switch SET enabled=true;
 INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only)
 VALUES(tenant,true,true);
 IF public.flow_commit_run_step(tenant,run,0,'ready','msg',1,'ready',
  '{}'::jsonb,NULL,effects,'transition',NULL) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'FIRST COMMIT FAILED'; END IF;
 IF public.flow_commit_run_step(tenant,run,0,'ready','msg',1,'ready',
  '{}'::jsonb,NULL,effects,'transition',NULL) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'DUPLICATE STEP COMMITTED'; END IF;
 IF (SELECT count(*) FROM public.automation_flow_outbox WHERE tenant_id=tenant)<>2
 OR (SELECT count(*) FROM public.automation_flow_metrics WHERE tenant_id=tenant AND event_key='transition')<>1
 THEN RAISE EXCEPTION 'ATOMIC_EFFECT_OR_METRIC_WRONG';END IF;
 -- Invalid effect aborts before any state/effect rows can be persisted.
 IF public.flow_commit_run_step(tenant,run,1,'ready','bad',2,'ready',
  '{}'::jsonb,NULL,'[{"kind":"request","idempotencyKey":"bad","payload":{}}]'::jsonb,
  'transition',NULL) IS DISTINCT FROM false THEN RAISE EXCEPTION 'UNSUPPORTED EFFECT ACCEPTED';END IF;
 IF (SELECT step_count FROM public.automation_flow_runs WHERE id=run)<>1 THEN
  RAISE EXCEPTION 'INVALID EFFECT COMMITTED A STEP';END IF;
 -- Durable delay, lease and resume.
 IF public.flow_commit_run_step(tenant,run,1,'ready','delay',2,'sleeping',
  '{}'::jsonb,now()-interval '1 minute',
  '[{"kind":"delay","idempotencyKey":"sleep","payload":{"seconds":30}}]'::jsonb,
  'transition',NULL) IS DISTINCT FROM true THEN RAISE EXCEPTION 'SLEEP_COMMIT_FAILED';END IF;
 IF (SELECT count(*) FROM public.flow_lease_due_runs(10))<>1 THEN
  RAISE EXCEPTION 'DUE_RUN_NOT_LEASED';END IF;
 IF EXISTS(SELECT 1 FROM public.flow_lease_due_runs(10)) THEN
  RAISE EXCEPTION 'DUPLICATE_LEASE';END IF;
 IF public.flow_commit_run_step(tenant,run,2,'sleeping','done',3,'completed',
  '{}'::jsonb,NULL,'[]'::jsonb,'completed',NULL) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'RESUMED_WITHOUT_LEASE';END IF;
 IF public.flow_commit_run_step(tenant,run,2,'sleeping','done',3,'completed',
  '{}'::jsonb,NULL,'[]'::jsonb,'completed',(SELECT token FROM public.automation_flow_run_leases WHERE run_id=run))
    IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'LEASED_RESUME_FAILED';END IF;
 IF (SELECT count(*) FROM public.automation_flow_run_leases WHERE run_id=run)<>0
 OR (SELECT count(*) FROM public.automation_flow_metrics WHERE run_id=run AND event_key='completed')<>1
 THEN RAISE EXCEPTION 'LEASE_NOT_RELEASED_OR_METRIC_MISSING';END IF;
END $test$;
-- Production rollout reuses the same durable DB leases, but may only
-- operate on operator-approved Instagram runs. Do not enable customer sends.
DO $production$
DECLARE tenant uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 run uuid:='77777777-7777-4777-8777-7777777777a4';
 lease uuid;
BEGIN
 UPDATE public.automation_flow_runs SET run_status='ready',
  step_count=0,current_node_id='start',wake_at=NULL
 WHERE tenant_id=tenant AND id=run;
 UPDATE public.automation_flow_tenant_switches
 SET test_only=false,production_approved=false WHERE tenant_id=tenant;
 IF public.flow_commit_run_step(tenant,run,0,'ready','delay',1,'sleeping',
   '{}'::jsonb,now()-interval '1 minute','[]'::jsonb,'transition',NULL)
   IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'UNAPPROVED_PRODUCTION_RUN_ACCEPTED'; END IF;
 UPDATE public.automation_flow_tenant_switches SET production_approved=true
 WHERE tenant_id=tenant;
 IF public.flow_commit_run_step(tenant,run,0,'ready','delay',1,'sleeping',
   '{}'::jsonb,now()-interval '1 minute','[]'::jsonb,'transition',NULL)
   IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'APPROVED_INSTAGRAM_RUN_REJECTED'; END IF;
 SELECT lease_token INTO lease FROM public.flow_lease_due_runs(10);
 IF lease IS NULL THEN RAISE EXCEPTION 'APPROVED_DUE_INSTAGRAM_NOT_LEASED';END IF;
 UPDATE public.automation_flow_tenant_switches SET production_approved=false
 WHERE tenant_id=tenant;
 IF public.flow_commit_run_step(tenant,run,1,'sleeping','finish',2,'completed',
   '{}'::jsonb,NULL,'[]'::jsonb,'completed',lease) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'REVOKED_APPROVAL_STILL_RESUMED';END IF;
 UPDATE public.automation_flow_tenant_switches SET production_approved=true
 WHERE tenant_id=tenant;
 IF public.flow_commit_run_step(tenant,run,1,'sleeping','finish',2,'completed',
   '{}'::jsonb,NULL,'[]'::jsonb,'completed',lease) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'APPROVED_WAKE_UP_NOT_COMPLETED';END IF;
 IF (SELECT count(*) FROM public.automation_flow_run_leases
     WHERE tenant_id=tenant AND run_id=run)<>0
 THEN RAISE EXCEPTION 'LEASE_NOT_RELEASED';END IF;
END $production$;
RESET ROLE;
DO $privacy$
BEGIN
 IF has_function_privilege('anon','public.flow_lease_due_runs(integer)','EXECUTE')
 OR has_function_privilege('authenticated',
   'public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)',
   'EXECUTE')
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.automation_flow_run_leases'::regclass)
 THEN RAISE EXCEPTION 'PUBLIC_RUNTIME_PRIVILEGE';END IF;
END $privacy$;
SELECT 'PASS: OFF blocks, atomic state+outbox+metrics, no replay, invalid effect rejects, durable lease one winner, resume once, RLS' AS result;
