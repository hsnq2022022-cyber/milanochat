-- Disposable PostgreSQL 17 replica of the two observed production RPCs.
\set ON_ERROR_STOP on
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE TABLE public.widgets(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id),
 token text NOT NULL,
 name text NOT NULL
);
ALTER TABLE public.conversations ADD COLUMN last_human_message_at timestamptz;
CREATE TABLE public.messages(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conversation_id uuid REFERENCES public.conversations(id),
 direction text NOT NULL,is_auto boolean NOT NULL,kind text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION public.create_widget(p_tenant_id uuid,p_name text DEFAULT 'Website Widget')
 RETURNS public.widgets LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $$
DECLARE new_widget public.widgets;
BEGIN
 INSERT INTO public.widgets(tenant_id,token,name)
 VALUES(p_tenant_id,encode(gen_random_bytes(32),'hex'),p_name)
 RETURNING * INTO new_widget;
 RETURN new_widget;
END
$$;
CREATE FUNCTION public.handle_new_human_message()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
 IF NEW.direction='outbound' AND NEW.is_auto IS FALSE AND NEW.kind='answer' THEN
  UPDATE public.conversations SET last_human_message_at=NEW.created_at
  WHERE id=NEW.conversation_id;
 END IF;
 RETURN NEW;
END
$$;
CREATE TRIGGER trigger_update_last_human_message
AFTER INSERT ON public.messages FOR EACH ROW
EXECUTE FUNCTION public.handle_new_human_message();
GRANT EXECUTE ON FUNCTION public.create_widget(uuid,text) TO PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_human_message() TO PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.widgets,public.conversations TO service_role;
GRANT INSERT ON public.messages TO service_role;
