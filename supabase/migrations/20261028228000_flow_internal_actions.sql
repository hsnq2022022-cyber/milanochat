-- REVIEW ONLY: internal tag and staff inbox effects (no external sends).
-- Depends on proposed staff membership/assignment migration 20261028227000.
BEGIN;
DO $guard$
BEGIN
 IF to_regclass('public.flow_conversation_tags') IS NOT NULL OR
    to_regclass('public.flow_staff_notifications') IS NOT NULL OR
    to_regprocedure('public.flow_apply_internal_effect(uuid,uuid)') IS NOT NULL
 THEN RAISE EXCEPTION 'Internal effects already installed';END IF;
 IF to_regclass('public.tenant_staff_memberships') IS NULL OR
    to_regclass('public.tenant_conversation_assignments') IS NULL OR
    to_regclass('public.automation_flow_outbox') IS NULL
 THEN RAISE EXCEPTION 'Staff and flow runtime prerequisites missing';END IF;
END $guard$;

CREATE TABLE public.flow_conversation_tags(
 tenant_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 tag text NOT NULL CHECK(length(tag) BETWEEN 1 AND 64 AND tag ~ '^[[:alnum:]_ -]+$'),
 created_by_outbox uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,conversation_id,tag),
 FOREIGN KEY(tenant_id,conversation_id)
  REFERENCES public.conversations(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,created_by_outbox)
  REFERENCES public.automation_flow_outbox(tenant_id,id)
);
COMMENT ON TABLE public.flow_conversation_tags
 IS 'CREATED_BY_20261028228000_INTERNAL_ACTIONS';
ALTER TABLE public.flow_conversation_tags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.flow_conversation_tags FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.flow_conversation_tags TO service_role;

CREATE TABLE public.flow_staff_notifications(
 tenant_id uuid NOT NULL,
 outbox_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 recipient_user_id uuid NOT NULL REFERENCES auth.users(id),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 500),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','read')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,outbox_id),
 FOREIGN KEY(tenant_id,conversation_id)
   REFERENCES public.conversations(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,outbox_id)
   REFERENCES public.automation_flow_outbox(tenant_id,id) ON DELETE CASCADE
);
COMMENT ON TABLE public.flow_staff_notifications
 IS 'CREATED_BY_20261028228000_INTERNAL_ACTIONS';
CREATE INDEX flow_staff_notifications_recipient_idx
 ON public.flow_staff_notifications(tenant_id,recipient_user_id,created_at DESC);
ALTER TABLE public.flow_staff_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.flow_staff_notifications FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.flow_staff_notifications TO service_role;

-- One trusted transactional statement; no network, Meta send or credit changes.
CREATE FUNCTION public.flow_apply_internal_effect(p_tenant uuid,p_outbox uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $apply$
DECLARE row_data record; tag_value text; body_value text; recipient uuid;
BEGIN
 IF p_tenant IS NULL OR p_outbox IS NULL THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch
   WHERE singleton AND enabled)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches
   WHERE tenant_id=p_tenant AND enabled AND test_only)
 THEN RETURN false;END IF;
 SELECT o.effect_kind,o.payload,r.conversation_id,t.user_id AS owner_id
 INTO row_data FROM public.automation_flow_outbox o
 JOIN public.automation_flow_runs r
  ON r.tenant_id=o.tenant_id AND r.id=o.run_id
 JOIN public.tenants t ON t.id=r.tenant_id
 JOIN public.automation_flow_activations a ON a.tenant_id=r.tenant_id
  AND a.channel_account_id=r.channel_account_id AND a.platform=r.platform
  AND a.flow_key=r.flow_key AND a.revision=r.publication_revision AND a.is_active
 WHERE o.tenant_id=p_tenant AND o.id=p_outbox
  AND o.delivery_status='pending'
  AND o.effect_kind IN ('tag','untag','staff_notification')
 FOR UPDATE OF o SKIP LOCKED;
 IF NOT FOUND OR row_data.payload->>'kind' IS DISTINCT FROM row_data.effect_kind
 THEN RETURN false;END IF;
 IF row_data.effect_kind IN('tag','untag') THEN
  tag_value:=row_data.payload->>'tag';
  IF tag_value IS NULL OR length(tag_value) NOT BETWEEN 1 AND 64 OR
     tag_value !~ '^[[:alnum:]_ -]+$' THEN RETURN false;END IF;
  IF row_data.effect_kind='tag' THEN
   INSERT INTO public.flow_conversation_tags(
    tenant_id,conversation_id,tag,created_by_outbox)
   VALUES(p_tenant,row_data.conversation_id,tag_value,p_outbox)
   ON CONFLICT DO NOTHING;
  ELSE
   DELETE FROM public.flow_conversation_tags
    WHERE tenant_id=p_tenant AND conversation_id=row_data.conversation_id
     AND tag=tag_value;
  END IF;
 ELSE
  body_value:=row_data.payload->>'text';
  IF body_value IS NULL OR length(body_value) NOT BETWEEN 1 AND 500
  THEN RETURN false;END IF;
  -- Active assigned agent first, otherwise the tenant owner. No broadcast.
  SELECT a.user_id INTO recipient FROM public.tenant_conversation_assignments a
  JOIN public.tenant_staff_memberships m ON m.tenant_id=a.tenant_id
   AND m.user_id=a.user_id AND m.status='active'
  WHERE a.tenant_id=p_tenant AND a.conversation_id=row_data.conversation_id
    AND a.status='active' AND m.role IN('agent','admin')
  ORDER BY a.created_at,a.user_id LIMIT 1;
  recipient:=coalesce(recipient,row_data.owner_id);
  IF recipient IS NULL THEN RETURN false;END IF;
  INSERT INTO public.flow_staff_notifications(
   tenant_id,outbox_id,conversation_id,recipient_user_id,body)
  VALUES(p_tenant,p_outbox,row_data.conversation_id,recipient,body_value)
  ON CONFLICT DO NOTHING;
 END IF;
 UPDATE public.automation_flow_outbox SET delivery_status='settled'
 WHERE tenant_id=p_tenant AND id=p_outbox AND delivery_status='pending';
 RETURN FOUND;
END $apply$;
COMMENT ON FUNCTION public.flow_apply_internal_effect(uuid,uuid)
 IS 'CREATED_BY_20261028228000_INTERNAL_ACTIONS';
REVOKE ALL ON FUNCTION public.flow_apply_internal_effect(uuid,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_apply_internal_effect(uuid,uuid)
 TO service_role;
COMMIT;
