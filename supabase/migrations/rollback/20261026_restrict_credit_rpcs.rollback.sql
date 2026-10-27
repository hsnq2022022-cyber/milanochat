-- EMERGENCY ROLLBACK ONLY. Requires explicit owner GO.
-- WARNING: restores historically broad RPC execution permissions.
-- Do NOT apply unless necessary to restore billing; users may then abuse grant_credits.
BEGIN;
GRANT EXECUTE ON FUNCTION public.grant_credits(uuid,integer) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_reply(uuid,uuid) TO PUBLIC, anon, authenticated;
COMMIT;
