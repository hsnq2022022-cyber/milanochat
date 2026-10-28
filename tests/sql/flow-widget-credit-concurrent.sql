\set ON_ERROR_STOP on
SET ROLE service_role;
SELECT public.consume_widget_reply(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
 'a0000000-0000-4000-8000-000000000007'::uuid);
RESET ROLE;
