-- TEST FIXTURE ONLY (never a migration, never applied to any real project).
-- Installs the PRODUCTION body of public.flow_claim_inbound over the repo
-- 20261028220000 version, so local SQL tests exercise the function exactly as
-- deployed. Production differs from the repo body in ONE predicate: the tenant
-- switch condition is "enabled AND (test_only OR production_approved)" (repo:
-- "enabled AND test_only"); both accept conversations.account_id IS NULL.
-- The text between the $claim$ tags is byte-identical to the production
-- prosrc (raw md5 d67fcf35e9042857c4f488d45cd9f9b9, 2716 bytes; normalized
-- md5 cced049e635e02b5a0be1353704b5020, normalization
-- md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g')))).
-- Header, attributes, marker and grants are the production ones.
-- Requires 20261028220000 and the production_approved column of
-- public.automation_flow_tenant_switches (the tests' live-shape columns).
BEGIN;
CREATE OR REPLACE FUNCTION public.flow_claim_inbound(
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
       WHERE tenant_id=p_tenant_id AND enabled AND (test_only OR production_approved)) AND
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
  RETURN; -- Winner must never also return a second duplicate result.
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
DO $check$
BEGIN
 IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
     WHERE p.oid=to_regprocedure('public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)'))
    IS DISTINCT FROM 'd67fcf35e9042857c4f488d45cd9f9b9' THEN
  RAISE EXCEPTION 'fixture: installed flow_claim_inbound body is not the production body';
 END IF;
END
$check$;
COMMIT;
