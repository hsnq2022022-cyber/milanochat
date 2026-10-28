-- Postgres 17 only, disposable CI database. Never run against production.
\set ON_ERROR_STOP on
insert into flow_ci.tenants(id,credits) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',10),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',10);
insert into flow_ci.accounts(tenant_id,id,platform,agent_enabled,auto_reply,token_valid)
values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','cccccccc-cccc-4ccc-8ccc-cccccccccccc','instagram',true,true,true),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','instagram',true,true,true),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','instagram',true,true,true);
insert into flow_ci.conversations(tenant_id,id,account_id,platform)
values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','dddddddd-dddd-4ddd-8ddd-dddddddddddd','cccccccc-cccc-4ccc-8ccc-cccccccccccc','instagram'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','instagram'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','ffffffff-ffff-4fff-8fff-ffffffffffff','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','instagram');
insert into flow_ci.publications(tenant_id,flow_key,revision)
values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','welcome',1),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','welcome',1);
insert into flow_ci.activations(tenant_id,account_id,platform,flow_key,revision)
values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','cccccccc-cccc-4ccc-8ccc-cccccccccccc','instagram','welcome',1),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','instagram','welcome',1);

set role service_role;
do $checks$
declare
 ta uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 tb uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 aa uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 ab uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 ca uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 cb uuid:='ffffffff-ffff-4fff-8fff-ffffffffffff';
 accepted boolean;
begin
 -- Both the global and tenant flags default OFF.
 accepted:=flow_ci.reserve_inbound(ta,aa,'instagram',ca,'welcome',1,'off',
 '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
 '30000000-0000-4000-8000-000000000001','effect-off','start','{"text":"test"}',true);
 if accepted then raise exception 'DEFAULT_OFF_BYPASSED';end if;

 update flow_ci.global_switch set flows_enabled=true;
 update flow_ci.tenants set flows_enabled=true where id=ta;
 -- Activation itself also starts OFF.
 accepted:=flow_ci.reserve_inbound(ta,aa,'instagram',ca,'welcome',1,'inactive',
 '10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002',
 '30000000-0000-4000-8000-000000000002','effect-inactive','start','{"text":"test"}',true);
 if accepted then raise exception 'INACTIVE_PUBLICATION_BYPASSED';end if;
 update flow_ci.activations set active=true where tenant_id=ta;

 accepted:=flow_ci.reserve_inbound(ta,aa,'instagram',ca,'welcome',1,'window-off',
 '10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003',
 '30000000-0000-4000-8000-000000000003','effect-window','start','{"text":"test"}',false);
 if accepted then raise exception 'MESSAGING_WINDOW_BYPASSED';end if;

 -- Exactly one receipt + run + outbox when the trusted, unique event arrives.
 accepted:=flow_ci.reserve_inbound(ta,aa,'instagram',ca,'welcome',1,'evt-1',
 '10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000004',
 '30000000-0000-4000-8000-000000000004','effect-1','start','{"text":"welcome"}',true);
 if not accepted then raise exception 'LEGITIMATE_EVENT_REJECTED';end if;
 accepted:=flow_ci.reserve_inbound(ta,aa,'instagram',ca,'welcome',1,'evt-1',
 '10000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000005',
 '30000000-0000-4000-8000-000000000005','effect-new','start','{"text":"DUPLICATE"}',true);
 if accepted then raise exception 'META_RETRY_ACCEPTED';end if;
 if (select count(*) from flow_ci.receipts where tenant_id=ta)<>1 or
    (select count(*) from flow_ci.runs where tenant_id=ta)<>1 or
    (select count(*) from flow_ci.outbox where tenant_id=ta)<>1
 then raise exception 'NONATOMIC_RESULTS';end if;

 -- Foreign tenant/account and same-tenant wrong account-conversation pairing fail.
 accepted:=flow_ci.reserve_inbound(ta,ab,'instagram',cb,'welcome',1,'cross-owner',
 '10000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000006',
 '30000000-0000-4000-8000-000000000006','effect-cross','start','{"text":"test"}',true);
 if accepted then raise exception 'CROSS_TENANT_ALLOWED';end if;
 accepted:=flow_ci.reserve_inbound(ta,aa,'instagram',
 '22222222-2222-4222-8222-222222222222','welcome',1,'wrong-conversation',
 '10000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000007',
 '30000000-0000-4000-8000-000000000007','effect-wrong','start','{"text":"test"}',true);
 if accepted then raise exception 'CROSS_ACCOUNT_CONVERSATION_ALLOWED';end if;

 update flow_ci.conversations set human_takeover=true where tenant_id=ta and id=ca;
 accepted:=flow_ci.reserve_inbound(ta,aa,'instagram',ca,'welcome',1,'handoff',
 '10000000-0000-4000-8000-000000000008','20000000-0000-4000-8000-000000000008',
 '30000000-0000-4000-8000-000000000008','effect-handoff','start','{"text":"test"}',true);
 if accepted then raise exception 'HUMAN_TAKEOVER_IGNORED';end if;
 update flow_ci.conversations set human_takeover=false where tenant_id=ta and id=ca;
 update flow_ci.tenants set credits=0 where id=ta;
 accepted:=flow_ci.reserve_inbound(ta,aa,'instagram',ca,'welcome',1,'no-credits',
 '10000000-0000-4000-8000-000000000009','20000000-0000-4000-8000-000000000009',
 '30000000-0000-4000-8000-000000000009','effect-no-credits','start','{"text":"test"}',true);
 if accepted then raise exception 'ZERO_CREDITS_IGNORED';end if;
 update flow_ci.tenants set credits=10 where id=ta;

 -- An outgoing idempotency collision must roll back the NEW event + run.
 begin
  accepted:=flow_ci.reserve_inbound(ta,aa,'instagram',ca,'welcome',1,'evt-rollback',
   '10000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000010',
   '30000000-0000-4000-8000-000000000010','effect-1','start','{"text":"must rollback"}',true);
  raise exception 'EXPECTED_UNIQUE_VIOLATION';
 exception when unique_violation then null;
 end;
 if exists(select 1 from flow_ci.receipts where event_id='evt-rollback') or
    exists(select 1 from flow_ci.runs where event_id='evt-rollback')
 then raise exception 'PARTIAL_COMMIT_AFTER_UNIQUE_ERROR';end if;

 -- Tenant B may use the same provider event id as tenant A, but not A's data.
 update flow_ci.tenants set flows_enabled=true where id=tb;
 update flow_ci.activations set active=true where tenant_id=tb;
 accepted:=flow_ci.reserve_inbound(tb,ab,'instagram',cb,'welcome',1,'evt-1',
 '10000000-0000-4000-8000-000000000011','20000000-0000-4000-8000-000000000011',
 '30000000-0000-4000-8000-000000000011','effect-1','start','{"text":"tenant B"}',true);
 if not accepted then raise exception 'SECOND_TENANT_REJECTED';end if;

 if (select count(*) from flow_ci.outbox)<>2 then
   raise exception 'CROSS_TENANT_OUTBOX_COUNT_BAD';
 end if;
end
$checks$;
reset role;

do $security$
declare t text;
begin
 foreach t in array array[
  'tenants','accounts','conversations','publications','activations',
  'receipts','runs','outbox'
 ] loop
   if has_table_privilege('anon','flow_ci.'||t,'SELECT')
     or has_table_privilege('authenticated','flow_ci.'||t,'INSERT') then
     raise exception 'BROWSER_ACCESS: %',t;
   end if;
   if not (select relrowsecurity from pg_class where oid=to_regclass('flow_ci.'||t))
     then raise exception 'MISSING_RLS: %',t;end if;
 end loop;
 if has_function_privilege('anon',
 'flow_ci.reserve_inbound(uuid,uuid,text,uuid,text,bigint,text,uuid,uuid,uuid,text,text,jsonb,boolean)','EXECUTE')
 or has_function_privilege('authenticated',
 'flow_ci.reserve_inbound(uuid,uuid,text,uuid,text,bigint,text,uuid,uuid,uuid,text,text,jsonb,boolean)','EXECUTE')
 then raise exception 'PUBLIC_RPC_ACCESS';end if;
 if not has_function_privilege('service_role',
 'flow_ci.reserve_inbound(uuid,uuid,text,uuid,text,bigint,text,uuid,uuid,uuid,text,text,jsonb,boolean)','EXECUTE')
 then raise exception 'SERVICE_ROLE_DENIED';end if;
end
$security$;
select 'PASS: atomic receipt+run+outbox, duplicate/rollback/tenant/guard/RLS' as result;
