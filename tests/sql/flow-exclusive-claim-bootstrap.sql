-- Disposable PG17 only; actual production table names and FK shapes.
\set ON_ERROR_STOP on
ALTER TABLE public.tenants ADD COLUMN credits_remaining integer NOT NULL DEFAULT 5;
CREATE TABLE public.messages(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id),
 conversation_id uuid NOT NULL REFERENCES public.conversations(id),
 direction text NOT NULL CHECK(direction IN('in','out')),
 wa_message_id text,
 kind text NOT NULL DEFAULT 'customer',
 is_auto boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX idx_messages_wa_message_id ON public.messages(wa_message_id)
 WHERE wa_message_id IS NOT NULL;
CREATE TABLE public.reply_ledger(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id),
 message_id uuid NOT NULL UNIQUE REFERENCES public.messages(id)
);
GRANT SELECT,INSERT,UPDATE ON public.tenants,public.channel_accounts,
 public.conversations,public.messages,public.reply_ledger TO service_role;
GRANT SELECT ON public.automation_flow_publications,public.automation_flow_activations TO service_role;
INSERT INTO public.messages(id,tenant_id,conversation_id,direction,wa_message_id) VALUES
 ('77777777-7777-4777-8777-777777777771',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','44444444-4444-4444-8444-444444444444','in','meta-a1'),
 ('77777777-7777-4777-8777-777777777772',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','44444444-4444-4444-8444-444444444444','in','meta-a2'),
 ('77777777-7777-4777-8777-777777777773',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','55555555-5555-4555-8555-555555555555','in','meta-b1');
