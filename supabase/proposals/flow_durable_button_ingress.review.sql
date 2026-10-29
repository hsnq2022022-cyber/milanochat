-- STAGED ONLY. Reviewed service-owned durable run and button continuation.
-- Not installed in production, does not enable any worker or alter existing flow.
-- Both calls must come exclusively from the signed, server-validated Meta webhook.
BEGIN;

DO $guard$
BEGIN
 IF to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)') IS NOT NULL
 OR to_regprocedure('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)') IS NOT NULL
 OR to_regclass('public.flow_one_awaiting_input_per_conversation') IS NOT NULL
 THEN RAISE EXCEPTION 'Durable ingress already installed; abort';END IF;
 IF to_regclass('public.automation_flow_runs') IS NULL
 OR to_regclass('public.automation_flow_event_receipts') IS NULL
 OR to_regprocedure('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)') IS NULL
 THEN RAISE EXCEPTION 'Durable engine prerequisites missing';END IF;
END $guard$;

-- Never present two ambiguous choices to the same customer at once.
CREATE UNIQUE INDEX flow_one_awaiting_input_per_conversation
 ON public.automation_flow_runs(tenant_id,conversation_id,channel_account_id)
 WHERE run_status='awaiting_input';
COMMENT ON INDEX public.flow_one_awaiting_input_per_conversation
 IS 'CREATED_BY_DURABLE_BUTTON_INGRESS';

CREATE FUNCTION public.flow_begin_durable_run(
 p_tenant uuid,p_account uuid,p_conversation uuid,p_inbound uuid,
 p_event text,p_flow text,p_revision bigint,p_start text,p_next text,
 p_next_step integer,p_status text,p_variables jsonb,p_wake timestamptz,
 p_effects jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $begin$
DECLARE v_run uuid; v_claim uuid; v_saved text; v_ok boolean;
BEGIN
 IF p_tenant IS NULL OR p_account IS NULL OR p_conversation IS NULL OR
    p_inbound IS NULL OR p_event IS NULL OR
    length(p_event) NOT BETWEEN 1 AND 256 OR p_flow IS NULL OR
    p_revision IS NULL OR p_revision<1 OR p_start IS NULL OR
    length(p_start) NOT BETWEEN 1 AND 128 OR p_next IS NULL OR
    p_next_step IS NULL OR p_next_step<=0 OR p_effects IS NULL
 THEN RETURN NULL; END IF;

 SELECT cl.id INTO v_claim FROM public.automation_message_claims cl
 JOIN public.messages m ON m.tenant_id=cl.tenant_id AND m.id=cl.inbound_message_id
 JOIN public.conversations c ON c.tenant_id=cl.tenant_id AND c.id=cl.conversation_id
 JOIN public.channel_accounts a ON a.tenant_id=cl.tenant_id AND a.id=cl.channel_account_id
 JOIN public.tenants t ON t.id=cl.tenant_id
 WHERE cl.tenant_id=p_tenant AND cl.channel_account_id=p_account
   AND cl.conversation_id=p_conversation AND cl.inbound_message_id=p_inbound
   AND cl.platform='instagram' AND cl.route='flow' AND cl.provider_event_id=p_event
   AND m.direction='in' AND m.wa_message_id=p_event
   AND c.account_id=p_account AND a.platform='instagram' AND a.is_active
   AND a.agent_enabled AND a.auto_reply AND t.is_active;
 IF v_claim IS NULL THEN RETURN NULL;END IF;

 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch
               WHERE singleton AND enabled)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches
               WHERE tenant_id=p_tenant AND enabled AND production_approved)
 OR NOT EXISTS(
  SELECT 1 FROM public.automation_flow_activations a
  JOIN public.automation_flow_publications p ON p.tenant_id=a.tenant_id
   AND p.channel_account_id=a.channel_account_id AND p.platform=a.platform
   AND p.flow_key=a.flow_key AND p.revision=a.revision
  WHERE a.tenant_id=p_tenant AND a.channel_account_id=p_account
   AND a.platform='instagram' AND a.flow_key=p_flow AND a.revision=p_revision
   AND a.is_active AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(p.document->'nodes') n
    WHERE n->>'id'=p_start AND n#>>'{data,kind}'='trigger'
     AND n#>>'{data,platform}'='instagram'
     AND n#>>'{data,triggerMode}'='message')
 ) THEN RETURN NULL;END IF;

 INSERT INTO public.automation_flow_event_receipts(
  tenant_id,channel_account_id,platform,provider_event_id)
 VALUES(p_tenant,p_account,'instagram',p_event)
 ON CONFLICT DO NOTHING RETURNING provider_event_id INTO v_saved;
 IF v_saved IS NULL THEN RETURN NULL;END IF;

 INSERT INTO public.automation_flow_runs(
  tenant_id,flow_key,publication_revision,channel_account_id,platform,
  conversation_id,provider_event_id,current_node_id,run_status,step_count,variables)
 VALUES(p_tenant,p_flow,p_revision,p_account,'instagram',
  p_conversation,p_event,p_start,'ready',0,'{}'::jsonb)
 RETURNING id INTO v_run;

 SELECT public.flow_commit_run_step(
  p_tenant,v_run,0,'ready',p_next,p_next_step,p_status,
  p_variables,p_wake,p_effects,'started',NULL
 ) INTO v_ok;
 IF v_ok IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'First durable step rejected; atomic rollback required';
 END IF;
 RETURN v_run;
END $begin$;

-- The server FIRST loads the existing run and immutable graph, checks the
-- signed quick-reply candidate against that graph and plans its next step.
-- Then this RPC performs receipt, transition and effects in ONE transaction.
CREATE FUNCTION public.flow_resume_button_run(
 p_tenant uuid,p_run uuid,p_event text,p_inbound uuid,p_expect_step integer,
 p_expect_node text,p_next text,p_next_step integer,p_status text,
 p_variables jsonb,p_wake timestamptz,p_effects jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $resume$
DECLARE old_run record; v_saved text; v_ok boolean;
BEGIN
 IF p_tenant IS NULL OR p_run IS NULL OR p_inbound IS NULL OR
    p_event IS NULL OR length(p_event) NOT BETWEEN 1 AND 256 OR
    p_expect_step IS NULL OR p_expect_node IS NULL OR p_next IS NULL
 THEN RETURN false;END IF;
 SELECT * INTO old_run FROM public.automation_flow_runs
 WHERE tenant_id=p_tenant AND id=p_run AND run_status='awaiting_input'
  AND step_count=p_expect_step AND current_node_id=p_expect_node
 FOR UPDATE;
 IF NOT FOUND OR old_run.platform<>'instagram' THEN RETURN false;END IF;

 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch
               WHERE singleton AND enabled)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches
               WHERE tenant_id=p_tenant AND enabled AND production_approved)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_activations
    WHERE tenant_id=p_tenant AND channel_account_id=old_run.channel_account_id
     AND platform='instagram' AND flow_key=old_run.flow_key
     AND revision=old_run.publication_revision AND is_active)
 OR NOT EXISTS(
  SELECT 1 FROM public.automation_message_claims cl
  JOIN public.messages m ON m.tenant_id=cl.tenant_id AND m.id=cl.inbound_message_id
  WHERE cl.tenant_id=p_tenant AND cl.channel_account_id=old_run.channel_account_id
   AND cl.conversation_id=old_run.conversation_id AND cl.platform='instagram'
   AND cl.route='flow' AND cl.provider_event_id=p_event
   AND cl.inbound_message_id=p_inbound AND m.direction='in'
   AND m.wa_message_id=p_event
 ) THEN RETURN false;END IF;

 INSERT INTO public.automation_flow_event_receipts(
  tenant_id,channel_account_id,platform,provider_event_id)
 VALUES(p_tenant,old_run.channel_account_id,'instagram',p_event)
 ON CONFLICT DO NOTHING RETURNING provider_event_id INTO v_saved;
 IF v_saved IS NULL THEN RETURN false;END IF;

 SELECT public.flow_commit_run_step(
  p_tenant,p_run,p_expect_step,'awaiting_input',p_next,
  p_next_step,p_status,p_variables,p_wake,p_effects,'button',NULL
 ) INTO v_ok;
 IF v_ok IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Button transition rejected; rollback receipt';
 END IF;
 RETURN true;
END $resume$;

REVOKE ALL ON FUNCTION public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
 TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)
 TO service_role;
COMMIT;
