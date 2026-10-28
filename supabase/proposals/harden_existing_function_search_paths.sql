-- Harden four pre-existing invoker routines without replacing their bodies.
-- All currently use unqualified public table identifiers or public vector operators.
-- Explicit trusted schema first and temporary schema last.
ALTER FUNCTION public.match_knowledge(uuid, vector, integer, double precision)
 SET search_path = public, pg_temp;
ALTER FUNCTION public.validate_widget_settings()
 SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_channel_platform()
 SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_agent_prompt()
 SET search_path = public, pg_temp;

DO $verify$
DECLARE
 n integer;
BEGIN
 SELECT count(*) INTO n FROM pg_proc
 WHERE pronamespace='public'::regnamespace AND
   proname IN ('match_knowledge','validate_widget_settings','sync_channel_platform','sync_agent_prompt')
   AND proconfig @> ARRAY['search_path=public, pg_temp'];
 IF n<>4 THEN
  RAISE EXCEPTION 'Not all four public routines have pinned search_path: %', n;
 END IF;
END $verify$;
