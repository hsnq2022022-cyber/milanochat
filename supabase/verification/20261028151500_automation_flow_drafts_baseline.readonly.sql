-- READ-ONLY. Safe metadata-only verification for the live drafts table.
SELECT
  to_regclass('public.automation_flow_drafts') IS NOT NULL AS exists,
  c.relrowsecurity AS rls_enabled,
  (SELECT count(*) FROM pg_attribute a
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=7
    AS seven_live_columns,
  (SELECT count(*) FROM pg_policies p
    WHERE p.schemaname='public' AND p.tablename='automation_flow_drafts'
      AND p.policyname IN ('owner select own automation drafts',
                          'owner insert own automation drafts',
                          'owner edit own automation drafts'))=3
    AS three_owner_policies,
  has_table_privilege('anon',c.oid,'SELECT') AS anon_select,
  has_table_privilege('authenticated',c.oid,'SELECT') AS auth_select,
  has_table_privilege('authenticated',c.oid,'INSERT') AS auth_insert,
  has_column_privilege('authenticated',c.oid,'name','UPDATE') AS auth_update_name,
  has_column_privilege('authenticated',c.oid,'document','UPDATE') AS auth_update_document,
  has_column_privilege('authenticated',c.oid,'draft_revision','UPDATE') AS auth_update_revision,
  has_column_privilege('authenticated',c.oid,'updated_at','UPDATE') AS auth_update_updated_at,
  has_column_privilege('authenticated',c.oid,'tenant_id','UPDATE') AS auth_update_owner,
  has_column_privilege('authenticated',c.oid,'flow_key','UPDATE') AS auth_update_flow_key
FROM pg_class c
WHERE c.oid=to_regclass('public.automation_flow_drafts');
-- Expected: true,true,true,true,false,true,true,true,true,true,true,false,false.
-- Database role auth UPDATE at the TABLE level may be FALSE while the
-- listed allowed COLUMN privileges are TRUE; this is intentional.
