-- Disposable PostgreSQL 17 end-to-end constraint and RLS checks.
\set ON_ERROR_STOP on
DO $checks$
DECLARE
  ta uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  tb uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  aa uuid:='11111111-1111-4111-8111-111111111111';
  ab uuid:='22222222-2222-4222-8222-222222222222';
  ca uuid:='44444444-4444-4444-8444-444444444444';
  cb uuid:='55555555-5555-4555-8555-555555555555';
  noacc uuid:='66666666-6666-4666-8666-666666666666';
  run uuid:='77777777-7777-4777-8777-777777777777';
  actor uuid:='99999999-9999-4999-8999-999999999999';
  doc jsonb:='{"version":3,"name":"Test","nodes":[],"edges":[]}'::jsonb;
BEGIN
  IF (SELECT enabled FROM public.automation_flow_global_switch WHERE singleton)
    OR EXISTS(SELECT 1 FROM public.automation_flow_activations) THEN
    RAISE EXCEPTION 'Runtime was active by default';
  END IF;

  INSERT INTO public.automation_flow_publications
   (tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
  VALUES(ta,'welcome',1,aa,'instagram',doc,actor);

  BEGIN
    INSERT INTO public.automation_flow_publications
     (tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
    VALUES(ta,'wrong_account',1,ab,'facebook',doc,actor);
    RAISE EXCEPTION 'CROSS-TENANT PUBLICATION ALLOWED';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.automation_flow_publications
     (tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
    VALUES(tb,'wrong_platform',1,ab,'messenger',doc,actor);
    RAISE EXCEPTION 'WRONG PLATFORM ALLOWED';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  INSERT INTO public.automation_flow_activations
   (tenant_id,channel_account_id,platform,flow_key,revision)
  VALUES(ta,aa,'instagram','welcome',1);
  IF (SELECT is_active FROM public.automation_flow_activations
      WHERE tenant_id=ta AND flow_key='welcome')
    THEN RAISE EXCEPTION 'Flow activated without consent';
  END IF;

  INSERT INTO public.automation_flow_event_receipts
   (tenant_id,channel_account_id,platform,provider_event_id)
  VALUES(ta,aa,'instagram','meta-event-1');
  BEGIN
    INSERT INTO public.automation_flow_event_receipts
     (tenant_id,channel_account_id,platform,provider_event_id)
    VALUES(ta,aa,'instagram','meta-event-1');
    RAISE EXCEPTION 'DUPLICATE RECEIPT ALLOWED';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  INSERT INTO public.automation_flow_runs
   (tenant_id,id,flow_key,publication_revision,channel_account_id,
    platform,conversation_id,provider_event_id,current_node_id)
  VALUES(ta,run,'welcome',1,aa,'instagram',ca,'meta-event-1','trigger');

  -- Distinct provider IDs keep the uniqueness test from masking tenant FK.
  INSERT INTO public.automation_flow_event_receipts
   (tenant_id,channel_account_id,platform,provider_event_id)
  VALUES(ta,aa,'instagram','meta-event-cross');
  INSERT INTO public.automation_flow_event_receipts
   (tenant_id,channel_account_id,platform,provider_event_id)
  VALUES(ta,aa,'instagram','meta-event-unbound');

  BEGIN
    INSERT INTO public.automation_flow_runs
     (tenant_id,flow_key,publication_revision,channel_account_id,
      platform,conversation_id,provider_event_id,current_node_id)
    VALUES(ta,'welcome',1,aa,'instagram',cb,'meta-event-cross','trigger');
    RAISE EXCEPTION 'CROSS-TENANT CONVERSATION ALLOWED';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.automation_flow_runs
     (tenant_id,flow_key,publication_revision,channel_account_id,
      platform,conversation_id,provider_event_id,current_node_id)
    VALUES(ta,'welcome',1,aa,'instagram',noacc,'meta-event-unbound','trigger');
    RAISE EXCEPTION 'NULL ACCOUNT CONVERSATION ALLOWED';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.automation_flow_runs
     (tenant_id,flow_key,publication_revision,channel_account_id,
      platform,conversation_id,provider_event_id,current_node_id)
    VALUES(ta,'welcome',1,aa,'instagram',ca,'meta-event-1','trigger');
    RAISE EXCEPTION 'DUPLICATE RUN ALLOWED';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  INSERT INTO public.automation_flow_outbox
   (tenant_id,run_id,idempotency_key,effect_kind,payload)
  VALUES(ta,run,'effect-1','message','{"text":"synthetic"}'::jsonb);

  BEGIN
    INSERT INTO public.automation_flow_outbox
     (tenant_id,run_id,idempotency_key,effect_kind,payload)
    VALUES(ta,run,'effect-1','message','{"text":"again"}'::jsonb);
    RAISE EXCEPTION 'DUPLICATE OUTBOX ALLOWED';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.automation_flow_outbox
     (tenant_id,run_id,idempotency_key,effect_kind,payload)
    VALUES(tb,run,'cross-tenant','message','{"text":"wrong"}'::jsonb);
    RAISE EXCEPTION 'CROSS-TENANT OUTBOX ALLOWED';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.automation_flow_publications
     SET document='{}'::jsonb WHERE tenant_id=ta AND flow_key='welcome';
    RAISE EXCEPTION 'REVISION MODIFIED';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM public.automation_flow_publications
     WHERE tenant_id=ta AND flow_key='welcome';
    RAISE EXCEPTION 'REVISION DELETED';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$checks$;
DO $security$
DECLARE name text; rel regclass;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'automation_flow_publications','automation_flow_activations',
    'automation_flow_event_receipts','automation_flow_runs',
    'automation_flow_outbox','automation_flow_metrics'
  ] LOOP
    rel:=to_regclass('public.'||name);
    IF rel IS NULL OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid=rel)
      THEN RAISE EXCEPTION 'MISSING RLS: %',name;
    END IF;
    IF has_table_privilege('anon',rel,'SELECT')
      OR has_table_privilege('authenticated',rel,'INSERT')
      OR NOT has_table_privilege('service_role',rel,'SELECT')
      THEN RAISE EXCEPTION 'WRONG ROLE PRIVILEGES: %',name;
    END IF;
  END LOOP;
END
$security$;
SELECT 'PASS: tenant/account/conversation FKs, idempotency, RLS and immutable revisions' AS result;
