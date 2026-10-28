-- Additive runtime schema proposal tailored to LIVE table shapes inspected
-- read-only on Supabase nmhefwvhoholcjrbbila, 2026-10-28.
-- DO NOT RUN ON THE LIVE PROJECT without exact schema-change GO.
-- No old rows are updated/deleted. New runtime has no worker attached.
-- PR #133 server-owned OFF switches must exist before deploying any worker.
BEGIN;

DO $preflight$
DECLARE name text;
        r regclass;
BEGIN
  -- Never replace an existing unrelated trigger function or composite index.
  IF to_regprocedure('public.reject_automation_flow_revision_mutation()') IS NOT NULL
    AND obj_description(to_regprocedure('public.reject_automation_flow_revision_mutation()'),'pg_proc')
      IS DISTINCT FROM 'CREATED_BY_20261028180000_FLOW_RUNTIME' THEN
    RAISE EXCEPTION 'Unknown existing publication immutability function';
  END IF;
  FOREACH name IN ARRAY ARRAY[
    'channel_accounts_flow_owner_uq','conversations_flow_owner_uq'
  ] LOOP
    r := to_regclass('public.'||name);
    IF r IS NOT NULL AND obj_description(r)
        IS DISTINCT FROM 'CREATED_BY_20261028180000_FLOW_RUNTIME' THEN
      RAISE EXCEPTION 'Unknown existing flow owner index: %',name;
    END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY[
    'automation_flow_publications','automation_flow_activations',
    'automation_flow_event_receipts','automation_flow_runs',
    'automation_flow_outbox','automation_flow_metrics'
  ] LOOP
    IF to_regclass('public.'||name) IS NOT NULL AND
       obj_description(to_regclass('public.'||name)) IS DISTINCT FROM
          'CREATED_BY_20261028180000_FLOW_RUNTIME' THEN
      RAISE EXCEPTION 'Unrecognized pre-existing flow runtime table: %',name;
    END IF;
  END LOOP;
  IF to_regclass('public.automation_flow_global_switch') IS NULL OR
     to_regclass('public.automation_flow_tenant_switches') IS NULL THEN
    RAISE EXCEPTION 'Server kill switches must exist before runtime schema';
  END IF;
END
$preflight$;

-- New composite UNIQUE indexes have no data mutations and permit strict FKs
-- into existing tenant/account/conversation tables. Existing IDs are UUID PKs.
CREATE UNIQUE INDEX IF NOT EXISTS channel_accounts_flow_owner_uq
  ON public.channel_accounts(tenant_id,id,platform);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_flow_owner_uq
  ON public.conversations(tenant_id,id,account_id);
COMMENT ON INDEX public.channel_accounts_flow_owner_uq
  IS 'CREATED_BY_20261028180000_FLOW_RUNTIME';
COMMENT ON INDEX public.conversations_flow_owner_uq
  IS 'CREATED_BY_20261028180000_FLOW_RUNTIME';

CREATE TABLE IF NOT EXISTS public.automation_flow_publications (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  flow_key text NOT NULL CHECK (flow_key ~ '^[a-zA-Z0-9_-]{1,128}$'),
  revision bigint NOT NULL CHECK(revision>0),
  channel_account_id uuid NOT NULL,
  platform text NOT NULL CHECK(platform IN ('facebook','instagram','whatsapp')),
  document jsonb NOT NULL CHECK(
    jsonb_typeof(document)='object' AND document->>'version'='3'
    AND jsonb_typeof(document->'nodes')='array'
    AND jsonb_typeof(document->'edges')='array'
    AND octet_length(document::text)<=4194304
  ),
  published_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,flow_key,revision),
  UNIQUE(tenant_id,flow_key,revision,channel_account_id,platform),
  FOREIGN KEY(tenant_id,channel_account_id,platform)
    REFERENCES public.channel_accounts(tenant_id,id,platform)
);
COMMENT ON TABLE public.automation_flow_publications
  IS 'CREATED_BY_20261028180000_FLOW_RUNTIME';

CREATE OR REPLACE FUNCTION public.reject_automation_flow_revision_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $$
BEGIN
  RAISE EXCEPTION 'Published revision is immutable' USING ERRCODE='23514';
END
$$;
COMMENT ON FUNCTION public.reject_automation_flow_revision_mutation()
  IS 'CREATED_BY_20261028180000_FLOW_RUNTIME';
REVOKE ALL ON FUNCTION public.reject_automation_flow_revision_mutation()
  FROM PUBLIC,anon,authenticated;

DO $trigger$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger
  WHERE tgrelid='public.automation_flow_publications'::regclass
  AND tgname='automation_flow_publications_immutable') THEN
   CREATE TRIGGER automation_flow_publications_immutable
    BEFORE UPDATE OR DELETE ON public.automation_flow_publications
    FOR EACH ROW EXECUTE FUNCTION public.reject_automation_flow_revision_mutation();
 END IF;
END
$trigger$;

CREATE TABLE IF NOT EXISTS public.automation_flow_activations (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL,
  platform text NOT NULL,
  flow_key text NOT NULL,
  revision bigint NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,channel_account_id,platform,flow_key),
  FOREIGN KEY(tenant_id,channel_account_id,platform)
    REFERENCES public.channel_accounts(tenant_id,id,platform),
  FOREIGN KEY(tenant_id,flow_key,revision,channel_account_id,platform)
    REFERENCES public.automation_flow_publications
      (tenant_id,flow_key,revision,channel_account_id,platform)
);
COMMENT ON TABLE public.automation_flow_activations
  IS 'CREATED_BY_20261028180000_FLOW_RUNTIME';

CREATE TABLE IF NOT EXISTS public.automation_flow_event_receipts (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL,
  platform text NOT NULL,
  provider_event_id text NOT NULL CHECK(length(provider_event_id) BETWEEN 1 AND 256),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,channel_account_id,platform,provider_event_id),
  FOREIGN KEY(tenant_id,channel_account_id,platform)
    REFERENCES public.channel_accounts(tenant_id,id,platform)
);
COMMENT ON TABLE public.automation_flow_event_receipts
  IS 'CREATED_BY_20261028180000_FLOW_RUNTIME';

CREATE TABLE IF NOT EXISTS public.automation_flow_runs (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  flow_key text NOT NULL,
  publication_revision bigint NOT NULL,
  channel_account_id uuid NOT NULL,
  platform text NOT NULL,
  conversation_id uuid NOT NULL,
  provider_event_id text NOT NULL,
  current_node_id text NOT NULL CHECK(length(current_node_id) BETWEEN 1 AND 128),
  run_status text NOT NULL DEFAULT 'ready' CHECK(run_status IN
    ('ready','awaiting_input','sleeping','handoff','completed','blocked')),
  step_count integer NOT NULL DEFAULT 0 CHECK(step_count BETWEEN 0 AND 150),
  variables jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(
    jsonb_typeof(variables)='object' AND octet_length(variables::text)<=32768
  ),
  wake_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,channel_account_id,platform,provider_event_id),
  FOREIGN KEY(tenant_id,flow_key,publication_revision,channel_account_id,platform)
    REFERENCES public.automation_flow_publications
      (tenant_id,flow_key,revision,channel_account_id,platform),
  FOREIGN KEY(tenant_id,conversation_id,channel_account_id)
    REFERENCES public.conversations(tenant_id,id,account_id),
  FOREIGN KEY(tenant_id,channel_account_id,platform,provider_event_id)
    REFERENCES public.automation_flow_event_receipts
      (tenant_id,channel_account_id,platform,provider_event_id)
);
COMMENT ON TABLE public.automation_flow_runs
  IS 'CREATED_BY_20261028180000_FLOW_RUNTIME';
CREATE INDEX IF NOT EXISTS automation_flow_runs_due_idx
  ON public.automation_flow_runs(wake_at)
  WHERE run_status='sleeping';

CREATE TABLE IF NOT EXISTS public.automation_flow_outbox (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 1024),
  outgoing_message_id uuid NOT NULL DEFAULT gen_random_uuid(),
  effect_kind text NOT NULL CHECK(effect_kind IN
    ('message','question','delay','handoff','tag','untag','staff_notification')),
  payload jsonb NOT NULL CHECK(
    jsonb_typeof(payload)='object' AND octet_length(payload::text)<=65536
  ),
  delivery_status text NOT NULL DEFAULT 'pending' CHECK(delivery_status IN
    ('pending','retry_wait','leased','uncertain','charge_pending','settled',
     'billing_blocked','dead_letter','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  lease_token uuid,
  lease_expires_at timestamptz,
  retry_at timestamptz,
  provider_message_id text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,idempotency_key),
  UNIQUE(tenant_id,outgoing_message_id),
  FOREIGN KEY(tenant_id,run_id)
    REFERENCES public.automation_flow_runs(tenant_id,id)
);
COMMENT ON TABLE public.automation_flow_outbox
  IS 'CREATED_BY_20261028180000_FLOW_RUNTIME';
CREATE INDEX IF NOT EXISTS automation_flow_outbox_due_idx
  ON public.automation_flow_outbox(retry_at)
  WHERE delivery_status IN ('pending','retry_wait');

CREATE TABLE IF NOT EXISTS public.automation_flow_metrics (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  event_key text NOT NULL CHECK(event_key IN
    ('started','transition','button','delivered','completed','handoff','failed')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,run_id)
    REFERENCES public.automation_flow_runs(tenant_id,id)
);
COMMENT ON TABLE public.automation_flow_metrics
  IS 'CREATED_BY_20261028180000_FLOW_RUNTIME';

ALTER TABLE public.automation_flow_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_flow_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_flow_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_flow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_flow_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_flow_metrics ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.automation_flow_publications,
  public.automation_flow_activations,
  public.automation_flow_event_receipts,
  public.automation_flow_runs,
  public.automation_flow_outbox,
  public.automation_flow_metrics
FROM PUBLIC,anon,authenticated;

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE
  public.automation_flow_activations,
  public.automation_flow_event_receipts,
  public.automation_flow_runs,
  public.automation_flow_outbox,
  public.automation_flow_metrics
TO service_role;

-- Publications are INSERT-ONLY; immutable revisions cannot be overwritten
-- even by a service-role client. Trigger also blocks accidental UPDATE/DELETE.
GRANT SELECT,INSERT ON public.automation_flow_publications TO service_role;

COMMIT;
