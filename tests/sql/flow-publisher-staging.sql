-- DISPOSABLE POSTGRES 17 STAGING FIXTURE ONLY.
-- Run AFTER flow-atomic-staging-bootstrap.sql & flow-atomic-staging.test.sql.
-- Not a production migration; do not execute on the live Supabase project.
create table flow_ci.published_docs(
 tenant_id uuid not null,
 flow_key text not null,
 revision bigint not null check(revision>0),
 account_id uuid not null,
 platform text not null,
 actor_id uuid not null,
 document jsonb not null check(
    jsonb_typeof(document)='object' and document->>'version'='3'
    and jsonb_typeof(document->'nodes')='array'
    and jsonb_typeof(document->'edges')='array'
    and octet_length(document::text)<=4194304
 ),
 created_at timestamptz not null default now(),
 primary key(tenant_id,flow_key,revision),
 foreign key(tenant_id,flow_key,revision)
  references flow_ci.publications(tenant_id,flow_key,revision),
 foreign key(tenant_id,account_id,platform)
  references flow_ci.accounts(tenant_id,id,platform)
);
create table flow_ci.canary_approvals(
 tenant_id uuid not null,
 account_id uuid not null,
 platform text not null,
 approved boolean not null default false,
 primary key(tenant_id,account_id,platform),
 foreign key(tenant_id,account_id,platform)
  references flow_ci.accounts(tenant_id,id,platform)
);
alter table flow_ci.published_docs enable row level security;
alter table flow_ci.canary_approvals enable row level security;
revoke all on flow_ci.published_docs,flow_ci.canary_approvals
 from public,anon,authenticated;
grant select,insert on flow_ci.published_docs to service_role;
grant select,insert,update on flow_ci.canary_approvals to service_role;

create function flow_ci.reject_published_mutation()
returns trigger language plpgsql security invoker set search_path=''
as $$
begin
 raise exception 'published revisions are immutable' using errcode='23514';
end
$$;
create trigger published_docs_immutable
 before update or delete on flow_ci.published_docs
 for each row execute function flow_ci.reject_published_mutation();

-- Transactionally lock the tenant row for serialized revision allocation.
-- Authentication and capability audit MUST be done by the trusted service
-- adapter before this private function; client cannot access it.
create function flow_ci.publish_doc(
 p_tenant uuid,p_account uuid,p_platform text,p_flow_key text,
 p_actor uuid,p_doc jsonb
) returns bigint language plpgsql security invoker set search_path=''
as $$
declare next_rev bigint; found_tenant uuid;
begin
 if p_actor is null or p_flow_key is null
  or length(p_flow_key) not between 1 and 128
  or p_flow_key !~ '^[a-zA-Z0-9_-]+$'
  or p_doc is null or jsonb_typeof(p_doc) is distinct from 'object'
  or p_doc->>'version' is distinct from '3'
  or jsonb_typeof(p_doc->'nodes') is distinct from 'array'
  or jsonb_typeof(p_doc->'edges') is distinct from 'array'
  or octet_length(p_doc::text)>4194304
 then return null;end if;

 select t.id into found_tenant from flow_ci.tenants t
 join flow_ci.accounts a on a.tenant_id=t.id and a.id=p_account
   and a.platform=p_platform
 where t.id=p_tenant for update of t;
 if found_tenant is null then return null;end if;

 select coalesce(max(revision),0)+1 into next_rev
 from flow_ci.publications
 where tenant_id=p_tenant and flow_key=p_flow_key;
 insert into flow_ci.publications(tenant_id,flow_key,revision)
 values(p_tenant,p_flow_key,next_rev);
 insert into flow_ci.published_docs(
   tenant_id,flow_key,revision,account_id,platform,actor_id,document
 ) values(p_tenant,p_flow_key,next_rev,p_account,p_platform,p_actor,p_doc);
 return next_rev;
end
$$;

-- Activation defaults OFF until an explicit test-account approval and
-- global+tenant flag. Rollback calls the same function with older revision.
create function flow_ci.activate_doc(
 p_tenant uuid,p_account uuid,p_platform text,p_flow_key text,p_rev bigint
) returns boolean language plpgsql security invoker set search_path=''
as $$
declare permitted boolean;
begin
 select true into permitted
 from flow_ci.global_switch g
 join flow_ci.tenants t on t.id=p_tenant
 join flow_ci.accounts a on a.tenant_id=t.id
   and a.id=p_account and a.platform=p_platform
 join flow_ci.canary_approvals approval on approval.tenant_id=t.id
   and approval.account_id=a.id and approval.platform=a.platform
 join flow_ci.published_docs doc on doc.tenant_id=t.id
   and doc.account_id=a.id and doc.platform=a.platform
   and doc.flow_key=p_flow_key and doc.revision=p_rev
 where g.singleton and g.flows_enabled and t.flows_enabled
  and approval.approved and a.agent_enabled and a.auto_reply and a.token_valid;
 if permitted is distinct from true then return false;end if;
 insert into flow_ci.activations(
   tenant_id,account_id,platform,flow_key,revision,active
 )values(p_tenant,p_account,p_platform,p_flow_key,p_rev,true)
 on conflict(tenant_id,account_id,platform,flow_key) do update
 set revision=excluded.revision,active=true;
 return true;
end
$$;

-- Disabling remains available even if the channel is disconnected or the
-- canary approval was revoked. Stopping must not require permission to start.
create function flow_ci.deactivate_doc(
 p_tenant uuid,p_account uuid,p_platform text,p_flow_key text
) returns boolean language plpgsql security invoker set search_path=''
as $$
begin
 update flow_ci.activations set active=false
 where tenant_id=p_tenant and account_id=p_account
   and platform=p_platform and flow_key=p_flow_key;
 return found;
end
$$;

revoke all on function flow_ci.reject_published_mutation()
 from public,anon,authenticated;
revoke all on function flow_ci.publish_doc(uuid,uuid,text,text,uuid,jsonb)
 from public,anon,authenticated;
revoke all on function flow_ci.activate_doc(uuid,uuid,text,text,bigint)
 from public,anon,authenticated;
revoke all on function flow_ci.deactivate_doc(uuid,uuid,text,text)
 from public,anon,authenticated;
grant execute on function flow_ci.publish_doc(uuid,uuid,text,text,uuid,jsonb)
 to service_role;
grant execute on function flow_ci.activate_doc(uuid,uuid,text,text,bigint)
 to service_role;
grant execute on function flow_ci.deactivate_doc(uuid,uuid,text,text)
 to service_role;
