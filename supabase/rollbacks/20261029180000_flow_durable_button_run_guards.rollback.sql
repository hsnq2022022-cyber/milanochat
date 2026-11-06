-- REVIEW ONLY rollback for 20261029180000_flow_durable_button_run_guards.
-- NOT applied anywhere by this repository.
--
-- Order: run right after the 20261029190000_flow_begin_durable_run_superseding
-- rollback (refused while that function exists). Required rollback order:
-- 190000, 180000, then 20261029170000, 160000, 150000, 140000, 130000, 125000
-- (each of those rollbacks refuses while a function carries the 180000 marker).
--
-- Restores, ONLY for a function whose comment carries the marker
-- CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS and whose body is
-- the 180000 body, the exact 20261029125000 body text (byte-identical to that
-- migration and to supabase/proposals/flow_durable_button_ingress.review.sql)
-- and the comment recorded by the migration (previous_comment: the 125000
-- marker, or none for proposal-installed functions). CREATE OR REPLACE keeps
-- the function OID and its service_role-only privileges. A function without
-- the marker is never touched; a marked function with another body is refused.
-- No rows are touched. Billing/credits are not referenced.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $rollback$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS';
 v_fn regprocedure;
 v_c text;
 v_prev text;
 v_owned integer := 0;
 r record;
 -- 20261029125000 bodies: byte-identical to 20261029125000_flow_durable_button_run.sql
 -- and supabase/proposals/flow_durable_button_ingress.review.sql.
 v_begin_125 constant text := $begin$
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
 v_resume_125 constant text := $resume$
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
 -- 20261029180000 bodies (125000 bodies plus the guards described above).
 v_begin_180 constant text := $begin$
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
   AND m.conversation_id=cl.conversation_id
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
 v_resume_180 constant text := $resume$
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
  SELECT 1 FROM public.channel_accounts a
  JOIN public.tenants t ON t.id=a.tenant_id
  WHERE a.tenant_id=p_tenant AND a.id=old_run.channel_account_id
   AND a.platform='instagram' AND a.is_active
   AND a.agent_enabled AND a.auto_reply AND t.is_active)
 OR NOT EXISTS(
  SELECT 1 FROM public.automation_message_claims cl
  JOIN public.messages m ON m.tenant_id=cl.tenant_id AND m.id=cl.inbound_message_id
  WHERE cl.tenant_id=p_tenant AND cl.channel_account_id=old_run.channel_account_id
   AND cl.conversation_id=old_run.conversation_id AND cl.platform='instagram'
   AND cl.route='flow' AND cl.provider_event_id=p_event
   AND cl.inbound_message_id=p_inbound AND m.direction='in'
   AND m.wa_message_id=p_event AND m.conversation_id=old_run.conversation_id
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
 v_begin_head constant text := $head$CREATE OR REPLACE FUNCTION public.flow_begin_durable_run(
 p_tenant uuid,p_account uuid,p_conversation uuid,p_inbound uuid,
 p_event text,p_flow text,p_revision bigint,p_start text,p_next text,
 p_next_step integer,p_status text,p_variables jsonb,p_wake timestamptz,
 p_effects jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $head$;
 v_resume_head constant text := $head$CREATE OR REPLACE FUNCTION public.flow_resume_button_run(
 p_tenant uuid,p_run uuid,p_event text,p_inbound uuid,p_expect_step integer,
 p_expect_node text,p_next text,p_next_step integer,p_status text,
 p_variables jsonb,p_wake timestamptz,p_effects jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $head$;
BEGIN
 -- 20261029210000 (media effects; requires the 130000..190000 chain) is newer: roll it back first.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN(
   to_regprocedure('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)'),
   to_regprocedure('public.flow_reserve_outbox_delivery(uuid,uuid)'),
   to_regprocedure('public.flow_finish_outbox_delivery(uuid,uuid,text,text)'))
  AND md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) IN(
   '94a87bc016ad93e609897025d259bf3e','1b7a6fe3f6a9ee97203d50d5e0e0baa7','1c6ec477519f8c91c24fc2ab82d4b9c4'))
 THEN RAISE EXCEPTION 'Refusing 20261029180000 rollback: 20261029210000 objects still exist; roll back 20261029210000_flow_media_effects first'; END IF;
 -- 20261029190000 (superseding begin; requires the 130000..180000 chain) is newer: roll it back first.
 IF to_regprocedure('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'Refusing 20261029180000 rollback: 20261029190000 objects still exist; roll back 20261029190000_flow_begin_durable_run_superseding first'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('flow_begin_durable_run','public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
   v_begin_125,v_begin_180,v_begin_head,'begin','uuid'::regtype,
   ARRAY['p_tenant','p_account','p_conversation','p_inbound','p_event','p_flow','p_revision',
    'p_start','p_next','p_next_step','p_status','p_variables','p_wake','p_effects']),
  ('flow_resume_button_run','public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)',
   v_resume_125,v_resume_180,v_resume_head,'resume','boolean'::regtype,
   ARRAY['p_tenant','p_run','p_event','p_inbound','p_expect_step','p_expect_node','p_next',
    'p_next_step','p_status','p_variables','p_wake','p_effects'])
 ) f(name,sig,src125,src180,head,tag,ret,args) LOOP
  v_fn := to_regprocedure(r.sig);
  v_c := CASE WHEN v_fn IS NOT NULL THEN obj_description(v_fn,'pg_proc') END;
  IF split_part(coalesce(v_c,''),' ',1)=v_marker THEN
   IF v_c NOT LIKE v_marker||' previous_comment=%' THEN
    RAISE EXCEPTION 'Refusing 20261029180000 rollback: % has an unrecognized marker comment', r.sig;
   END IF;
   IF (SELECT btrim(regexp_replace(x.prosrc,'[[:space:]]+',' ','g')) FROM pg_catalog.pg_proc x WHERE x.oid=v_fn)
      IS DISTINCT FROM btrim(regexp_replace(r.src180,'[[:space:]]+',' ','g')) THEN
    RAISE EXCEPTION 'Refusing 20261029180000 rollback: % carries the marker but not the 20261029180000 body', r.sig;
   END IF;
   v_owned := v_owned+1;
  END IF;
 END LOOP;
 IF v_owned=0 THEN
  RAISE EXCEPTION '20261029180000_flow_durable_button_run_guards not installed; nothing to roll back';
 END IF;

 FOR r IN SELECT * FROM (VALUES
  ('flow_begin_durable_run','public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
   v_begin_125,v_begin_180,v_begin_head,'begin','uuid'::regtype,
   ARRAY['p_tenant','p_account','p_conversation','p_inbound','p_event','p_flow','p_revision',
    'p_start','p_next','p_next_step','p_status','p_variables','p_wake','p_effects']),
  ('flow_resume_button_run','public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)',
   v_resume_125,v_resume_180,v_resume_head,'resume','boolean'::regtype,
   ARRAY['p_tenant','p_run','p_event','p_inbound','p_expect_step','p_expect_node','p_next',
    'p_next_step','p_status','p_variables','p_wake','p_effects'])
 ) f(name,sig,src125,src180,head,tag,ret,args) LOOP
  v_fn := to_regprocedure(r.sig);
  v_c := CASE WHEN v_fn IS NOT NULL THEN obj_description(v_fn,'pg_proc') END;
  IF split_part(coalesce(v_c,''),' ',1)=v_marker THEN
   v_prev := substr(v_c,length(v_marker||' previous_comment=')+1)::json #>> '{}';
   EXECUTE r.head||'$'||r.tag||'$'||r.src125||'$'||r.tag||'$';
   EXECUTE format('COMMENT ON FUNCTION %s IS %s', r.sig, coalesce(quote_literal(v_prev),'NULL'));
   RAISE NOTICE '% restored to the 20261029125000 body (marker=%)', r.sig, coalesce(v_prev,'-');
  ELSE
   RAISE NOTICE '% does not carry the 20261029180000 marker (marker=%); left in place',
    r.sig, coalesce(v_c,'-');
  END IF;
 END LOOP;
END
$rollback$;
COMMIT;
