-- Verify the migration has removed effective EXECUTE privileges from both web roles.
-- PostgreSQL defaults grant EXECUTE to PUBLIC; both grants must be revoked.
DO $$
DECLARE fname text;
BEGIN
  FOREACH fname IN ARRAY ARRAY['public.grant_credits(uuid,integer)','public.consume_reply(uuid,uuid)'] LOOP
    IF has_function_privilege('anon',fname,'EXECUTE') THEN
      RAISE EXCEPTION '% callable by anon',fname;
    END IF;
    IF has_function_privilege('authenticated',fname,'EXECUTE') THEN
      RAISE EXCEPTION '% callable by authenticated',fname;
    END IF;
    IF NOT has_function_privilege('service_role',fname,'EXECUTE') THEN
      RAISE EXCEPTION '% NOT callable by service_role',fname;
    END IF;
  END LOOP;
END $$;
SELECT 'PASS: anon and authenticated denied, service_role allowed' AS result;
