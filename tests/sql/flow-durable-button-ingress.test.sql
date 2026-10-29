\set ON_ERROR_STOP on
-- Disposable PostgreSQL 17 only: no customer data, no Meta API calls.
ALTER TABLE public.tenants ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.channel_accounts
 ADD COLUMN is_active boolean NOT NULL DEFAULT true,
 ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true,
 ADD COLUMN auto_reply boolean NOT NULL DEFAULT true;
ALTER TABLE public.automation_flow_tenant_switches
 ADD COLUMN production_approved boolean NOT NULL DEFAULT false;
INSERT INTO public.automation_flow_publications(
 tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
VALUES(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','interactive',1,
 '11111111-1111-4111-8111-111111111111','instagram',
 '{"version":3,"name":"buttons","nodes":[{"id":"start","data":{"kind":"trigger","platform":"instagram","triggerMode":"message"}},{"id":"btn","data":{"kind":"question","text":"Choose","inputMode":"buttons","options":[{"id":"one","label":"Yes"}]}},{"id":"end","data":{"kind":"message","text":"Okay","options":[],"contentBlocks":[],"image":""}}],"edges":[{"source":"start","target":"btn","sourceHandle":"next"},{"source":"btn","target":"end","sourceHandle":"one"}]}'::jsonb,
 '88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_activations(
 tenant_id,channel_account_id,platform,flow_key,revision,is_active)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '11111111-1111-4111-8111-111111111111','instagram','interactive',1,true);
INSERT INTO public.automation_flow_tenant_switches(
 tenant_id,enabled,test_only,production_approved)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true,false,true);
INSERT INTO public.automation_message_claims(
 tenant_id,channel_account_id,platform,provider_event_id,
 conversation_id,inbound_message_id,route)
VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '11111111-1111-4111-8111-111111111111','instagram','meta-a1',
 '44444444-4444-4444-8444-444444444444',
 '77777777-7777-4777-8777-777777777771','flow'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '11111111-1111-4111-8111-111111111111','instagram','meta-a2',
 '44444444-4444-4444-8444-444444444444',
 '77777777-7777-4777-8777-777777777772','flow');

SET ROLE service_role;
DO $test$
DECLARE a uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 account uuid:='11111111-1111-4111-8111-111111111111';
 conv uuid:='44444444-4444-4444-8444-444444444444';
 first_msg uuid:='77777777-7777-4777-8777-777777777771';
 choice_msg uuid:='77777777-7777-4777-8777-777777777772';
 run uuid;
 effects jsonb:='[{"kind":"question","idempotencyKey":"ask-1","payload":{"kind":"question","text":"Choose","inputMode":"buttons","choices":["Yes"],"choiceIds":["one"]}}]'::jsonb;
 reply jsonb:='[{"kind":"message","idempotencyKey":"reply-1","payload":{"kind":"message","text":"Okay"}}]'::jsonb;
BEGIN
 -- Absolute global gate blocks run creation.
 IF public.flow_begin_durable_run(a,account,conv,first_msg,'meta-a1','interactive',
    1,'start','btn',2,'awaiting_input','{}'::jsonb,NULL,effects) IS NOT NULL
 THEN RAISE EXCEPTION 'GLOBAL_OFF_START_SUCCEEDED';END IF;
 UPDATE public.automation_flow_global_switch SET enabled=true WHERE singleton=true;
 -- The same provider event may enter only once, with one initial effect.
 SELECT public.flow_begin_durable_run(a,account,conv,first_msg,'meta-a1','interactive',
   1,'start','btn',2,'awaiting_input','{}'::jsonb,NULL,effects) INTO run;
 IF run IS NULL THEN RAISE EXCEPTION 'VERIFIED_BUTTON_RUN_NOT_STARTED';END IF;
 IF public.flow_begin_durable_run(a,account,conv,first_msg,'meta-a1','interactive',
   1,'start','btn',2,'awaiting_input','{}'::jsonb,NULL,effects) IS NOT NULL
 THEN RAISE EXCEPTION 'DUPLICATE_PROVIDER_EVENT_STARTED_TWICE';END IF;
 IF (SELECT count(*) FROM public.automation_flow_outbox WHERE run_id=run)<>1
 OR (SELECT count(*) FROM public.automation_flow_event_receipts WHERE provider_event_id='meta-a1')<>1
 OR (SELECT run_status FROM public.automation_flow_runs WHERE id=run)<>'awaiting_input'
 THEN RAISE EXCEPTION 'RUN_OR_QUESTION_NOT_DURABLE';END IF;

 -- An unapproved store cannot resume a previously waiting run.
 UPDATE public.automation_flow_tenant_switches SET production_approved=false WHERE tenant_id=a;
 IF public.flow_resume_button_run(a,run,'meta-a2',choice_msg,2,'btn','end',3,
   'completed','{}'::jsonb,NULL,reply) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'REVOKED_APPROVAL_RESUMED';END IF;
 UPDATE public.automation_flow_tenant_switches SET production_approved=true WHERE tenant_id=a;

 IF public.flow_resume_button_run(a,run,'meta-a2',choice_msg,2,'btn','end',3,
   'completed','{}'::jsonb,NULL,reply) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'VERIFIED_BUTTON_DID_NOT_RESUME';END IF;
 IF public.flow_resume_button_run(a,run,'meta-a2',choice_msg,2,'btn','end',3,
   'completed','{}'::jsonb,NULL,reply) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'REPLAYED_BUTTON_RESUMED_TWICE';END IF;
 IF public.flow_resume_button_run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   run,'meta-b1','77777777-7777-4777-8777-777777777773',2,'btn','end',3,
   'completed','{}'::jsonb,NULL,reply) IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'CROSS_TENANT_BUTTON_SUCCEEDED';END IF;
 IF (SELECT count(*) FROM public.automation_flow_outbox WHERE run_id=run)<>2
 OR (SELECT count(*) FROM public.automation_flow_event_receipts WHERE provider_event_id='meta-a2')<>1
 OR (SELECT run_status FROM public.automation_flow_runs WHERE id=run)<>'completed'
 OR (SELECT step_count FROM public.automation_flow_runs WHERE id=run)<>3
 THEN RAISE EXCEPTION 'BUTTON_TRANSITION_NOT_ATOMIC';END IF;
END $test$;
RESET ROLE;
DO $acl$
BEGIN
 IF has_function_privilege('anon',
  'public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)','EXECUTE')
 OR has_function_privilege('authenticated',
  'public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'PUBLIC_BUTTON_RPC_EXECUTION_ALLOWED';END IF;
END $acl$;
SELECT 'PASS: durable start+awaiting button+one resume, production approval, replay, isolation, atomic effects' AS result;
