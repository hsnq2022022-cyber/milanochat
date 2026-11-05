-- REVIEW ONLY: guards for the V3 durable Instagram button run RPCs.
-- NOT applied anywhere by this repository; apply only with an explicit owner GO.
--
-- Replaces the bodies of the two service-only RPCs installed by
-- 20261029125000_flow_durable_button_run (or, identically, by the older
-- proposal supabase/proposals/flow_durable_button_ingress.review.sql):
--   public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
--   public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)
-- Signatures, argument names, return types, LANGUAGE plpgsql, SECURITY
-- INVOKER, SET search_path='' and privileges (service_role only) are kept.
-- Two refusal conditions are added; every accepted call has exactly the same
-- result and side effects as with the 125000 bodies:
--  A. flow_resume_button_run re-checks, like flow_begin_durable_run, that the
--     run's channel account (same tenant, platform 'instagram') has
--     is_active AND agent_enabled AND auto_reply, and the tenant is_active.
--     Same predicate and NULL semantics as begin: a NULL flag is not true, so
--     the call is refused. Refusal returns false before any write: the run
--     stays awaiting_input unchanged (no receipt, effect, metric or variable
--     change) and a later tap resumes it once the flags are on again. The
--     workers' pause logic (20261029150000/160000) is not changed.
--  B. The claim's inbound message must belong to the claim's conversation:
--     begin adds m.conversation_id=cl.conversation_id (cl.conversation_id is
--     already p_conversation); resume adds
--     m.conversation_id=old_run.conversation_id. A mismatch is refused
--     (begin: NULL, resume: false) with no writes.
--
-- Installed state handling (normalized definition: body with whitespace runs
-- collapsed and trimmed, language, return type, argument names, security,
-- search_path, volatility, strictness, no defaults):
--  * equal to the 125000/proposal definition -> replaced by the body below;
--    comment set to the marker 'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
--    followed by ' previous_comment=<JSON string or null>' (the replaced
--    function's comment: the 125000 marker, or null for the proposal), which
--    the rollback restores;
--  * equal to the definition below -> left unchanged (idempotent re-apply);
--  * anything else, a missing function or another overload -> REFUSED (a
--    production-specific body is never overwritten).
-- Requires the 20261028220000, 20261028225000 and 20261029130000..170000
-- ownership markers (preflight refuses otherwise). No table, row, index,
-- trigger or other function is changed. Billing/credits are not referenced.
--
-- The 20261029170000 preflight only requires both functions to exist (its
-- message names the proposal); they keep existing, so it is unaffected.
-- Order: after 20261029170000 (newest). Rollback:
-- supabase/rollbacks/20261029180000_flow_durable_button_run_guards.rollback.sql
-- (run FIRST: 180000, then 170000, 160000, 150000, 140000, 130000, 125000; the
-- older rollbacks refuse while a function carries the marker above).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $migration$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS';
 v_name text;
 v_tbl text;
 v_col text;
 v_missing text := '';
 v_fn regprocedure;
 v_prev text;
 r record;
 p record;
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
 -- ---------------------------------------------------------------- preflight
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_name) THEN
   RAISE EXCEPTION 'Durable button run guards prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 -- Column the new predicates add (all others are 125000 prerequisites).
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
   WHERE a.attrelid=to_regclass('public.messages') AND a.attname='conversation_id'
    AND a.attnum>0 AND NOT a.attisdropped) THEN
  RAISE EXCEPTION 'Durable button run guards prerequisite missing: column public.messages.conversation_id';
 END IF;
 -- Live-only columns: bound when the functions run (resume now reads them too).
 FOREACH v_name IN ARRAY ARRAY[
  'tenants.is_active','channel_accounts.is_active','channel_accounts.agent_enabled',
  'channel_accounts.auto_reply','automation_flow_tenant_switches.production_approved'
 ] LOOP
  v_tbl := split_part(v_name,'.',1); v_col := split_part(v_name,'.',2);
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=to_regclass('public.'||v_tbl) AND a.attname=v_col
     AND a.attnum>0 AND NOT a.attisdropped) THEN
   v_missing := v_missing||' public.'||v_name;
  END IF;
 END LOOP;
 IF v_missing<>'' THEN
  RAISE WARNING 'Durable button run guards: live-only column(s) absent:% (every begin/resume call errors and writes nothing until they exist)', v_missing;
 END IF;
 -- 20261028220000 / 20261028225000 objects the bodies use (exact markers).
 IF obj_description(to_regclass('public.automation_message_claims'),'pg_class')
    IS DISTINCT FROM 'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM' THEN
  RAISE EXCEPTION 'Missing or unrecognized public.automation_message_claims; apply 20261028220000_webhook_exclusive_claim first';
 END IF;
 v_fn := to_regprocedure('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)');
 IF v_fn IS NULL
 OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM 'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE'
 OR (SELECT prorettype FROM pg_catalog.pg_proc WHERE oid=v_fn)<>'boolean'::regtype THEN
  RAISE EXCEPTION 'Missing or unrecognized public.flow_commit_run_step; apply 20261028225000_flow_runtime_advance first';
 END IF;
 -- 20261029130000 .. 20261029170000 chain (exact ownership markers).
 FOR r IN SELECT * FROM (VALUES
  ('public.flow_lease_due_runs(integer)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','20261029130000_flow_run_lifecycle'),
  ('public.flow_cancel_run(uuid,uuid,text,text)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','20261029130000_flow_run_lifecycle'),
  ('public.flow_claim_outbox_ai(uuid,uuid,integer,integer)','CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY','20261029140000_flow_outbox_ai_retry'),
  ('public.flow_end_stale_paused_runs(integer,integer)','CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME','20261029150000_flow_takeover_resume'),
  ('public.flow_channel_temporarily_paused(uuid,uuid)','CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE','20261029160000_flow_credits_pause'),
  ('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)','CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE','20261029170000_flow_canary_claim_durable')
 ) c(sig,marker,mig) LOOP
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM r.marker THEN
   RAISE EXCEPTION 'Missing or unrecognized % object %; apply % first', split_part(r.mig,'_',1), r.sig, r.mig;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY['automation_flow_canary_accounts','automation_flow_canary_claims'] LOOP
  IF obj_description(to_regclass('public.'||v_name),'pg_class')
     IS DISTINCT FROM 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE' THEN
   RAISE EXCEPTION 'Missing or unrecognized 20261029170000 object public.%; apply 20261029170000_flow_canary_claim_durable first', v_name;
  END IF;
 END LOOP;

 -- ------------------------------------------- installed definitions (check all first)
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
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc x
    WHERE x.pronamespace='public'::regnamespace AND x.proname=r.name
     AND x.oid IS DISTINCT FROM to_regprocedure(r.sig)) THEN
   RAISE EXCEPTION 'Unrecognized overload of public.% exists; refusing to replace %', r.name, r.sig;
  END IF;
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL THEN
   RAISE EXCEPTION '% is missing; apply 20261029125000_flow_durable_button_run first', r.sig;
  END IF;
  SELECT x.* INTO p FROM pg_catalog.pg_proc x WHERE x.oid=v_fn;
  IF p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR p.prorettype IS DISTINCT FROM r.ret OR p.proretset OR p.prokind<>'f'
  OR p.prosecdef OR p.proisstrict OR p.provolatile<>'v' OR p.pronargdefaults<>0
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
  OR p.proargnames IS DISTINCT FROM r.args
  OR (btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))
       IS DISTINCT FROM btrim(regexp_replace(r.src125,'[[:space:]]+',' ','g'))
      AND btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))
       IS DISTINCT FROM btrim(regexp_replace(r.src180,'[[:space:]]+',' ','g'))) THEN
   RAISE EXCEPTION 'Existing % differs from both the 20261029125000 and the 20261029180000 definition (marker=%); refusing to overwrite',
    r.sig, coalesce(obj_description(v_fn,'pg_proc'),'-');
  END IF;
  IF split_part(coalesce(obj_description(v_fn,'pg_proc'),''),' ',1)=v_marker
     AND btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))
      IS DISTINCT FROM btrim(regexp_replace(r.src180,'[[:space:]]+',' ','g')) THEN
   RAISE EXCEPTION '% carries the 20261029180000 marker but not its body; refusing (inconsistent state)', r.sig;
  END IF;
 END LOOP;

 -- ---------------------------------------------------------------- replace
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
  SELECT x.* INTO p FROM pg_catalog.pg_proc x WHERE x.oid=v_fn;
  IF btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))
     IS NOT DISTINCT FROM btrim(regexp_replace(r.src180,'[[:space:]]+',' ','g')) THEN
   RAISE NOTICE '% already has the 20261029180000 definition (marker=%); left unchanged',
    r.sig, coalesce(split_part(obj_description(v_fn,'pg_proc'),' ',1),'-');
  ELSE
   v_prev := obj_description(v_fn,'pg_proc');
   EXECUTE r.head||'$'||r.tag||'$'||r.src180||'$'||r.tag||'$';
   EXECUTE format('COMMENT ON FUNCTION %s IS %L', r.sig,
    v_marker||' previous_comment='||coalesce(to_json(v_prev)::text,'null'));
   RAISE NOTICE '% replaced (previous marker=%)', r.sig, coalesce(v_prev,'-');
  END IF;
 END LOOP;
END
$migration$;

REVOKE ALL ON FUNCTION public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
 TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)
 TO service_role;
COMMIT;
