\set ON_ERROR_STOP on
SET ROLE service_role;
DO $verify$
DECLARE id uuid:='11111111-1111-4111-8111-111111111111';
 tid uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
BEGIN
 IF public.wayl_grant_topup_once(id,35000) <> 'applied'
 THEN RAISE EXCEPTION 'paid event failed to grant';END IF;
 IF public.wayl_grant_topup_once(id,35000) <> 'already_applied'
 THEN RAISE EXCEPTION 'duplicate payment was not rejected';END IF;
 IF (SELECT credits_remaining FROM public.tenants WHERE id=tid)<>1010
 THEN RAISE EXCEPTION 'wrong credits after paid event';END IF;
 IF (SELECT credits_granted FROM public.payments WHERE id=id)<>1000
 THEN RAISE EXCEPTION 'payment ledger not persisted';END IF;
 IF public.wayl_grant_topup_once('22222222-2222-4222-8222-222222222222',35000)<>'amount_mismatch'
 THEN RAISE EXCEPTION 'wrong paid amount accepted';END IF;
 IF (SELECT credits_remaining FROM public.tenants WHERE id=tid)<>1010
 THEN RAISE EXCEPTION 'amount mismatch changed credits';END IF;
 IF public.wayl_grant_topup_once('22222222-2222-4222-8222-222222222222',85000)<>'applied'
 THEN RAISE EXCEPTION 'valid second payment not paid';END IF;
 IF (SELECT credits_remaining FROM public.tenants WHERE id=tid)<>4010
 THEN RAISE EXCEPTION 'second payment wrong credit';END IF;
 UPDATE public.payments SET status='refunded'
 WHERE id='33333333-3333-4333-8333-333333333333';
 IF public.wayl_grant_topup_once('33333333-3333-4333-8333-333333333333',225000)<>'manual_review'
 THEN RAISE EXCEPTION 'refund state was improperly credited';END IF;
 IF (SELECT credits_remaining FROM public.tenants WHERE id=tid)<>4010
 THEN RAISE EXCEPTION 'refund changed balance';END IF;
END $verify$;
RESET ROLE;
DO $acl$
BEGIN
 IF has_function_privilege('anon','public.wayl_grant_topup_once(uuid,integer)','EXECUTE')
 OR has_function_privilege('authenticated','public.wayl_grant_topup_once(uuid,integer)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.wayl_grant_topup_once(uuid,integer)','EXECUTE')
 THEN RAISE EXCEPTION 'Wayl RPC is publicly callable';END IF;
END $acl$;
SELECT 'PASS Wayl atomic grant, duplicate, mismatch, refunded, ACL' AS result;
