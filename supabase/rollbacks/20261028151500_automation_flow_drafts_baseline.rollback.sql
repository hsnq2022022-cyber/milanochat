-- SAFE rollback rule: production table PRE-EXISTED this migration.
-- Do NOT drop or erase it. Only a table *created by this migration* may be
-- dropped, and only when empty; otherwise fail closed.
-- Requires a separate owner GO even for staging schema deletion.
BEGIN;
DO $rollback$
DECLARE mark text;
BEGIN
  IF to_regclass('public.automation_flow_drafts') IS NULL THEN RETURN; END IF;
  mark:=obj_description('public.automation_flow_drafts'::regclass);
  IF mark IS DISTINCT FROM
    'CREATED_BY_MIGRATION_20261028151500_automation_flow_drafts_baseline'
  THEN
    RAISE NOTICE 'Pre-existing drafts table preserved by rollback';
    RETURN;
  END IF;

  IF EXISTS(SELECT 1 FROM public.automation_flow_drafts LIMIT 1) THEN
    RAISE EXCEPTION 'Refusing to drop drafts table containing customer drafts';
  END IF;

  DROP TABLE public.automation_flow_drafts;
END
$rollback$;
COMMIT;
