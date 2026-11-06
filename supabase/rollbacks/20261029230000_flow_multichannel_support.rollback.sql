-- REVIEW ONLY rollback for 20261029230000_flow_multichannel_support.
-- NOT applied anywhere by this repository.
--
-- Restores the exact previous bodies (verbatim below) of
-- flow_claim_inbound_durable (20261029170000), flow_begin_durable_run and
-- flow_resume_button_run (20261029180000), flow_end_stale_paused_runs and
-- flow_lease_due_runs (20261029150000), flow_commit_run_step and
-- flow_reserve_outbox_delivery (20261029210000), and the instagram-only CHECK
-- automation_flow_canary_accounts_platform_chk with its previous comment.
-- CREATE OR REPLACE keeps the OIDs, the service_role-only privileges and the
-- ownership comments (230000 never changed them). Only bodies whose hash is
-- the 20261029230000 body and a CHECK carrying the marker
-- CREATED_BY_20261029230000_FLOW_MULTICHANNEL_SUPPORT are touched; any other
-- or partial state is refused. No row is inserted, updated or deleted.
-- Billing/credits are not referenced.
--
-- Data guard (no opt-in): the previous bodies and CHECK accept Instagram
-- only, so the rollback REFUSES while any of these exist:
--  * a WhatsApp/Facebook canary registration (the instagram-only CHECK could
--    not be validated; delete it as the table owner first);
--  * a non-Instagram durable run in ready / awaiting_input / sleeping (it
--    could never be resumed, leased or committed again: end it first with
--    public.flow_cancel_run(tenant_id,id,'manual',run_status));
--  * an Outbox effect of a non-Instagram run still pending / retry_wait /
--    leased (it could never be reserved again: cancel pending ones with
--    flow_skip_outbox_effect ... 'manual', let leased ones finish).
-- Ended runs and terminal effects do not block (they need no function).
--
-- Order: turn FLOW_MULTICHANNEL_ENABLED off FIRST. Then run this rollback
-- FIRST (20261029230000 is the newest flow migration); required rollback
-- order: 230000, then 20261029220000, 210000, 190000, 180000, 170000, 160000,
-- 150000, 140000, 130000, 125000; each of those refuses while a 230000 body
-- or the marked CHECK is installed.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029230000_FLOW_MULTICHANNEL_SUPPORT';
 v_chk_old constant text := 'CHECK ((platform = ''instagram''::text))';
 v_chk_new constant text := 'CHECK ((platform = ANY (ARRAY[''instagram''::text, ''whatsapp''::text, ''facebook''::text])))';
 v_new integer := 0;
 v_old integer := 0;
 v_def text;
 v_cmt text;
 v_canary bigint := 0;
 v_runs bigint := 0;
 v_open bigint := 0;
 r record;
BEGIN
 -- 20261029230000 is the newest flow migration: no later rollback must run first.
 FOR r IN SELECT * FROM (VALUES
 ('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)',
  'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE',false,'6fc0c342af5bfc155c9057428791e1fd','c9299f42239a6a4f275ba4be61e04b9d'),
 ('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
  'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS',true,'80953ca6c0b52e627699748b59f383f9','d0fea89cd85053ee62276bccf4156d43'),
 ('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)',
  'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS',true,'7a65417ddf106671862eea0da80d8c73','0d4917f27cece556b549c5ca0c7046a2'),
 ('public.flow_end_stale_paused_runs(integer,integer)',
  'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME',false,'ca56c8772ed58e2952f5b7da61c25b77','c7a764911307aefeb1f593312364d440'),
 ('public.flow_lease_due_runs(integer)',
  'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE',false,'c54246eacd947ae32841ae3995a4a7a7','7cddbd9a4964716eec402f399e878a78'),
 ('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)',
  'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE',false,'94a87bc016ad93e609897025d259bf3e','f5b147309700470f8b9f410dda5a6df0'),
 ('public.flow_reserve_outbox_delivery(uuid,uuid)',
  'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY',false,'1b7a6fe3f6a9ee97203d50d5e0e0baa7','4a8882ddd7ad430c4187db821cc3de99')
 ) f(sig,marker,prefix,h_old,h_new) LOOP
  IF to_regprocedure(r.sig) IS NULL
  OR (NOT r.prefix AND obj_description(to_regprocedure(r.sig),'pg_proc') IS DISTINCT FROM r.marker)
  OR (r.prefix AND split_part(coalesce(obj_description(to_regprocedure(r.sig),'pg_proc'),''),' ',1) IS DISTINCT FROM r.marker) THEN
   RAISE EXCEPTION 'Refusing 20261029230000 rollback: % missing or unrecognized', r.sig;
  END IF;
  CASE (SELECT md5(btrim(regexp_replace(x.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc x
        WHERE x.oid=to_regprocedure(r.sig))
   WHEN r.h_new THEN v_new := v_new+1;
   WHEN r.h_old THEN v_old := v_old+1;
   ELSE RAISE EXCEPTION 'Refusing 20261029230000 rollback: % has neither the 20261029230000 nor the previous body', r.sig;
  END CASE;
 END LOOP;
 SELECT pg_catalog.pg_get_constraintdef(c.oid),obj_description(c.oid,'pg_constraint') INTO v_def,v_cmt
 FROM pg_catalog.pg_constraint c
 WHERE c.conrelid=to_regclass('public.automation_flow_canary_accounts')
  AND c.conname='automation_flow_canary_accounts_platform_chk' AND c.contype='c';
 IF v_new=0 AND v_def IS NOT DISTINCT FROM v_chk_old
    AND split_part(coalesce(v_cmt,''),' ',1) IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION '20261029230000_flow_multichannel_support not installed; nothing to roll back (previous bodies and the instagram-only CHECK are in place)';
 END IF;
 IF v_new<>7 OR v_def IS DISTINCT FROM v_chk_new
    OR split_part(coalesce(v_cmt,''),' ',1) IS DISTINCT FROM v_marker
    OR v_cmt NOT LIKE v_marker||' previous_comment=%' THEN
  RAISE EXCEPTION 'Refusing 20261029230000 rollback: partial state (% of 7 functions with the 230000 body, CHECK definition=%, marker=%)',
   v_new, coalesce(v_def,'-'), coalesce(split_part(v_cmt,' ',1),'-');
 END IF;
 -- Data-loss guard: the previous bodies and CHECK accept Instagram only.
 SELECT count(*) INTO v_canary FROM public.automation_flow_canary_accounts WHERE platform<>'instagram';
 SELECT count(*) INTO v_runs FROM public.automation_flow_runs
 WHERE platform<>'instagram' AND run_status IN('ready','awaiting_input','sleeping');
 SELECT count(*) INTO v_open FROM public.automation_flow_outbox o
 JOIN public.automation_flow_runs run ON run.tenant_id=o.tenant_id AND run.id=o.run_id
 WHERE run.platform<>'instagram' AND o.delivery_status IN('pending','retry_wait','leased');
 IF v_canary>0 OR v_runs>0 OR v_open>0 THEN
  RAISE EXCEPTION 'Refusing 20261029230000 rollback: non-Instagram durable data still depends on it (% WhatsApp/Facebook canary registration(s), % active run(s), % open outbox effect(s)); turn FLOW_MULTICHANNEL_ENABLED off, delete the non-Instagram canary registrations, end the active runs (flow_cancel_run) and cancel or finish the open effects first',
   v_canary, v_runs, v_open;
 END IF;
END
$g$;

-- Previous CHECK (same name, same definition, previous comment).
DO $check$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029230000_FLOW_MULTICHANNEL_SUPPORT';
 v_c text;
 v_prev text;
BEGIN
 SELECT obj_description(c.oid,'pg_constraint') INTO v_c
 FROM pg_catalog.pg_constraint c
 WHERE c.conrelid='public.automation_flow_canary_accounts'::regclass
  AND c.conname='automation_flow_canary_accounts_platform_chk';
 v_prev := (substr(v_c,length(v_marker||' previous_comment=')+1)::json)#>>'{}';
 ALTER TABLE public.automation_flow_canary_accounts
  DROP CONSTRAINT automation_flow_canary_accounts_platform_chk;
 ALTER TABLE public.automation_flow_canary_accounts
  ADD CONSTRAINT automation_flow_canary_accounts_platform_chk
  CHECK(platform='instagram') NOT VALID;
 ALTER TABLE public.automation_flow_canary_accounts
  VALIDATE CONSTRAINT automation_flow_canary_accounts_platform_chk;
 EXECUTE format('COMMENT ON CONSTRAINT automation_flow_canary_accounts_platform_chk ON public.automation_flow_canary_accounts IS %L', v_prev);
END
$check$;

-- flow_claim_inbound_durable: previous body (verbatim).
CREATE OR REPLACE FUNCTION public.flow_claim_inbound_durable(
 p_tenant_id uuid,
 p_account_id uuid,
 p_platform text,
 p_provider_event_id text,
 p_conversation_id uuid,
 p_inbound_message_id uuid
) RETURNS TABLE(acquired boolean,route text,claim_id uuid,outgoing_message_id uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $claim$
DECLARE v_id uuid;v_route text;v_outgoing uuid;j jsonb;
BEGIN
 IF p_tenant_id IS NULL OR p_account_id IS NULL OR p_conversation_id IS NULL OR
    p_inbound_message_id IS NULL OR p_platform IS DISTINCT FROM 'instagram' OR
    p_provider_event_id IS NULL OR length(p_provider_event_id) NOT BETWEEN 1 AND 256
 THEN RETURN; END IF;
 -- Same ownership rule as flow_claim_inbound, and the conversation must be
 -- bound to this account (flow_begin_durable_run refuses anything else).
 IF NOT EXISTS (
   SELECT 1 FROM public.messages m JOIN public.conversations c
     ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id
     JOIN public.channel_accounts a
       ON a.id=p_account_id AND a.tenant_id=c.tenant_id
   WHERE m.id=p_inbound_message_id AND m.tenant_id=p_tenant_id
     AND m.direction='in' AND m.conversation_id=p_conversation_id
     AND m.wa_message_id=p_provider_event_id
     AND c.account_id=p_account_id
     AND a.platform=p_platform
 ) THEN RETURN; END IF;
 -- Operator-registered canary: tenant, account and platform must all match.
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_canary_accounts r
   WHERE r.tenant_id=p_tenant_id AND r.channel_account_id=p_account_id
     AND r.platform=p_platform)
 THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch g
    WHERE g.singleton AND g.enabled IS TRUE)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches s
    WHERE s.tenant_id=p_tenant_id AND s.enabled IS TRUE
      AND s.production_approved IS TRUE AND s.test_only IS FALSE)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_activations f
    WHERE f.tenant_id=p_tenant_id AND f.channel_account_id=p_account_id
      AND f.platform=p_platform AND f.is_active)
 THEN RETURN; END IF;
 -- Optional live-only flags (absent column = enabled), as begin requires.
 SELECT to_jsonb(t) INTO j FROM public.tenants t WHERE t.id=p_tenant_id;
 IF j IS NULL OR (j ? 'is_active' AND (j->>'is_active') IS DISTINCT FROM 'true')
 THEN RETURN; END IF;
 SELECT to_jsonb(ca) INTO j FROM public.channel_accounts ca
 WHERE ca.tenant_id=p_tenant_id AND ca.id=p_account_id;
 IF j IS NULL
  OR (j ? 'is_active' AND (j->>'is_active') IS DISTINCT FROM 'true')
  OR (j ? 'agent_enabled' AND (j->>'agent_enabled') IS DISTINCT FROM 'true')
  OR (j ? 'auto_reply' AND (j->>'auto_reply') IS DISTINCT FROM 'true')
 THEN RETURN; END IF;

 -- PostgreSQL unique conflict serialization is the exclusivity barrier,
 -- shared with V2's flow_claim_inbound (same table, same keys).
 INSERT INTO public.automation_message_claims(
  tenant_id,channel_account_id,platform,provider_event_id,conversation_id,
  inbound_message_id,route)
 VALUES(p_tenant_id,p_account_id,p_platform,p_provider_event_id,
        p_conversation_id,p_inbound_message_id,'flow')
 ON CONFLICT DO NOTHING
 RETURNING automation_message_claims.id,automation_message_claims.route,
  automation_message_claims.outgoing_message_id
 INTO v_id,v_route,v_outgoing;

 IF v_id IS NOT NULL THEN
  INSERT INTO public.automation_flow_canary_claims(
   tenant_id,channel_account_id,platform,provider_event_id)
  VALUES(p_tenant_id,p_account_id,p_platform,p_provider_event_id);
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

-- flow_begin_durable_run: previous body (verbatim).
CREATE OR REPLACE FUNCTION public.flow_begin_durable_run(
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

-- flow_resume_button_run: previous body (verbatim).
CREATE OR REPLACE FUNCTION public.flow_resume_button_run(
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

-- flow_end_stale_paused_runs: previous body (verbatim).
CREATE OR REPLACE FUNCTION public.flow_end_stale_paused_runs(
 p_max_age_minutes integer DEFAULT 1440,p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $stale$
DECLARE r record; n integer := 0; v_age integer; v_limit integer;
BEGIN
 v_age := least(greatest(coalesce(p_max_age_minutes,1440),60),10080);
 v_limit := least(greatest(coalesce(p_limit,100),1),500);
 FOR r IN
  SELECT run.tenant_id,run.id
  FROM public.automation_flow_runs run
  WHERE run.run_status='sleeping'
   AND run.wake_at<=now()-make_interval(mins=>v_age)
   AND NOT EXISTS(SELECT 1 FROM public.automation_flow_run_leases l
     WHERE l.tenant_id=run.tenant_id AND l.run_id=run.id AND l.expires_at>now())
   AND (public.flow_channel_temporarily_paused(run.tenant_id,run.channel_account_id)
    OR NOT EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches x
     WHERE x.tenant_id=run.tenant_id AND x.enabled
      AND (x.test_only OR (x.production_approved AND run.platform='instagram'))))
  ORDER BY run.wake_at,run.id
  FOR UPDATE OF run SKIP LOCKED
  LIMIT v_limit
 LOOP
  IF public.flow_cancel_run(r.tenant_id,r.id,'stale','sleeping') THEN
   n := n+1;
  END IF;
 END LOOP;
 RETURN n;
END
$stale$;

-- flow_lease_due_runs: previous body (verbatim).
CREATE OR REPLACE FUNCTION public.flow_lease_due_runs(p_limit integer DEFAULT 20)
RETURNS TABLE(tenant_id uuid,run_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $lease$
DECLARE r record; t uuid; v_attempts integer; v_leased integer := 0;
        v_reason text; j jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN
  RAISE EXCEPTION 'Invalid lease batch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch g
               WHERE g.singleton AND g.enabled)
 THEN RETURN; END IF;
 PERFORM public.flow_end_stale_paused_runs(1440,100);
 FOR r IN SELECT run.tenant_id AS t_id,run.id AS r_id,run.channel_account_id,
   run.conversation_id,run.platform,run.flow_key,run.publication_revision
  FROM public.automation_flow_runs run
  JOIN public.automation_flow_tenant_switches x
   ON x.tenant_id=run.tenant_id AND x.enabled
     AND (x.test_only OR (x.production_approved AND run.platform='instagram'))
  WHERE run.run_status='sleeping' AND run.wake_at<=now()
   AND NOT EXISTS(SELECT 1 FROM public.automation_flow_run_leases l
     WHERE l.tenant_id=run.tenant_id AND l.run_id=run.id AND l.expires_at>now())
   AND NOT public.flow_channel_temporarily_paused(run.tenant_id,run.channel_account_id)
  ORDER BY run.wake_at,run.id
  FOR UPDATE OF run SKIP LOCKED LIMIT least(p_limit*5,500)
 LOOP
  EXIT WHEN v_leased>=p_limit;
  v_reason := NULL;
  IF NOT EXISTS(SELECT 1 FROM public.automation_flow_activations a
    WHERE a.tenant_id=r.t_id AND a.channel_account_id=r.channel_account_id
     AND a.platform=r.platform AND a.flow_key=r.flow_key
     AND a.revision=r.publication_revision AND a.is_active)
  THEN v_reason := 'revision_inactive'; END IF;
  IF v_reason IS NULL AND NOT EXISTS(SELECT 1 FROM public.tenants tn WHERE tn.id=r.t_id)
  THEN v_reason := 'ineligible'; END IF;
  IF v_reason IS NULL AND NOT EXISTS(SELECT 1 FROM public.channel_accounts ca
    WHERE ca.tenant_id=r.t_id AND ca.id=r.channel_account_id)
  THEN v_reason := 'ineligible'; END IF;
  IF v_reason IS NULL THEN
   SELECT to_jsonb(c) INTO j FROM public.conversations c
   WHERE c.tenant_id=r.t_id AND c.id=r.conversation_id;
   IF j IS NULL OR (j->>'account_id') IS DISTINCT FROM r.channel_account_id::text
   THEN v_reason := 'ineligible';
   ELSIF public.flow_conversation_human_takeover(r.t_id,r.conversation_id)
   THEN v_reason := 'human_takeover';
   END IF;
  END IF;
  IF v_reason IS NOT NULL THEN
   PERFORM public.flow_cancel_run(r.t_id,r.r_id,v_reason,'sleeping');
   CONTINUE;
  END IF;
  -- Temporary pause that appeared after the scan: leave sleeping, no lease.
  IF public.flow_channel_temporarily_paused(r.t_id,r.channel_account_id) THEN
   CONTINUE;
  END IF;

  t := NULL; v_attempts := NULL;
  INSERT INTO public.automation_flow_run_leases(tenant_id,run_id,token,expires_at,attempts)
  VALUES(r.t_id,r.r_id,gen_random_uuid(),now()+interval '2 minutes',1)
  ON CONFLICT ON CONSTRAINT automation_flow_run_leases_pkey DO UPDATE
  SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at,
      attempts=public.automation_flow_run_leases.attempts+1
  WHERE public.automation_flow_run_leases.expires_at<=now()
  RETURNING public.automation_flow_run_leases.token,
            public.automation_flow_run_leases.attempts INTO t,v_attempts;
  IF t IS NULL THEN CONTINUE; END IF;
  IF v_attempts>3 THEN
   PERFORM public.flow_cancel_run(r.t_id,r.r_id,'lease_exhausted','sleeping');
   CONTINUE;
  END IF;
  v_leased := v_leased+1;
  RETURN QUERY SELECT r.t_id,r.r_id,t;
 END LOOP;
END
$lease$;

-- flow_commit_run_step: previous body (verbatim).
CREATE OR REPLACE FUNCTION public.flow_commit_run_step(
 p_tenant uuid,p_run uuid,p_expect_step integer,p_expect_status text,
 p_next_node text,p_next_step integer,p_next_status text,
 p_variables jsonb,p_wake_at timestamptz,p_effects jsonb,p_metric text,
 p_lease_token uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $advance$
DECLARE old record; e jsonb; k text; kind text; payload jsonb;
BEGIN
 IF p_tenant IS NULL OR p_run IS NULL OR p_expect_step IS NULL OR
  p_expect_status IS NULL OR p_next_node IS NULL OR
  length(p_next_node) NOT BETWEEN 1 AND 128 OR
  p_next_step IS NULL OR p_next_step NOT BETWEEN 0 AND 150 OR
  p_next_step<=p_expect_step OR p_next_status IS NULL OR
  p_next_status NOT IN('ready','awaiting_input','sleeping','handoff','completed','blocked') OR
  p_variables IS NULL OR jsonb_typeof(p_variables)<>'object' OR
  octet_length(p_variables::text)>32768 OR
  p_effects IS NULL OR jsonb_typeof(p_effects)<>'array' OR
  jsonb_array_length(p_effects)>5 OR
  p_metric NOT IN('started','transition','button','completed','handoff','failed')
 THEN RETURN false; END IF;
 IF (p_next_status='sleeping') IS DISTINCT FROM (p_wake_at IS NOT NULL)
 THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch WHERE singleton AND enabled)
 OR NOT EXISTS(
   SELECT 1 FROM public.automation_flow_tenant_switches x
   JOIN public.automation_flow_runs r ON r.tenant_id=x.tenant_id AND r.id=p_run
   WHERE x.tenant_id=p_tenant AND x.enabled
    AND (x.test_only OR (x.production_approved AND r.platform='instagram'))
 ) THEN RETURN false; END IF;
 SELECT run_status,step_count,wake_at INTO old
 FROM public.automation_flow_runs WHERE id=p_run AND tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND OR old.run_status<>p_expect_status OR old.step_count<>p_expect_step OR
    old.run_status IN('completed','handoff','blocked')
 THEN RETURN false; END IF;
 IF old.run_status='sleeping' THEN
  IF old.wake_at>now() OR NOT EXISTS(
    SELECT 1 FROM public.automation_flow_run_leases WHERE
      tenant_id=p_tenant AND run_id=p_run AND token=p_lease_token AND expires_at>now())
  THEN RETURN false; END IF;
 END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p_effects)
 LOOP
  IF jsonb_typeof(e)<>'object' THEN RETURN false; END IF;
  k:=e->>'idempotencyKey';
  kind:=e->>'kind';
  payload:=e->'payload';
  IF k IS NULL OR length(k) NOT BETWEEN 1 AND 1024 OR
     kind NOT IN('message','question','delay','handoff','tag','untag','staff_notification','message_image') OR
     payload IS NULL OR jsonb_typeof(payload)<>'object' OR octet_length(payload::text)>65536
  THEN RETURN false; END IF;
  INSERT INTO public.automation_flow_outbox(
    tenant_id,run_id,idempotency_key,effect_kind,payload)
  VALUES(p_tenant,p_run,k,kind,payload)
  ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
 END LOOP;
 UPDATE public.automation_flow_runs
 SET current_node_id=p_next_node,step_count=p_next_step,run_status=p_next_status,
     variables=p_variables,wake_at=p_wake_at,updated_at=now()
 WHERE id=p_run AND tenant_id=p_tenant;
 INSERT INTO public.automation_flow_metrics(tenant_id,run_id,event_key)
 VALUES(p_tenant,p_run,p_metric);
 IF old.run_status='sleeping' THEN
  DELETE FROM public.automation_flow_run_leases WHERE tenant_id=p_tenant AND run_id=p_run;
 END IF;
 RETURN true;
END $advance$;

-- flow_reserve_outbox_delivery: previous body (verbatim).
CREATE OR REPLACE FUNCTION public.flow_reserve_outbox_delivery(p_tenant uuid,p_outbox uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $reserve$
DECLARE row_data record;
BEGIN
 IF p_tenant IS NULL OR p_outbox IS NULL THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch WHERE singleton AND enabled)
 OR NOT EXISTS(
   SELECT 1 FROM public.automation_flow_tenant_switches s
   JOIN public.automation_flow_outbox o ON o.tenant_id=s.tenant_id
   JOIN public.automation_flow_runs r ON r.tenant_id=o.tenant_id AND r.id=o.run_id
   WHERE s.tenant_id=p_tenant AND o.id=p_outbox AND s.enabled
    AND (s.test_only OR (s.production_approved AND r.platform='instagram'))
 ) THEN RETURN false;END IF;
 SELECT o.id,o.tenant_id,o.run_id,o.outgoing_message_id,
   c.id AS claim_id
 INTO row_data FROM public.automation_flow_outbox o
 JOIN public.automation_flow_runs r ON r.tenant_id=o.tenant_id AND r.id=o.run_id
 JOIN public.automation_message_claims c ON c.tenant_id=r.tenant_id
  AND c.channel_account_id=r.channel_account_id AND c.platform=r.platform
  AND c.provider_event_id=r.provider_event_id AND c.route='flow'
 JOIN public.automation_flow_activations a ON a.tenant_id=r.tenant_id
  AND a.channel_account_id=r.channel_account_id AND a.platform=r.platform
  AND a.flow_key=r.flow_key AND a.revision=r.publication_revision AND a.is_active
 WHERE o.tenant_id=p_tenant AND o.id=p_outbox
  AND o.delivery_status='pending' AND o.effect_kind IN('message','question','message_image')
 FOR UPDATE OF o SKIP LOCKED;
 IF NOT FOUND THEN RETURN false;END IF;
 -- Claim is a link to the incoming event, not a single-send lock; this table
 -- records each effect independently, preserving distinct outgoing IDs.
 INSERT INTO public.automation_flow_delivery_attempts(
  tenant_id,outbox_id,claim_id,outgoing_message_id)
 VALUES(p_tenant,p_outbox,row_data.claim_id,row_data.outgoing_message_id)
 ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN false;END IF;
 UPDATE public.automation_flow_outbox SET delivery_status='leased',
  attempts=attempts+1,lease_token=gen_random_uuid(),
  lease_expires_at=now()+interval '2 minutes'
 WHERE tenant_id=p_tenant AND id=p_outbox;
 RETURN true;
END $reserve$;
COMMIT;
