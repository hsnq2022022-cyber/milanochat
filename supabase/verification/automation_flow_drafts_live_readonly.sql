-- STEP 2 - READ ONLY. Owner runs on live Supabase SQL Editor and shares output.
-- No data rows, tokens, customer content or user IDs are read by these queries.
-- DO NOT apply proposal or any migration based only on remembered live structure.

-- 1: Existence, owner, RLS and forced RLS.
select c.oid::regclass::text as table_name,pg_get_userbyid(c.relowner) as table_owner,
       c.relrowsecurity as rls_enabled,c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='automation_flow_drafts';

-- 2: Exact columns, order, identity and defaults.
select a.attnum,a.attname as column_name,format_type(a.atttypid,a.atttypmod) as data_type,
       a.attnotnull as not_null,pg_get_expr(d.adbin,d.adrelid) as default_expr,
       a.attgenerated,a.attidentity
from pg_attribute a
join pg_class c on c.oid=a.attrelid
join pg_namespace n on n.oid=c.relnamespace
left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
where n.nspname='public' and c.relname='automation_flow_drafts'
and a.attnum>0 and not a.attisdropped order by a.attnum;

-- 3: All constraints including validated/not-validated status.
select conname,contype,convalidated,pg_get_constraintdef(oid,true) as definition
from pg_constraint
where conrelid=to_regclass('public.automation_flow_drafts')
order by conname;

-- 4: All indexes, exact expressions and predicates.
select indexname,indexdef
from pg_indexes where schemaname='public' and tablename='automation_flow_drafts'
order by indexname;

-- 5: Exact RLS policies and role targets.
select policyname,permissive,roles,cmd,qual,with_check
from pg_policies where schemaname='public' and tablename='automation_flow_drafts'
order by policyname;

-- 6: Table and per-column grants including PUBLIC.
select grantee,privilege_type,is_grantable
from information_schema.role_table_grants
where table_schema='public' and table_name='automation_flow_drafts'
order by grantee,privilege_type;
select grantee,column_name,privilege_type
from information_schema.column_privileges
where table_schema='public' and table_name='automation_flow_drafts'
order by grantee,column_name,privilege_type;

-- 7: Trigger definitions and sequence dependencies, if any.
select tgname,pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid=to_regclass('public.automation_flow_drafts') and not tgisinternal
order by tgname;
