-- Isolated CI-only fixture. Never execute against a live Supabase project.
\set ON_ERROR_STOP on

create role anon nologin;
create role authenticated nologin;
create schema auth;

-- يحاكي معرّف المستخدم الذي تضعه Supabase في سياق طلب موثّق.
create function auth.uid() returns uuid language sql stable
as $uid$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $uid$;

grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create table public.tenants (
  id uuid primary key,
  user_id uuid not null
);
alter table public.tenants enable row level security;
grant select on public.tenants to authenticated;
create policy "user read own tenant" on public.tenants
for select to authenticated using (user_id = auth.uid());

insert into public.tenants (id, user_id) values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111'),
('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222');
