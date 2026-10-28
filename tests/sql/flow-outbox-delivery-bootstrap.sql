\set ON_ERROR_STOP on
INSERT INTO public.automation_flow_activations(
 tenant_id,channel_account_id,platform,flow_key,revision,is_active)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '11111111-1111-4111-8111-111111111111','instagram','phase4',1,true);
INSERT INTO public.automation_message_claims(
 tenant_id,channel_account_id,platform,provider_event_id,conversation_id,
 inbound_message_id,route)
VALUES(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '11111111-1111-4111-8111-111111111111','instagram','phase4-event',
 '44444444-4444-4444-8444-444444444444',
 '77777777-7777-4777-8777-777777777771','flow');
INSERT INTO public.automation_flow_outbox(
 tenant_id,id,run_id,idempotency_key,effect_kind,payload)
VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
 '77777777-7777-4777-8777-7777777777a4','flow-msg-1','message',
 '{"kind":"message","text":"First safe test text"}'::jsonb),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
 '77777777-7777-4777-8777-7777777777a4','flow-msg-2','message',
 '{"kind":"message","text":"Second safe test text"}'::jsonb),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
 '77777777-7777-4777-8777-7777777777a4','flow-msg-3','message',
 '{"kind":"message","text":"Concurrent safe test text"}'::jsonb);
