-- Demonstrate the precise ghost-ledger bug in the CONFIRMED old RPC.
\set ON_ERROR_STOP on
SET ROLE service_role;
DO $test$
DECLARE t uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        m uuid:='10000000-0000-4000-8000-000000000001';
        result integer;
BEGIN
 result:=public.consume_reply(t,m);
 IF result IS DISTINCT FROM -1 THEN
   RAISE EXCEPTION 'Old RPC no-credit result unexpectedly changed: %',result;
 END IF;
 IF (SELECT COUNT(*) FROM public.reply_ledger WHERE message_id=m)<>1 THEN
   RAISE EXCEPTION 'Expected a ghost ledger from the old RPC, not reproduced';
 END IF;
 IF public.consume_reply(t,m) IS DISTINCT FROM -2 THEN
   RAISE EXCEPTION 'Old RPC should wrongly treat no-credit retry as already charged';
 END IF;
END
$test$;
RESET ROLE;
-- Clean synthetic ghost ledger before testing the corrected RPC.
DELETE FROM public.reply_ledger WHERE message_id='10000000-0000-4000-8000-000000000001';
SELECT 'REPRODUCED: original RPC writes ghost ledger on no credit' AS evidence;
