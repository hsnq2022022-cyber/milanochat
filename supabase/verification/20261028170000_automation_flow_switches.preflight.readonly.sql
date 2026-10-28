-- READ-ONLY preflight for the exact single project migration.
-- Safe to execute before either switch table exists. This never reads
-- tenant/customer contents and never modifies grants, schema or settings.
WITH targets AS (
  SELECT name, to_regclass('public.' || name) AS relation
  FROM (VALUES ('automation_flow_global_switch'),
               ('automation_flow_tenant_switches')) AS t(name)
)
SELECT
  name AS proposed_table,
  relation IS NOT NULL AS already_exists,
  CASE WHEN relation IS NULL THEN 'safe_to_create'
       WHEN obj_description(relation) =
            'CREATED_BY_20261028170000_automation_flow_switches'
         THEN 'recognized_reapply'
       ELSE 'STOP_unrecognized_existing_table'
  END AS assessment
FROM targets
ORDER BY proposed_table;
-- Both should be safe_to_create on nmhefwvhoholcjrbbila, according to
-- the live read-only inspection. If either assessment says STOP, DO NOT APPLY.
