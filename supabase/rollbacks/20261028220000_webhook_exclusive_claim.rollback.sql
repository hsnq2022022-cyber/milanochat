-- Review-only rollback, independent explicit owner GO required.
-- Never remove claims after any customer event; they are durable dedupe records.
BEGIN;
DO $guard$
BEGIN
 IF to_regclass('public.automation_message_claims') IS NULL OR
  obj_description('public.automation_message_claims'::regclass) IS DISTINCT FROM
    'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM'
 THEN RAISE EXCEPTION 'Unrecognized claim relation: refusal'; END IF;
 IF EXISTS(SELECT 1 FROM public.automation_message_claims) THEN
  RAISE EXCEPTION 'Refusing to remove nonempty claims: duplicates could resend';
 END IF;
 IF obj_description(to_regprocedure(
  'public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)'),'pg_proc')
  IS DISTINCT FROM 'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM'
 THEN RAISE EXCEPTION 'Unexpected claim RPC owner: refusal'; END IF;
END
$guard$;
DROP FUNCTION public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean);
DROP TABLE public.automation_message_claims;
COMMIT;
