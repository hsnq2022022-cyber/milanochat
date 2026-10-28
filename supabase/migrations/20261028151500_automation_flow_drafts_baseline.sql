-- Live-schema baseline: verified read-only in project nmhefwvhoholcjrbbila
-- on 2026-10-28. The table already exists in PRODUCTION.
-- Applying this migration to production is NOT approved in this work session.
-- It must be recorded only after schema comparison and a per-step owner GO.
-- Safe on an existing matching table; creates only when the table is missing.
BEGIN;

DO $create$
BEGIN
  IF to_regclass('public.automation_flow_drafts') IS NULL THEN
    CREATE TABLE public.automation_flow_drafts (
      tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
      flow_key text NOT NULL CHECK (length(flow_key) BETWEEN 1 AND 128),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      document jsonb NOT NULL CHECK (
        jsonb_typeof(document)='object' AND document->>'version'='3'
        AND jsonb_typeof(document->'nodes')='array'
        AND jsonb_typeof(document->'edges')='array'
        AND octet_length(document::text)<=4194304
      ),
      draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision>0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(tenant_id,flow_key)
    );
    -- Only tables created by THIS migration carry the rollback marker.
    COMMENT ON TABLE public.automation_flow_drafts IS
      'CREATED_BY_MIGRATION_20261028151500_automation_flow_drafts_baseline';
  END IF;
END
$create$;

-- Fail closed if an unrelated table happens to use the same name.
DO $shape$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM pg_attribute a
  WHERE a.attrelid='public.automation_flow_drafts'::regclass
    AND a.attnum>0 AND NOT a.attisdropped;
  IF n<>7 THEN RAISE EXCEPTION 'Unexpected automation_flow_drafts column count: %',n; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.automation_flow_drafts'::regclass
      AND contype='p' AND conname='automation_flow_drafts_pkey'
  ) THEN RAISE EXCEPTION 'Unexpected automation_flow_drafts primary key'; END IF;
END
$shape$;

CREATE INDEX IF NOT EXISTS automation_flow_drafts_tenant_updated_idx
  ON public.automation_flow_drafts(tenant_id,updated_at DESC);
ALTER TABLE public.automation_flow_drafts ENABLE ROW LEVEL SECURITY;

-- Authenticated users may change CONTENT fields but never owning tenant/key.
REVOKE ALL ON public.automation_flow_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT ON public.automation_flow_drafts TO authenticated;
GRANT UPDATE(name,document,draft_revision,updated_at)
  ON public.automation_flow_drafts TO authenticated;

DO $policies$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='automation_flow_drafts'
      AND policyname='owner select own automation drafts') THEN
    CREATE POLICY "owner select own automation drafts"
      ON public.automation_flow_drafts FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.tenants t
        WHERE t.id=tenant_id AND t.user_id=(SELECT auth.uid())
      ));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='automation_flow_drafts'
      AND policyname='owner insert own automation drafts') THEN
    CREATE POLICY "owner insert own automation drafts"
      ON public.automation_flow_drafts FOR INSERT TO authenticated
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.tenants t
        WHERE t.id=tenant_id AND t.user_id=(SELECT auth.uid())
      ));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='automation_flow_drafts'
      AND policyname='owner edit own automation drafts') THEN
    CREATE POLICY "owner edit own automation drafts"
      ON public.automation_flow_drafts FOR UPDATE TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.tenants t
        WHERE t.id=tenant_id AND t.user_id=(SELECT auth.uid())
      ))
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.tenants t
        WHERE t.id=tenant_id AND t.user_id=(SELECT auth.uid())
      ));
  END IF;
END
$policies$;

COMMIT;
