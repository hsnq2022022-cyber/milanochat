-- PostgreSQL 17 disposable publication integration tests, no customer data.
\set ON_ERROR_STOP on
set role service_role;
do $checks$
declare
 ta uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 tb uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 aa uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 ab uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
 actor uuid:='bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
 doc1 jsonb:='{"version":3,"name":"first","nodes":[{"id":"a"}],"edges":[]}'::jsonb;
 doc2 jsonb:='{"version":3,"name":"second","nodes":[{"id":"a"}],"edges":[]}'::jsonb;
 rev bigint; allowed boolean;
begin
 rev:=flow_ci.publish_doc(ta,ab,'instagram','testpub',actor,doc1);
 if rev is not null then raise exception 'CROSS_TENANT_PUBLISH_ALLOWED';end if;
 rev:=flow_ci.publish_doc(ta,aa,'instagram','testpub',actor,doc1);
 if rev<>1 then raise exception 'FIRST_REVISION_WRONG: %',rev;end if;
 rev:=flow_ci.publish_doc(ta,aa,'instagram','testpub',actor,doc2);
 if rev<>2 then raise exception 'SECOND_REVISION_WRONG: %',rev;end if;
 if (select count(*) from flow_ci.published_docs
   where tenant_id=ta and flow_key='testpub')<>2
 then raise exception 'REVISION_OVERWRITE';end if;
 if (select document->>'name' from flow_ci.published_docs
   where tenant_id=ta and flow_key='testpub' and revision=1)<>'first'
 then raise exception 'IMMUTABLE_DOCUMENT_CHANGED';end if;

 allowed:=flow_ci.activate_doc(ta,aa,'instagram','testpub',2);
 if allowed then raise exception 'ACTIVATION_BYPASSED_DEFAULT_OFF';end if;
 insert into flow_ci.canary_approvals(tenant_id,account_id,platform)
 values(ta,aa,'instagram');
 allowed:=flow_ci.activate_doc(ta,aa,'instagram','testpub',2);
 if allowed then raise exception 'UNAPPROVED_ACTIVATION_ALLOWED';end if;
 update flow_ci.canary_approvals set approved=true
  where tenant_id=ta and account_id=aa and platform='instagram';
 allowed:=flow_ci.activate_doc(ta,aa,'instagram','testpub',99);
 if allowed then raise exception 'MISSING_REVISION_ACTIVATED';end if;
 allowed:=flow_ci.activate_doc(tb,ab,'instagram','testpub',2);
 if allowed then raise exception 'CROSS_TENANT_REVISION_ACTIVATED';end if;

 if not flow_ci.activate_doc(ta,aa,'instagram','testpub',2)
 then raise exception 'APPROVED_TEST_ACTIVATION_FAILED';end if;
 if not (select active and revision=2 from flow_ci.activations
   where tenant_id=ta and account_id=aa and flow_key='testpub')
 then raise exception 'ACTIVE_POINTER_MISMATCH';end if;

 if not flow_ci.activate_doc(ta,aa,'instagram','testpub',1)
 then raise exception 'ROLLBACK_TO_REVISION1_FAILED';end if;
 if not (select active and revision=1 from flow_ci.activations
   where tenant_id=ta and account_id=aa and flow_key='testpub')
 then raise exception 'ROLLBACK_POINTER_MISMATCH';end if;
 if (select count(*) from flow_ci.published_docs
   where tenant_id=ta and flow_key='testpub')<>2
 then raise exception 'ROLLBACK_DESTROYED_REVISION';end if;

 update flow_ci.global_switch set flows_enabled=false;
 if flow_ci.activate_doc(ta,aa,'instagram','testpub',2)
 then raise exception 'GLOBAL_KILL_FAILED';end if;
 -- Disable must always work, even after activation permission is revoked.
 update flow_ci.canary_approvals set approved=false
  where tenant_id=ta and account_id=aa;
 if not flow_ci.deactivate_doc(ta,aa,'instagram','testpub')
 then raise exception 'DEACTIVATION_DID_NOT_WORK';end if;
 if (select active from flow_ci.activations
   where tenant_id=ta and account_id=aa and flow_key='testpub')
 then raise exception 'DEACTIVATED_FLOW_STILL_ACTIVE';end if;
end
$checks$;
reset role;

-- Trigger blocks even a schema-owner direct UPDATE/DELETE of a revision.
do $immutability$
begin
 begin
  update flow_ci.published_docs set document='{}'::jsonb
    where flow_key='testpub' and revision=1;
  raise exception 'UNEXPECTED_REVISION_UPDATE';
 exception when check_violation then null;
 end;
 begin
  delete from flow_ci.published_docs
    where flow_key='testpub' and revision=1;
  raise exception 'UNEXPECTED_REVISION_DELETE';
 exception when check_violation then null;
 end;
 if (select count(*) from flow_ci.published_docs where flow_key='testpub')<>2
 then raise exception 'REVISION_DELETED';end if;
end
$immutability$;

do $security$
declare fn text;
begin
 foreach fn in array array[
  'publish_doc(uuid,uuid,text,text,uuid,jsonb)',
  'activate_doc(uuid,uuid,text,text,bigint)',
  'deactivate_doc(uuid,uuid,text,text)'
 ] loop
  if has_function_privilege('anon','flow_ci.'||fn,'EXECUTE')
   or has_function_privilege('authenticated','flow_ci.'||fn,'EXECUTE')
  then raise exception 'PUBLIC_PUBLISHING_RPC: %',fn;end if;
 end loop;
 if has_table_privilege('authenticated','flow_ci.published_docs','SELECT')
   or has_table_privilege('anon','flow_ci.canary_approvals','UPDATE')
 then raise exception 'PUBLIC_TABLE_ACCESS';end if;
 if not (select relrowsecurity from pg_class
    where oid=to_regclass('flow_ci.published_docs'))
 then raise exception 'PUBLISH_RLS_DISABLED';end if;
end
$security$;
select 'PASS: immutable revisions, canary OFF, private publish/activation, rollback, isolation and shutdown' as result;
