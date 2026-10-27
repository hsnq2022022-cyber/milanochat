-- REVIEW-ONLY: persistent flow runner schema proposal. NOT a production migration.
-- No DML, role grants, or functions from this file have been deployed to Supabase.
-- Publication and execution belong to trusted service code, NEVER the browser.
begin;

-- Composite references prevent even privileged services from linking another tenant's accounts.
-- REVIEW ONLY. Check indexes and migration locks before applying in production.
alter table public.channel_accounts
  add constraint automation_channel_accounts_owner_id_key unique(tenant_id,id);
alter table public.channel_accounts
  add constraint automation_channel_accounts_owner_platform_key unique(tenant_id,id,platform);
alter table public.conversations
  add constraint automation_conversations_owner_id_key unique(tenant_id,id);

create table public.automation_flow_publications (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  flow_key text not null check (length(flow_key) between 1 and 128),
  revision bigint not null check (revision > 0),
  document jsonb not null check (
    jsonb_typeof(document) = 'object' and document->>'version' = '3'
    and jsonb_typeof(document->'nodes') = 'array'
    and jsonb_typeof(document->'edges') = 'array'
    and octet_length(document::text) <= 4194304
  ),
  published_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id,flow_key,revision)
);

-- لا يمكن تعديل نسخة منشورة إطلاقاً، حتى باستخدام صلاحيات الخادم العادية.
create function public.reject_automation_flow_publication_mutation()
returns trigger language plpgsql security invoker set search_path = ''
as $func$
begin
  raise exception 'Published flow revisions are immutable' using errcode = '23514';
end
$func$;
revoke all on function public.reject_automation_flow_publication_mutation() from public, anon, authenticated;
create trigger automation_flow_publications_immutable
before update or delete on public.automation_flow_publications
for each row execute function public.reject_automation_flow_publication_mutation();

-- الفصل بين التحرير والنشر والتفعيل يمنع تفعيل المسودة بالخطأ.
create table public.automation_flow_activations (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel_account_id uuid not null,
  platform text not null check (platform in ('instagram','facebook','whatsapp')),
  flow_key text not null,
  revision bigint not null,
  is_active boolean not null default false,
  activated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id,channel_account_id,platform,flow_key),
  foreign key (tenant_id,flow_key,revision)
    references public.automation_flow_publications(tenant_id,flow_key,revision),
  foreign key (tenant_id,channel_account_id,platform)
    references public.channel_accounts(tenant_id,id,platform)
);

-- التكرار حسب الحدث والقناة والمتجر، قبل إنشاء أي تنفيذ أو محاولة إرسال.
create table public.automation_flow_event_receipts (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel_account_id uuid not null,
  platform text not null check (platform in ('instagram','facebook','whatsapp')),
  provider_event_id text not null check (length(provider_event_id) between 1 and 256),
  received_at timestamptz not null default now(),
  primary key (tenant_id,channel_account_id,platform,provider_event_id),
  foreign key (tenant_id,channel_account_id,platform)
    references public.channel_accounts(tenant_id,id,platform)
);

create table public.automation_flow_runs (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  flow_key text not null,
  publication_revision bigint not null,
  channel_account_id uuid not null,
  conversation_id uuid not null,
  current_node_id text not null,
  run_status text not null check (
    run_status in ('ready','awaiting_input','sleeping','handoff','completed','blocked')
  ),
  step_count integer not null default 0 check (step_count between 0 and 150),
  variables jsonb not null default '{}'::jsonb check (
    jsonb_typeof(variables)='object' and octet_length(variables::text) <= 32768
  ),
  wake_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id,id),
  foreign key (tenant_id,flow_key,publication_revision)
    references public.automation_flow_publications(tenant_id,flow_key,revision),
  foreign key (tenant_id,channel_account_id)
    references public.channel_accounts(tenant_id,id),
  foreign key (tenant_id,conversation_id)
    references public.conversations(tenant_id,id)
);

create index automation_flow_runs_due_idx on public.automation_flow_runs(wake_at)
where run_status='sleeping';

-- رسالة أو إجراء واحد لكل مفتاح. الإرسال من worker موثوق فقط بعد الالتزام بالـ transaction.
create table public.automation_flow_outbox (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  run_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 1024),
  effect_kind text not null check (effect_kind in ('message','question','delay','handoff')),
  payload jsonb not null check (octet_length(payload::text) <= 65536),
  delivery_status text not null default 'pending' check (
    delivery_status in ('pending','sending','sent','failed','cancelled')
  ),
  provider_message_id text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id,id),
  unique (tenant_id,idempotency_key),
  foreign key (tenant_id,run_id) references public.automation_flow_runs(tenant_id,id)
);

-- No raw message bodies, contacts, provider tokens, or AI prompts in metrics.
create table public.automation_flow_metrics (
  tenant_id uuid not null,
  run_id uuid not null,
  event_key text not null check (
    event_key in ('started','transition','button','delivered','completed','handoff','failed')
  ),
  occurred_at timestamptz not null default now(),
  foreign key (tenant_id,run_id) references public.automation_flow_runs(tenant_id,id)
);

alter table public.automation_flow_publications enable row level security;
alter table public.automation_flow_activations enable row level security;
alter table public.automation_flow_event_receipts enable row level security;
alter table public.automation_flow_runs enable row level security;
alter table public.automation_flow_outbox enable row level security;
alter table public.automation_flow_metrics enable row level security;

revoke all on public.automation_flow_publications,
  public.automation_flow_activations,
  public.automation_flow_event_receipts,
  public.automation_flow_runs,
  public.automation_flow_outbox,
  public.automation_flow_metrics
  from public, anon, authenticated;

grant select, insert, update, delete on public.automation_flow_publications,
  public.automation_flow_activations,
  public.automation_flow_event_receipts,
  public.automation_flow_runs,
  public.automation_flow_outbox,
  public.automation_flow_metrics
  to service_role;

-- Channel platform values match the actual database; adapters must convert
-- editor "messenger" into database "facebook" before storing activation/receipt.
-- Existing AI responder integration and Meta permission gating are still required.
commit;
