\set ON_ERROR_STOP on
SET ROLE service_role;
SELECT public.flow_publish_revision(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
 '11111111-1111-4111-8111-111111111111'::uuid,
 'instagram','concurrent',
 '99999999-9999-4999-8999-999999999999'::uuid,
 '{"version":3,"name":"concurrent","nodes":[{"id":"x","data":{"kind":"trigger"}}],"edges":[]}'::jsonb
);
