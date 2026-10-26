-- Flow Engine draft schema. ADDITIVE ONLY; not applied to production.
-- Service-role access only. No existing tables/functions are modified.
-- Review alongside a transactional executor before enabling any flow.
begin;

create table if not exists public.flows (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 name text not null check (length(btrim(name)) between 1 and 120),
 channel text not null check (channel in ('instagram','facebook','whatsapp')),
 status text not null default 'draft' check (status in ('draft','active','paused')),
 entry_node_id uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(id,tenant_id)
);
create index if not exists flows_tenant_channel_status_idx on public.flows(tenant_id,channel,status);

create table if not exists public.flow_nodes (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 flow_id uuid not null,
 node_type text not null check (node_type in ('message','buttons','image','condition','ai_handoff','transfer_human','end')),
 config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
 created_at timestamptz not null default now(),
 unique(id,flow_id,tenant_id),
 foreign key (flow_id,tenant_id) references public.flows(id,tenant_id) on delete cascade
);
create index if not exists flow_nodes_flow_idx on public.flow_nodes(tenant_id,flow_id);

alter table public.flows
 add constraint flows_entry_node_fk foreign key (entry_node_id,id,tenant_id)
 references public.flow_nodes(id,flow_id,tenant_id) deferrable initially deferred;

create table if not exists public.flow_edges (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 flow_id uuid not null,
 from_node_id uuid not null,
 to_node_id uuid not null,
 match_type text check (match_type in ('keyword','default')),
 match_value text,
 created_at timestamptz not null default now(),
 foreign key (flow_id,tenant_id) references public.flows(id,tenant_id) on delete cascade,
 foreign key (from_node_id,flow_id,tenant_id) references public.flow_nodes(id,flow_id,tenant_id) on delete cascade,
 foreign key (to_node_id,flow_id,tenant_id) references public.flow_nodes(id,flow_id,tenant_id) on delete cascade
);
create index if not exists flow_edges_flow_idx on public.flow_edges(tenant_id,flow_id,from_node_id);

create table if not exists public.flow_sessions (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 flow_id uuid not null,
 channel text not null check (channel in ('instagram','facebook','whatsapp')),
 channel_account_id uuid not null,
 customer_external_id text not null check (length(customer_external_id) between 1 and 255),
 current_node_id uuid,
 state text not null default 'active' check (state in ('active','waiting','handoff','completed','failed')),
 version integer not null default 0 check (version >= 0),
 updated_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 unique(tenant_id,channel_account_id,customer_external_id),
 foreign key (flow_id,tenant_id) references public.flows(id,tenant_id),
 foreign key (current_node_id,flow_id,tenant_id) references public.flow_nodes(id,flow_id,tenant_id),
 foreign key (channel_account_id) references public.channel_accounts(id)
);
create index if not exists flow_sessions_flow_idx on public.flow_sessions(tenant_id,flow_id,state);

create table if not exists public.flow_executions (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 session_id uuid not null references public.flow_sessions(id) on delete cascade,
 event_key text not null check (length(event_key) between 1 and 255),
 outcome text not null default 'pending' check (outcome in ('pending','processed','failed')),
 error_message text,
 created_at timestamptz not null default now(),
 unique(tenant_id,event_key)
);
create index if not exists flow_executions_session_idx on public.flow_executions(tenant_id,session_id);

create table if not exists public.flow_outbox (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 session_id uuid not null references public.flow_sessions(id) on delete cascade,
 execution_id uuid not null references public.flow_executions(id) on delete cascade,
 channel text not null check (channel in ('instagram','facebook','whatsapp')),
 recipient_external_id text not null,
 payload jsonb not null check (jsonb_typeof(payload) = 'object'),
 idempotency_key text not null,
 state text not null default 'pending' check (state in ('pending','sending','sent','failed')),
 attempt_count integer not null default 0 check (attempt_count >= 0),
 available_at timestamptz not null default now(),
 sent_at timestamptz,
 created_at timestamptz not null default now(),
 unique(tenant_id,idempotency_key)
);
create index if not exists flow_outbox_pending_idx on public.flow_outbox(available_at) where state='pending';

-- RLS: deny browser users entirely until audited tenant-scoped CRUD is introduced.
alter table public.flows enable row level security;
alter table public.flow_nodes enable row level security;
alter table public.flow_edges enable row level security;
alter table public.flow_sessions enable row level security;
alter table public.flow_executions enable row level security;
alter table public.flow_outbox enable row level security;

revoke all on public.flows,public.flow_nodes,public.flow_edges,
 public.flow_sessions,public.flow_executions,public.flow_outbox from public,anon,authenticated;
grant all on public.flows,public.flow_nodes,public.flow_edges,
 public.flow_sessions,public.flow_executions,public.flow_outbox to service_role;
commit;
