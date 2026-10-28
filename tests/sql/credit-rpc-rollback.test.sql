-- DisposABLE test of the *explicitly unsafe* rollback; never run it in production by CI.
DO $$
DECLARE fname text;
BEGIN
  FOREACH fname IN ARRAY ARRAY['public.grant_credits(uuid,integer)','public.consume_reply(uuid,uuid)'] LOOP
    IF NOT has_function_privilege('anon',fname,'EXECUTE') THEN
      RAISE EXCEPTION '% rollback did not restore anon',fname;
    END IF;
    IF NOT has_function_privilege('authenticated',fname,'EXECUTE') THEN
      RAISE EXCEPTION '% rollback did not restore authenticated',fname;
    END IF;
    IF NOT has_function_privilege('service_role',fname,'EXECUTE') THEN
      RAISE EXCEPTION '% rollback lost service_role',fname;
    END IF;
  END LOOP;
END $$;
SELECT 'PASS: rollback restores legacy privilege state (UNSAFE ON PRODUCTION)' AS result;
