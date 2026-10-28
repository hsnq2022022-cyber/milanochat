-- REVIEW ONLY. Additive schema: does not alter consume_reply or historical Widget answers.
BEGIN;
DO $guard$
BEGIN
 IF to_regclass('public.widget_reply_ledger') IS NOT NULL OR
    to_regprocedure('public.consume_widget_reply(uuid,uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'Widget credit schema already exists; refuse replacement';
 END IF;
 IF to_regclass('public.widget_messages') IS NULL OR to_regclass('public.widget_sessions') IS NULL OR
    to_regclass('public.widgets') IS NULL OR to_regclass('public.tenants') IS NULL THEN
  RAISE EXCEPTION 'Required Widget tables are absent';
 END IF;
END $guard$;
CREATE TABLE public.widget_reply_ledger(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 widget_message_id uuid NOT NULL UNIQUE REFERENCES public.widget_messages(id) ON DELETE RESTRICT,
 charged_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.widget_reply_ledger IS 'CREATED_BY_20261028223000_WIDGET_CREDIT_V2';
ALTER TABLE public.widget_reply_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.widget_reply_ledger FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.widget_reply_ledger TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.widget_reply_ledger_id_seq TO service_role;

CREATE FUNCTION public.consume_widget_reply(p_tenant_id uuid,p_widget_message_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $bill$
DECLARE remaining integer;
BEGIN
 IF p_tenant_id IS NULL OR p_widget_message_id IS NULL THEN RETURN -3; END IF;
 SELECT credits_remaining INTO remaining
 FROM public.tenants WHERE id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RETURN -3; END IF;
 IF NOT EXISTS(
  SELECT 1 FROM public.widget_messages m
   JOIN public.widget_sessions s ON s.id=m.session_id AND s.tenant_id=m.tenant_id
    AND s.widget_id=m.widget_id
   JOIN public.widgets w ON w.id=m.widget_id AND w.tenant_id=m.tenant_id
   WHERE m.id=p_widget_message_id AND m.tenant_id=p_tenant_id AND
    m.direction='out' AND m.kind='answer'
 ) THEN RETURN -3; END IF;
 IF EXISTS(SELECT 1 FROM public.widget_reply_ledger l
   WHERE l.widget_message_id=p_widget_message_id AND l.tenant_id=p_tenant_id)
 THEN RETURN -2; END IF;
 IF remaining<=0 THEN RETURN -1; END IF;
 UPDATE public.tenants SET credits_remaining=credits_remaining-1
 WHERE id=p_tenant_id AND credits_remaining>0
 RETURNING credits_remaining INTO remaining;
 IF NOT FOUND THEN RAISE EXCEPTION 'Credit changed despite locked tenant row'; END IF;
 INSERT INTO public.widget_reply_ledger(tenant_id,widget_message_id)
 VALUES(p_tenant_id,p_widget_message_id);
 RETURN remaining;
END $bill$;
COMMENT ON FUNCTION public.consume_widget_reply(uuid,uuid)
 IS 'CREATED_BY_20261028223000_WIDGET_CREDIT_V2';
REVOKE ALL ON FUNCTION public.consume_widget_reply(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consume_widget_reply(uuid,uuid) TO service_role;
COMMIT;
