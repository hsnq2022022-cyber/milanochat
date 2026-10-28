-- Disposable PG17 only. Mirrors live Widget table FK and direction/kind fields.
\set ON_ERROR_STOP on
CREATE TABLE public.widgets(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE
);
CREATE TABLE public.widget_sessions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 widget_id uuid NOT NULL REFERENCES public.widgets(id) ON DELETE CASCADE
);
CREATE TABLE public.widget_messages(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 widget_id uuid NOT NULL REFERENCES public.widgets(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES public.widget_sessions(id) ON DELETE CASCADE,
 direction text NOT NULL CHECK(direction IN('in','out')),kind text DEFAULT 'text'
);
INSERT INTO public.widgets VALUES
 ('a0000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('b0000000-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO public.widget_sessions VALUES
 ('a0000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a0000000-0000-4000-8000-000000000001'),
 ('b0000000-0000-4000-8000-000000000002','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','b0000000-0000-4000-8000-000000000001');
INSERT INTO public.widget_messages VALUES
 ('a0000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','out','answer'),
 ('a0000000-0000-4000-8000-000000000004','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','out','answer'),
 ('a0000000-0000-4000-8000-000000000005','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','in','customer'),
 ('a0000000-0000-4000-8000-000000000006','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','out','refusal'),
 ('a0000000-0000-4000-8000-000000000007','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','out','answer');
GRANT SELECT ON public.widgets,public.widget_sessions,public.widget_messages TO service_role;
