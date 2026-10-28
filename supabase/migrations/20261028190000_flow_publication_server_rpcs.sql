-- REVIEW ONLY: requires a separate owner GO for production Supabase.
-- Depends on 20261028180000_flow_runtime_tenant_bound.sql (NOT installed).
-- No changes to existing customers, conversations, credits or AI messaging.
-- Server-only functions. NEVER grant EXECUTE to anon/authenticated/PUBLIC.
BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.automation_flow_publications') IS NULL OR
     to_regclass('public.automation_flow_activations') IS NULL OR
     to_regclass('public.automation_flow_global_switch') IS NULL OR
     to_regclass('public.automation_flow_tenant_switches') IS NULL THEN
    RAISE EXCEPTION 'Required flow tables are missing; apply separately approved runtime migration first';
  END IF;

  IF to_regprocedure('public.flow_publish_revision(uuid,uuid,text,text,uuid,jsonb)') IS NOT NULL
    OR to_regprocedure('public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid)') IS NOT NULL
    OR to_regprocedure('public.flow_deactivate_revision(uuid,uuid,text,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Unrecognized publication RPC already exists; refusing overwrite';
  END IF;
END
$preflight$;

CREATE FUNCTION public.flow_publish_revision(
  p_tenant_id uuid,
  p_account_id uuid,
  p_platform text,
  p_flow_key text,
  p_actor_id uuid,
  p_document jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $publish$
DECLARE
  v_revision bigint;
  v_existing_account uuid;
BEGIN
  IF p_tenant_id IS NULL OR p_account_id IS NULL
    OR p_actor_id IS NULL OR p_platform IS NULL
    OR p_flow_key IS NULL OR p_flow_key !~ '^[A-Za-z0-9_-]{1,128}$'
    OR p_document IS NULL OR jsonb_typeof(p_document) IS DISTINCT FROM 'object'
    OR p_document->>'version' IS DISTINCT FROM '3'
    OR jsonb_typeof(p_document->'nodes') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_document->'edges') IS DISTINCT FROM 'array'
    OR octet_length(p_document::text)>4194304
  THEN RETURN NULL; END IF;

  -- Lock owner row BEFORE revision allocation, so parallel publishes cannot
  -- select the same MAX(revision)+1. This is a trusted service-role RPC.
  PERFORM 1 FROM public.tenants t
    WHERE t.id=p_tenant_id AND t.user_id=p_actor_id AND t.is_active
    FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.channel_accounts a
    WHERE a.id=p_account_id AND a.tenant_id=p_tenant_id
      AND a.platform=p_platform AND a.is_active IS TRUE
  ) THEN RETURN NULL; END IF;

  -- A flow key is bound to its original account/platform. A new revision
  -- cannot silently take over another Meta account of the same tenant.
  SELECT p.channel_account_id INTO v_existing_account
    FROM public.automation_flow_publications p
    WHERE p.tenant_id=p_tenant_id AND p.flow_key=p_flow_key
    LIMIT 1;
  IF v_existing_account IS NOT NULL AND
    (v_existing_account<>p_account_id OR EXISTS(
      SELECT 1 FROM public.automation_flow_publications p
      WHERE p.tenant_id=p_tenant_id AND p.flow_key=p_flow_key
        AND p.platform<>p_platform
    ))
  THEN RETURN NULL; END IF;

  SELECT COALESCE(MAX(p.revision),0)+1 INTO v_revision
  FROM public.automation_flow_publications p
  WHERE p.tenant_id=p_tenant_id AND p.flow_key=p_flow_key;

  INSERT INTO public.automation_flow_publications
  (tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
  VALUES(p_tenant_id,p_flow_key,v_revision,p_account_id,p_platform,p_document,p_actor_id);
  RETURN v_revision;
END
$publish$;

CREATE FUNCTION public.flow_activate_revision(
  p_tenant_id uuid,
  p_account_id uuid,
  p_platform text,
  p_flow_key text,
  p_revision bigint,
  p_actor_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $activate$
BEGIN
  IF p_tenant_id IS NULL OR p_actor_id IS NULL OR p_account_id IS NULL OR
     p_revision IS NULL OR p_revision<1 OR p_flow_key IS NULL
  THEN RETURN FALSE; END IF;

  -- Serialize with any update to the global kill switch (row lock). Without
  -- both explicit ON flags and a test-only tenant, activate is impossible.
  PERFORM 1 FROM public.automation_flow_global_switch s
  WHERE s.singleton AND s.enabled FOR SHARE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  PERFORM 1 FROM public.automation_flow_tenant_switches s
  WHERE s.tenant_id=p_tenant_id AND s.enabled AND s.test_only FOR SHARE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenants t
      JOIN public.channel_accounts a ON a.tenant_id=t.id
    WHERE t.id=p_tenant_id AND t.user_id=p_actor_id AND t.is_active
      AND a.id=p_account_id AND a.platform=p_platform
      AND a.is_active IS TRUE AND a.agent_enabled IS TRUE
      AND a.auto_reply IS TRUE
  ) THEN RETURN FALSE; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.automation_flow_publications p
    WHERE p.tenant_id=p_tenant_id AND p.channel_account_id=p_account_id
      AND p.platform=p_platform AND p.flow_key=p_flow_key
      AND p.revision=p_revision
  ) THEN RETURN FALSE; END IF;

  INSERT INTO public.automation_flow_activations
    (tenant_id,channel_account_id,platform,flow_key,revision,is_active,activated_at)
  VALUES(p_tenant_id,p_account_id,p_platform,p_flow_key,p_revision,TRUE,now())
  ON CONFLICT(tenant_id,channel_account_id,platform,flow_key)
  DO UPDATE SET revision=EXCLUDED.revision,is_active=TRUE,
    activated_at=now(),updated_at=now();

  RETURN TRUE;
END
$activate$;

-- Deactivation must remain possible after token loss, account suspension,
-- revoked canary approval, or either kill switch going OFF.
CREATE FUNCTION public.flow_deactivate_revision(
  p_tenant_id uuid,
  p_account_id uuid,
  p_platform text,
  p_flow_key text,
  p_actor_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $deactivate$
BEGIN
  IF p_tenant_id IS NULL OR p_actor_id IS NULL OR p_account_id IS NULL
    OR p_flow_key IS NULL THEN RETURN FALSE; END IF;

  IF NOT EXISTS(SELECT 1 FROM public.tenants t
    WHERE t.id=p_tenant_id AND t.user_id=p_actor_id) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.automation_flow_activations a
  SET is_active=FALSE,updated_at=now()
  WHERE a.tenant_id=p_tenant_id AND a.channel_account_id=p_account_id
    AND a.platform=p_platform AND a.flow_key=p_flow_key;
  RETURN FOUND;
END
$deactivate$;

REVOKE ALL ON FUNCTION public.flow_publish_revision(uuid,uuid,text,text,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_deactivate_revision(uuid,uuid,text,text,uuid)
  FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION public.flow_publish_revision(uuid,uuid,text,text,uuid,jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_deactivate_revision(uuid,uuid,text,text,uuid)
  TO service_role;

COMMIT;
