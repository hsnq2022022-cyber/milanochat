-- PROPOSAL ONLY. Separate production migration GO required.
-- Owner is tenants.user_id. Membership never replaces the owner.
BEGIN;
DO $guard$
BEGIN
 IF to_regclass('public.tenant_staff_memberships') IS NOT NULL OR
    to_regclass('public.tenant_conversation_assignments') IS NOT NULL OR
    to_regprocedure('public.flow_staff_can(uuid,uuid,text,uuid)') IS NOT NULL OR
    to_regclass('public.conversations_staff_scope_uq') IS NOT NULL
 THEN RAISE EXCEPTION 'Staff authorization objects already exist'; END IF;
 IF to_regclass('public.tenants') IS NULL OR
    to_regclass('public.conversations') IS NULL OR
    to_regclass('auth.users') IS NULL
 THEN RAISE EXCEPTION 'Required tenant, conversation or Supabase Auth schema missing'; END IF;
END $guard$;

-- Required to tie the conversation to its tenant at the FK level.
CREATE UNIQUE INDEX conversations_staff_scope_uq
 ON public.conversations(tenant_id,id);
COMMENT ON INDEX public.conversations_staff_scope_uq
 IS 'CREATED_BY_20261028227000_TENANT_STAFF';

CREATE TABLE public.tenant_staff_memberships(
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN('admin','agent','auditor')),
 status text NOT NULL DEFAULT 'invited' CHECK(status IN('invited','active','suspended')),
 invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id)
);
COMMENT ON TABLE public.tenant_staff_memberships IS
 'CREATED_BY_20261028227000_TENANT_STAFF';
CREATE INDEX tenant_staff_memberships_user_idx
 ON public.tenant_staff_memberships(user_id,status);
ALTER TABLE public.tenant_staff_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_staff_memberships FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.tenant_staff_memberships TO service_role;
-- A signed-in member can only see THEIR OWN role; no enumeration of others.
GRANT SELECT ON public.tenant_staff_memberships TO authenticated;
CREATE POLICY tenant_staff_self_read
 ON public.tenant_staff_memberships
 FOR SELECT TO authenticated
 USING (user_id=(SELECT auth.uid()));

CREATE TABLE public.tenant_conversation_assignments(
 tenant_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 user_id uuid NOT NULL,
 assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','released')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,conversation_id,user_id),
 FOREIGN KEY(tenant_id,conversation_id)
   REFERENCES public.conversations(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,user_id)
   REFERENCES public.tenant_staff_memberships(tenant_id,user_id) ON DELETE CASCADE
);
COMMENT ON TABLE public.tenant_conversation_assignments IS
 'CREATED_BY_20261028227000_TENANT_STAFF';
CREATE INDEX tenant_conversation_assignments_user_idx
 ON public.tenant_conversation_assignments(tenant_id,user_id,status);
ALTER TABLE public.tenant_conversation_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_conversation_assignments FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.tenant_conversation_assignments TO service_role;

-- Server-only read-only permission decision. MUST receive p_actor from
-- auth.getUser(access_token), NEVER an unverified request body field.
-- This RPC is NOT callable from the browser, even by authenticated users.
CREATE FUNCTION public.flow_staff_can(
 p_tenant uuid,p_actor uuid,p_action text,p_conversation uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER
SET search_path=''
AS $can$
DECLARE v_role text;
BEGIN
 IF p_tenant IS NULL OR p_actor IS NULL OR
    p_action IS NULL OR p_action NOT IN(
      'review_read','review_resolve','reply','handoff','metrics',
      'member_invite','publish_flow','credit_manage'
    )
 THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.tenants t
   WHERE t.id=p_tenant AND t.user_id=p_actor)
 THEN RETURN true; END IF;
 SELECT m.role INTO v_role
 FROM public.tenant_staff_memberships m
 WHERE m.tenant_id=p_tenant AND m.user_id=p_actor AND m.status='active';
 IF NOT FOUND THEN RETURN false; END IF;
 IF v_role='admin' THEN
   RETURN p_action IN ('review_read','review_resolve','reply','handoff',
                      'metrics','member_invite');
 END IF;
 IF v_role='auditor' THEN RETURN p_action='metrics'; END IF;
 IF v_role='agent' AND p_action IN('review_read','reply','handoff')
    AND p_conversation IS NOT NULL THEN
  RETURN EXISTS(
    SELECT 1 FROM public.tenant_conversation_assignments a
    WHERE a.tenant_id=p_tenant AND a.conversation_id=p_conversation
      AND a.user_id=p_actor AND a.status='active'
  );
 END IF;
 RETURN false;
END $can$;
COMMENT ON FUNCTION public.flow_staff_can(uuid,uuid,text,uuid)
 IS 'CREATED_BY_20261028227000_TENANT_STAFF';
REVOKE ALL ON FUNCTION public.flow_staff_can(uuid,uuid,text,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_staff_can(uuid,uuid,text,uuid)
 TO service_role;
COMMIT;
