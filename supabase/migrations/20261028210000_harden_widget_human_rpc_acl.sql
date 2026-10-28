-- REVIEW ONLY — do not apply to production without a dedicated owner GO.
-- Live preflight 2026-10-28:
-- create_widget(uuid,text) is SECURITY DEFINER, search_path=public,
-- uses extensions.gen_random_bytes, currently PUBLIC/anon/authenticated EXECUTE.
-- handle_new_human_message() is SECURITY DEFINER trigger on public.messages,
-- search_path unset, currently PUBLIC/anon/authenticated EXECUTE.
-- Existing service APIs use direct public.widgets INSERT, not this RPC.
-- Preserves bodies, return types, trigger attachments and existing rows.
BEGIN;
DO $preflight$
DECLARE
 w oid:=to_regprocedure('public.create_widget(uuid,text)');
 h oid:=to_regprocedure('public.handle_new_human_message()');
BEGIN
 IF w IS NULL OR h IS NULL THEN
  RAISE EXCEPTION 'One of the targeted functions is missing; refusing change';
 END IF;
 IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=w) OR
    NOT (SELECT prosecdef FROM pg_proc WHERE oid=h) THEN
  RAISE EXCEPTION 'Unexpected function security mode; refusing change';
 END IF;
 IF position('gen_random_bytes' in pg_get_functiondef(w))=0 OR
    position('public.widgets' in pg_get_functiondef(w))=0 OR
    position('public.conversations' in pg_get_functiondef(h))=0 THEN
  RAISE EXCEPTION 'Function body differs from reviewed production version';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n
     ON p.pronamespace=n.oid WHERE p.proname='gen_random_bytes'
     AND n.nspname='extensions' AND pg_get_function_identity_arguments(p.oid)='integer') THEN
  RAISE EXCEPTION 'extensions.gen_random_bytes dependency missing';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t
  WHERE t.tgfoid=h AND t.tgrelid='public.messages'::regclass
    AND t.tgname='trigger_update_last_human_message'
    AND NOT t.tgisinternal) THEN
  RAISE EXCEPTION 'Expected human message trigger missing';
 END IF;
END
$preflight$;

-- Keep SECURITY DEFINER but prevent schema hijacking. pg_catalog owns
-- encode; extensions owns gen_random_bytes; both are non-writable by users.
ALTER FUNCTION public.create_widget(uuid,text)
 SET search_path TO pg_catalog,extensions;
ALTER FUNCTION public.handle_new_human_message()
 SET search_path TO pg_catalog;
REVOKE ALL ON FUNCTION public.create_widget(uuid,text)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.handle_new_human_message()
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_widget(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_human_message() TO service_role;
COMMIT;
