-- ═══════════════════════════════════════════════════════════════════════════
-- Milano Widgets Schema
-- نفّذ هذا الملف في Supabase SQL Editor بعد schema.sql الأساسي
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Widgets ──────────────────────────────────────────────────────────────
create table public.widgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  public_token text unique not null default encode(gen_random_bytes(16), 'hex'),
  enabled boolean not null default true,
  
  -- إعدادات الواجهة
  welcome_message text not null default 'مرحباً! كيف يمكنني مساعدتك؟',
  primary_color text not null default '#2ec27e',
  position text not null default 'left' check (position in ('left', 'right')),
  language text not null default 'ar',
  rtl boolean not null default true,
  avatar_url text,
  show_branding boolean not null default true,
  placeholder text not null default 'اكتب رسالتك...',
  suggested_questions text[] default array[]::text[],
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  unique (tenant_id, name)
);

create index if not exists widgets_tenant_idx on public.widgets (tenant_id);
create index if not exists widgets_token_idx on public.widgets (public_token);

-- ── Widget Sessions ──────────────────────────────────────────────────────
create table public.widget_sessions (
  id uuid primary key default gen_random_uuid(),
  widget_id uuid not null references public.widgets(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  visitor_id text not null, -- معرف الزائر (يُولّد في الـ widget)
  visitor_ip text, -- مشفر في التطبيق
  visitor_ua text, -- User Agent (مختصر)
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  
  unique (widget_id, visitor_id)
);

create index if not exists widget_sessions_widget_idx on public.widget_sessions (widget_id, last_message_at desc);

-- ── Widget Messages ──────────────────────────────────────────────────────
create table public.widget_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.widget_sessions(id) on delete cascade,
  widget_id uuid not null references public.widgets(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  body text not null,
  kind text not null default 'answer' check (kind in ('customer', 'answer', 'refusal', 'error')),
  created_at timestamptz not null default now()
);

create index if not exists widget_messages_session_idx on public.widget_messages (session_id, created_at);

-- ═══ RLS Policies ════════════════════════════════════════════════════════

alter table public.widgets enable row level security;
alter table public.widget_sessions enable row level security;
alter table public.widget_messages enable row level security;

-- Widgets: المالك فقط يراها
create policy widgets_owner on public.widgets
  for all using (
    exists (
      select 1 from public.tenants t 
      where t.id = tenant_id and t.user_id = auth.uid()
    )
  );

-- Widget Sessions: المالك فقط يراها
create policy widget_sessions_owner on public.widget_sessions
  for all using (
    exists (
      select 1 from public.tenants t 
      where t.id = tenant_id and t.user_id = auth.uid()
    )
  );

-- Widget Messages: المالك فقط يراها
create policy widget_messages_owner on public.widget_messages
  for all using (
    exists (
      select 1 from public.tenants t 
      where t.id = tenant_id and t.user_id = auth.uid()
    )
  );

-- ═══ Functions ═══════════════════════════════════════════════════════════

-- تحديث updated_at تلقائياً
create or replace function public.update_widget_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger widgets_updated_at
  before update on public.widgets
  for each row execute function public.update_widget_timestamp();
