-- Reviewed against live database 2026-10-26.
-- Credit-related SECURITY DEFINER RPCs must not be callable with public API keys.
-- Payment webhooks and the active milan-api use server-side service_role clients.
-- Do not deploy without verifying any other external callers.
BEGIN;

REVOKE EXECUTE ON FUNCTION public.grant_credits(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_credits(uuid, integer)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.consume_reply(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_reply(uuid, uuid)
  TO service_role;

COMMIT;

-- Post-apply verification (read-only):
-- select has_function_privilege('anon', 'public.grant_credits(uuid,integer)', 'EXECUTE'),
--        has_function_privilege('authenticated', 'public.grant_credits(uuid,integer)', 'EXECUTE'),
--        has_function_privilege('service_role', 'public.grant_credits(uuid,integer)', 'EXECUTE');
