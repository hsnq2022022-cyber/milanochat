-- ═══ Omnichannel Phase 2 Migration — تكامل Instagram / Facebook Messenger ═══
-- يكمّل omnichannel_migration.sql ويهيّئ قاعدة البيانات لـ Webhooks الرسمية.
-- آمن للتكرار (idempotent) — كل الأوامر تستخدم if not exists / drop if exists.
-- لا يغيّر أي بيانات موجودة، ولا يمسّ جدول واتساب الحالي.

-- ─────────────────────────────────────────────────────────────
-- 1) جدول الحسابات المرتبطة channel_accounts
--    (موجود في omnichannel_migration.sql — يُعاد هنا بأمان لمن لم يطبّقه بعد)
--    tenant_id → عزل Multi-Tenant: كل حساب يخص عميلاً واحداً فقط.
--    external_id → page_id لفيسبوك، ig-user-id لإنستغرام، phone_number_id لواتساب.
--    access_token_encrypted → الرمز مشفراً على الخادم فقط، لا يصل الواجهة أبداً.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.channel_accounts (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  channel                text not null check (channel in ('whatsapp','instagram','facebook')),
  external_id            text not null,
  display_name           text,
  avatar_url             text,
  status                 text not null default 'active'
                         check (status in ('active','needs_reauth','disconnected')),
  agent_enabled          boolean not null default true,
  auto_reply             boolean not null default true,
  language               text not null default 'ar',
  handoff_rules          jsonb not null default '{}'::jsonb,
  access_token_encrypted text,
  token_expires_at       timestamptz,
  agent_config           jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (tenant_id, channel, external_id)
);
create index if not exists channel_accounts_tenant_idx
  on public.channel_accounts (tenant_id, channel);

alter table public.channel_accounts enable row level security;

drop policy if exists channel_accounts_owner on public.channel_accounts;
create policy channel_accounts_owner on public.channel_accounts
  for all
  using (
    tenant_id in (select id from public.tenants where owner_user_id = auth.uid())
  )
  with check (
    tenant_id in (select id from public.tenants where owner_user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────
-- 2) أعمدة القناة في المحادثات
--    channel: whatsapp | instagram | facebook (افتراضي whatsapp للمحادثات القديمة)
--    account_id: الحساب التجاري الذي وصلت إليه الرسالة (وليس العميل)
--    customer_name / customer_avatar: اسم وصورة المرسل كما من Meta (للبadge في Inbox)
-- ─────────────────────────────────────────────────────────────
alter table public.conversations
  add column if not exists channel text not null default 'whatsapp'
    check (channel in ('whatsapp','instagram','facebook'));

alter table public.conversations
  add column if not exists account_id uuid
    references public.channel_accounts(id) on delete set null;

alter table public.conversations
  add column if not exists customer_name text;

alter table public.conversations
  add column if not exists customer_avatar text;

-- فهرس التصفية حسب القناة مع الترتيب الزمني (يستخدمه Inbox الموحّد والفلاتر)
create index if not exists conversations_tenant_channel_idx
  on public.conversations (tenant_id, channel, last_message_at desc);

-- ملاحظة مهمة: wa_chat_id يبقى المعرّف العام لمحادثة العميل داخل القناة:
--   واتساب   : رقم الهاتف
--   فيسبوك   : "facebook:<PSID>"
--   إنستغرام : "instagram:<IG-scoped-id>"
-- البادئة تمنع تصادم المعرّفات بين القنوات لنفس الشخص، وتمنع الدمج التلقائي للهويات.

-- ─────────────────────────────────────────────────────────────
-- 3) منع تكرار الرسائل الواردة (Webhook قد يصل أكثر من مرة)
--    external_message_id = معرّف mid من Meta (أو wamid لواتساب).
--    فهرس فريد جزئي: لا يمنع تكرار الردود الصادرة (null).
-- ─────────────────────────────────────────────────────────────
alter table public.messages
  add column if not exists external_message_id text;

create unique index if not exists messages_ext_msg_uidx
  on public.messages (external_message_id)
  where external_message_id is not null;

-- تسريع جلب رسائل المحادثة بالترتيب الزمني (يستخدمه Dashboard وRealtime)
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at asc);

-- ─────────────────────────────────────────────────────────────
-- 4) توسيع قيد kind في الرسائل
--    الكود الجديد يحفظ kind='text' للرسائل الواردة النصية،
--    بينما القيد القديم يسمح فقط بـ (customer, answer, refusal, handoff, manual).
--    نضيف 'text' دون كسر أي شيء موجود.
-- ─────────────────────────────────────────────────────────────
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages
  add constraint messages_kind_check
  check (kind in ('customer','answer','refusal','handoff','manual','text'));

-- ─────────────────────────────────────────────────────────────
-- 5) Realtime — لدفع الرسائل الجديدة إلى لوحة التحكم بدون Polling
-- ─────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- RLS على messages: نفس سياسة المالك الحالية تبقى كما هي؛ تأكد أنها مفعّلة:
alter table public.messages enable row level security;

-- ═══ نهاية الميجريشن ═══
-- بعد التنفيذ في Supabase SQL Editor يجب:
-- 1) ضبط متغيرات الخادم: META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, PUBLIC_URL
-- 2) تسجيل Webhook في Meta Developers على:
--    {PUBLIC_URL}/api/channels/meta/webhook
--    مع Subscribe fields: messages, messaging_postbacks, messaging_optins
-- 3) منح التطبيق صلاحيات: pages_messaging, pages_read_engagement,
--    instagram_basic, instagram_manage_messages, business_management (تحتاج App Review)
