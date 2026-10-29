\set ON_ERROR_STOP on
-- Production-approved flag is installed by a separate additive migration on live.
-- Reconstruct only in isolated disposable PostgreSQL test schema.
ALTER TABLE public.automation_flow_tenant_switches
 ADD COLUMN production_approved boolean NOT NULL DEFAULT false;
-- Fake tenant A, active flow, receipt, and sleeping run in disposable PG.
INSERT INTO public.automation_flow_publications(
 tenant_id,flow_key,revision,channel_account_id,platform,document,published_by)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','phase4',1,
 '11111111-1111-4111-8111-111111111111','instagram',
 '{"version":3,"name":"test","nodes":[],"edges":[]}'::jsonb,
 '88888888-8888-4888-8888-888888888888');
INSERT INTO public.automation_flow_event_receipts
(tenant_id,channel_account_id,platform,provider_event_id)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '11111111-1111-4111-8111-111111111111','instagram','phase4-event');
INSERT INTO public.automation_flow_runs(
 tenant_id,id,flow_key,publication_revision,channel_account_id,platform,
 conversation_id,provider_event_id,current_node_id,run_status)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-7777777777a4',
 'phase4',1,'11111111-1111-4111-8111-111111111111','instagram',
 '44444444-4444-4444-8444-444444444444','phase4-event','start','ready');
