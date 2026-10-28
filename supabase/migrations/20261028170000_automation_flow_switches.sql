-- Safe, additive flow kill switches for the EXISTING Supabase project.
-- Review only: DO NOT apply without a specific owner GO for this migration.
-- No customers/tenants/credits/messages are inserted, updated or deleted.
-- All new automation starts disabled at BOTH global and tenant levels.
BEGIN;

DO $create$
DECLARE
  v_name text;
  v_relation regclass;
BEGIN
  -- Reject unrelated/pre-existing tables before any DDL or GRANT. Names
  -- alone never authorize this migration to take ownership of a table.
  FOREACH v_name IN ARRAY ARRAY[
    'automation_flow_global_switch','automation_flow_tenant_switches'
  ] LOOP
    v_relation := to_regclass('public.' || v_name);
    IF v_relation IS NOT NULL AND obj_description(v_relation) IS DISTINCT FROM
        'CREATED_BY_20261028170000_automation_flow_switches' THEN
      RAISE EXCEPTION
        'Unrecognized existing table %; refusing to modify grants or data',
        v_name;
    END IF;
  END LOOP;

  IF to_regclass('public.automation_flow_global_switch') IS NULL THEN
    CREATE TABLE public.automation_flow_global_switch (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      enabled boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE public.automation_flow_global_switch IS
      'CREATED_BY_20261028170000_automation_flow_switches';
  END IF;

  IF to_regclass('public.automation_flow_tenant_switches') IS NULL THEN
    CREATE TABLE public.automation_flow_tenant_switches (
      tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
      enabled boolean NOT NULL DEFAULT false,
      test_only boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE public.automation_flow_tenant_switches IS
      'CREATED_BY_20261028170000_automation_flow_switches';
  END IF;
END
$create$;

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='automation_flow_global_switch'
        AND column_name='enabled' AND data_type='boolean'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='automation_flow_tenant_switches'
        AND column_name='tenant_id' AND data_type='uuid'
  ) THEN
    RAISE EXCEPTION 'Flow switch schema mismatch; refusing to modify existing settings';
  END IF;
END
$check$;

-- In a fresh installation the switches must be write-protected by RLS,
-- and the single global row is OFF. Re-application never flips user settings.
-- An existing, deliberately configured switch is NEVER reset by a re-run.
INSERT INTO public.automation_flow_global_switch(singleton,enabled)
VALUES(true,false)
ON CONFLICT(singleton) DO NOTHING;

ALTER TABLE public.automation_flow_global_switch ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_flow_tenant_switches ENABLE ROW LEVEL SECURITY;

-- No authenticated browser user may activate a flow by writing settings.
REVOKE ALL ON TABLE public.automation_flow_global_switch
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON TABLE public.automation_flow_tenant_switches
  FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.automation_flow_global_switch
  TO service_role;
GRANT SELECT,INSERT,UPDATE ON public.automation_flow_tenant_switches
  TO service_role;

COMMIT;
