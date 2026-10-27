-- Tests execute on disposable GitHub Actions Postgres only.
-- All fixture identities are synthetic. No live tenant data or credentials.
\set ON_ERROR_STOP on

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

do $checks$
declare
  affected integer;
  visible_count integer;
  template jsonb := '{"version":3,"name":"Test A","nodes":[],"edges":[]}';
begin
  -- المتجر A يستطيع إنشاء مسودته وقراءتها فقط.
  insert into public.automation_flow_drafts (tenant_id,flow_key,name,document)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a-flow','Owner A',template);
  select count(*) into visible_count from public.automation_flow_drafts;
  if visible_count <> 1 then raise exception 'Owner A must see exactly its own draft'; end if;

  -- مستخدم A لا يستطيع إنشاء مسودة في متجر B.
  begin
    insert into public.automation_flow_drafts (tenant_id,flow_key,name,document)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cross-insert','Denied',template);
    raise exception 'CROSS_TENANT_INSERT_ALLOWED';
  exception when insufficient_privilege then null;
  end;

  -- تغيير هوية متجر موجود ممنوع على مستوى صلاحية العمود.
  begin
    update public.automation_flow_drafts
    set tenant_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    where flow_key='a-flow';
    raise exception 'TENANT_ID_UPDATE_ALLOWED';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.automation_flow_drafts
    set flow_key='stolen-key'
    where flow_key='a-flow';
    raise exception 'FLOW_KEY_UPDATE_ALLOWED';
  exception when insufficient_privilege then null;
  end;

  -- قفل النسخة المتفائل: مراجعة 1 تنجح مرة واحدة فقط.
  update public.automation_flow_drafts
  set name='Revision 2',draft_revision=2
  where tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    and flow_key='a-flow' and draft_revision=1;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Owner A revision update failed'; end if;

  update public.automation_flow_drafts
  set name='Stale edit',draft_revision=2
  where tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    and flow_key='a-flow' and draft_revision=1;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Stale update was accepted'; end if;

  -- لا يقبل مستندًا بإصدار غير مدعوم.
  begin
    insert into public.automation_flow_drafts(tenant_id,flow_key,name,document)
    values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','wrong-schema','Invalid',
      '{"version":5,"nodes":[],"edges":[]}'::jsonb);
    raise exception 'INVALID_SCHEMA_ALLOWED';
  exception when check_violation then null;
  end;

  -- تجاوز حد حجم JSON يحظر إدخاله إلى الجدول.
  begin
    insert into public.automation_flow_drafts(tenant_id,flow_key,name,document)
    values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','oversized','Oversized',
      jsonb_build_object('version',3,'nodes',
        jsonb_build_array(jsonb_build_object('text',repeat('x',4194304))),
        'edges',jsonb_build_array()));
    raise exception 'OVERSIZED_DOCUMENT_ALLOWED';
  exception when check_violation then null;
  end;
end
$checks$;

reset role;
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';

do $checks$
declare
  visible_count integer;
  affected integer;
begin
  -- تسجيل دخول B لا يكشف بيانات A.
  select count(*) into visible_count from public.automation_flow_drafts;
  if visible_count <> 0 then raise exception 'Owner B can read A drafts'; end if;

  update public.automation_flow_drafts set name='Stolen'
  where tenant_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and flow_key='a-flow';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Owner B can update A drafts'; end if;

  insert into public.automation_flow_drafts (tenant_id,flow_key,name,document)
  values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','b-flow','Owner B',
   '{"version":3,"name":"Test B","nodes":[],"edges":[]}'::jsonb);
  select count(*) into visible_count from public.automation_flow_drafts;
  if visible_count <> 1 then raise exception 'Owner B cannot see its own draft'; end if;

  -- الحذف ممنوع حتى لصاحب المسودة، ويظل الاسترجاع ممكنًا.
  begin
    delete from public.automation_flow_drafts where flow_key='b-flow';
    raise exception 'DELETE_ALLOWED';
  exception when insufficient_privilege then null;
  end;
end
$checks$;

reset role;
set role anon;

do $checks$
begin
  -- الزائر غير المسجّل لا يملك صلاحيات قراءة أو إنشاء مسودات.
  begin
    perform count(*) from public.automation_flow_drafts;
    raise exception 'ANON_READ_ALLOWED';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.automation_flow_drafts(tenant_id,flow_key,name,document)
    values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','anon-flow','Anon',
      '{"version":3,"nodes":[],"edges":[]}'::jsonb);
    raise exception 'ANON_INSERT_ALLOWED';
  exception when insufficient_privilege then null;
  end;
end
$checks$;

reset role;
-- اختبارات مستقلة عن الإنتاج، وتفشل مباشرة عند خرق أي عزل.
select 'ALL_FLOW_DRAFT_RLS_ASSERTIONS_PASSED' as result;
