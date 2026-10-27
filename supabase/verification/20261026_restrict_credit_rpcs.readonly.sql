-- Read-only verification; execute using owner SQL Editor and share results.
select p.oid::regprocedure::text as rpc,
       p.prosecdef as security_definer,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
       has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('grant_credits','consume_reply')
order by 1;
-- Expected after lockdown: anon=false, authenticated=false, service_role=true.
