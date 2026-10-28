-- Disposable SQL validation after applying proposed ACL migration.
\set ON_ERROR_STOP on
DO $test$
DECLARE f oid; s text;
BEGIN
 FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
  WHERE n.nspname='public' AND p.proname IN('create_widget','handle_new_human_message')
 LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR
     has_function_privilege('authenticated',f,'EXECUTE') OR
     NOT has_function_privilege('service_role',f,'EXECUTE')
  THEN RAISE EXCEPTION 'LEGACY_RPC_ACL_FAILED'; END IF;
 END LOOP;
 SELECT array_to_string(proconfig,',') INTO s FROM pg_proc
  WHERE oid='public.create_widget(uuid,text)'::regprocedure;
 IF s IS DISTINCT FROM 'search_path=pg_catalog, extensions' AND
    s IS DISTINCT FROM 'search_path=pg_catalog,extensions' THEN
  RAISE EXCEPTION 'WIDGET_SEARCH_PATH_WRONG %',s; END IF;
END
$test$;
SET ROLE service_role;
SELECT CASE WHEN length((public.create_widget(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,'secure test')).token)=64
 THEN 'PASS: service-role widget creation still generates token' ELSE
 pg_catalog.format('FAIL: widget token') END AS result;
INSERT INTO public.messages(conversation_id,direction,is_auto,kind,created_at)
VALUES('44444444-4444-4444-8444-444444444444','outbound',false,'answer',
 '2026-10-28T15:00:00Z');
SELECT CASE WHEN last_human_message_at='2026-10-28T15:00:00Z'::timestamptz
 THEN 'PASS: trigger still updates conversation without direct RPC EXECUTE'
 ELSE 'FAIL: human trigger did not update' END AS result
FROM public.conversations WHERE id='44444444-4444-4444-8444-444444444444';
RESET ROLE;
