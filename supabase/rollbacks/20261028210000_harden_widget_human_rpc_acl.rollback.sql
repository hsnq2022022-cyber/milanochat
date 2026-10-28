-- REVIEW ONLY — rollback needs its own explicit production GO.
-- CAUTION: this intentionally restores the previous unsafe broad EXECUTE
-- privileges and original search paths; use only during a verified breakage.
BEGIN;
DO $guard$
BEGIN
 IF to_regprocedure('public.create_widget(uuid,text)') IS NULL OR
  to_regprocedure('public.handle_new_human_message()') IS NULL THEN
  RAISE EXCEPTION 'Expected functions missing; rollback refused';
 END IF;
END
$guard$;
ALTER FUNCTION public.create_widget(uuid,text) SET search_path TO public;
ALTER FUNCTION public.handle_new_human_message() RESET search_path;
GRANT EXECUTE ON FUNCTION public.create_widget(uuid,text)
 TO PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_human_message()
 TO PUBLIC,anon,authenticated,service_role;
COMMIT;
