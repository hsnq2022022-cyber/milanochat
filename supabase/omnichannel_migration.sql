-- ═══ Omnichannel Migration — القنوات الثلاث (واتساب / إنستغرام / فيسبوك) ═══
-- يضيف حقل القناة للمحادثات، وجدول الحسابات المرتبطة لكل عميل.
-- لا يغيّر أي بيانات موجودة؛ المحادثات الحالية تُعتبر whatsapp افتراضياً.

-- ── حقل القناة في المحادثات ──
alter table public.conversations
  add column if not exists channel text not null default 'whatsapp'
    check (channel in ('whatsapp','instagram','facebook'));

-- فهرس للتصفية حسب القناة مع الترتيب الزمني
create index if not exists conversations_tenant_channel_idx
  on public.conversations (tenant_id, channel, last_message_at desc);

-- ── جدول الحسابات المرتبطة (Meta OAuth assets) ──
create table if not exists public.channel_accounts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  channel           text not null check (channel in ('whatsapp','instagram','facebook')),
  external_id       text not null,               -- page_id / ig-user-id / phone_number_id
  display_name      text,                        -- اسم الصفحة/الحساب كما من Meta
  avatar_url        text,
  status            text not null default 'active'
                    check (status in ('active','needs_reauth','disconnected')),
  agent_enabled     boolean not null default true,   -- تشغيل الرد التلقائي للوكيل
  auto_reply        boolean not null default true,
  language          text not null default 'ar',
  handoff_rules     jsonb not null default '{}'::jsonb,
  access_token_encrypted text,                   -- يُحفظ مشفراً على الخادم فقط
  token_expires_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, channel, external_id)
);
create index if not exists channel_accounts_tenant_idx
  on public.channel_accounts (tenant_id, channel);

-- معرّف الوكيل المرتبط بالحساب (مرجع اختياري لجدول الوكلاء عند إنشائه)
alter table public.channel_accounts
  add column if not exists agent_config jsonb not null default '{}'::jsonb;

alter table public.channel_accounts enable row level security;

-- سياسة المالك: السيرفر يستخدم service role، والسياسات حماية لأي وصول مباشر
drop policy if exists channel_accounts_owner on public.channel_accounts;
create policy channel_accounts_owner on public.channel_accounts
  for all
  using (
    tenant_id in (
      select id from public.tenants
      where owner_user_id = auth.uid()
    )
  )
  with check (
    tenant_id in (
      select id from public.tenants
      where owner_user_id = auth.uid()
    )
  );

-- ── ربط المحادثة بالحساب الذي وصلت إليه الرسالة ──
alter table public.conversations
  add column if not exists account_id uuid references public.channel_accounts(id) on delete set null;

-- ملاحظة: wa_chat_id يبقى المعرّف العام لمحادثة العميل داخل القناة
-- (أرقام واتساب، أو psid لفيسبوك، أو ig-scoped id لإنستغرام — مع بادئة القناة).
