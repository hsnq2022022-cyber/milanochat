-- REVIEW ONLY: comment automation (public reply BEFORE the DM). NOT applied
-- anywhere by this repository; apply only with an explicit owner GO. Live
-- behaviour stays OFF behind FLOW_COMMENT_AUTOMATION_ENABLED (default OFF) in
-- milan-api, flow-outbox-worker and flow-publication: with the flag off no
-- comment event reaches these functions and no reply_comment effect exists,
-- so behaviour is unchanged.
--
-- Changes:
--  1. NEW table public.automation_comment_replies (marker CREATED_BY_20261029300000_COMMENT_REPLIES):
--     one row per (tenant, account, comment id) = the durable comment dedupe
--     (UNIQUE automation_comment_replies_comment_uq) and the activity log
--     (comment text encrypted enc:v1, public reply text, reply status /
--     attempts / error code / reply id, DM status, timestamps). RLS on;
--     authenticated may only SELECT its own tenant's rows (policy
--     automation_comment_replies_owner_select, tenants.user_id = auth.uid());
--     writes are service_role only. CHECK automation_comment_replies_order_chk:
--     a DM can only be 'sent'/'failed' after the public reply is 'sent'.
--  2. CHECK on automation_flow_outbox(effect_kind) (same name): the
--     20261029210000 list plus 'reply_comment' (strict superset; NOT VALID,
--     then VALIDATE; marker plus the previous comment).
--  3. flow_commit_run_step (20261029230000 body): 'reply_comment' added to the
--     accepted effect kinds. flow_begin_durable_run / flow_resume_button_run
--     have no kind list of their own (they commit through this function), so
--     all three run RPCs accept it; their bodies are not touched.
--  4. flow_reserve_outbox_delivery (20261029230000 body): refuses any effect of
--     a comment run while that run's automation_comment_replies row is not
--     'sent' (the DM is structurally held until the public reply succeeded).
--     reply_comment itself is never reserved here (not in its kind list).
--  5. flow_skip_blocked_outbox (20261029220000 body): also sweeps
--     'reply_comment' and mirrors a cancelled step into the activity row
--     (reply 'failed' with cancelled_<reason>, DM 'skipped').
--  6. NEW functions (service_role only, SECURITY INVOKER, search_path=''):
--     flow_begin_comment_run (dedupe row + claim + receipt + run + effects
--     [reply_comment, then DM messages] in ONE transaction; the reply text must
--     equal the published trigger's publicReplyText), flow_claim_comment_reply
--     (lease of a reply_comment effect; a crashed attempt is reported as
--     'uncertain' so the worker reconciles before any re-post) and
--     flow_finish_comment_reply (sent / failed / retry / uncertain / absent
--     under the lease token; failed = dead_letter + DM 'skipped' + the run's
--     other open effects cancelled).
-- Not changed: flow_begin_durable_run, flow_resume_button_run,
-- flow_claim_inbound_durable, flow_finish_outbox_delivery, billing/credits,
-- signatures, ownership comments of the replaced functions (proven by body hash).
--
-- Preflight refuses unless roles anon/authenticated/service_role, auth.uid()
-- and tenants.user_id exist; the three replaced functions carry their marker,
-- attributes and EITHER the exact previous body OR this migration's body; the
-- effect_kind CHECK is the 210000 marked definition or this one; and any
-- already existing new object carries this migration's marker.
-- Re-apply is idempotent. Lock impact: ALTER TABLE on automation_flow_outbox
-- (CHECK swap, validated scan). lock_timeout 3s / statement_timeout 60s.
--
-- Order: after 20261029230000 (newest flow migration) and 20261029290000.
-- Apply BEFORE deploying the milan-api / flow-outbox-worker /
-- flow-publication builds that use it (they stay inert while
-- FLOW_COMMENT_AUTOMATION_ENABLED is off). Rollback:
-- supabase/rollbacks/20261029300000_comment_replies.rollback.sql FIRST; the
-- 230000 / 220000 / 210000 rollbacks refuse while a 300000 body or CHECK is
-- installed.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029300000_COMMENT_REPLIES';
 v_kind_210 constant text := 'CHECK ((effect_kind = ANY (ARRAY[''message''::text, ''question''::text, ''delay''::text, ''handoff''::text, ''tag''::text, ''untag''::text, ''staff_notification''::text, ''message_image''::text])))';
 v_kind_300 constant text := 'CHECK ((effect_kind = ANY (ARRAY[''message''::text, ''question''::text, ''delay''::text, ''handoff''::text, ''tag''::text, ''untag''::text, ''staff_notification''::text, ''message_image''::text, ''reply_comment''::text])))';
 v_name text;
 v_fn regprocedure;
 v_n integer;
 v_def text;
 v_con text;
 v_cmt text;
 r record;
 p record;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_name) THEN
   RAISE EXCEPTION 'Comment replies prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 IF to_regprocedure('auth.uid()') IS NULL THEN
  RAISE EXCEPTION 'Comment replies prerequisite missing: function auth.uid()';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='public.tenants'::regclass
   AND attname='user_id' AND NOT attisdropped) THEN
  RAISE EXCEPTION 'Comment replies prerequisite missing: column public.tenants.user_id';
 END IF;
 IF obj_description(to_regclass('public.automation_flow_canary_accounts'),'pg_class')
    IS DISTINCT FROM 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE' THEN
  RAISE EXCEPTION 'Missing 20261029170000 canary tables; apply 20261029170000_flow_canary_claim_durable first';
 END IF;
 IF split_part(coalesce((SELECT obj_description(c.oid,'pg_constraint') FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.automation_flow_canary_accounts'::regclass
     AND c.conname='automation_flow_canary_accounts_platform_chk'),''),' ',1)
    IS DISTINCT FROM 'CREATED_BY_20261029230000_FLOW_MULTICHANNEL_SUPPORT' THEN
  RAISE EXCEPTION 'Missing 20261029230000 objects; apply 20261029230000_flow_multichannel_support first';
 END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)','CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE','20261029230000_flow_multichannel_support',
   'f5b147309700470f8b9f410dda5a6df0','792f53c13ea7da1ddb15dd28b7251cfc'),
  ('public.flow_reserve_outbox_delivery(uuid,uuid)','CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY','20261029230000_flow_multichannel_support',
   '4a8882ddd7ad430c4187db821cc3de99','dda2d36ae3146fca8a1306bcb8c59d84'),
  ('public.flow_skip_blocked_outbox(integer,integer)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','20261029220000_flow_media_stale_sweep',
   'dacdf7bb582a7d380651d478f47c6b97','38622855fbb486c370913e0796d6975b')
 ) f(sig,marker,mig,h_old,h_new) LOOP
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc x
    WHERE x.pronamespace='public'::regnamespace AND x.proname=split_part(substr(r.sig,8),'(',1)
     AND x.oid IS DISTINCT FROM to_regprocedure(r.sig)) THEN
   RAISE EXCEPTION 'Unrecognized overload of % exists; refusing to replace it', split_part(r.sig,'(',1);
  END IF;
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM r.marker THEN
   RAISE EXCEPTION 'Missing or unrecognized %; apply % first', r.sig, r.mig;
  END IF;
  SELECT x.* INTO p FROM pg_catalog.pg_proc x WHERE x.oid=v_fn;
  IF p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR p.prokind<>'f' OR p.prosecdef OR p.proisstrict OR p.provolatile<>'v'
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
  OR md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) NOT IN(r.h_old,r.h_new) THEN
   RAISE EXCEPTION 'Existing % differs from both the % and the 20261029300000 definition; refusing to overwrite',
    r.sig, split_part(r.mig,'_',1);
  END IF;
 END LOOP;
 -- effect_kind CHECK: exactly one, the 210000 marked definition or this migration's.
 SELECT count(*),min(pg_catalog.pg_get_constraintdef(c.oid)),min(c.conname::text),
  min(obj_description(c.oid,'pg_constraint'))
 INTO v_n,v_def,v_con,v_cmt
 FROM pg_catalog.pg_constraint c
 WHERE c.conrelid='public.automation_flow_outbox'::regclass AND c.contype='c'
  AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%effect_kind%';
 IF v_n<>1 OR v_def NOT IN(v_kind_210,v_kind_300) THEN
  RAISE EXCEPTION 'Unrecognized CHECK on public.automation_flow_outbox.effect_kind (count=%, definition=%); refusing to replace it',
   v_n, coalesce(v_def,'-');
 END IF;
 IF v_def=v_kind_210 AND split_part(coalesce(v_cmt,''),' ',1) IS DISTINCT FROM 'CREATED_BY_20261029210000_FLOW_MEDIA_EFFECTS' THEN
  RAISE EXCEPTION 'effect_kind CHECK % lacks the 20261029210000 marker; apply 20261029210000_flow_media_effects first', v_con;
 END IF;
 IF v_def=v_kind_300 AND split_part(coalesce(v_cmt,''),' ',1) IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'effect_kind CHECK % has the 20261029300000 definition without its marker; refusing', v_con;
 END IF;
 -- New objects: absent, or carrying this migration's marker (re-apply).
 IF to_regclass('public.automation_comment_replies') IS NOT NULL AND
    obj_description(to_regclass('public.automation_comment_replies'),'pg_class') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Unrecognized pre-existing public.automation_comment_replies; refusing';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['flow_begin_comment_run','flow_claim_comment_reply','flow_finish_comment_reply'] LOOP
  FOR p IN SELECT x.oid FROM pg_catalog.pg_proc x
    WHERE x.pronamespace='public'::regnamespace AND x.proname=v_name LOOP
   IF obj_description(p.oid,'pg_proc') IS DISTINCT FROM v_marker
   OR NOT coalesce(p.oid IN(to_regprocedure('public.flow_begin_comment_run(uuid,uuid,uuid,uuid,text,text,text,text,text,text,bigint,text,text,integer,jsonb)'),to_regprocedure('public.flow_claim_comment_reply(uuid,uuid,integer)'),to_regprocedure('public.flow_finish_comment_reply(uuid,uuid,uuid,text,text,text,integer,boolean,integer)')),false) THEN
    RAISE EXCEPTION 'Unrecognized pre-existing function public.%; refusing to replace it', v_name;
   END IF;
  END LOOP;
 END LOOP;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.automation_comment_replies(
 id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 channel_account_id uuid NOT NULL,
 platform text NOT NULL CHECK(platform IN('instagram','facebook')),
 comment_id text NOT NULL CHECK(comment_id ~ '^[0-9]{1,32}(_[0-9]{1,32})?$'),
 post_id text NOT NULL CHECK(post_id ~ '^[0-9]{1,32}(_[0-9]{1,32})?$'),
 from_id text NOT NULL CHECK(from_id ~ '^[0-9]{1,32}$'),
 from_name text CHECK(from_name IS NULL OR length(from_name) BETWEEN 1 AND 256),
 comment_text_encrypted text NOT NULL CHECK(comment_text_encrypted LIKE 'enc:v1:%'
  AND length(comment_text_encrypted)<=65536),
 public_reply_text text NOT NULL CHECK(length(btrim(public_reply_text)) BETWEEN 1 AND 2200),
 flow_key text NOT NULL CHECK(flow_key ~ '^[a-zA-Z0-9_-]{1,128}$'),
 publication_revision bigint NOT NULL CHECK(publication_revision>0),
 run_id uuid,
 reply_status text NOT NULL DEFAULT 'pending'
  CHECK(reply_status IN('pending','attempting','uncertain','sent','failed')),
 reply_id text CHECK(reply_id IS NULL OR length(reply_id) BETWEEN 1 AND 255),
 reply_attempts integer NOT NULL DEFAULT 0 CHECK(reply_attempts BETWEEN 0 AND 10),
 reply_error_code text CHECK(reply_error_code IS NULL OR reply_error_code ~ '^[a-z0-9_]{1,48}$'),
 replied_at timestamptz,
 dm_status text NOT NULL DEFAULT 'pending' CHECK(dm_status IN('pending','sent','failed','skipped')),
 dm_updated_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT automation_comment_replies_comment_uq UNIQUE(tenant_id,channel_account_id,comment_id),
 CONSTRAINT automation_comment_replies_tenant_id_uq UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,channel_account_id,platform)
  REFERENCES public.channel_accounts(tenant_id,id,platform),
 FOREIGN KEY(tenant_id,run_id) REFERENCES public.automation_flow_runs(tenant_id,id),
 CONSTRAINT automation_comment_replies_sent_chk CHECK((reply_status='sent')=(reply_id IS NOT NULL)),
 CONSTRAINT automation_comment_replies_order_chk CHECK(dm_status IN('pending','skipped') OR reply_status='sent')
);
COMMENT ON TABLE public.automation_comment_replies IS 'CREATED_BY_20261029300000_COMMENT_REPLIES';
CREATE UNIQUE INDEX IF NOT EXISTS automation_comment_replies_run_uq
 ON public.automation_comment_replies(tenant_id,run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS automation_comment_replies_activity_idx
 ON public.automation_comment_replies(tenant_id,created_at DESC,id DESC);
ALTER TABLE public.automation_comment_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.automation_comment_replies FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.automation_comment_replies TO service_role;
GRANT SELECT ON public.automation_comment_replies TO authenticated;
DO $policy$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname='public'
   AND tablename='automation_comment_replies' AND policyname='automation_comment_replies_owner_select') THEN
  CREATE POLICY automation_comment_replies_owner_select ON public.automation_comment_replies
   FOR SELECT TO authenticated
   USING (tenant_id IN (SELECT t.id FROM public.tenants t WHERE t.user_id = (SELECT auth.uid())));
 END IF;
END
$policy$;

-- (2) effect_kind CHECK: same name, superset list, marker with the previous comment.
DO $check$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029300000_COMMENT_REPLIES';
 v_con text;
 v_prev text;
BEGIN
 SELECT c.conname::text,obj_description(c.oid,'pg_constraint') INTO v_con,v_prev
 FROM pg_catalog.pg_constraint c
 WHERE c.conrelid='public.automation_flow_outbox'::regclass AND c.contype='c'
  AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%effect_kind%';
 IF split_part(coalesce(v_prev,''),' ',1)=v_marker THEN
  RAISE NOTICE 'CHECK % already has the 20261029300000 definition; left unchanged', v_con;
 ELSE
  EXECUTE format('ALTER TABLE public.automation_flow_outbox DROP CONSTRAINT %I', v_con);
  EXECUTE format('ALTER TABLE public.automation_flow_outbox ADD CONSTRAINT %I CHECK (%s) NOT VALID', v_con,
   'effect_kind IN (''message'',''question'',''delay'',''handoff'',''tag'',''untag'',''staff_notification'',''message_image'',''reply_comment'')');
  EXECUTE format('ALTER TABLE public.automation_flow_outbox VALIDATE CONSTRAINT %I', v_con);
  EXECUTE format('COMMENT ON CONSTRAINT %I ON public.automation_flow_outbox IS %L', v_con,
   v_marker||' previous_comment='||coalesce(to_json(v_prev)::text,'null'));
 END IF;
END
$check$;

-- (3) 20261029230000 body; only change: 'reply_comment' in the accepted kinds.
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
     kind NOT IN('message','question','delay','handoff','tag','untag','staff_notification','message_image','reply_comment') OR
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

-- (4) 20261029230000 body; only change: a comment run's effects wait for the sent public reply.
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
  AND NOT EXISTS(SELECT 1 FROM public.automation_comment_replies cr
   WHERE cr.tenant_id=o.tenant_id AND cr.run_id=o.run_id AND cr.reply_status<>'sent')
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

-- (5) 20261029220000 body; only changes: 'reply_comment' swept, activity row mirrored.
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
  SELECT q.tenant_id,q.id,q.reason,q.run_id,q.effect_kind FROM (
   SELECT o.tenant_id,o.id,o.created_at,o.run_id,o.effect_kind,
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
    AND o.effect_kind IN('message','question','message_image','reply_comment')
  ) q
  WHERE q.reason IS NOT NULL
  ORDER BY q.created_at,q.id
  LIMIT p_limit
 LOOP
  IF public.flow_skip_outbox_effect(r.tenant_id,r.id,r.reason) THEN
   n := n+1;
   IF r.effect_kind='reply_comment' THEN
    UPDATE public.automation_comment_replies
    SET reply_status='failed',reply_error_code='cancelled_'||r.reason,
        dm_status=CASE WHEN dm_status='pending' THEN 'skipped' ELSE dm_status END,
        updated_at=now()
    WHERE tenant_id=r.tenant_id AND run_id=r.run_id
     AND reply_status IN('pending','uncertain','attempting');
   ELSE
    UPDATE public.automation_comment_replies
    SET dm_status='skipped',dm_updated_at=now(),updated_at=now()
    WHERE tenant_id=r.tenant_id AND run_id=r.run_id AND dm_status='pending';
   END IF;
  END IF;
 END LOOP;
 RETURN n;
END
$skip_many$;

-- (6) New comment functions.
CREATE OR REPLACE FUNCTION public.flow_begin_comment_run(
 p_tenant uuid,p_account uuid,p_conversation uuid,p_inbound uuid,
 p_comment_id text,p_post_id text,p_from_id text,p_from_name text,
 p_comment_encrypted text,p_flow text,p_revision bigint,p_start text,
 p_next text,p_next_step integer,p_effects jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $comment_begin$
DECLARE v_platform text; v_event text; v_reply text; v_row uuid; v_claim uuid;
 v_saved text; v_run uuid; v_ok boolean; e jsonb; i integer := 0;
BEGIN
 IF p_tenant IS NULL OR p_account IS NULL OR p_conversation IS NULL OR p_inbound IS NULL OR
    p_comment_id IS NULL OR p_comment_id !~ '^[0-9]{1,32}(_[0-9]{1,32})?$' OR
    p_post_id IS NULL OR p_post_id !~ '^[0-9]{1,32}(_[0-9]{1,32})?$' OR
    p_from_id IS NULL OR p_from_id !~ '^[0-9]{1,32}$' OR
    (p_from_name IS NOT NULL AND length(p_from_name) NOT BETWEEN 1 AND 256) OR
    p_comment_encrypted IS NULL OR p_comment_encrypted NOT LIKE 'enc:v1:%' OR
    length(p_comment_encrypted)>65536 OR
    p_flow IS NULL OR p_flow !~ '^[a-zA-Z0-9_-]{1,128}$' OR p_revision IS NULL OR p_revision<1 OR
    p_start IS NULL OR length(p_start) NOT BETWEEN 1 AND 128 OR
    p_next IS NULL OR length(p_next) NOT BETWEEN 1 AND 128 OR
    p_next_step IS NULL OR p_next_step NOT BETWEEN 1 AND 150 OR
    p_effects IS NULL OR jsonb_typeof(p_effects)<>'array' OR
    jsonb_array_length(p_effects) NOT BETWEEN 2 AND 5
 THEN RETURN NULL; END IF;
 v_event := 'comment:'||p_comment_id;
 SELECT a.platform INTO v_platform FROM public.channel_accounts a
 JOIN public.tenants t ON t.id=a.tenant_id
 JOIN public.conversations c ON c.tenant_id=a.tenant_id AND c.id=p_conversation AND c.account_id=a.id
 JOIN public.messages m ON m.tenant_id=a.tenant_id AND m.id=p_inbound AND m.conversation_id=c.id
  AND m.direction='in' AND m.wa_message_id=v_event
 WHERE a.tenant_id=p_tenant AND a.id=p_account AND a.platform IN('instagram','facebook')
  AND a.is_active AND a.agent_enabled AND a.auto_reply AND t.is_active;
 IF v_platform IS NULL THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_canary_accounts r
   WHERE r.tenant_id=p_tenant AND r.channel_account_id=p_account AND r.platform=v_platform)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch WHERE singleton AND enabled)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches
   WHERE tenant_id=p_tenant AND enabled AND production_approved)
 THEN RETURN NULL; END IF;
 SELECT btrim(n#>>'{data,publicReplyText}') INTO v_reply
 FROM public.automation_flow_activations a
 JOIN public.automation_flow_publications p ON p.tenant_id=a.tenant_id
  AND p.channel_account_id=a.channel_account_id AND p.platform=a.platform
  AND p.flow_key=a.flow_key AND p.revision=a.revision
 CROSS JOIN LATERAL jsonb_array_elements(p.document->'nodes') n
 WHERE a.tenant_id=p_tenant AND a.channel_account_id=p_account AND a.platform=v_platform
  AND a.flow_key=p_flow AND a.revision=p_revision AND a.is_active
  AND n->>'id'=p_start AND n#>>'{data,kind}'='trigger'
  AND n#>>'{data,platform}'=CASE v_platform WHEN 'facebook' THEN 'messenger' ELSE v_platform END
  AND n#>>'{data,triggerMode}'='comment'
 LIMIT 1;
 IF v_reply IS NULL OR length(v_reply) NOT BETWEEN 1 AND 2200 THEN RETURN NULL; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p_effects)
 LOOP
  IF jsonb_typeof(e)<>'object' OR jsonb_typeof(e->'payload') IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
  IF i=0 THEN
   IF e->>'kind' IS DISTINCT FROM 'reply_comment' OR e#>>'{payload,kind}' IS DISTINCT FROM 'reply_comment'
    OR e#>>'{payload,commentId}' IS DISTINCT FROM p_comment_id
    OR e#>>'{payload,text}' IS DISTINCT FROM v_reply
    OR e#>>'{payload,seq}' IS DISTINCT FROM '0'
   THEN RETURN NULL; END IF;
  ELSIF e->>'kind' IS DISTINCT FROM 'message' OR e#>>'{payload,kind}' IS DISTINCT FROM 'message'
   OR e#>>'{payload,seq}' IS DISTINCT FROM i::text
  THEN RETURN NULL; END IF;
  i := i+1;
 END LOOP;
 INSERT INTO public.automation_comment_replies(
  tenant_id,channel_account_id,platform,comment_id,post_id,from_id,from_name,
  comment_text_encrypted,public_reply_text,flow_key,publication_revision)
 VALUES(p_tenant,p_account,v_platform,p_comment_id,p_post_id,p_from_id,p_from_name,
  p_comment_encrypted,v_reply,p_flow,p_revision)
 ON CONFLICT ON CONSTRAINT automation_comment_replies_comment_uq DO NOTHING
 RETURNING id INTO v_row;
 IF v_row IS NULL THEN RETURN NULL; END IF;
 INSERT INTO public.automation_message_claims(
  tenant_id,channel_account_id,platform,provider_event_id,conversation_id,
  inbound_message_id,route)
 VALUES(p_tenant,p_account,v_platform,v_event,p_conversation,p_inbound,'flow')
 ON CONFLICT DO NOTHING RETURNING id INTO v_claim;
 IF v_claim IS NULL THEN
  RAISE EXCEPTION 'flow_comment_claim_exists' USING ERRCODE='23505';
 END IF;
 INSERT INTO public.automation_flow_event_receipts(
  tenant_id,channel_account_id,platform,provider_event_id)
 VALUES(p_tenant,p_account,v_platform,v_event)
 ON CONFLICT DO NOTHING RETURNING provider_event_id INTO v_saved;
 IF v_saved IS NULL THEN
  RAISE EXCEPTION 'flow_comment_receipt_exists' USING ERRCODE='23505';
 END IF;
 INSERT INTO public.automation_flow_runs(
  tenant_id,flow_key,publication_revision,channel_account_id,platform,
  conversation_id,provider_event_id,current_node_id,run_status,step_count,variables)
 VALUES(p_tenant,p_flow,p_revision,p_account,v_platform,
  p_conversation,v_event,p_start,'ready',0,'{}'::jsonb)
 RETURNING id INTO v_run;
 UPDATE public.automation_comment_replies SET run_id=v_run
 WHERE tenant_id=p_tenant AND id=v_row;
 SELECT public.flow_commit_run_step(
  p_tenant,v_run,0,'ready',p_next,p_next_step,'completed',
  '{}'::jsonb,NULL,p_effects,'started',NULL
 ) INTO v_ok;
 IF v_ok IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'First comment step rejected; atomic rollback required';
 END IF;
 RETURN v_run;
END $comment_begin$;

CREATE OR REPLACE FUNCTION public.flow_claim_comment_reply(
 p_tenant uuid,p_outbox uuid,p_lease_seconds integer
) RETURNS TABLE(outcome text,claim_token uuid,comment_id text,post_id text,
 reply_text text,prior_status text,attempts integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $comment_claim$
DECLARE o record; c record; v_token uuid; v_prior text;
BEGIN
 IF p_tenant IS NULL OR p_outbox IS NULL OR p_lease_seconds IS NULL OR
    p_lease_seconds NOT BETWEEN 30 AND 600 THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch WHERE singleton AND enabled)
 OR NOT EXISTS(
   SELECT 1 FROM public.automation_flow_tenant_switches s
   JOIN public.automation_flow_outbox x ON x.tenant_id=s.tenant_id
   JOIN public.automation_flow_runs r ON r.tenant_id=x.tenant_id AND r.id=x.run_id
   WHERE s.tenant_id=p_tenant AND x.id=p_outbox AND s.enabled
    AND (s.test_only OR (s.production_approved AND r.platform IN('instagram','facebook')))
 ) THEN
  RETURN QUERY SELECT 'not_claimable'::text,NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::text,NULL::integer;
  RETURN;
 END IF;
 SELECT x.id,x.run_id INTO o FROM public.automation_flow_outbox x
 JOIN public.automation_flow_runs r ON r.tenant_id=x.tenant_id AND r.id=x.run_id
 JOIN public.automation_flow_activations a ON a.tenant_id=r.tenant_id
  AND a.channel_account_id=r.channel_account_id AND a.platform=r.platform
  AND a.flow_key=r.flow_key AND a.revision=r.publication_revision AND a.is_active
 WHERE x.tenant_id=p_tenant AND x.id=p_outbox AND x.effect_kind='reply_comment'
  AND (x.delivery_status='pending'
   OR (x.delivery_status='retry_wait' AND x.retry_at<=now())
   OR (x.delivery_status='leased' AND x.lease_expires_at<=now()))
 FOR UPDATE OF x SKIP LOCKED;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'not_claimable'::text,NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::text,NULL::integer;
  RETURN;
 END IF;
 SELECT cr.id,cr.comment_id,cr.post_id,cr.public_reply_text,cr.reply_status,cr.reply_attempts
 INTO c FROM public.automation_comment_replies cr
 WHERE cr.tenant_id=p_tenant AND cr.run_id=o.run_id
  AND cr.reply_status IN('pending','uncertain','attempting')
 FOR UPDATE;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'not_claimable'::text,NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::text,NULL::integer;
  RETURN;
 END IF;
 v_prior := CASE c.reply_status WHEN 'attempting' THEN 'uncertain' ELSE c.reply_status END;
 v_token := gen_random_uuid();
 UPDATE public.automation_flow_outbox
 SET delivery_status='leased',lease_token=v_token,
     lease_expires_at=now()+make_interval(secs=>p_lease_seconds)
 WHERE tenant_id=p_tenant AND id=p_outbox;
 UPDATE public.automation_comment_replies SET reply_status='attempting',updated_at=now()
 WHERE tenant_id=p_tenant AND id=c.id;
 RETURN QUERY SELECT 'claimed'::text,v_token,c.comment_id,c.post_id,c.public_reply_text,
  v_prior,c.reply_attempts;
END $comment_claim$;

CREATE OR REPLACE FUNCTION public.flow_finish_comment_reply(
 p_tenant uuid,p_outbox uuid,p_token uuid,p_result text,p_reply_id text,
 p_error_code text,p_delay_seconds integer,p_posted boolean,p_max_attempts integer
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $comment_finish$
DECLARE o record; c record; v_attempts integer; v_result text; v_code text; x record;
BEGIN
 IF p_tenant IS NULL OR p_outbox IS NULL OR p_token IS NULL OR p_posted IS NULL OR
    p_result IS NULL OR p_result NOT IN('sent','failed','retry','uncertain','absent') OR
    (p_result='sent' AND (p_reply_id IS NULL OR length(p_reply_id) NOT BETWEEN 1 AND 255)) OR
    (p_result<>'sent' AND p_reply_id IS NOT NULL) OR
    (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,48}$') OR
    p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 0 AND 3600 OR
    p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 10
 THEN RETURN NULL; END IF;
 SELECT x2.id,x2.run_id INTO o FROM public.automation_flow_outbox x2
 WHERE x2.tenant_id=p_tenant AND x2.id=p_outbox AND x2.effect_kind='reply_comment'
  AND x2.delivery_status='leased' AND x2.lease_token=p_token
 FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT cr.id,cr.reply_attempts,cr.dm_status INTO c FROM public.automation_comment_replies cr
 WHERE cr.tenant_id=p_tenant AND cr.run_id=o.run_id AND cr.reply_status='attempting'
 FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 v_attempts := least(c.reply_attempts+CASE WHEN p_posted THEN 1 ELSE 0 END,10);
 v_result := p_result; v_code := p_error_code;
 IF v_result IN('retry','absent') AND v_attempts>=p_max_attempts THEN
  v_result := 'failed'; v_code := 'reply_attempts_exhausted';
 END IF;
 IF v_result='sent' THEN
  UPDATE public.automation_comment_replies
  SET reply_status='sent',reply_id=p_reply_id,reply_attempts=v_attempts,
      reply_error_code=NULL,replied_at=now(),updated_at=now()
  WHERE tenant_id=p_tenant AND id=c.id;
  UPDATE public.automation_flow_outbox
  SET delivery_status='settled',provider_message_id=p_reply_id,delivered_at=now(),
      lease_token=NULL,lease_expires_at=NULL
  WHERE tenant_id=p_tenant AND id=p_outbox;
 ELSIF v_result='failed' THEN
  UPDATE public.automation_comment_replies
  SET reply_status='failed',reply_attempts=v_attempts,
      reply_error_code=coalesce(v_code,'reply_failed'),
      dm_status=CASE WHEN dm_status='pending' THEN 'skipped' ELSE dm_status END,
      dm_updated_at=now(),updated_at=now()
  WHERE tenant_id=p_tenant AND id=c.id;
  UPDATE public.automation_flow_outbox
  SET delivery_status='dead_letter',lease_token=NULL,lease_expires_at=NULL
  WHERE tenant_id=p_tenant AND id=p_outbox;
  FOR x IN SELECT y.id FROM public.automation_flow_outbox y
   WHERE y.tenant_id=p_tenant AND y.run_id=o.run_id AND y.id<>p_outbox
    AND y.delivery_status IN('pending','retry_wait')
  LOOP
   PERFORM public.flow_skip_outbox_effect(p_tenant,x.id,'ineligible');
  END LOOP;
 ELSE
  UPDATE public.automation_comment_replies
  SET reply_status=CASE v_result WHEN 'uncertain' THEN 'uncertain' ELSE 'pending' END,
      reply_attempts=v_attempts,reply_error_code=v_code,updated_at=now()
  WHERE tenant_id=p_tenant AND id=c.id;
  UPDATE public.automation_flow_outbox
  SET delivery_status='retry_wait',retry_at=now()+make_interval(secs=>p_delay_seconds),
      lease_token=NULL,lease_expires_at=NULL
  WHERE tenant_id=p_tenant AND id=p_outbox;
 END IF;
 RETURN v_result;
END $comment_finish$;

COMMENT ON FUNCTION public.flow_begin_comment_run(uuid,uuid,uuid,uuid,text,text,text,text,text,text,bigint,text,text,integer,jsonb) IS 'CREATED_BY_20261029300000_COMMENT_REPLIES';
COMMENT ON FUNCTION public.flow_claim_comment_reply(uuid,uuid,integer) IS 'CREATED_BY_20261029300000_COMMENT_REPLIES';
COMMENT ON FUNCTION public.flow_finish_comment_reply(uuid,uuid,uuid,text,text,text,integer,boolean,integer) IS 'CREATED_BY_20261029300000_COMMENT_REPLIES';

-- service_role-only privileges (restated for the replaced functions).
REVOKE ALL ON FUNCTION public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.flow_reserve_outbox_delivery(uuid,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_reserve_outbox_delivery(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.flow_skip_blocked_outbox(integer,integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_skip_blocked_outbox(integer,integer) TO service_role;
REVOKE ALL ON FUNCTION public.flow_begin_comment_run(uuid,uuid,uuid,uuid,text,text,text,text,text,text,bigint,text,text,integer,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_begin_comment_run(uuid,uuid,uuid,uuid,text,text,text,text,text,text,bigint,text,text,integer,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.flow_claim_comment_reply(uuid,uuid,integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_claim_comment_reply(uuid,uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION public.flow_finish_comment_reply(uuid,uuid,uuid,text,text,text,integer,boolean,integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_finish_comment_reply(uuid,uuid,uuid,text,text,text,integer,boolean,integer) TO service_role;
COMMIT;
