-- REVIEW PROPOSAL ONLY — NOT APPLIED TO LIVE DATABASE.
-- Deploy only after approval, tenant-RLS allow/deny tests, and backup verification.
-- Existing confirmed parent table: public.tenants(id uuid, user_id uuid).
-- No changes to Meta, existing channel accounts, payments or milan-api.
-- This proposal is the candidate canonical design. PR #100 contains a DIFFERENT
-- non-deployed schema proposal; DO NOT APPLY BOTH. Review the reconciliation note.
begin;

create table public.automation_flow_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  flow_key text not null check (length(flow_key) between 1 and 128),
  name text not null check (length(name) between 1 and 100),
  document jsonb not null check (
    jsonb_typeof(document) = 'object' and
    document->>'version' = '3' and
    jsonb_typeof(document->'nodes') = 'array' and
    jsonb_typeof(document->'edges') = 'array' and
    case when jsonb_typeof(document->'nodes') = 'array'
      then jsonb_array_length(document->'nodes') <= 100 else false end and
    case when jsonb_typeof(document->'edges') = 'array'
      then jsonb_array_length(document->'edges') <= 250 else false end and
    octet_length(document::text) <= 4194304
  ),
  draft_revision integer not null default 1 check (draft_revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, flow_key),
  unique (id, tenant_id)
);

create index automation_flow_drafts_tenant_updated_idx
  on public.automation_flow_drafts (tenant_id, updated_at desc);

alter table public.automation_flow_drafts enable row level security;

-- Explicit Data API grants: NO permissions to public/anon, authenticated users
-- may not alter tenant_id/flow_key or publish from this draft-only table.
revoke all on table public.automation_flow_drafts from public, anon, authenticated;
grant select, insert on table public.automation_flow_drafts to authenticated;
grant update (name, document, draft_revision)
  on table public.automation_flow_drafts to authenticated;

create policy "owner select own automation drafts"
  on public.automation_flow_drafts for select to authenticated
  using (exists (
    select 1 from public.tenants t
    where t.id=tenant_id and t.user_id=(select auth.uid())
  ));

create policy "owner insert own automation drafts"
  on public.automation_flow_drafts for insert to authenticated
  with check (exists (
    select 1 from public.tenants t
    where t.id=tenant_id and t.user_id=(select auth.uid())
  ));

create policy "owner edit own automation drafts"
  on public.automation_flow_drafts for update to authenticated
  using (exists (
    select 1 from public.tenants t
    where t.id=tenant_id and t.user_id=(select auth.uid())
  ))
  with check (exists (
    select 1 from public.tenants t
    where t.id=tenant_id and t.user_id=(select auth.uid())
  ));

-- Server-owned revision and update time: clients cannot skip revisions or forge timestamps.
-- SECURITY INVOKER; this function is only invoked by the table trigger.
create function public.automation_flow_draft_revision_guard()
returns trigger language plpgsql security invoker set search_path='pg_catalog'
as $
begin
  if new.draft_revision <> old.draft_revision + 1 then
    raise exception 'cloud draft revision must increment by one' using errcode='23514';
  end if;
  new.updated_at = now();
  return new;
end
$;
revoke all on function public.automation_flow_draft_revision_guard() from public, anon, authenticated;
create trigger automation_flow_draft_revision_guard
  before update on public.automation_flow_drafts
  for each row execute function public.automation_flow_draft_revision_guard();

-- Deliberate exclusions:
-- * No DELETE: recovery safety pending explicit deletion workflow.
-- * No publish/enable fields: saving a draft MUST NOT start any Meta automation.
-- * No SECURITY DEFINER routines or service-role secrets exposed to clients.
-- * Deploy after tests for role anon, owner A, owner B, denied cross-tenant CRUD,
--   authorized revision compare-and-swap, oversized payload and schema rejection.
commit;
