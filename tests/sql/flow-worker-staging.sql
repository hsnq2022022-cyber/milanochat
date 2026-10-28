-- DISPOSABLE POSTGRES 17 TEST ONLY. NOT A PRODUCTION MIGRATION.
-- Extends tests/sql/flow-atomic-staging-bootstrap.sql after its fixture tests.
-- Actual Supabase tables, accounts and RPCs MUST be reconciled before live SQL.

alter table flow_ci.outbox
 add column attempts integer not null default 0 check (attempts between 0 and 3),
 add column lease_token uuid,
 add column lease_expires_at timestamptz,
 add column retry_at timestamptz,
 add column provider_message_id text,
 add column charged_at timestamptz;

create table flow_ci.reply_ledger(
 tenant_id uuid not null references flow_ci.tenants(id),
 outgoing_message_id uuid not null unique,
 created_at timestamptz not null default now(),
 primary key(tenant_id,outgoing_message_id)
);
alter table flow_ci.reply_ledger enable row level security;
revoke all on flow_ci.reply_ledger from public,anon,authenticated;
grant select,insert on flow_ci.reply_ledger to service_role;

-- A real worker calls this ONLY after receiving a trusted queue event. The
-- statement uses PostgreSQL atomic UPDATE to guarantee one lease.
create function flow_ci.claim_outbox(
 p_tenant uuid,p_outbox uuid,p_token uuid
) returns boolean language plpgsql security invoker set search_path=''
as $$
declare claimed uuid;
begin
 if p_token is null then return false;end if;
 update flow_ci.outbox o
 set state='leased',attempts=o.attempts+1,
     lease_token=p_token,lease_expires_at=clock_timestamp()+interval '30 seconds'
 where o.tenant_id=p_tenant and o.id=p_outbox
   and o.state='pending' and o.attempts=0
   and exists(
     select 1 from flow_ci.runs r
     join flow_ci.tenants t on t.id=r.tenant_id
     join flow_ci.global_switch g on g.singleton
     join flow_ci.accounts a on a.tenant_id=r.tenant_id
       and a.id=r.account_id and a.platform=r.platform
     join flow_ci.conversations c on c.tenant_id=r.tenant_id
       and c.id=r.conversation_id
       and c.account_id=r.account_id and c.platform=r.platform
     join flow_ci.activations act on act.tenant_id=r.tenant_id
       and act.account_id=r.account_id and act.platform=r.platform
       and act.flow_key=r.flow_key and act.revision=r.revision
     where r.tenant_id=o.tenant_id and r.id=o.run_id
       and t.flows_enabled and g.flows_enabled and t.credits>0
       and a.agent_enabled and a.auto_reply and a.token_valid
       and not c.human_takeover and act.active
   )
 returning o.id into claimed;
 return claimed is not null;
end
$$;

-- Backend calls directly before provider I/O; cannot cancel a request already
-- on the network. A FALSE result forbids sending.
create function flow_ci.dispatch_allowed(
 p_tenant uuid,p_outbox uuid,p_token uuid
) returns boolean language sql stable security invoker set search_path=''
as $$
 select exists(
   select 1 from flow_ci.outbox o
   join flow_ci.runs r on r.tenant_id=o.tenant_id and r.id=o.run_id
   join flow_ci.tenants t on t.id=o.tenant_id
   join flow_ci.global_switch g on g.singleton
   join flow_ci.accounts a on a.tenant_id=r.tenant_id and
     a.id=r.account_id and a.platform=r.platform
   join flow_ci.conversations c on c.tenant_id=r.tenant_id
     and c.id=r.conversation_id and c.account_id=r.account_id and c.platform=r.platform
   join flow_ci.activations act on act.tenant_id=r.tenant_id
     and act.account_id=r.account_id and act.platform=r.platform
     and act.flow_key=r.flow_key and act.revision=r.revision
   where o.tenant_id=p_tenant and o.id=p_outbox
     and o.state='leased' and o.lease_token=p_token
     and o.lease_expires_at>clock_timestamp()
     and t.flows_enabled and g.flows_enabled and t.credits>0
     and a.agent_enabled and a.auto_reply and a.token_valid
     and not c.human_takeover and act.active
 )
$$;

-- Unknown delivery results and expired leases are *quarantined*, never
-- automatically retried. Only a verified provider acceptance permits debit.
create function flow_ci.record_provider(
 p_tenant uuid,p_outbox uuid,p_token uuid,p_result text,p_provider_id text
) returns boolean language plpgsql security invoker set search_path=''
as $$
declare changed uuid;
begin
 if p_result not in ('accepted','unknown','definitely_rejected') then return false;end if;
 if p_result='accepted' and
   (p_provider_id is null or length(p_provider_id) not between 1 and 256)
   then return false;end if;
 update flow_ci.outbox o
 set state=case when p_result='accepted' then 'charge_pending'
                when p_result='unknown' then 'uncertain'
                else 'dead_letter' end,
     provider_message_id=case when p_result='accepted' then p_provider_id else null end,
     lease_token=null,lease_expires_at=null
 where o.tenant_id=p_tenant and o.id=p_outbox
   and o.state='leased' and o.lease_token=p_token
 returning o.id into changed;
 return changed is not null;
end
$$;

create function flow_ci.quarantine_expired(
 p_tenant uuid,p_outbox uuid
) returns boolean language plpgsql security invoker set search_path=''
as $$
declare changed uuid;
begin
 update flow_ci.outbox o set state='uncertain',lease_token=null,lease_expires_at=null
 where o.tenant_id=p_tenant and o.id=p_outbox
   and o.state='leased' and o.lease_expires_at<=clock_timestamp()
 returning o.id into changed;
 return changed is not null;
end
$$;

-- This synthetic consume_reply replacement prevents ghost ledger rows and
-- decrements credits at most once per outgoing UUID in a single transaction.
-- NOT a replacement for live consume_reply: schema/semantics not verified.
create function flow_ci.debit_once(
 p_tenant uuid,p_outbox uuid
) returns text language plpgsql security invoker set search_path=''
as $$
declare msg uuid; remaining integer;
begin
 select o.outgoing_message_id into msg
 from flow_ci.outbox o where o.tenant_id=p_tenant
   and o.id=p_outbox and o.state in ('charge_pending','settled');
 if msg is null then return 'not_accepted';end if;

 select credits into remaining from flow_ci.tenants
   where id=p_tenant for update;
 if remaining is null then return 'wrong_tenant';end if;
 if exists(select 1 from flow_ci.reply_ledger
   where tenant_id=p_tenant and outgoing_message_id=msg)
 then
   update flow_ci.outbox set state='settled',charged_at=coalesce(charged_at,now())
     where tenant_id=p_tenant and id=p_outbox;
   return 'already_charged';
 end if;
 if remaining<=0 then return 'insufficient';end if;
 update flow_ci.tenants set credits=credits-1 where id=p_tenant and credits>0;
 insert into flow_ci.reply_ledger(tenant_id,outgoing_message_id)
   values(p_tenant,msg);
 update flow_ci.outbox set state='settled',charged_at=now()
   where tenant_id=p_tenant and id=p_outbox and state='charge_pending';
 return 'charged';
end
$$;

revoke all on function flow_ci.claim_outbox(uuid,uuid,uuid)
 from public,anon,authenticated;
revoke all on function flow_ci.dispatch_allowed(uuid,uuid,uuid)
 from public,anon,authenticated;
revoke all on function flow_ci.record_provider(uuid,uuid,uuid,text,text)
 from public,anon,authenticated;
revoke all on function flow_ci.quarantine_expired(uuid,uuid)
 from public,anon,authenticated;
revoke all on function flow_ci.debit_once(uuid,uuid)
 from public,anon,authenticated;
grant execute on function flow_ci.claim_outbox(uuid,uuid,uuid) to service_role;
grant execute on function flow_ci.dispatch_allowed(uuid,uuid,uuid) to service_role;
grant execute on function flow_ci.record_provider(uuid,uuid,uuid,text,text) to service_role;
grant execute on function flow_ci.quarantine_expired(uuid,uuid) to service_role;
grant execute on function flow_ci.debit_once(uuid,uuid) to service_role;
