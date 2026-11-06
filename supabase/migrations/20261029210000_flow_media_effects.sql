-- REVIEW ONLY: database support for the 'message_image' Outbox effect
-- (Instagram image attachment). NOT applied anywhere by this repository;
-- apply only with an explicit owner GO. Sending stays OFF behind
-- FLOW_MEDIA_SEND_ENABLED (default OFF) in milan-api and flow-outbox-worker:
-- this migration lets the database STORE, reserve and finish such effects, it
-- never sends anything by itself.
--
-- Changes (nothing else is touched):
--  1. CHECK on public.automation_flow_outbox(effect_kind): the existing
--     single-column CHECK (live/fixture shape: message, question, delay,
--     handoff, tag, untag, staff_notification) is replaced, under the SAME
--     constraint name, by the same list plus 'message_image' (a strict
--     superset: every existing row stays valid). Refused unless exactly one
--     single-column CHECK on effect_kind exists, no other CHECK references
--     effect_kind, and its definition is exactly the previous list (or
--     already this migration's list, re-apply = no-op).
--  2. CHECK on public.automation_flow_delivery_attempts(status) (inline CHECK
--     of 20261028226000: attempting, confirmed, uncertain) gains 'rejected',
--     same name, same rules as (1).
--  3. public.flow_commit_run_step (20261028225000 body): the accepted effect
--     kinds gain 'message_image'. Nothing else changes.
--  4. public.flow_reserve_outbox_delivery (20261028226000 body): pending
--     'message_image' effects can be reserved like 'message' / 'question'
--     (same switches, activation, claim and one-shot attempt journal).
--  5. public.flow_finish_outbox_delivery (20261028226000 body): additive
--     outcome 'rejected' = the provider refused an IMAGE effect outright
--     (Meta 4xx such as code 100: nothing was delivered). Only for
--     effect_kind 'message_image', only from status 'attempting' / 'leased',
--     never with a provider message id. The attempt becomes 'rejected' and the
--     effect 'dead_letter' (never resent, never billed, never queued for
--     human review). 'confirmed' and 'uncertain' keep exactly their previous
--     semantics; 5xx / 429 / network / unknown errors stay 'uncertain'.
-- Function headers, LANGUAGE plpgsql, SECURITY INVOKER, SET search_path='',
-- defaults, tenant scoping (every statement keyed by p_tenant) and the
-- service_role-only privileges are unchanged. CREATE OR REPLACE keeps the
-- function OIDs, privileges and ownership comments: the three functions keep
-- their 20261028225000 / 20261028226000 markers on purpose (the 125000 /
-- 180000 preflights and the read-only pre-deploy checks pin the 225000 marker
-- of flow_commit_run_step; 225000/226000 refuse any re-apply, so no
-- 150000-style restore hazard exists). Ownership of the replaced bodies is
-- proven by body hash (md5 of the whitespace-normalized prosrc, as 190000);
-- the two constraints carry the marker below.
-- Ownership marker: CREATED_BY_20261029210000_FLOW_MEDIA_EFFECTS
-- Billing/credits are not referenced; no row is inserted, updated or deleted.
--
-- Preflight refuses unless: roles anon/authenticated/service_role exist; the
-- 20261029130000 .. 20261029190000 chain is installed (exact markers, the
-- 180000 begin body hash); the three functions exist with their 225000/226000
-- markers, attributes and either the exact previous body or this migration's
-- body (any other body is refused, never overwritten); no other overload of
-- those names exists; the two CHECKs are exactly as described above; and the
-- outbox delivery_status CHECK allows 'dead_letter'.
-- Lock impact: ALTER TABLE on automation_flow_outbox and
-- automation_flow_delivery_attempts (ACCESS EXCLUSIVE for the transaction;
-- VALIDATE scans each table once). lock_timeout 3s / statement_timeout 60s.
--
-- Order: after 20261029190000 (newest flow migration; 20261029200000
-- flow-media storage is independent). Deploy worker/ingress builds that emit
-- or send message_image only AFTER this migration, and keep
-- FLOW_MEDIA_SEND_ENABLED off until the operator GO. Rollback:
-- supabase/rollbacks/20261029210000_flow_media_effects.rollback.sql FIRST,
-- before 190000, 180000, 170000, 160000, 150000, 140000, 130000, 125000 and
-- the 20261028226000 / 20261028225000 rollbacks (each refuses while a
-- 210000 body is installed).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029210000_FLOW_MEDIA_EFFECTS';
 v_gd constant text := 'CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS';
 -- md5 of the whitespace-normalized 20261029180000 flow_begin_durable_run body.
 v_begin_180_md5 constant text := '80953ca6c0b52e627699748b59f383f9';
 -- Exact previous CHECK definitions (pg_get_constraintdef) and this migration's.
 v_kind_old constant text := 'CHECK ((effect_kind = ANY (ARRAY[''message''::text, ''question''::text, ''delay''::text, ''handoff''::text, ''tag''::text, ''untag''::text, ''staff_notification''::text])))';
 v_kind_new constant text := 'CHECK ((effect_kind = ANY (ARRAY[''message''::text, ''question''::text, ''delay''::text, ''handoff''::text, ''tag''::text, ''untag''::text, ''staff_notification''::text, ''message_image''::text])))';
 v_status_old constant text := 'CHECK ((status = ANY (ARRAY[''attempting''::text, ''confirmed''::text, ''uncertain''::text])))';
 v_status_new constant text := 'CHECK ((status = ANY (ARRAY[''attempting''::text, ''confirmed''::text, ''uncertain''::text, ''rejected''::text])))';
 v_name text;
 v_fn regprocedure;
 v_n integer;
 v_def text;
 v_con text;
 r record;
 p record;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_name) THEN
   RAISE EXCEPTION 'Media effects prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY['automation_flow_outbox','automation_flow_runs','automation_flow_delivery_attempts'] LOOP
  IF to_regclass('public.'||v_name) IS NULL THEN
   RAISE EXCEPTION 'Media effects prerequisite missing: public.%', v_name;
  END IF;
 END LOOP;
 IF obj_description('public.automation_flow_delivery_attempts'::regclass,'pg_class')
    IS DISTINCT FROM 'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY' THEN
  RAISE EXCEPTION 'Missing or unrecognized public.automation_flow_delivery_attempts; apply 20261028226000_flow_outbox_delivery_attempts first';
 END IF;
 -- 20261029130000 .. 20261029190000 chain (exact ownership markers).
 FOR r IN SELECT * FROM (VALUES
  ('public.flow_lease_due_runs(integer)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','20261029130000_flow_run_lifecycle'),
  ('public.flow_cancel_run(uuid,uuid,text,text)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','20261029130000_flow_run_lifecycle'),
  ('public.flow_claim_outbox_ai(uuid,uuid,integer,integer)','CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY','20261029140000_flow_outbox_ai_retry'),
  ('public.flow_end_stale_paused_runs(integer,integer)','CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME','20261029150000_flow_takeover_resume'),
  ('public.flow_channel_temporarily_paused(uuid,uuid)','CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE','20261029160000_flow_credits_pause'),
  ('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)','CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE','20261029170000_flow_canary_claim_durable'),
  ('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
   'CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING','20261029190000_flow_begin_durable_run_superseding')
 ) c(sig,marker,mig) LOOP
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM r.marker THEN
   RAISE EXCEPTION 'Missing or unrecognized % object %; apply % first', split_part(r.mig,'_',1), r.sig, r.mig;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
  'public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)'
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NULL OR split_part(coalesce(obj_description(v_fn,'pg_proc'),''),' ',1) IS DISTINCT FROM v_gd THEN
   RAISE EXCEPTION 'Missing or unrecognized 20261029180000 object %; apply 20261029180000_flow_durable_button_run_guards first', v_name;
  END IF;
 END LOOP;
 IF (SELECT md5(btrim(regexp_replace(x.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc x
     WHERE x.oid=to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)'))
    IS DISTINCT FROM v_begin_180_md5 THEN
  RAISE EXCEPTION 'public.flow_begin_durable_run does not have the 20261029180000 definition; apply 20261029180000_flow_durable_button_run_guards first';
 END IF;

 -- The three functions replaced here: exact previous (or this migration's) definition
 -- (md5 of the whitespace-normalized body: 20261028225000/226000, then 20261029210000).
 FOR r IN SELECT * FROM (VALUES
  ('flow_commit_run_step','public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)',
   'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE','20261028225000_flow_runtime_advance',1,
   ARRAY['p_tenant','p_run','p_expect_step','p_expect_status','p_next_node','p_next_step','p_next_status',
    'p_variables','p_wake_at','p_effects','p_metric','p_lease_token'],
   '3d6031bb218b29cb0ffaed0286bd3b1b','94a87bc016ad93e609897025d259bf3e'),
  ('flow_reserve_outbox_delivery','public.flow_reserve_outbox_delivery(uuid,uuid)',
   'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY','20261028226000_flow_outbox_delivery_attempts',0,
   ARRAY['p_tenant','p_outbox'],
   '1b7108ae5c17bb190015aa64b4297f98','1b7a6fe3f6a9ee97203d50d5e0e0baa7'),
  ('flow_finish_outbox_delivery','public.flow_finish_outbox_delivery(uuid,uuid,text,text)',
   'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY','20261028226000_flow_outbox_delivery_attempts',1,
   ARRAY['p_tenant','p_outbox','p_result','p_provider_message_id'],
   '4cc4008c25291a1db951b595514efc56','1c6ec477519f8c91c24fc2ab82d4b9c4')
 ) f(name,sig,marker,mig,ndefaults,args,h_old,h_new) LOOP
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc x
    WHERE x.pronamespace='public'::regnamespace AND x.proname=r.name
     AND x.oid IS DISTINCT FROM to_regprocedure(r.sig)) THEN
   RAISE EXCEPTION 'Unrecognized overload of public.% exists; refusing to replace %', r.name, r.sig;
  END IF;
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM r.marker THEN
   RAISE EXCEPTION 'Missing or unrecognized %; apply % first', r.sig, r.mig;
  END IF;
  SELECT x.* INTO p FROM pg_catalog.pg_proc x WHERE x.oid=v_fn;
  IF p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR p.prorettype IS DISTINCT FROM 'boolean'::regtype OR p.proretset OR p.prokind<>'f'
  OR p.prosecdef OR p.proisstrict OR p.provolatile<>'v' OR p.pronargdefaults<>r.ndefaults
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
  OR p.proargnames IS DISTINCT FROM r.args
  OR md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) NOT IN(r.h_old,r.h_new) THEN
   RAISE EXCEPTION 'Existing % differs from both the % and the 20261029210000 definition; refusing to overwrite',
    r.sig, split_part(r.mig,'_',1);
  END IF;
 END LOOP;

 -- Single-column CHECKs: exactly one each, exactly the previous or this list.
 FOR r IN SELECT * FROM (VALUES
  ('public.automation_flow_outbox','effect_kind',v_kind_old,v_kind_new),
  ('public.automation_flow_delivery_attempts','status',v_status_old,v_status_new)
 ) t(tbl,col,def_old,def_new) LOOP
  SELECT count(*),min(pg_catalog.pg_get_constraintdef(c.oid)),min(c.conname::text) INTO v_n,v_def,v_con
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid=r.tbl::regclass AND c.contype='c'
   AND c.conkey=ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
     WHERE a.attrelid=r.tbl::regclass AND a.attname=r.col AND NOT a.attisdropped)]::int2[];
  IF v_n<>1 OR v_def NOT IN(r.def_old,r.def_new) THEN
   RAISE EXCEPTION 'Unrecognized CHECK on %.% (count=%, definition=%); refusing to replace it',
    r.tbl, r.col, v_n, coalesce(v_def,'-');
  END IF;
  IF r.col='effect_kind' AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid=r.tbl::regclass AND c.contype='c' AND c.conname::text<>v_con
     AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%effect_kind%') THEN
   RAISE EXCEPTION 'Another CHECK on %.% exists; refusing to replace it', r.tbl, r.col;
  END IF;
  IF v_def=r.def_new AND split_part(coalesce((SELECT obj_description(c.oid,'pg_constraint')
     FROM pg_catalog.pg_constraint c WHERE c.conrelid=r.tbl::regclass AND c.conname=v_con),''),' ',1)
     IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'CHECK % on % has the 20261029210000 definition without its marker; refusing', v_con, r.tbl;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='public.automation_flow_outbox'::regclass AND c.contype='c'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%delivery_status%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''dead_letter''%') THEN
  RAISE EXCEPTION 'Media effects prerequisite missing: outbox delivery_status CHECK allowing dead_letter';
 END IF;
END
$preflight$;

-- (1) + (2): same constraint names, superset lists, marker with the previous comment.
DO $checks$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029210000_FLOW_MEDIA_EFFECTS';
 v_con text;
 v_prev text;
 r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.automation_flow_outbox','effect_kind',
   'effect_kind IN (''message'',''question'',''delay'',''handoff'',''tag'',''untag'',''staff_notification'',''message_image'')'),
  ('public.automation_flow_delivery_attempts','status',
   'status IN (''attempting'',''confirmed'',''uncertain'',''rejected'')')
 ) t(tbl,col,expr) LOOP
  SELECT c.conname::text,obj_description(c.oid,'pg_constraint') INTO v_con,v_prev
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid=r.tbl::regclass AND c.contype='c'
   AND c.conkey=ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
     WHERE a.attrelid=r.tbl::regclass AND a.attname=r.col AND NOT a.attisdropped)]::int2[];
  IF split_part(coalesce(v_prev,''),' ',1)=v_marker THEN
   RAISE NOTICE 'CHECK % on % already has the 20261029210000 definition; left unchanged', v_con, r.tbl;
  ELSE
   EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, v_con);
   EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s) NOT VALID', r.tbl, v_con, r.expr);
   EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.tbl, v_con);
   EXECUTE format('COMMENT ON CONSTRAINT %I ON %s IS %L', v_con, r.tbl,
    v_marker||' previous_comment='||coalesce(to_json(v_prev)::text,'null'));
  END IF;
 END LOOP;
END
$checks$;

-- (3) 20261028225000 body; only change: 'message_image' in the accepted kinds.
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

-- (4) 20261028226000 body; only change: 'message_image' may be reserved.
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

-- (5) 20261028226000 body plus the additive 'rejected' outcome (image only).
CREATE OR REPLACE FUNCTION public.flow_finish_outbox_delivery(
 p_tenant uuid,p_outbox uuid,p_result text,p_provider_message_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $finish$
DECLARE final_status text;
BEGIN
 IF p_tenant IS NULL OR p_outbox IS NULL OR p_result NOT IN('confirmed','uncertain','rejected')
 OR (p_result='confirmed' AND
    (p_provider_message_id IS NULL OR
     length(btrim(p_provider_message_id)) NOT BETWEEN 1 AND 255))
 OR (p_result IN('uncertain','rejected') AND p_provider_message_id IS NOT NULL)
 THEN RETURN false;END IF;
 -- 'rejected': the provider refused this IMAGE effect outright (nothing was
 -- delivered). Never for text/question effects.
 IF p_result='rejected' AND NOT EXISTS(
   SELECT 1 FROM public.automation_flow_outbox
   WHERE tenant_id=p_tenant AND id=p_outbox AND effect_kind='message_image')
 THEN RETURN false;END IF;
 UPDATE public.automation_flow_delivery_attempts
 SET status=p_result,
 provider_message_id=CASE WHEN p_result='confirmed' THEN p_provider_message_id ELSE NULL END,
 confirmed_at=CASE WHEN p_result='confirmed' THEN now() ELSE NULL END,
 uncertain_at=CASE WHEN p_result='uncertain' THEN now() ELSE NULL END
 WHERE tenant_id=p_tenant AND outbox_id=p_outbox AND status='attempting';
 IF NOT FOUND THEN RETURN false;END IF;
 final_status:=CASE WHEN p_result='confirmed' THEN 'charge_pending'
  WHEN p_result='rejected' THEN 'dead_letter' ELSE 'uncertain' END;
 UPDATE public.automation_flow_outbox
 SET delivery_status=final_status,provider_message_id=CASE WHEN p_result='confirmed' THEN p_provider_message_id ELSE NULL END,
  delivered_at=CASE WHEN p_result='confirmed' THEN now() ELSE NULL END,
  lease_token=NULL,lease_expires_at=NULL
 WHERE tenant_id=p_tenant AND id=p_outbox AND delivery_status='leased';
 IF NOT FOUND THEN RAISE EXCEPTION 'Outbox status changed after delivery';END IF;
 RETURN true;
END $finish$;

-- Same service_role-only privileges as 20261028225000 / 20261028226000.
REVOKE ALL ON FUNCTION public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_reserve_outbox_delivery(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_finish_outbox_delivery(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_reserve_outbox_delivery(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_finish_outbox_delivery(uuid,uuid,text,text) TO service_role;
COMMIT;
