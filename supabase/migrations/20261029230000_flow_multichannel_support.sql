-- REVIEW ONLY: durable Flow V3/V4 support for WhatsApp and Facebook Messenger
-- canary accounts. NOT applied anywhere by this repository; apply only with an
-- explicit owner GO. Sending and ingress stay OFF behind
-- FLOW_MULTICHANNEL_ENABLED (default OFF) in milan-api and flow-outbox-worker:
-- with the flag off no WhatsApp/Facebook event ever reaches these functions,
-- so behaviour is unchanged.
--
-- Changes (nothing else is touched). Every hard-coded 'instagram' comparison
-- of the durable chain now accepts the single allowed list
-- ('instagram','whatsapp','facebook'), compared against the row's OWN
-- platform (claim / account / run), never against a caller-supplied value
-- alone. For an Instagram row every predicate is equivalent to the previous
-- one, so Instagram behaviour is unchanged:
--  1. CHECK automation_flow_canary_accounts_platform_chk (same name):
--     platform='instagram' -> platform IN ('instagram','whatsapp','facebook')
--     (strict superset: added NOT VALID, then VALIDATE). Marker comment
--     'CREATED_BY_20261029230000_FLOW_MULTICHANNEL_SUPPORT previous_comment=<json>'.
--     The composite FK (tenant_id,channel_account_id,platform) ->
--     channel_accounts still binds a registration to its tenant's account.
--  2. flow_claim_inbound_durable (170000 body): p_platform must be one of the
--     list (was: 'instagram'); the existing checks already require
--     a.platform=p_platform and a canary registration for exactly
--     (tenant, account, platform).
--  3. flow_begin_durable_run (180000 body; flow_begin_durable_run_superseding
--     of 20261029190000 only calls it and has no platform literal): the
--     platform is the claimed account's own platform (cl.platform=a.platform,
--     a.platform in the list) and is used for the activation, the receipt and
--     the run row. The document trigger must name the same platform, mapped
--     account 'facebook' <-> document trigger 'messenger' (src/flow/model.ts),
--     'instagram'/'whatsapp' unchanged.
--  4. flow_resume_button_run (180000 body): the run's own platform (in the
--     list) is required of its activation, account, claim and receipt.
--  5. flow_end_stale_paused_runs, flow_lease_due_runs (150000 bodies),
--     flow_commit_run_step, flow_reserve_outbox_delivery (210000 bodies):
--     production_approved admits a run whose platform is in the list (was:
--     'instagram'); test_only is unchanged.
-- Not changed: flow_finish_outbox_delivery ('rejected' stays image-only),
-- flow_skip_blocked_outbox, flow_claim_inbound (V2), billing/credits,
-- signatures, argument names, defaults, return types, LANGUAGE plpgsql,
-- SECURITY INVOKER, SET search_path='', tenant scoping (every statement is
-- still keyed by the tenant) and the service_role-only privileges. The
-- replaced functions keep their existing ownership comments on purpose (the
-- older preflights, rollbacks and the read-only pre-deploy checks pin them);
-- ownership of every replaced body is proven by body hash (md5 of the
-- whitespace-normalized prosrc, as 20261029190000/210000/220000 do).
--
-- Preflight refuses unless: roles anon/authenticated/service_role exist; the
-- 20261029130000 .. 20261029190000 markers, the 170000 canary tables and the
-- 20261029220000 sweep body are installed; each replaced function exists with
-- its marker, attributes and EITHER its exact previous body OR this
-- migration's body (any other body or overload is refused, never
-- overwritten); and the canary platform CHECK is exactly the 170000
-- definition or this migration's marked definition.
-- Re-apply is idempotent (same bodies; marked CHECK left unchanged).
-- Lock impact: ALTER TABLE on automation_flow_canary_accounts (operator-owned,
-- a handful of rows). lock_timeout 3s / statement_timeout 60s.
--
-- Order: after 20261029220000 (newest flow migration). Deploy the milan-api /
-- flow-outbox-worker builds first or after (both are inert while
-- FLOW_MULTICHANNEL_ENABLED is off); register a WhatsApp/Facebook canary
-- (operator, table owner) only after this migration. Rollback:
-- supabase/rollbacks/20261029230000_flow_multichannel_support.rollback.sql
-- FIRST, before 20261029220000, 210000, 190000, 180000, 170000, 160000,
-- 150000, 140000, 130000 and 125000 (each refuses while a 230000 body or the
-- marked CHECK is installed).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029230000_FLOW_MULTICHANNEL_SUPPORT';
 -- Exact canary platform CHECK definitions (pg_get_constraintdef): 170000 and this migration.
 v_chk_old constant text := 'CHECK ((platform = ''instagram''::text))';
 v_chk_new constant text := 'CHECK ((platform = ANY (ARRAY[''instagram''::text, ''whatsapp''::text, ''facebook''::text])))';
 v_con constant text := 'automation_flow_canary_accounts_platform_chk';
 -- md5 of the whitespace-normalized 20261029220000 flow_skip_blocked_outbox body.
 v_sweep_220_md5 constant text := 'dacdf7bb582a7d380651d478f47c6b97';
 v_name text;
 v_fn regprocedure;
 v_n integer;
 v_def text;
 v_cname text;
 v_cmt text;
 r record;
 p record;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_name) THEN
   RAISE EXCEPTION 'Multichannel support prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY['automation_flow_canary_accounts','automation_flow_canary_claims'] LOOP
  IF obj_description(to_regclass('public.'||v_name),'pg_class')
     IS DISTINCT FROM 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE' THEN
   RAISE EXCEPTION 'Missing or unrecognized 20261029170000 object public.%; apply 20261029170000_flow_canary_claim_durable first', v_name;
  END IF;
 END LOOP;
 -- 20261029130000 .. 20261029190000 chain (exact ownership markers).
 FOR r IN SELECT * FROM (VALUES
  ('public.flow_cancel_run(uuid,uuid,text,text)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','20261029130000_flow_run_lifecycle'),
  ('public.flow_claim_outbox_ai(uuid,uuid,integer,integer)','CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY','20261029140000_flow_outbox_ai_retry'),
  ('public.flow_channel_temporarily_paused(uuid,uuid)','CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE','20261029160000_flow_credits_pause'),
  ('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
   'CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING','20261029190000_flow_begin_durable_run_superseding')
 ) c(sig,marker,mig) LOOP
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM r.marker THEN
   RAISE EXCEPTION 'Missing or unrecognized % object %; apply % first', split_part(r.mig,'_',1), r.sig, r.mig;
  END IF;
 END LOOP;
 -- 20261029220000 (newest flow migration before this one): exact sweep body.
 IF (SELECT md5(btrim(regexp_replace(x.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc x
     WHERE x.oid=to_regprocedure('public.flow_skip_blocked_outbox(integer,integer)'))
    IS DISTINCT FROM v_sweep_220_md5 THEN
  RAISE EXCEPTION 'public.flow_skip_blocked_outbox does not have the 20261029220000 definition; apply 20261029220000_flow_media_stale_sweep first';
 END IF;

 -- The seven functions replaced here: marker, attributes and EXACT previous
 -- (or this migration's) body: md5 of the whitespace-normalized prosrc.
 FOR r IN SELECT * FROM (VALUES
 ('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)',
  'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE',false,'20261029170000_flow_canary_claim_durable',
  'p_tenant_id uuid, p_account_id uuid, p_platform text, p_provider_event_id text, p_conversation_id uuid, p_inbound_message_id uuid',
  'TABLE(acquired boolean, route text, claim_id uuid, outgoing_message_id uuid)',
  '6fc0c342af5bfc155c9057428791e1fd','c9299f42239a6a4f275ba4be61e04b9d'),
 ('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
  'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS',true,'20261029180000_flow_durable_button_run_guards',
  'p_tenant uuid, p_account uuid, p_conversation uuid, p_inbound uuid, p_event text, p_flow text, p_revision bigint, p_start text, p_next text, p_next_step integer, p_status text, p_variables jsonb, p_wake timestamp with time zone, p_effects jsonb',
  'uuid',
  '80953ca6c0b52e627699748b59f383f9','d0fea89cd85053ee62276bccf4156d43'),
 ('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)',
  'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS',true,'20261029180000_flow_durable_button_run_guards',
  'p_tenant uuid, p_run uuid, p_event text, p_inbound uuid, p_expect_step integer, p_expect_node text, p_next text, p_next_step integer, p_status text, p_variables jsonb, p_wake timestamp with time zone, p_effects jsonb',
  'boolean',
  '7a65417ddf106671862eea0da80d8c73','0d4917f27cece556b549c5ca0c7046a2'),
 ('public.flow_end_stale_paused_runs(integer,integer)',
  'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME',false,'20261029150000_flow_takeover_resume',
  'p_max_age_minutes integer DEFAULT 1440, p_limit integer DEFAULT 100',
  'integer',
  'ca56c8772ed58e2952f5b7da61c25b77','c7a764911307aefeb1f593312364d440'),
 ('public.flow_lease_due_runs(integer)',
  'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE',false,'20261029150000_flow_takeover_resume',
  'p_limit integer DEFAULT 20',
  'TABLE(tenant_id uuid, run_id uuid, lease_token uuid)',
  'c54246eacd947ae32841ae3995a4a7a7','7cddbd9a4964716eec402f399e878a78'),
 ('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)',
  'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE',false,'20261029210000_flow_media_effects',
  'p_tenant uuid, p_run uuid, p_expect_step integer, p_expect_status text, p_next_node text, p_next_step integer, p_next_status text, p_variables jsonb, p_wake_at timestamp with time zone, p_effects jsonb, p_metric text, p_lease_token uuid DEFAULT NULL::uuid',
  'boolean',
  '94a87bc016ad93e609897025d259bf3e','f5b147309700470f8b9f410dda5a6df0'),
 ('public.flow_reserve_outbox_delivery(uuid,uuid)',
  'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY',false,'20261029210000_flow_media_effects',
  'p_tenant uuid, p_outbox uuid',
  'boolean',
  '1b7a6fe3f6a9ee97203d50d5e0e0baa7','4a8882ddd7ad430c4187db821cc3de99')
 ) f(sig,marker,prefix,mig,args,res,h_old,h_new) LOOP
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc x
    WHERE x.pronamespace='public'::regnamespace AND x.proname=split_part(substr(r.sig,8),'(',1)
     AND x.oid IS DISTINCT FROM to_regprocedure(r.sig)) THEN
   RAISE EXCEPTION 'Unrecognized overload of % exists; refusing to replace it', split_part(r.sig,'(',1);
  END IF;
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL
  OR (NOT r.prefix AND obj_description(v_fn,'pg_proc') IS DISTINCT FROM r.marker)
  OR (r.prefix AND split_part(coalesce(obj_description(v_fn,'pg_proc'),''),' ',1) IS DISTINCT FROM r.marker) THEN
   RAISE EXCEPTION 'Missing or unrecognized %; apply % first', r.sig, r.mig;
  END IF;
  SELECT x.* INTO p FROM pg_catalog.pg_proc x WHERE x.oid=v_fn;
  IF p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR p.prokind<>'f' OR p.prosecdef OR p.proisstrict OR p.provolatile<>'v'
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
  OR pg_catalog.pg_get_function_arguments(v_fn) IS DISTINCT FROM r.args
  OR pg_catalog.pg_get_function_result(v_fn) IS DISTINCT FROM r.res
  OR md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) NOT IN(r.h_old,r.h_new) THEN
   RAISE EXCEPTION 'Existing % differs from both the % and the 20261029230000 definition; refusing to overwrite',
    r.sig, split_part(r.mig,'_',1);
  END IF;
 END LOOP;

 -- Canary platform CHECK: exactly one single-column CHECK on platform, with
 -- the 170000 name and either the 170000 definition or this migration's
 -- definition carrying this migration's marker.
 SELECT count(*),min(pg_catalog.pg_get_constraintdef(c.oid)),min(c.conname::text),
  min(obj_description(c.oid,'pg_constraint'))
 INTO v_n,v_def,v_cname,v_cmt
 FROM pg_catalog.pg_constraint c
 WHERE c.conrelid='public.automation_flow_canary_accounts'::regclass AND c.contype='c'
  AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%platform%';
 IF v_n<>1 OR v_cname IS DISTINCT FROM v_con OR v_def NOT IN(v_chk_old,v_chk_new) THEN
  RAISE EXCEPTION 'Unrecognized CHECK on public.automation_flow_canary_accounts.platform (count=%, name=%, definition=%); refusing to replace it',
   v_n, coalesce(v_cname,'-'), coalesce(v_def,'-');
 END IF;
 IF v_def=v_chk_new AND split_part(coalesce(v_cmt,''),' ',1) IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'CHECK % has the 20261029230000 definition without its marker; refusing', v_con;
 END IF;
 IF v_def=v_chk_old AND split_part(coalesce(v_cmt,''),' ',1)=v_marker THEN
  RAISE EXCEPTION 'CHECK % carries the 20261029230000 marker without its definition; refusing', v_con;
 END IF;
END
$preflight$;

-- Canary platform CHECK: same name; NOT VALID, then VALIDATE (a strict
-- superset: every existing row stays valid); marker plus the previous comment.
DO $check$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029230000_FLOW_MULTICHANNEL_SUPPORT';
 v_prev text;
BEGIN
 SELECT obj_description(c.oid,'pg_constraint') INTO v_prev
 FROM pg_catalog.pg_constraint c
 WHERE c.conrelid='public.automation_flow_canary_accounts'::regclass
  AND c.conname='automation_flow_canary_accounts_platform_chk';
 IF split_part(coalesce(v_prev,''),' ',1)=v_marker THEN
  RAISE NOTICE 'CHECK automation_flow_canary_accounts_platform_chk already has the 20261029230000 definition; left unchanged';
 ELSE
  ALTER TABLE public.automation_flow_canary_accounts
   DROP CONSTRAINT automation_flow_canary_accounts_platform_chk;
  ALTER TABLE public.automation_flow_canary_accounts
   ADD CONSTRAINT automation_flow_canary_accounts_platform_chk
   CHECK(platform IN('instagram','whatsapp','facebook')) NOT VALID;
  ALTER TABLE public.automation_flow_canary_accounts
   VALIDATE CONSTRAINT automation_flow_canary_accounts_platform_chk;
  EXECUTE format('COMMENT ON CONSTRAINT automation_flow_canary_accounts_platform_chk ON public.automation_flow_canary_accounts IS %L',
   v_marker||' previous_comment='||coalesce(to_json(v_prev)::text,'null'));
 END IF;
END
$check$;

-- flow_claim_inbound_durable: previous body; only the platform comparisons change (see header).
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
    p_inbound_message_id IS NULL OR p_platform IS NULL OR
    p_platform NOT IN('instagram','whatsapp','facebook') OR
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

-- flow_begin_durable_run: previous body; only the platform comparisons change (see header).
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
     AND n#>>'{data,triggerMode}'='message')
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

-- flow_resume_button_run: previous body; only the platform comparisons change (see header).
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
 IF NOT FOUND OR old_run.platform IS NULL OR
    old_run.platform NOT IN('instagram','whatsapp','facebook') THEN RETURN false;END IF;

 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch
               WHERE singleton AND enabled)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches
               WHERE tenant_id=p_tenant AND enabled AND production_approved)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_activations
    WHERE tenant_id=p_tenant AND channel_account_id=old_run.channel_account_id
     AND platform=old_run.platform AND flow_key=old_run.flow_key
     AND revision=old_run.publication_revision AND is_active)
 OR NOT EXISTS(
  SELECT 1 FROM public.channel_accounts a
  JOIN public.tenants t ON t.id=a.tenant_id
  WHERE a.tenant_id=p_tenant AND a.id=old_run.channel_account_id
   AND a.platform=old_run.platform AND a.is_active
   AND a.agent_enabled AND a.auto_reply AND t.is_active)
 OR NOT EXISTS(
  SELECT 1 FROM public.automation_message_claims cl
  JOIN public.messages m ON m.tenant_id=cl.tenant_id AND m.id=cl.inbound_message_id
  WHERE cl.tenant_id=p_tenant AND cl.channel_account_id=old_run.channel_account_id
   AND cl.conversation_id=old_run.conversation_id AND cl.platform=old_run.platform
   AND cl.route='flow' AND cl.provider_event_id=p_event
   AND cl.inbound_message_id=p_inbound AND m.direction='in'
   AND m.wa_message_id=p_event AND m.conversation_id=old_run.conversation_id
 ) THEN RETURN false;END IF;

 INSERT INTO public.automation_flow_event_receipts(
  tenant_id,channel_account_id,platform,provider_event_id)
 VALUES(p_tenant,old_run.channel_account_id,old_run.platform,p_event)
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

-- flow_end_stale_paused_runs: previous body; only the platform comparisons change (see header).
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
      AND (x.test_only OR (x.production_approved AND run.platform IN('instagram','whatsapp','facebook')))))
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

-- flow_lease_due_runs: previous body; only the platform comparisons change (see header).
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
     AND (x.test_only OR (x.production_approved AND run.platform IN('instagram','whatsapp','facebook')))
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

-- flow_commit_run_step: previous body; only the platform comparisons change (see header).
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
    AND (x.test_only OR (x.production_approved AND r.platform IN('instagram','whatsapp','facebook')))
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

-- flow_reserve_outbox_delivery: previous body; only the platform comparisons change (see header).
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
    AND (s.test_only OR (s.production_approved AND r.platform IN('instagram','whatsapp','facebook')))
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

-- Same service_role-only privileges as before (CREATE OR REPLACE keeps the
-- OIDs, ACLs and ownership comments; restated for safety).
REVOKE ALL ON FUNCTION public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_end_stale_paused_runs(integer,integer)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_lease_due_runs(integer)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_reserve_outbox_delivery(uuid,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_end_stale_paused_runs(integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_lease_due_runs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_reserve_outbox_delivery(uuid,uuid) TO service_role;
COMMIT;
