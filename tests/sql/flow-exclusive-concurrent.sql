\set ON_ERROR_STOP on
SET ROLE service_role;
SELECT acquired::text FROM public.flow_claim_inbound(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
 '11111111-1111-4111-8111-111111111111'::uuid,
 'instagram','meta-concurrent',
 '44444444-4444-4444-8444-444444444444'::uuid,
 '77777777-7777-4777-8777-777777777774'::uuid,false);
RESET ROLE;
