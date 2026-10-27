-- Synthetic fixture for isolated GitHub CI only. Never applied to production.
\set ON_ERROR_STOP on

-- المحاكاة تطابق الحقول الفعلية للعلاقات الموجودة في بيئة الإنتاج.
create table public.channel_accounts (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  platform text not null check (platform in ('instagram','facebook','whatsapp'))
);
create table public.conversations (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id)
);

insert into public.channel_accounts(id,tenant_id,platform) values
('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','instagram'),
('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','facebook');

insert into public.conversations(id,tenant_id) values
('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
('ffffffff-ffff-4fff-8fff-ffffffffffff',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
