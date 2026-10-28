-- Disposable PostgreSQL 17 regressions. All UUIDs fake.
\set ON_ERROR_STOP on
SET ROLE service_role;
DO $regression$
DECLARE
 a uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 b uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 account_a uuid:='11111111-1111-4111-8111-111111111111';
 account_b uuid:='22222222-2222-4222-8222-222222222222';
 conv_a uuid:='44444444-4444-4444-8444-444444444444';
 conv_b uuid:='55555555-5555-4555-8555-555555555555';
 incoming1 uuid:='77777777-7777-4777-8777-777777777771';
 incoming2 uuid:='77777777-7777-4777-8777-777777777772';
 incoming_b uuid:='77777777-7777-4777-8777-777777777773';
 receipt record;
BEGIN
 -- OFF: server claims LEGACY even if caller reports engine_ready=true.
 SELECT * INTO receipt FROM public.flow_claim_inbound(
   a,account_a,'instagram','meta-a1',conv_a,incoming1,true);
 IF receipt.acquired IS DISTINCT FROM true OR receipt.route<>'legacy_ai'
 THEN RAISE EXCEPTION 'OFF_SWITCH_DID_NOT_FALL_BACK';END IF;
 -- Redelivery: never acquire same event twice.
 SELECT * INTO receipt FROM public.flow_claim_inbound(
   a,account_a,'instagram','meta-a1',conv_a,incoming1,true);
 IF receipt.acquired IS DISTINCT FROM false OR receipt.route<>'legacy_ai'
 THEN RAISE EXCEPTION 'DUPLICATE_RECLAIMED';END IF;
 -- Ownership validated against inbound message and real account.
 IF EXISTS(SELECT 1 FROM public.flow_claim_inbound(
   b,account_a,'instagram','meta-a1',conv_a,incoming1,false))
 THEN RAISE EXCEPTION 'CROSS_TENANT_CLAIM';END IF;
 IF EXISTS(SELECT 1 FROM public.flow_claim_inbound(
   a,account_a,'instagram','meta-wrong',conv_a,incoming1,false))
 THEN RAISE EXCEPTION 'SPOOFED_PROVIDER_EVENT';END IF;
 -- Arm both flags in synthetic PG only. Engine failed -> LEGACY.
 UPDATE public.automation_flow_global_switch SET enabled=true WHERE singleton;
 INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only)
 VALUES(a,true,true),(b,true,true);
 SELECT * INTO receipt FROM public.flow_claim_inbound(
   a,account_a,'instagram','meta-a2',conv_a,incoming2,false);
 IF receipt.acquired IS DISTINCT FROM true OR receipt.route<>'legacy_ai'
 THEN RAISE EXCEPTION 'ENGINE_FAILURE_DID_NOT_FALL_BACK';END IF;

 -- A synthetic valid active flow for B: route FLOW only if engine was ready.
 INSERT INTO public.automation_flow_publications(
 tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
 VALUES(b,'simple',1,account_b,'facebook',
 '{"version":3,"name":"test","nodes":[],"edges":[]}'::jsonb,
 '88888888-8888-4888-8888-888888888888');
 INSERT INTO public.automation_flow_activations(
 tenant_id,channel_account_id,platform,flow_key,revision,is_active)
 VALUES(b,account_b,'facebook','simple',1,true);
 SELECT * INTO receipt FROM public.flow_claim_inbound(
   b,account_b,'facebook','meta-b1',conv_b,incoming_b,true);
 IF receipt.acquired IS DISTINCT FROM true OR receipt.route<>'flow'
 THEN RAISE EXCEPTION 'ELIGIBLE_FLOW_NOT_CHOSEN';END IF;

 -- Simulated one provider reply and one idempotent post-delivery debit.
 SELECT * INTO receipt FROM public.flow_claim_inbound(
   a,account_a,'instagram','meta-a1',conv_a,incoming1,false);
 IF receipt.acquired IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'DUPLICATE_ATTEMPTED_SEND';END IF;
 SELECT outgoing_message_id INTO receipt.outgoing_message_id
 FROM public.automation_message_claims WHERE tenant_id=a AND provider_event_id='meta-a1';
 INSERT INTO public.messages(id,tenant_id,conversation_id,direction,kind,is_auto)
 VALUES(receipt.outgoing_message_id,a,conv_a,'out','answer',true);
 IF public.consume_reply(a,receipt.outgoing_message_id) IS DISTINCT FROM 4
 THEN RAISE EXCEPTION 'FIRST_REPLY_NOT_BILLED_ONCE';END IF;
 IF public.consume_reply(a,receipt.outgoing_message_id) IS DISTINCT FROM -2
 THEN RAISE EXCEPTION 'RETRY_DOUBLE_DEBIT';END IF;
 IF (SELECT count(*) FROM public.reply_ledger WHERE message_id=receipt.outgoing_message_id)<>1 OR
   (SELECT credits_remaining FROM public.tenants WHERE id=a)<>4
 THEN RAISE EXCEPTION 'LEDGER_OR_CREDIT_COUNT_WRONG'; END IF;
 IF EXISTS(SELECT 1 FROM public.automation_message_claims WHERE route NOT IN ('legacy_ai','flow'))
 THEN RAISE EXCEPTION 'UNEXPECTED_ROUTE'; END IF;
END
$regression$;
RESET ROLE;
DO $permission$
BEGIN
 IF has_function_privilege('anon','public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)','EXECUTE')
 OR has_function_privilege('authenticated','public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)','EXECUTE')
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.automation_message_claims'::regclass)
 THEN RAISE EXCEPTION 'CLAIM_RPC_PUBLICLY_EXPOSED';END IF;
END
$permission$;
SELECT 'PASS: OFF=legacy, engine-failure=legacy, duplicate blocked, forged owner refused, flow only when armed, one outgoing and one debit' AS result;
