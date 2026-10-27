-- REVIEW ONLY — DO NOT RUN ON PRODUCTION.
-- Proposal based on a READ-ONLY inspection of the active Supabase public schema.
-- Existing owner model: public.tenants.user_id = auth.uid().
-- These tables have NOT been created in Supabase by this PR.
-- Design requires approval, a local migration generated via Supabase CLI, and RLS tests.

create table if not exists public.automation_flow_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  flow_key text not null check (length(flow_key) between 1 and 128),
  name text not null check (length(name) between 1 and 100),
  document jsonb not null,
  revision bigint not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,flow_key),
  unique(id,tenant_id),
  constraint automation_draft_valid_v3 check (
    jsonb_typeof(document)='object'
    and document->>'version'='3'
    and jsonb_typeof(document->'nodes')='array'
    and jsonb_typeof(document->'edges')='array'
    and jsonb_array_length(document->'nodes')<=100
    and jsonb_array_length(document->'edges')<=350
    and octet_length(document::text)<=1048576
  )
);
create index if not exists automation_flow_drafts_by_tenant
  on public.automation_flow_drafts(tenant_id,updated_at desc);
alter table public.automation_flow_drafts enable row level security;
revoke all on public.automation_flow_drafts from anon;
grant select,insert,update,delete on public.automation_flow_drafts to authenticated;

create policy automation_drafts_owner_select on public.automation_flow_drafts
for select to authenticated
using (exists (
  select 1 from public.tenants t
  where t.id=tenant_id and t.user_id=(select auth.uid())
));
create policy automation_drafts_owner_insert on public.automation_flow_drafts
for insert to authenticated
with check (exists (
  select 1 from public.tenants t
  where t.id=tenant_id and t.user_id=(select auth.uid())
));
create policy automation_drafts_owner_update on public.automation_flow_drafts
for update to authenticated
using (exists (
  select 1 from public.tenants t
  where t.id=tenant_id and t.user_id=(select auth.uid())
))
with check (exists (
  select 1 from public.tenants t
  where t.id=tenant_id and t.user_id=(select auth.uid())
));
create policy automation_drafts_owner_delete on public.automation_flow_drafts
for delete to authenticated
using (exists (
  select 1 from public.tenants t
  where t.id=tenant_id and t.user_id=(select auth.uid())
));

create or replace function public.automation_flow_drafts_revision_guard()
returns trigger language plpgsql security invoker set search_path=''
as $$
begin
  -- A client may only update a draft with an incremented CAS revision.
  -- UPDATE WHERE revision=expected_revision protects against concurrent edits.
  if new.revision <> old.revision+1 then
    raise exception 'automation draft revision must increment exactly once';
  end if;
  new.updated_at=now();
  return new;
end
$$;
revoke all on function public.automation_flow_drafts_revision_guard() from public;
drop trigger if exists automation_flow_drafts_revision_guard on public.automation_flow_drafts;
create trigger automation_flow_drafts_revision_guard
before update on public.automation_flow_drafts
for each row execute function public.automation_flow_drafts_revision_guard();

-- Publishing is a separate server-only operation. Browser clients may READ
-- the published state, but MUST NOT INSERT/UPDATE/DELETE it directly.
create table if not exists public.automation_flow_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  draft_id uuid not null,
  version_number bigint not null check (version_number >= 1),
  document jsonb not null,
  status text not null default 'paused' check (status in ('paused','active','replaced')),
  published_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  unique(draft_id,version_number),
  foreign key(draft_id,tenant_id)
    references public.automation_flow_drafts(id,tenant_id) on delete cascade,
  constraint automation_flow_release_valid_v3 check (
    jsonb_typeof(document)='object'
    and document->>'version'='3'
    and jsonb_typeof(document->'nodes')='array'
    and jsonb_typeof(document->'edges')='array'
    and octet_length(document::text)<=1048576
  )
);
create unique index if not exists automation_flow_only_one_active_version
on public.automation_flow_versions(draft_id)
where status='active';
create index if not exists automation_flow_versions_tenant
on public.automation_flow_versions(tenant_id,draft_id,published_at desc);
alter table public.automation_flow_versions enable row level security;
revoke all on public.automation_flow_versions from anon,authenticated;
grant select on public.automation_flow_versions to authenticated;
create policy automation_flow_versions_owner_select on public.automation_flow_versions
for select to authenticated
using (exists (
  select 1 from public.tenants t
  where t.id=tenant_id and t.user_id=(select auth.uid())
));

-- NO front-end INSERT/UPDATE rights on automation_flow_versions.
-- In a later phase a dedicated authenticated Edge Function must validate
-- v3, tenant ownership, Meta constraints and activation transaction before
-- committing a new version using server-side credentials.

-- Before applying this proposal:
-- 1. Generate a timestamped migration using the installed Supabase CLI.
-- 2. Test as owner A, owner B, anonymous and service role on an isolated DB.
-- 3. Verify SELECT/INSERT/UPDATE/DELETE RLS and revision concurrency.
-- 4. Run Supabase security/performance advisors.
-- 5. Verify DB Data API exposure/grants for authenticated role.
