-- ═══════════════════════════════════════════════════════════════
-- إدارة سوشيال — قنوات Facebook + Instagram (feature/social-channels)
-- ينفذ بأمان إن سبق تنفيذ أجزاء منه (idempotent).
-- ملاحظة: tenants.user_id هو عمود المالك في هذا المشروع.
-- ═══════════════════════════════════════════════════════════════

-- 1) عمود المصدر في المحادثات (افتراضي واتساب حتى لا تتأثر البيانات القديمة)
alter table public.conversations
add column if not exists source text default 'whatsapp';

update public.conversations set source = 'whatsapp' where source is null;

-- 2) جدول القنوات — قناة واحدة لكل منصة لكل نشاط تجاري
create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  platform text not null check (platform in ('whatsapp', 'facebook', 'instagram')),
  platform_account_id text,
  account_name text,
  account_avatar text,
  is_connected boolean default false,
  connected_at timestamptz,
  created_at timestamptz default now(),
  unique(tenant_id, platform)
);

alter table public.channels enable row level security;

-- 3) سياسات RLS — كل مستخدم يرى/يعدّل قنواته فقط (Multi-Tenant isolation)
drop policy if exists "users see their channels" on public.channels;
create policy "users see their channels"
on public.channels for select
to authenticated
using (
  tenant_id in (
    select id from public.tenants where user_id = auth.uid()
  )
);

drop policy if exists "users manage their channels" on public.channels;
create policy "users manage their channels"
on public.channels for all
to authenticated
using (
  tenant_id in (
    select id from public.tenants where user_id = auth.uid()
  )
)
with check (
  tenant_id in (
    select id from public.tenants where user_id = auth.uid()
  )
);

-- فهرس للمساعدة على الجلب حسب النشاط
create index if not exists channels_tenant_idx on public.channels (tenant_id, platform);
