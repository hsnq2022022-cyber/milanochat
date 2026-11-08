-- REVIEW ONLY rollback for 20261029300000_comment_replies.
-- NOT applied anywhere by this repository.
--
-- Restores the exact previous bodies (verbatim below) of
-- flow_commit_run_step and flow_reserve_outbox_delivery (20261029230000) and
-- flow_skip_blocked_outbox (20261029220000), the 20261029210000 effect_kind
-- CHECK with its previous comment, and drops flow_begin_comment_run,
-- flow_claim_comment_reply, flow_finish_comment_reply, the policy and the
-- table public.automation_comment_replies. Only bodies whose hash is the
-- 20261029300000 body and objects carrying the marker CREATED_BY_20261029300000_COMMENT_REPLIES
-- are touched; any other or partial state is refused.
--
-- Order guard: this must be the newest flow migration (every replaced body
-- must still be the 300000 body; a later redefinition is refused). The
-- 230000 / 220000 / 210000 rollbacks refuse while a 300000 body or CHECK is
-- installed, so this rollback must run FIRST.
--
-- Data guard (no opt-in): REFUSES while any comment data exists, because the
-- restored CHECK cannot hold 'reply_comment' rows and the restored reserve no
-- longer holds a comment run's DM behind its public reply:
--  * any automation_flow_outbox row with effect_kind 'reply_comment';
--  * any open (pending/retry_wait/leased) effect of a comment run
--    (provider_event_id 'comment:...');
--  * any row of public.automation_comment_replies (export the activity first).
-- Turn FLOW_COMMENT_AUTOMATION_ENABLED off FIRST, cancel open effects with
-- flow_skip_outbox_effect(...,'manual'), then remove those rows as the owner.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029300000_COMMENT_REPLIES';
 v_kind_300 constant text := 'CHECK ((effect_kind = ANY (ARRAY[''message''::text, ''question''::text, ''delay''::text, ''handoff''::text, ''tag''::text, ''untag''::text, ''staff_notification''::text, ''message_image''::text, ''reply_comment''::text])))';
 v_new integer := 0;
 v_def text;
 v_cmt text;
 v_reply bigint;
 v_open bigint;
 v_rows bigint;
 r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)','f5b147309700470f8b9f410dda5a6df0','792f53c13ea7da1ddb15dd28b7251cfc'),
  ('public.flow_reserve_outbox_delivery(uuid,uuid)','4a8882ddd7ad430c4187db821cc3de99','dda2d36ae3146fca8a1306bcb8c59d84'),
  ('public.flow_skip_blocked_outbox(integer,integer)','dacdf7bb582a7d380651d478f47c6b97','38622855fbb486c370913e0796d6975b')
 ) f(sig,h_old,h_new) LOOP
  IF to_regprocedure(r.sig) IS NULL THEN
   RAISE EXCEPTION 'Refusing 20261029300000 rollback: % missing', r.sig;
  END IF;
  IF (SELECT md5(btrim(regexp_replace(x.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc x
      WHERE x.oid=to_regprocedure(r.sig))=r.h_new THEN v_new := v_new+1;
  ELSIF (SELECT md5(btrim(regexp_replace(x.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc x
      WHERE x.oid=to_regprocedure(r.sig)) IS DISTINCT FROM r.h_old THEN
   RAISE EXCEPTION 'Refusing 20261029300000 rollback: % has neither the 20261029300000 nor the previous body (a later migration?)', r.sig;
  END IF;
 END LOOP;
 SELECT min(pg_catalog.pg_get_constraintdef(c.oid)),min(obj_description(c.oid,'pg_constraint'))
 INTO v_def,v_cmt FROM pg_catalog.pg_constraint c
 WHERE c.conrelid='public.automation_flow_outbox'::regclass AND c.contype='c'
  AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%effect_kind%';
 IF v_new=0 AND to_regclass('public.automation_comment_replies') IS NULL
    AND v_def IS DISTINCT FROM v_kind_300 THEN
  RAISE EXCEPTION '20261029300000_comment_replies not installed; nothing to roll back';
 END IF;
 IF v_new<>3 OR v_def IS DISTINCT FROM v_kind_300
  OR split_part(coalesce(v_cmt,''),' ',1) IS DISTINCT FROM v_marker
  OR obj_description(to_regclass('public.automation_comment_replies'),'pg_class') IS DISTINCT FROM v_marker
  OR obj_description(to_regprocedure('public.flow_begin_comment_run(uuid,uuid,uuid,uuid,text,text,text,text,text,text,bigint,text,text,integer,jsonb)'),'pg_proc') IS DISTINCT FROM v_marker
  OR obj_description(to_regprocedure('public.flow_claim_comment_reply(uuid,uuid,integer)'),'pg_proc') IS DISTINCT FROM v_marker
  OR obj_description(to_regprocedure('public.flow_finish_comment_reply(uuid,uuid,uuid,text,text,text,integer,boolean,integer)'),'pg_proc') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Refusing 20261029300000 rollback: partial or unrecognized state (% of 3 bodies with the 300000 body, CHECK=%)',
   v_new, coalesce(v_def,'-');
 END IF;
 SELECT count(*) INTO v_reply FROM public.automation_flow_outbox WHERE effect_kind='reply_comment';
 SELECT count(*) INTO v_open FROM public.automation_flow_outbox o
 JOIN public.automation_flow_runs run ON run.tenant_id=o.tenant_id AND run.id=o.run_id
 WHERE run.provider_event_id LIKE 'comment:%' AND o.delivery_status IN('pending','retry_wait','leased');
 SELECT count(*) INTO v_rows FROM public.automation_comment_replies;
 IF v_reply>0 OR v_open>0 OR v_rows>0 THEN
  RAISE EXCEPTION 'Refusing 20261029300000 rollback: comment data still depends on it (% reply_comment effect(s), % open comment-run effect(s), % activity row(s)); turn FLOW_COMMENT_AUTOMATION_ENABLED off, cancel open effects and remove those rows first',
   v_reply, v_open, v_rows;
 END IF;
END
$g$;

-- Previous effect_kind CHECK (20261029210000 definition) with its previous comment.
DO $check$
DECLARE v_con text; v_cmt text; v_prev text;
BEGIN
 SELECT c.conname::text,obj_description(c.oid,'pg_constraint') INTO v_con,v_cmt
 FROM pg_catalog.pg_constraint c
 WHERE c.conrelid='public.automation_flow_outbox'::regclass AND c.contype='c'
  AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%effect_kind%';
 v_prev := (substring(v_cmt from ' previous_comment=(.*)$'))::json #>> '{}';
 EXECUTE format('ALTER TABLE public.automation_flow_outbox DROP CONSTRAINT %I', v_con);
 EXECUTE format('ALTER TABLE public.automation_flow_outbox ADD CONSTRAINT %I CHECK (%s) NOT VALID', v_con,
  'effect_kind IN (''message'',''question'',''delay'',''handoff'',''tag'',''untag'',''staff_notification'',''message_image'')');
 EXECUTE format('ALTER TABLE public.automation_flow_outbox VALIDATE CONSTRAINT %I', v_con);
 EXECUTE format('COMMENT ON CONSTRAINT %I ON public.automation_flow_outbox IS %L', v_con, v_prev);
END
$check$;

-- Exact previous bodies (CREATE OR REPLACE keeps OIDs, privileges and comments).
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

CREATE OR REPLACE FUNCTION public.flow_skip_blocked_outbox(
 p_max_age_minutes integer DEFAULT 60,p_limit integer DEFAULT 200)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $skip_many$
DECLARE r record; n integer := 0;
BEGIN
 IF p_max_age_minutes IS NULL OR p_max_age_minutes NOT BETWEEN 5 AND 10080
  OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
 THEN RAISE EXCEPTION 'invalid outbox skip bounds'; END IF;
 FOR r IN
  SELECT q.tenant_id,q.id,q.reason FROM (
   SELECT o.tenant_id,o.id,o.created_at,
    CASE
     WHEN run.ended_reason IS NOT NULL THEN run.ended_reason
     WHEN NOT EXISTS(SELECT 1 FROM public.automation_flow_activations a
       WHERE a.tenant_id=run.tenant_id AND a.channel_account_id=run.channel_account_id
        AND a.platform=run.platform AND a.flow_key=run.flow_key
        AND a.revision=run.publication_revision AND a.is_active)
      THEN 'revision_inactive'
     WHEN public.flow_conversation_human_takeover(run.tenant_id,run.conversation_id)
      THEN 'human_takeover'
     WHEN o.created_at<=now()-make_interval(mins=>p_max_age_minutes) THEN 'stale'
    END AS reason
   FROM public.automation_flow_outbox o
   JOIN public.automation_flow_runs run
    ON run.tenant_id=o.tenant_id AND run.id=o.run_id
   WHERE o.delivery_status IN('pending','retry_wait')
    AND o.effect_kind IN('message','question','message_image')
  ) q
  WHERE q.reason IS NOT NULL
  ORDER BY q.created_at,q.id
  LIMIT p_limit
 LOOP
  IF public.flow_skip_outbox_effect(r.tenant_id,r.id,r.reason) THEN
   n := n+1;
  END IF;
 END LOOP;
 RETURN n;
END
$skip_many$;

DROP FUNCTION public.flow_begin_comment_run(uuid,uuid,uuid,uuid,text,text,text,text,text,text,bigint,text,text,integer,jsonb);
DROP FUNCTION public.flow_claim_comment_reply(uuid,uuid,integer);
DROP FUNCTION public.flow_finish_comment_reply(uuid,uuid,uuid,text,text,text,integer,boolean,integer);
DROP POLICY automation_comment_replies_owner_select ON public.automation_comment_replies;
DROP TABLE public.automation_comment_replies;
COMMIT;
