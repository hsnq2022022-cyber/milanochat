-- جدول جلسات OAuth لتطبيقات Meta (Facebook Login / Instagram API with Facebook Login)
-- يُستخدم للتحقق من صلاحية state ومنع إعادة استخدامه عبر كل نسخ الخادم
-- (الحل الجذري لفشل oauth_state بعد كل deploy/restart الذي كان يعتمد على ذاكرة العملية).

create table if not exists public.meta_oauth_states (
  id           text primary key,            -- nonce عشوائي مضمّن في payload الـ state الموقّع
  user_id      uuid not null,               -- معرّف مستخدم Supabase Auth الذي بدأ الربط
  tenant_id    uuid not null,               -- النشاط التجاري المرتبط بالجلسة
  platform     text not null check (platform in ('facebook', 'instagram')),
  consumed     boolean not null default false,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

create index if not exists meta_oauth_states_expires_idx
  on public.meta_oauth_states (expires_at);

-- الوصول فقط عبر service role (الخادم). لا RLS policies للـ anon — لا يحتاجها المتصفح إطلاقاً.
alter table public.meta_oauth_states enable row level security;

-- تنظيف دوري للسجلات المنتهية (اختياري — يمكن تشغيله يدوياً أو عبر pg_cron)
delete from public.meta_oauth_states where expires_at < now() - interval '1 day';
