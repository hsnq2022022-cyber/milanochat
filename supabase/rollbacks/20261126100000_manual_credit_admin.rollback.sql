-- Rollback of 20261126100000_manual_credit_admin. Refuses while the audit ledger holds rows
-- (the ledger is the only record of manual credit changes) and never drops a foreign object.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$
BEGIN
  IF to_regclass('public.tenant_admin_actions') IS NULL THEN
    RAISE EXCEPTION '20261126100000_manual_credit_admin not installed; nothing to roll back';
  END IF;
  IF coalesce(obj_description(to_regclass('public.tenant_admin_actions'),'pg_class'),'')<>'CREATED_BY_20261126100000_MANUAL_CREDIT_ADMIN' THEN
    RAISE EXCEPTION 'Refusing: public.tenant_admin_actions is not owned by this migration';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_admin_actions) THEN
    RAISE EXCEPTION 'Refusing: the manual credit ledger is not empty; export it first';
  END IF;
  IF to_regprocedure('public.admin_adjust_credits(uuid,uuid,integer,text,text)') IS NOT NULL
     AND coalesce(obj_description(to_regprocedure('public.admin_adjust_credits(uuid,uuid,integer,text,text)'),'pg_proc'),'')<>'CREATED_BY_20261126100000_MANUAL_CREDIT_ADMIN' THEN
    RAISE EXCEPTION 'Refusing: admin_adjust_credits is not owned by this migration';
  END IF;
  IF to_regprocedure('public.admin_set_tenant_active(uuid,uuid,boolean,text,text)') IS NOT NULL
     AND coalesce(obj_description(to_regprocedure('public.admin_set_tenant_active(uuid,uuid,boolean,text,text)'),'pg_proc'),'')<>'CREATED_BY_20261126100000_MANUAL_CREDIT_ADMIN' THEN
    RAISE EXCEPTION 'Refusing: admin_set_tenant_active is not owned by this migration';
  END IF;
END
$guard$;
DROP FUNCTION IF EXISTS public.admin_set_tenant_active(uuid,uuid,boolean,text,text);
DROP FUNCTION IF EXISTS public.admin_adjust_credits(uuid,uuid,integer,text,text);
DROP TABLE public.tenant_admin_actions;
COMMIT;
