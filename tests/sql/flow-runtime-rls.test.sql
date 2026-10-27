-- Runs only in disposable CI postgres:17 after stage 7 owner fixture.
\set ON_ERROR_STOP on
set role service_role;
do $checks$
declare
  tenant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  publication jsonb := '{"version":3,"name":"Welcome","nodes":[],"edges":[]}';
  run_id uuid;
  receipts integer;
begin
  insert into public.automation_flow_publications
  (tenant_id,flow_key,revision,document,published_by)
  values(tenant,'welcome',1,publication,'11111111-1111-4111-8111-111111111111');

  -- تعديل الوثيقة المنشورة يفشل حتى عندما يطلبه دور الخادم.
  begin
    update public.automation_flow_publications set document=publication
    where tenant_id=tenant and flow_key='welcome';
    raise exception 'PUBLISHED_REVISION_MUTABLE';
  exception when check_violation then null;
  end;
  begin
    delete from public.automation_flow_publications
    where tenant_id=tenant and flow_key='welcome';
    raise exception 'PUBLISHED_REVISION_DELETABLE';
  exception when check_violation then null;
  end;

  insert into public.automation_flow_activations
  (tenant_id,channel_account_id,platform,flow_key,revision)
  values(tenant,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','instagram','welcome',1);

  if (select is_active from public.automation_flow_activations
    where tenant_id=tenant and flow_key='welcome') then
      raise exception 'ACTIVATION_DEFAULTED_ON';
  end if;

  insert into public.automation_flow_event_receipts
  (tenant_id,channel_account_id,platform,provider_event_id)
  values(tenant,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','instagram','meta-event-1');

  -- إعادة إرسال نفس Meta webhook يجب ألا تبدأ جلسة ثانية.
  begin
    insert into public.automation_flow_event_receipts
    (tenant_id,channel_account_id,platform,provider_event_id)
    values(tenant,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','instagram','meta-event-1');
    raise exception 'REPLAY_EVENT_ACCEPTED';
  exception when unique_violation then null;
  end;

  insert into public.automation_flow_runs
  (tenant_id,flow_key,publication_revision,channel_account_id,conversation_id,current_node_id,run_status)
  values(tenant,'welcome',1,'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd','start','ready')
  returning id into run_id;

  insert into public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
  values(tenant,run_id,'message:meta-event-1:1','message','{"text":"welcome"}');

  begin
    insert into public.automation_flow_outbox(tenant_id,run_id,idempotency_key,effect_kind,payload)
    values(tenant,run_id,'message:meta-event-1:1','message','{"text":"DUPLICATE"}');
    raise exception 'DUPLICATE_OUTBOUND_EFFECT_ACCEPTED';
  exception when unique_violation then null;
  end;

  select count(*) into receipts from public.automation_flow_outbox
    where tenant_id=tenant;
  if receipts<>1 then raise exception 'OUTBOX_IDEMPOTENCY_FAILED'; end if;

  begin
    insert into public.automation_flow_metrics(tenant_id,run_id,event_key)
    values(tenant,run_id,'full_customer_message');
    raise exception 'PII_METRIC_ALLOWED';
  exception when check_violation then null;
  end;
end
$checks$;
reset role;

-- No implicit grants to user browsers or anonymous clients.
do $checks$
declare tab text;
begin
  foreach tab in array array[
    'automation_flow_publications','automation_flow_activations',
    'automation_flow_event_receipts','automation_flow_runs',
    'automation_flow_outbox','automation_flow_metrics'
  ] loop
    if has_table_privilege('anon','public.'||tab,'SELECT')
      or has_table_privilege('authenticated','public.'||tab,'SELECT')
      or has_table_privilege('authenticated','public.'||tab,'INSERT')
      or has_table_privilege('authenticated','public.'||tab,'UPDATE')
    then raise exception 'BROWSER_ROLE_HAS_RUNTIME_TABLE_ACCESS: %',tab; end if;
    if not (select relrowsecurity from pg_class where oid=to_regclass('public.'||tab))
    then raise exception 'MISSING_RLS: %',tab; end if;
  end loop;
end
$checks$;

select 'STAGES_8_TO_11_SQL_CONSTRAINTS_PASSED' as result;
