-- REVIEW ONLY: V3 durable Instagram button run (start + button continuation).
-- NOT applied anywhere by this repository; apply only with an explicit owner GO.
--
-- Reconciles the executable migration chain with the two service-only RPCs
-- that milan-api (supabase/functions/milan-api/flowDurableIngress.ts) calls
-- and that 20261029170000_flow_canary_claim_durable requires in its preflight:
--   public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)
--   public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)
-- Until now they existed only in the staged proposal
-- supabase/proposals/flow_durable_button_ingress.review.sql. The function
-- bodies below are BYTE-IDENTICAL to that proposal (same signatures, argument
-- names, SECURITY INVOKER, search_path='', REVOKE/GRANT). No semantic change.
-- The 170000 preflight message "apply supabase/proposals/
-- flow_durable_button_ingress.review.sql first" is satisfied by this migration.
--
-- Not included (not required by the two functions): the proposal's partial
-- unique index flow_one_awaiting_input_per_conversation. One active run per
-- conversation is enforced later by 20261029130000 (index
-- flow_one_active_run_per_conversation + trigger flow_one_active_run_guard).
-- If the proposal was applied, its index is left exactly as it is.
--
-- Already installed (e.g. production applied the proposal): every function
-- whose normalized definition (body text with whitespace collapsed, language,
-- return type, argument names, security, search_path, volatility,
-- strictness) equals the one below is LEFT UNCHANGED (no replace, no ownership
-- marker). A differing definition, or another overload with the same name, is
-- REFUSED, so a production-specific body is never silently overwritten. The
-- only statements that touch a pre-existing identical function are the
-- idempotent REVOKE/GRANT at the end, which re-assert the proposal's own
-- service_role-only privileges.
--
-- Prerequisites (preflight refuses otherwise): tenants, channel_accounts,
-- conversations, messages, automation_flow_* runtime tables (installed shape:
-- tests/sql/fixtures/installed-flow-runtime.sql, installed-flow-switches.sql),
-- automation_message_claims (20261028220000), flow_commit_run_step
-- (20261028225000), the receipts unique key used by ON CONFLICT DO NOTHING,
-- and the roles anon/authenticated/service_role. The live-only columns
-- tenants.is_active, channel_accounts.is_active/agent_enabled/auto_reply and
-- automation_flow_tenant_switches.production_approved are read when the
-- functions RUN (PL/pgSQL binds them at execution); if absent this migration
-- warns, and every call fails with an error (no row is written) until they exist.
--
-- Order: after 20261028220000, 20261028225000 (and every other existing
-- migration up to 20261029122000); before 20261029130000..170000 (170000's
-- preflight requires these functions). Billing/credits are not referenced.
-- Rollback: supabase/rollbacks/20261029125000_flow_durable_button_run.rollback.sql
-- (LAST: after the 170000, 160000, 150000, 140000, 130000 rollbacks; it refuses
-- while any of their objects exist and drops only functions carrying the
-- marker below).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $migration$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029125000_FLOW_DURABLE_BUTTON_RUN';
 v_name text;
 v_tbl text;
 v_col text;
 v_missing text := '';
 v_fn regprocedure;
 r record;
 p record;
 -- Bodies: byte-identical to supabase/proposals/flow_durable_button_ingress.review.sql.
 v_begin_src constant text := $begin$
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
 v_resume_src constant text := $resume$
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
   RAISE EXCEPTION 'Durable button run prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY[
  'tenants','channel_accounts','conversations','messages',
  'automation_message_claims','automation_flow_global_switch',
  'automation_flow_tenant_switches','automation_flow_activations',
  'automation_flow_publications','automation_flow_event_receipts',
  'automation_flow_runs','automation_flow_outbox'
 ] LOOP
  IF to_regclass('public.'||v_name) IS NULL THEN
   RAISE EXCEPTION 'Durable button run prerequisite missing: table public.%', v_name;
  END IF;
 END LOOP;
 -- Columns the function bodies (and flow_commit_run_step) read or write.
 FOREACH v_name IN ARRAY ARRAY[
  'automation_message_claims.id','automation_message_claims.tenant_id',
  'automation_message_claims.channel_account_id','automation_message_claims.conversation_id',
  'automation_message_claims.inbound_message_id','automation_message_claims.platform',
  'automation_message_claims.route','automation_message_claims.provider_event_id',
  'messages.id','messages.tenant_id','messages.direction','messages.wa_message_id',
  'conversations.id','conversations.tenant_id','conversations.account_id',
  'channel_accounts.id','channel_accounts.tenant_id','channel_accounts.platform',
  'tenants.id',
  'automation_flow_global_switch.singleton','automation_flow_global_switch.enabled',
  'automation_flow_tenant_switches.tenant_id','automation_flow_tenant_switches.enabled',
  'automation_flow_activations.tenant_id','automation_flow_activations.channel_account_id',
  'automation_flow_activations.platform','automation_flow_activations.flow_key',
  'automation_flow_activations.revision','automation_flow_activations.is_active',
  'automation_flow_publications.tenant_id','automation_flow_publications.channel_account_id',
  'automation_flow_publications.platform','automation_flow_publications.flow_key',
  'automation_flow_publications.revision','automation_flow_publications.document',
  'automation_flow_event_receipts.tenant_id','automation_flow_event_receipts.channel_account_id',
  'automation_flow_event_receipts.platform','automation_flow_event_receipts.provider_event_id',
  'automation_flow_runs.id','automation_flow_runs.tenant_id','automation_flow_runs.flow_key',
  'automation_flow_runs.publication_revision','automation_flow_runs.channel_account_id',
  'automation_flow_runs.platform','automation_flow_runs.conversation_id',
  'automation_flow_runs.provider_event_id','automation_flow_runs.current_node_id',
  'automation_flow_runs.run_status','automation_flow_runs.step_count',
  'automation_flow_runs.variables'
 ] LOOP
  v_tbl := split_part(v_name,'.',1); v_col := split_part(v_name,'.',2);
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=to_regclass('public.'||v_tbl) AND a.attname=v_col
     AND a.attnum>0 AND NOT a.attisdropped) THEN
   RAISE EXCEPTION 'Durable button run prerequisite missing: column public.%', v_name;
  END IF;
 END LOOP;
 -- Live-only columns: bound when the functions run, not when they are created.
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
  RAISE WARNING 'Durable button run: live-only column(s) absent:% (every call errors and writes nothing until they exist)', v_missing;
 END IF;
 -- 20261028220000 claim table (exact ownership marker).
 IF obj_description(to_regclass('public.automation_message_claims'),'pg_class')
    IS DISTINCT FROM 'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM' THEN
  RAISE EXCEPTION 'Missing or unrecognized public.automation_message_claims; apply 20261028220000_webhook_exclusive_claim first';
 END IF;
 -- 20261028225000 transition function (exact signature, marker, boolean result).
 v_fn := to_regprocedure('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)');
 IF v_fn IS NULL
 OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM 'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE'
 OR (SELECT prorettype FROM pg_catalog.pg_proc WHERE oid=v_fn)<>'boolean'::regtype THEN
  RAISE EXCEPTION 'Missing or unrecognized public.flow_commit_run_step; apply 20261028225000_flow_runtime_advance first';
 END IF;
 -- Idempotency barrier: ON CONFLICT DO NOTHING on the provider event receipt.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
   WHERE i.indrelid='public.automation_flow_event_receipts'::regclass
    AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
    AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
         FROM unnest(i.indkey::int2[]) k(attnum)
         JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)
        =ARRAY['channel_account_id','platform','provider_event_id','tenant_id']) THEN
  RAISE EXCEPTION 'automation_flow_event_receipts has no unique (tenant_id,channel_account_id,platform,provider_event_id) key; abort';
 END IF;

 -- ---------------------------------------------------------------- functions
 FOR r IN SELECT * FROM (VALUES
  ('flow_begin_durable_run',
   'public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
   v_begin_src,v_begin_head,'begin','uuid'::regtype,
   ARRAY['p_tenant','p_account','p_conversation','p_inbound','p_event','p_flow','p_revision',
    'p_start','p_next','p_next_step','p_status','p_variables','p_wake','p_effects']),
  ('flow_resume_button_run',
   'public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)',
   v_resume_src,v_resume_head,'resume','boolean'::regtype,
   ARRAY['p_tenant','p_run','p_event','p_inbound','p_expect_step','p_expect_node','p_next',
    'p_next_step','p_status','p_variables','p_wake','p_effects'])
 ) f(name,sig,src,head,tag,ret,args) LOOP
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc x
    WHERE x.pronamespace='public'::regnamespace AND x.proname=r.name
     AND x.oid IS DISTINCT FROM to_regprocedure(r.sig)) THEN
   RAISE EXCEPTION 'Unrecognized overload of public.% exists; refusing to install %', r.name, r.sig;
  END IF;
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL THEN
   EXECUTE r.head||'$'||r.tag||'$'||r.src||'$'||r.tag||'$';
   EXECUTE format('COMMENT ON FUNCTION %s IS %L', r.sig, v_marker);
  ELSE
   SELECT x.* INTO p FROM pg_catalog.pg_proc x WHERE x.oid=v_fn;
   -- Normalized body: whitespace runs collapsed to one space, then trimmed
   -- (same rule as the predeploy checks' durable_button_run rows).
   IF btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))
      IS DISTINCT FROM btrim(regexp_replace(r.src,'[[:space:]]+',' ','g'))
   OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
   OR p.prorettype IS DISTINCT FROM r.ret OR p.proretset OR p.prokind<>'f'
   OR p.prosecdef OR p.proisstrict OR p.provolatile<>'v' OR p.pronargdefaults<>0
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
   OR p.proargnames IS DISTINCT FROM r.args THEN
    RAISE EXCEPTION 'Existing % differs from the reviewed durable button run definition (marker=%); refusing to overwrite. Compare it with supabase/proposals/flow_durable_button_ingress.review.sql',
     r.sig, coalesce(obj_description(v_fn,'pg_proc'),'-');
   END IF;
   RAISE NOTICE '% already installed with the identical definition (marker=%); left unchanged',
    r.sig, coalesce(obj_description(v_fn,'pg_proc'),'-');
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
