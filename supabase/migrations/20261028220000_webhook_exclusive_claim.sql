-- REVIEW ONLY: stage 3 exclusive webhook claim. No production SQL without exact GO.
-- Depends on live flow switches/runtime and existing channel_accounts/messages tables.
BEGIN;
DO $guard$
BEGIN
 IF to_regclass('public.automation_message_claims') IS NOT NULL OR
    to_regprocedure('public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)') IS NOT NULL
 THEN RAISE EXCEPTION 'Existing message claim object; refuse blind replacement'; END IF;
 IF to_regclass('public.automation_flow_global_switch') IS NULL OR
    to_regclass('public.automation_flow_activations') IS NULL OR
    to_regclass('public.messages') IS NULL OR
    to_regclass('public.conversations') IS NULL
 THEN RAISE EXCEPTION 'Required runtime or legacy messaging schema absent'; END IF;
END
$guard$;

CREATE TABLE public.automation_message_claims (
 id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 channel_account_id uuid NOT NULL,
 platform text NOT NULL CHECK(platform IN ('instagram','facebook','whatsapp')),
 provider_event_id text NOT NULL CHECK(length(provider_event_id) BETWEEN 1 AND 256),
 conversation_id uuid NOT NULL REFERENCES public.conversations(id),
 inbound_message_id uuid NOT NULL UNIQUE REFERENCES public.messages(id),
 route text NOT NULL CHECK(route IN ('legacy_ai','flow')),
 outgoing_message_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 claimed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,channel_account_id,platform,provider_event_id),
 FOREIGN KEY(tenant_id,channel_account_id,platform)
   REFERENCES public.channel_accounts(tenant_id,id,platform)
);
COMMENT ON TABLE public.automation_message_claims
 IS 'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM';
ALTER TABLE public.automation_message_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.automation_message_claims FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.automation_message_claims TO service_role;

CREATE FUNCTION public.flow_claim_inbound(
 p_tenant_id uuid,
 p_account_id uuid,
 p_platform text,
 p_provider_event_id text,
 p_conversation_id uuid,
 p_inbound_message_id uuid,
 p_engine_ready boolean DEFAULT false
) RETURNS TABLE(acquired boolean,route text,claim_id uuid,outgoing_message_id uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $claim$
DECLARE v_id uuid;v_route text;v_outgoing uuid;
BEGIN
 IF p_tenant_id IS NULL OR p_account_id IS NULL OR p_conversation_id IS NULL OR
    p_inbound_message_id IS NULL OR p_platform NOT IN('instagram','facebook','whatsapp') OR
    p_provider_event_id IS NULL OR length(p_provider_event_id) NOT BETWEEN 1 AND 256
 THEN RETURN; END IF;
 -- Never claim an event against the wrong tenant/account/conversation or an
 -- unrelated incoming message. A missing provider ID is NOT deduplicable.
 IF NOT EXISTS (
   SELECT 1 FROM public.messages m JOIN public.conversations c
     ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id
     JOIN public.channel_accounts a
       ON a.id=p_account_id AND a.tenant_id=c.tenant_id
   WHERE m.id=p_inbound_message_id AND m.tenant_id=p_tenant_id
     AND m.direction='in' AND m.conversation_id=p_conversation_id
     AND m.wa_message_id=p_provider_event_id
     AND (c.account_id=p_account_id OR c.account_id IS NULL)
     AND a.platform=p_platform
 ) THEN RETURN; END IF;

 v_route:='legacy_ai';
 -- p_engine_ready means the SERVER already successfully prepared a
 -- supported flow response; it does not override database kill switches.
 IF p_engine_ready IS TRUE AND
    EXISTS(SELECT 1 FROM public.automation_flow_global_switch WHERE singleton AND enabled) AND
    EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches
       WHERE tenant_id=p_tenant_id AND enabled AND test_only) AND
    EXISTS(SELECT 1 FROM public.automation_flow_activations
       WHERE tenant_id=p_tenant_id AND channel_account_id=p_account_id
         AND platform=p_platform AND is_active)
 THEN v_route:='flow'; END IF;

 -- PostgreSQL unique conflict serialization is the exclusivity barrier.
 INSERT INTO public.automation_message_claims(
  tenant_id,channel_account_id,platform,provider_event_id,conversation_id,
  inbound_message_id,route)
 VALUES(p_tenant_id,p_account_id,p_platform,p_provider_event_id,
        p_conversation_id,p_inbound_message_id,v_route)
 ON CONFLICT DO NOTHING
 RETURNING id,automation_message_claims.route,automation_message_claims.outgoing_message_id
 INTO v_id,v_route,v_outgoing;

 IF v_id IS NOT NULL THEN
  RETURN QUERY SELECT true,v_route,v_id,v_outgoing;
 END IF;
 -- Another request won (possibly while this request was blocked waiting).
 -- Never transfer ownership to the loser, even if the winner's path failed.
 RETURN QUERY SELECT false,c.route,c.id,c.outgoing_message_id
 FROM public.automation_message_claims c
 WHERE c.tenant_id=p_tenant_id AND c.channel_account_id=p_account_id
   AND c.platform=p_platform AND c.provider_event_id=p_provider_event_id;
END
$claim$;
COMMENT ON FUNCTION public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)
 IS 'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM';
REVOKE ALL ON FUNCTION public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)
 TO service_role;
COMMIT;
