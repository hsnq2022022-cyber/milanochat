-- Separate GO required. Refuse removing any membership or assignments.
BEGIN;
DO $guard$
BEGIN
 IF to_regclass('public.tenant_staff_memberships') IS NULL OR
   obj_description('public.tenant_staff_memberships'::regclass)
   IS DISTINCT FROM 'CREATED_BY_20261028227000_TENANT_STAFF'
 OR to_regclass('public.tenant_conversation_assignments') IS NULL OR
   obj_description('public.tenant_conversation_assignments'::regclass)
   IS DISTINCT FROM 'CREATED_BY_20261028227000_TENANT_STAFF'
 THEN RAISE EXCEPTION 'Staff objects not recognized'; END IF;
 IF EXISTS(SELECT 1 FROM public.tenant_staff_memberships)
 OR EXISTS(SELECT 1 FROM public.tenant_conversation_assignments)
 THEN RAISE EXCEPTION 'Nonempty staff history: rollback refused'; END IF;
END $guard$;
DROP FUNCTION public.flow_staff_can(uuid,uuid,text,uuid);
DROP TABLE public.tenant_conversation_assignments;
DROP TABLE public.tenant_staff_memberships;
DROP INDEX public.conversations_staff_scope_uq;
COMMIT;
