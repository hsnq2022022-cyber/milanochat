-- REVIEW ONLY: let durable flows with a KEYWORD trigger start.
-- NOT applied anywhere by this repository; apply only with an explicit owner GO.
--
-- public.flow_begin_durable_run (20261029230000 body, production-pinned md5
-- d0fea89cd85053ee62276bccf4156d43) re-validates the start node of the active
-- revision and accepts only triggerMode='message'. A durable graph with a
-- keyword trigger is selected and keyword-matched by milan-api
-- (flowInboundSelection.ts / triggerKeywords.ts) BEFORE any claim, but its
-- start was refused here, rolled back by flow_claim_begin_durable_run
-- (20261029330000) and fell back to V2/legacy AI.
--
-- Change: replaces that ONE function with the previous body VERBATIM except
-- the start-node predicate, which now accepts
--   triggerMode='message'  (unchanged), or
--   triggerMode='keyword' with a keywords text that is not blank after
--   trimming spaces, commas, Arabic commas, tabs and line breaks
--   (shape only: the keyword MATCH stays in the Edge, before the claim).
-- 'comment' and every other mode are still refused. Same signature, return
-- type, SECURITY INVOKER, search_path='', volatility; CREATE OR REPLACE keeps
-- the existing COMMENT (marker CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS)
-- and privileges. No other object is changed. Callers
-- (flow_begin_durable_run_superseding 20261029190000,
-- flow_claim_begin_durable_run 20261029330000) are unchanged.
--
-- Preflight refuses unless exactly one overload exists with that marker,
-- plpgsql/volatile/invoker/non-strict/search_path=''/returns uuid,
-- service_role holds EXECUTE, and the normalized body md5
-- (md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g')))) is the
-- 20261029230000 body d0fea89cd85053ee62276bccf4156d43 or this migration's own
-- 1b8bbc385d536e1ff829ad6043a31e65 (idempotent re-apply).
-- NOTE: after this migration the 20261029330000 preflight (which pins
-- d0fea89c...) refuses a RE-apply of 330000; apply 330000 FIRST.
--
-- Order: 20261029230000 -> 20261029330000 -> this. Without it the Edge
-- still selects/matches durable keyword flows, the start is refused in SQL,
-- flow_claim_begin_durable_run rolls the claim back and V2/legacy AI answers
-- (no lost message, no duplicate run/reply).
-- Rollback: supabase/rollbacks/20261029350000_flow_durable_keyword_start.rollback.sql
-- (restores the 20261029230000 body verbatim; refuses any foreign body).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS';
 v_prev_md5 constant text := 'd0fea89cd85053ee62276bccf4156d43';  -- 20261029230000 (production-pinned)
 v_self_md5 constant text := '1b8bbc385d536e1ff829ad6043a31e65';  -- this migration
 v_fn regprocedure := to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)');
 v_md5 text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='service_role') THEN
  RAISE EXCEPTION 'Durable keyword start prerequisite missing: role service_role';
 END IF;
 IF v_fn IS NULL THEN
  RAISE EXCEPTION 'Missing function public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb); apply 20261029230000_flow_multichannel_support first';
 END IF;
 IF (SELECT count(*) FROM pg_catalog.pg_proc p
     WHERE p.pronamespace='public'::regnamespace AND p.proname='flow_begin_durable_run')<>1 THEN
  RAISE EXCEPTION 'Unrecognized overload of public.flow_begin_durable_run; refusing to install';
 END IF;
 IF split_part(coalesce(obj_description(v_fn,'pg_proc'),''),' ',1) IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'public.flow_begin_durable_run lacks marker %; refusing to install', v_marker;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=v_fn AND l.lanname='plpgsql' AND p.provolatile='v' AND NOT p.prosecdef
    AND NOT p.proisstrict AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']
    AND pg_catalog.pg_get_function_result(p.oid)='uuid') THEN
  RAISE EXCEPTION 'public.flow_begin_durable_run does not have the expected definition; refusing to install';
 END IF;
 SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) INTO v_md5
 FROM pg_catalog.pg_proc p WHERE p.oid=v_fn;
 IF v_md5 IS DISTINCT FROM v_prev_md5 AND v_md5 IS DISTINCT FROM v_self_md5 THEN
  RAISE EXCEPTION 'public.flow_begin_durable_run body is neither the 20261029230000 nor this migration''s (md5 %); refusing to overwrite', v_md5;
 END IF;
 IF NOT pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
  RAISE EXCEPTION 'Durable keyword start prerequisite missing: EXECUTE on flow_begin_durable_run for service_role';
 END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.flow_begin_durable_run(
 p_tenant uuid,p_account uuid,p_conversation uuid,p_inbound uuid,
 p_event text,p_flow text,p_revision bigint,p_start text,p_next text,
 p_next_step integer,p_status text,p_variables jsonb,p_wake timestamptz,
 p_effects jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $begin$
DECLARE v_run uuid; v_claim uuid; v_platform text; v_saved text; v_ok boolean;
BEGIN
 IF p_tenant IS NULL OR p_account IS NULL OR p_conversation IS NULL OR
    p_inbound IS NULL OR p_event IS NULL OR
    length(p_event) NOT BETWEEN 1 AND 256 OR p_flow IS NULL OR
    p_revision IS NULL OR p_revision<1 OR p_start IS NULL OR
    length(p_start) NOT BETWEEN 1 AND 128 OR p_next IS NULL OR
    p_next_step IS NULL OR p_next_step<=0 OR p_effects IS NULL
 THEN RETURN NULL; END IF;

 SELECT cl.id,a.platform INTO v_claim,v_platform FROM public.automation_message_claims cl
 JOIN public.messages m ON m.tenant_id=cl.tenant_id AND m.id=cl.inbound_message_id
 JOIN public.conversations c ON c.tenant_id=cl.tenant_id AND c.id=cl.conversation_id
 JOIN public.channel_accounts a ON a.tenant_id=cl.tenant_id AND a.id=cl.channel_account_id
 JOIN public.tenants t ON t.id=cl.tenant_id
 WHERE cl.tenant_id=p_tenant AND cl.channel_account_id=p_account
   AND cl.conversation_id=p_conversation AND cl.inbound_message_id=p_inbound
   AND cl.platform=a.platform AND cl.route='flow' AND cl.provider_event_id=p_event
   AND m.direction='in' AND m.wa_message_id=p_event
   AND m.conversation_id=cl.conversation_id
   AND c.account_id=p_account AND a.platform IN('instagram','whatsapp','facebook') AND a.is_active
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
   AND a.platform=v_platform AND a.flow_key=p_flow AND a.revision=p_revision
   AND a.is_active AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(p.document->'nodes') n
    WHERE n->>'id'=p_start AND n#>>'{data,kind}'='trigger'
     AND n#>>'{data,platform}'=CASE v_platform WHEN 'facebook' THEN 'messenger' ELSE v_platform END
     -- message: every DM; keyword: >= 1 non-blank keyword text (the keyword
     -- MATCH runs in the Edge before any claim; comment/other modes refused).
     AND (n#>>'{data,triggerMode}'='message' OR
          (n#>>'{data,triggerMode}'='keyword' AND
           btrim(coalesce(n#>>'{data,keywords}',''),' ,'||chr(1548)||chr(10)||chr(9)||chr(13))<>'')))
 ) THEN RETURN NULL;END IF;

 INSERT INTO public.automation_flow_event_receipts(
  tenant_id,channel_account_id,platform,provider_event_id)
 VALUES(p_tenant,p_account,v_platform,p_event)
 ON CONFLICT DO NOTHING RETURNING provider_event_id INTO v_saved;
 IF v_saved IS NULL THEN RETURN NULL;END IF;

 INSERT INTO public.automation_flow_runs(
  tenant_id,flow_key,publication_revision,channel_account_id,platform,
  conversation_id,provider_event_id,current_node_id,run_status,step_count,variables)
 VALUES(p_tenant,p_flow,p_revision,p_account,v_platform,
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
COMMIT;
