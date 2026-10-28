BEGIN;
DO $guard$
BEGIN
 IF to_regclass('public.flow_conversation_tags') IS NULL OR
    to_regclass('public.flow_staff_notifications') IS NULL OR
    obj_description('public.flow_staff_notifications'::regclass)
      IS DISTINCT FROM 'CREATED_BY_20261028228000_INTERNAL_ACTIONS'
 THEN RAISE EXCEPTION 'Internal effect tables not recognized';END IF;
 IF EXISTS(SELECT 1 FROM public.flow_conversation_tags)
 OR EXISTS(SELECT 1 FROM public.flow_staff_notifications)
 THEN RAISE EXCEPTION 'Cannot delete internal effect history';END IF;
END $guard$;
DROP FUNCTION public.flow_apply_internal_effect(uuid,uuid);
DROP TABLE public.flow_staff_notifications;
DROP TABLE public.flow_conversation_tags;
COMMIT;
