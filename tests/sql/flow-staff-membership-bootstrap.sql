\set ON_ERROR_STOP on
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE SET search_path=''
AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
INSERT INTO auth.users(id) VALUES
 ('99999999-9999-4999-8999-999999999999'), -- owner A
 ('88888888-8888-4888-8888-888888888888'), -- owner B
 ('77777777-7777-4777-8777-777777777777'), -- agent A
 ('66666666-6666-4666-8666-666666666666'), -- admin A
 ('55555555-5555-4555-8555-555555555555'), -- auditor A
 ('44444444-4444-4444-8444-444444444444'); -- suspended A
ALTER TABLE public.tenants ADD COLUMN user_id uuid REFERENCES auth.users(id);
UPDATE public.tenants SET user_id=
  CASE WHEN id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' THEN
    '99999999-9999-4999-8999-999999999999'::uuid
   ELSE '88888888-8888-4888-8888-888888888888'::uuid END;
GRANT SELECT ON public.tenants TO service_role;
GRANT SELECT ON public.conversations TO service_role;
