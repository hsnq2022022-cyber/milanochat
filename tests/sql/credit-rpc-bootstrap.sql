-- Disposable postgres CI only. Never execute in production.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE FUNCTION public.grant_credits(uuid,integer) RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
CREATE FUNCTION public.consume_reply(uuid,uuid) RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
GRANT EXECUTE ON FUNCTION public.grant_credits(uuid,integer) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_reply(uuid,uuid) TO PUBLIC, anon, authenticated;
