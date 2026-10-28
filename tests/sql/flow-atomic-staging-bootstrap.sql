-- DISPOSABLE CI STAGING MODEL. This file is NOT a Supabase migration.
-- Do not execute against the production project or copy into migrations.
-- Actual live account/conversation schemas must be inspected before designing
-- a versioned production migration with rollback and read-only verification.
\set ON_ERROR_STOP on

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema flow_ci;

create table flow_ci.tenants(
  id uuid primary key,
  credits integer not null default 0 check(credits >= 0),
  flows_enabled boolean not null default false
);
create table flow_ci.global_switch(
  singleton boolean primary key default true check(singleton),
  flows_enabled boolean not null default false
);
insert into flow_ci.global_switch(singleton) values(true);

create table flow_ci.accounts(
  tenant_id uuid not null references flow_ci.tenants(id),
  id uuid not null,
  platform text not null check(platform in ('instagram','facebook','whatsapp')),
  agent_enabled boolean not null default false,
  auto_reply boolean not null default false,
  token_valid boolean not null default false,
  primary key(tenant_id,id,platform)
);
create table flow_ci.conversations(
  tenant_id uuid not null,
  id uuid not null,
  account_id uuid not null,
  platform text not null,
  human_takeover boolean not null default false,
  primary key(tenant_id,id),
  unique(tenant_id,id,account_id,platform),
  foreign key(tenant_id,account_id,platform)
    references flow_ci.accounts(tenant_id,id,platform)
);
create table flow_ci.publications(
  tenant_id uuid not null references flow_ci.tenants(id),
  flow_key text not null,
  revision bigint not null check(revision > 0),
  primary key(tenant_id,flow_key,revision)
);
create table flow_ci.activations(
  tenant_id uuid not null,
  account_id uuid not null,
  platform text not null,
  flow_key text not null,
  revision bigint not null,
  active boolean not null default false,
  primary key(tenant_id,account_id,platform,flow_key),
  foreign key(tenant_id,account_id,platform)
    references flow_ci.accounts(tenant_id,id,platform),
  foreign key(tenant_id,flow_key,revision)
    references flow_ci.publications(tenant_id,flow_key,revision)
);
create table flow_ci.receipts(
  tenant_id uuid not null,
  account_id uuid not null,
  platform text not null,
  event_id text not null check(length(event_id) between 1 and 256),
  created_at timestamptz not null default now(),
  primary key(tenant_id,account_id,platform,event_id),
  foreign key(tenant_id,account_id,platform)
    references flow_ci.accounts(tenant_id,id,platform)
);
create table flow_ci.runs(
  tenant_id uuid not null,
  id uuid not null,
  account_id uuid not null,
  platform text not null,
  conversation_id uuid not null,
  flow_key text not null,
  revision bigint not null,
  event_id text not null,
  current_node_id text not null,
  status text not null default 'ready' check(status in ('ready','blocked','completed')),
  primary key(tenant_id,id),
  unique(tenant_id,account_id,platform,event_id),
  foreign key(tenant_id,conversation_id,account_id,platform)
    references flow_ci.conversations(tenant_id,id,account_id,platform),
  foreign key(tenant_id,flow_key,revision)
    references flow_ci.publications(tenant_id,flow_key,revision),
  foreign key(tenant_id,account_id,platform,event_id)
    references flow_ci.receipts(tenant_id,account_id,platform,event_id)
);
create table flow_ci.outbox(
  tenant_id uuid not null,
  id uuid not null,
  run_id uuid not null,
  effect_key text not null check(length(effect_key) between 1 and 1024),
  outgoing_message_id uuid not null,
  kind text not null check(kind in ('message','question')),
  payload jsonb not null check(
    jsonb_typeof(payload)='object' and octet_length(payload::text) <= 65536
  ),
  state text not null default 'pending' check(state in
    ('pending','leased','uncertain','charge_pending','settled','dead_letter')),
  primary key(tenant_id,id),
  unique(tenant_id,effect_key),
  unique(tenant_id,outgoing_message_id),
  foreign key(tenant_id,run_id) references flow_ci.runs(tenant_id,id)
);

-- No plaintext in flow metrics. No browser access even with a valid login.
alter table flow_ci.tenants enable row level security;
alter table flow_ci.global_switch enable row level security;
alter table flow_ci.accounts enable row level security;
alter table flow_ci.conversations enable row level security;
alter table flow_ci.publications enable row level security;
alter table flow_ci.activations enable row level security;
alter table flow_ci.receipts enable row level security;
alter table flow_ci.runs enable row level security;
alter table flow_ci.outbox enable row level security;

revoke all on schema flow_ci from public, anon, authenticated;
revoke all on all tables in schema flow_ci from public, anon, authenticated;
grant usage on schema flow_ci to service_role;
grant select,insert,update,delete on all tables in schema flow_ci to service_role;

-- Runs as INVOKER, requires trusted service role. Not a public-facing RPC.
create function flow_ci.reserve_inbound(
 p_tenant uuid,p_account uuid,p_platform text,p_conversation uuid,
 p_flow_key text,p_revision bigint,p_event_id text,
 p_run_id uuid,p_outbox_id uuid,p_message_id uuid,
 p_effect_key text,p_node_id text,p_payload jsonb,
 p_window_verified boolean default false
)
returns boolean
language plpgsql security invoker set search_path=''
as $body$
declare accepted boolean;
begin
  if p_event_id is null or length(p_event_id) not between 1 and 256
    or p_effect_key is null or length(p_effect_key) not between 1 and 1024
    or p_node_id is null or length(p_node_id) not between 1 and 128
    or p_flow_key is null or length(p_flow_key) not between 1 and 128
    or p_window_verified is distinct from true or
    jsonb_typeof(p_payload) is distinct from 'object'
    or octet_length(p_payload::text) > 65536
  then return false; end if;

  -- All values above must originate from a signed webhook and a trusted
  -- matching/routing service. The caller is never a browser.
  select true into accepted
  from flow_ci.global_switch g
  join flow_ci.tenants t on t.id=p_tenant
  join flow_ci.accounts a on a.tenant_id=t.id and a.id=p_account
    and a.platform=p_platform
  join flow_ci.conversations c on c.tenant_id=t.id and c.id=p_conversation
    and c.account_id=a.id and c.platform=a.platform
  join flow_ci.activations act on act.tenant_id=t.id
    and act.account_id=a.id and act.platform=a.platform
    and act.flow_key=p_flow_key and act.revision=p_revision
  where g.singleton and g.flows_enabled
    and t.flows_enabled and t.credits>0
    and a.agent_enabled and a.auto_reply and a.token_valid
    and not c.human_takeover and act.active;
  if accepted is distinct from true then return false; end if;

  -- Unique inbound receipt is the concurrency arbitration point. On conflict
  -- every subsequent operation is skipped; concurrent callers serialize here.
  insert into flow_ci.receipts(tenant_id,account_id,platform,event_id)
  values(p_tenant,p_account,p_platform,p_event_id)
  on conflict do nothing;
  if not found then return false; end if;

  -- The three inserts share one PostgreSQL statement transaction. If any
  -- downstream insert fails, the new receipt and run both roll back.
  insert into flow_ci.runs(
    tenant_id,id,account_id,platform,conversation_id,flow_key,
    revision,event_id,current_node_id
  ) values(
    p_tenant,p_run_id,p_account,p_platform,p_conversation,p_flow_key,
    p_revision,p_event_id,p_node_id
  );
  insert into flow_ci.outbox(
    tenant_id,id,run_id,effect_key,outgoing_message_id,kind,payload
  ) values(
    p_tenant,p_outbox_id,p_run_id,p_effect_key,p_message_id,
    'message',p_payload
  );
  return true;
end
$body$;

revoke all on function flow_ci.reserve_inbound(
 uuid,uuid,text,uuid,text,bigint,text,uuid,uuid,uuid,text,text,jsonb,boolean
) from public,anon,authenticated;
grant execute on function flow_ci.reserve_inbound(
 uuid,uuid,text,uuid,text,bigint,text,uuid,uuid,uuid,text,text,jsonb,boolean
) to service_role;
