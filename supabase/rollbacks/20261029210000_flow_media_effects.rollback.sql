-- REVIEW ONLY rollback for 20261029210000_flow_media_effects.
-- NOT applied anywhere by this repository.
--
-- Restores the exact 20261028225000 body of public.flow_commit_run_step and the
-- exact 20261028226000 bodies of public.flow_reserve_outbox_delivery and
-- public.flow_finish_outbox_delivery (verbatim below; CREATE OR REPLACE keeps
-- the OIDs, the service_role-only privileges and the 225000/226000 markers,
-- which 210000 never changed), and the previous CHECK definitions on
-- automation_flow_outbox(effect_kind) and automation_flow_delivery_attempts(status)
-- under the same constraint names with their previous comments. Only bodies
-- whose hash is the 20261029210000 body and only CHECKs carrying the marker
-- CREATED_BY_20261029210000_FLOW_MEDIA_EFFECTS are touched; anything else is
-- refused. No row is inserted, updated or deleted. Billing/credits are not
-- referenced.
--
-- Data guard: the previous CHECKs cannot hold rows with effect_kind
-- 'message_image' or attempts with status 'rejected'. If any exist the
-- rollback REFUSES, unless the operator opts in for this session to keep the
-- two widened CHECKs (functions are still restored; no row is changed):
--   PGOPTIONS='-c flow.rollback_210000=keep-media-checks' \
--     psql -X -v ON_ERROR_STOP=1 -f supabase/rollbacks/20261029210000_flow_media_effects.rollback.sql "<conn>"
-- Even then it refuses while a message_image effect is still pending,
-- retry_wait or leased: the restored reserve function would never send it and
-- it would hold the later effects of its run. Cancel those first, e.g.
-- SELECT public.flow_skip_outbox_effect(tenant_id,id,'manual') per row.
--
-- Order: turn FLOW_MEDIA_SEND_ENABLED off and revert worker/ingress builds that
-- emit message_image FIRST. Then run this rollback right after the
-- 20261029220000_flow_media_stale_sweep rollback (refused while the 220000
-- sweep body is installed); required rollback order: 220000, 210000, then
-- 20261029190000, 180000, 170000, 160000, 150000, 140000, 130000, 125000 (and
-- the 20261028226000 / 20261028225000 rollbacks); each refuses while a 210000
-- body is installed.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029210000_FLOW_MEDIA_EFFECTS';
 v_new integer := 0;
 v_old integer := 0;
 v_checks integer := 0;
 v_images bigint := 0;
 v_open bigint := 0;
 v_rejected bigint := 0;
 r record;
BEGIN
 -- 20261029220000 (media stale sweep; requires 210000) is newer: roll it back first.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.flow_skip_blocked_outbox(integer,integer)')
  AND md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g')))='dacdf7bb582a7d380651d478f47c6b97')
 THEN RAISE EXCEPTION 'Refusing 20261029210000 rollback: 20261029220000 objects still exist; roll back 20261029220000_flow_media_stale_sweep first'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)',
   'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE','3d6031bb218b29cb0ffaed0286bd3b1b','94a87bc016ad93e609897025d259bf3e'),
  ('public.flow_reserve_outbox_delivery(uuid,uuid)',
   'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY','1b7108ae5c17bb190015aa64b4297f98','1b7a6fe3f6a9ee97203d50d5e0e0baa7'),
  ('public.flow_finish_outbox_delivery(uuid,uuid,text,text)',
   'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY','4cc4008c25291a1db951b595514efc56','1c6ec477519f8c91c24fc2ab82d4b9c4')
 ) f(sig,marker,h_old,h_new) LOOP
  IF to_regprocedure(r.sig) IS NULL
  OR obj_description(to_regprocedure(r.sig),'pg_proc') IS DISTINCT FROM r.marker THEN
   RAISE EXCEPTION 'Refusing 20261029210000 rollback: % missing or unrecognized', r.sig;
  END IF;
  CASE (SELECT md5(btrim(regexp_replace(x.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc x
        WHERE x.oid=to_regprocedure(r.sig))
   WHEN r.h_new THEN v_new := v_new+1;
   WHEN r.h_old THEN v_old := v_old+1;
   ELSE RAISE EXCEPTION 'Refusing 20261029210000 rollback: % has neither the 20261029210000 nor the previous body', r.sig;
  END CASE;
 END LOOP;
 SELECT count(*) INTO v_checks FROM pg_catalog.pg_constraint c
 WHERE c.conrelid IN('public.automation_flow_outbox'::regclass,'public.automation_flow_delivery_attempts'::regclass)
  AND c.contype='c' AND split_part(coalesce(obj_description(c.oid,'pg_constraint'),''),' ',1)=v_marker;
 IF v_new=0 THEN
  RAISE EXCEPTION '20261029210000_flow_media_effects not installed; nothing to roll back (functions have the previous bodies, % marked CHECK(s) kept)', v_checks;
 END IF;
 IF v_new<>3 OR v_checks<>2 THEN
  RAISE EXCEPTION 'Refusing 20261029210000 rollback: partial state (% of 3 functions with the 210000 body, % of 2 marked CHECKs)', v_new, v_checks;
 END IF;
 SELECT count(*),count(*) FILTER(WHERE delivery_status IN('pending','retry_wait','leased'))
 INTO v_images,v_open FROM public.automation_flow_outbox WHERE effect_kind='message_image';
 SELECT count(*) INTO v_rejected FROM public.automation_flow_delivery_attempts WHERE status='rejected';
 IF v_open>0 THEN
  RAISE EXCEPTION 'Refusing 20261029210000 rollback: % message_image effect(s) still pending/retry_wait/leased; cancel them first (flow_skip_outbox_effect ... ''manual'')', v_open;
 END IF;
 IF (v_images>0 OR v_rejected>0) AND
    current_setting('flow.rollback_210000',true) IS DISTINCT FROM 'keep-media-checks' THEN
  RAISE EXCEPTION 'Refusing 20261029210000 rollback: % message_image effect(s) and % rejected attempt(s) violate the previous CHECKs; re-run with PGOPTIONS ''-c flow.rollback_210000=keep-media-checks'' to restore the functions and keep the widened CHECKs',
   v_images,v_rejected;
 END IF;
END
$g$;

-- Previous CHECKs (same names, previous comments), only when no row needs the
-- widened ones; otherwise (operator opt-in above) they are kept unchanged.
DO $checks$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029210000_FLOW_MEDIA_EFFECTS';
 v_con text;
 v_c text;
 v_prev text;
 r record;
BEGIN
 IF EXISTS(SELECT 1 FROM public.automation_flow_outbox WHERE effect_kind='message_image')
 OR EXISTS(SELECT 1 FROM public.automation_flow_delivery_attempts WHERE status='rejected') THEN
  RAISE NOTICE 'flow.rollback_210000=keep-media-checks: widened CHECKs kept, no row changed';
  RETURN;
 END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.automation_flow_outbox','effect_kind',
   'effect_kind IN (''message'',''question'',''delay'',''handoff'',''tag'',''untag'',''staff_notification'')'),
  ('public.automation_flow_delivery_attempts','status',
   'status IN (''attempting'',''confirmed'',''uncertain'')')
 ) t(tbl,col,expr) LOOP
  SELECT c.conname::text,obj_description(c.oid,'pg_constraint') INTO v_con,v_c
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid=r.tbl::regclass AND c.contype='c'
   AND c.conkey=ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
     WHERE a.attrelid=r.tbl::regclass AND a.attname=r.col AND NOT a.attisdropped)]::int2[];
  IF split_part(coalesce(v_c,''),' ',1) IS DISTINCT FROM v_marker
  OR v_c NOT LIKE v_marker||' previous_comment=%' THEN
   RAISE EXCEPTION 'Refusing 20261029210000 rollback: CHECK on %.% is not marked by 20261029210000', r.tbl, r.col;
  END IF;
  v_prev := (substr(v_c,length(v_marker||' previous_comment=')+1)::json)#>>'{}';
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, v_con);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s) NOT VALID', r.tbl, v_con, r.expr);
  EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.tbl, v_con);
  EXECUTE format('COMMENT ON CONSTRAINT %I ON %s IS %L', v_con, r.tbl, v_prev);
 END LOOP;
END
$checks$;

-- 20261028225000 body (verbatim).
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
     kind NOT IN('message','question','delay','handoff','tag','untag','staff_notification') OR
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

-- 20261028226000 bodies (verbatim).
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
  AND o.delivery_status='pending' AND o.effect_kind IN('message','question')
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

CREATE OR REPLACE FUNCTION public.flow_finish_outbox_delivery(
 p_tenant uuid,p_outbox uuid,p_result text,p_provider_message_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $finish$
DECLARE final_status text;
BEGIN
 IF p_tenant IS NULL OR p_outbox IS NULL OR p_result NOT IN('confirmed','uncertain')
 OR (p_result='confirmed' AND
    (p_provider_message_id IS NULL OR
     length(btrim(p_provider_message_id)) NOT BETWEEN 1 AND 255))
 OR (p_result='uncertain' AND p_provider_message_id IS NOT NULL)
 THEN RETURN false;END IF;
 UPDATE public.automation_flow_delivery_attempts
 SET status=p_result,
 provider_message_id=CASE WHEN p_result='confirmed' THEN p_provider_message_id ELSE NULL END,
 confirmed_at=CASE WHEN p_result='confirmed' THEN now() ELSE NULL END,
 uncertain_at=CASE WHEN p_result='uncertain' THEN now() ELSE NULL END
 WHERE tenant_id=p_tenant AND outbox_id=p_outbox AND status='attempting';
 IF NOT FOUND THEN RETURN false;END IF;
 final_status:=CASE WHEN p_result='confirmed' THEN 'charge_pending' ELSE 'uncertain' END;
 UPDATE public.automation_flow_outbox
 SET delivery_status=final_status,provider_message_id=CASE WHEN p_result='confirmed' THEN p_provider_message_id ELSE NULL END,
  delivered_at=CASE WHEN p_result='confirmed' THEN now() ELSE NULL END,
  lease_token=NULL,lease_expires_at=NULL
 WHERE tenant_id=p_tenant AND id=p_outbox AND delivery_status='leased';
 IF NOT FOUND THEN RAISE EXCEPTION 'Outbox status changed after delivery';END IF;
 RETURN true;
END $finish$;
COMMIT;
