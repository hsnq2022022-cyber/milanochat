\set ON_ERROR_STOP on
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.tenants(
 id uuid PRIMARY KEY,credits_remaining integer NOT NULL DEFAULT 0,
 is_active boolean NOT NULL DEFAULT false);
CREATE TABLE public.payments(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants(id),
 provider text NOT NULL,amount integer NOT NULL,currency text NOT NULL,
 status text NOT NULL,credits_granted integer NOT NULL DEFAULT 0,
 paid_at timestamptz);
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT,UPDATE ON public.tenants,public.payments TO service_role;
INSERT INTO public.tenants(id,credits_remaining)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',10);
INSERT INTO public.payments(id,tenant_id,provider,amount,currency,status)
VALUES
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','wayl',35000,'IQD','pending_payment'),
 ('22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','wayl',85000,'IQD','pending_payment'),
 ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','wayl',225000,'IQD','pending_payment');
