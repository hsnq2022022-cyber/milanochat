\set ON_ERROR_STOP on
SET ROLE service_role;
SELECT public.flow_reserve_outbox_delivery(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3');
RESET ROLE;
