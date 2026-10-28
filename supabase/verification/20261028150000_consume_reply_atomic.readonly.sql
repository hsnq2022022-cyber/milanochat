-- READ-ONLY verification for migration 20261028150000_consume_reply_atomic.sql.
-- Produces only schema/privilege facts; never reads private message bodies.
SELECT
 p.oid::regprocedure::text AS function_signature,
 p.prosecdef AS security_definer,
 position('FOR UPDATE' in upper(pg_get_functiondef(p.oid))) > 0
   AS locks_tenant_before_debit,
 position('m.direction = ''out''' in pg_get_functiondef(p.oid)) > 0
   AS checks_outgoing_message,
 position('RETURN -3' in upper(pg_get_functiondef(p.oid))) > 0
   AS validates_identity,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon_can_run,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_can_run,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_can_run
FROM pg_proc p
WHERE p.oid=to_regprocedure('public.consume_reply(uuid,uuid)');

-- A successful release should show: true/true/true for the three guards,
-- false/false/true for anon/authenticated/service_role.
-- A zero-row result indicates the RPC is not installed.
