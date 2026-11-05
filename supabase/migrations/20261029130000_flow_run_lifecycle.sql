-- REVIEW ONLY: durable Flow run lifecycle hardening. NOT applied anywhere.
-- Fixes: (A) awaiting_input runs that wait forever, (B) flow_lease_due_runs
-- head-of-line blocking by leased/ineligible sleeping runs, (C) stale or
-- blocked outbox effects that could be sent after a human takeover ends,
-- (E) more than one active durable run per conversation.
--
-- Additive and idempotent: nullable columns, CREATE OR REPLACE functions,
-- IF NOT EXISTS indexes. No row is deleted; no existing status is rewritten
-- by this migration itself. No cron, Vault, secrets or network calls.
--
-- Status vocabulary (no CHECK constraint is replaced):
--  * run "cancel/expire" = run_status 'blocked' + ended_reason + ended_at.
--    'blocked' is already terminal for flow_commit_run_step and
--    flow_resume_button_run.
--  * outbox "skipped"   = delivery_status 'cancelled' (already allowed by the
--    installed outbox CHECK) + cancel_reason + cancelled_at. Only rows in
--    'pending'/'retry_wait' are ever skipped; leased/charge_pending/settled
--    rows (already in flight or sent) are never touched.
--
-- Production-only dependencies (NOT created by supabase/migrations; they exist
-- on the live project per tests/sql/fixtures/installed-flow-runtime.sql and
-- installed-flow-switches.sql): automation_flow_runs (with platform,
-- provider_event_id, updated_at), automation_flow_outbox (with retry_wait /
-- cancelled statuses), automation_flow_activations, automation_flow_tenant_switches
-- (production_approved), automation_flow_global_switch. Optional live-only
-- columns tenants.is_active, channel_accounts.is_active/agent_enabled/auto_reply,
-- conversations.transferred/human_agent_until are read dynamically through
-- to_jsonb(row), so the functions work whether or not those columns exist.
-- The preflight fails closed if a required object is missing.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_name text;
 v_fn regprocedure;
 v_def text;
 v_marker constant text := 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
BEGIN
 FOREACH v_name IN ARRAY ARRAY[
  'automation_flow_runs','automation_flow_outbox','automation_flow_run_leases',
  'automation_flow_activations','automation_flow_global_switch',
  'automation_flow_tenant_switches','tenants','channel_accounts','conversations'
 ] LOOP
  IF to_regclass('public.'||v_name) IS NULL THEN
   RAISE EXCEPTION 'Flow lifecycle prerequisite missing: %', v_name;
  END IF;
 END LOOP;

 IF (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='automation_flow_runs'
      AND column_name IN ('tenant_id','id','conversation_id','channel_account_id',
       'platform','flow_key','publication_revision','run_status','wake_at','updated_at'))<>10
 OR (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='automation_flow_outbox'
      AND column_name IN ('tenant_id','id','run_id','effect_kind','delivery_status','created_at'))<>6
 THEN RAISE EXCEPTION 'Flow runtime table shape mismatch; refusing to install lifecycle';
 END IF;

 -- 'cancelled' must already be a legal outbox status: this migration never
 -- replaces or relaxes an existing CHECK constraint.
 FOR v_def IN SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
  WHERE c.conrelid='public.automation_flow_outbox'::regclass AND c.contype='c'
   AND pg_get_constraintdef(c.oid) LIKE '%delivery_status%'
 LOOP
  IF position('''cancelled''' IN v_def)=0 THEN
   RAISE EXCEPTION 'Outbox status CHECK does not allow cancelled; abort';
  END IF;
 END LOOP;
 FOR v_def IN SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
  WHERE c.conrelid='public.automation_flow_runs'::regclass AND c.contype='c'
   AND pg_get_constraintdef(c.oid) LIKE '%run_status%'
 LOOP
  IF position('''blocked''' IN v_def)=0 THEN
   RAISE EXCEPTION 'Run status CHECK does not allow blocked; abort';
  END IF;
 END LOOP;

 v_fn := to_regprocedure('public.flow_lease_due_runs(integer)');
 IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') NOT IN
   ('CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE', v_marker)
 THEN RAISE EXCEPTION 'Unrecognized flow_lease_due_runs; refusing to replace';
 END IF;

 -- Never take over unrelated objects that merely share a name.
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_conversation_human_takeover(uuid,uuid)',
  'public.flow_cancel_run(uuid,uuid,text,text)',
  'public.flow_expire_waiting_runs(integer,integer)',
  'public.flow_skip_outbox_effect(uuid,uuid,text)',
  'public.flow_skip_blocked_outbox(integer,integer)',
  'public.flow_resolve_duplicate_active_runs(integer)',
  'public.flow_guard_one_active_run()'
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NOT NULL AND obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'Unrecognized existing function %', v_name;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY[
  'flow_one_active_run_per_conversation','automation_flow_runs_waiting_idx'
 ] LOOP
  IF to_regclass('public.'||v_name) IS NOT NULL AND
     obj_description(to_regclass('public.'||v_name)) IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'Unrecognized existing index %', v_name;
  END IF;
 END LOOP;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- Additive columns (nullable / constant default: no table rewrite).
-- ---------------------------------------------------------------------------
ALTER TABLE public.automation_flow_runs
 ADD COLUMN IF NOT EXISTS ended_reason text,
 ADD COLUMN IF NOT EXISTS ended_at timestamptz;
ALTER TABLE public.automation_flow_outbox
 ADD COLUMN IF NOT EXISTS cancel_reason text,
 ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.automation_flow_run_leases
 ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

DO $checks$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint
   WHERE conrelid='public.automation_flow_runs'::regclass
    AND conname='automation_flow_runs_ended_reason_chk') THEN
  ALTER TABLE public.automation_flow_runs
   ADD CONSTRAINT automation_flow_runs_ended_reason_chk CHECK(
    ended_reason IS NULL OR ended_reason IN(
     'input_timeout','stale','free_text','revision_inactive','superseded',
     'ineligible','human_takeover','lease_exhausted','duplicate_active','manual'))
   NOT VALID;
  ALTER TABLE public.automation_flow_runs
   VALIDATE CONSTRAINT automation_flow_runs_ended_reason_chk;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint
   WHERE conrelid='public.automation_flow_outbox'::regclass
    AND conname='automation_flow_outbox_cancel_reason_chk') THEN
  ALTER TABLE public.automation_flow_outbox
   ADD CONSTRAINT automation_flow_outbox_cancel_reason_chk CHECK(
    cancel_reason IS NULL OR cancel_reason IN(
     'input_timeout','stale','free_text','revision_inactive','superseded',
     'ineligible','human_takeover','lease_exhausted','duplicate_active','manual'))
   NOT VALID;
  ALTER TABLE public.automation_flow_outbox
   VALIDATE CONSTRAINT automation_flow_outbox_cancel_reason_chk;
 END IF;
END
$checks$;

CREATE INDEX IF NOT EXISTS automation_flow_runs_waiting_idx
 ON public.automation_flow_runs(updated_at)
 WHERE run_status IN ('ready','awaiting_input');
COMMENT ON INDEX public.automation_flow_runs_waiting_idx
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';

-- ---------------------------------------------------------------------------
-- Human takeover probe. Reads optional live-only columns dynamically and
-- fails closed (true) on a missing conversation or unparsable timestamp.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flow_conversation_human_takeover(
 p_tenant uuid,p_conversation uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=''
AS $takeover$
DECLARE j jsonb; v_until timestamptz;
BEGIN
 SELECT to_jsonb(c) INTO j FROM public.conversations c
 WHERE c.tenant_id=p_tenant AND c.id=p_conversation;
 IF j IS NULL THEN RETURN true; END IF;
 IF j ? 'transferred' AND jsonb_typeof(j->'transferred')<>'null'
    AND (j->>'transferred') IS DISTINCT FROM 'false' THEN RETURN true; END IF;
 IF j ? 'human_agent_until' AND jsonb_typeof(j->'human_agent_until')<>'null' THEN
  IF jsonb_typeof(j->'human_agent_until')<>'string' THEN RETURN true; END IF;
  BEGIN
   v_until := (j->>'human_agent_until')::timestamptz;
  EXCEPTION WHEN others THEN RETURN true;
  END;
  IF v_until>now() THEN RETURN true; END IF;
 END IF;
 RETURN false;
END
$takeover$;

-- ---------------------------------------------------------------------------
-- (A) Cancel one active run (tenant-scoped). Usable by ingress on free text,
-- inactive revision or supersede; by the worker on ineligible wake-ups.
-- Ends the run as 'blocked' and skips its not-yet-sent effects.
-- Deliberately NOT gated by kill switches: stopping is always allowed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flow_cancel_run(
 p_tenant uuid,p_run uuid,p_reason text,p_expect_status text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $cancel$
DECLARE v_status text;
BEGIN
 IF p_tenant IS NULL OR p_run IS NULL OR p_reason IS NULL OR p_reason NOT IN(
     'input_timeout','stale','free_text','revision_inactive','superseded',
     'ineligible','human_takeover','lease_exhausted','duplicate_active','manual')
  OR (p_expect_status IS NOT NULL AND
      p_expect_status NOT IN('ready','awaiting_input','sleeping'))
 THEN RETURN false; END IF;
 SELECT r.run_status INTO v_status FROM public.automation_flow_runs r
 WHERE r.tenant_id=p_tenant AND r.id=p_run FOR UPDATE;
 IF NOT FOUND OR v_status NOT IN('ready','awaiting_input','sleeping')
  OR (p_expect_status IS NOT NULL AND v_status<>p_expect_status)
 THEN RETURN false; END IF;
 UPDATE public.automation_flow_runs
 SET run_status='blocked',wake_at=NULL,ended_reason=p_reason,
     ended_at=now(),updated_at=now()
 WHERE tenant_id=p_tenant AND id=p_run;
 UPDATE public.automation_flow_outbox
 SET delivery_status='cancelled',cancel_reason=p_reason,cancelled_at=now()
 WHERE tenant_id=p_tenant AND run_id=p_run
  AND delivery_status IN('pending','retry_wait');
 DELETE FROM public.automation_flow_run_leases
 WHERE tenant_id=p_tenant AND run_id=p_run;
 RETURN true;
END
$cancel$;

-- (A) Sweep: awaiting_input/ready runs older than p_max_age_minutes (based on
-- updated_at, which flow_commit_run_step sets when entering the state), plus
-- awaiting_input runs whose exact revision is no longer active (any age).
CREATE OR REPLACE FUNCTION public.flow_expire_waiting_runs(
 p_max_age_minutes integer DEFAULT 1440,p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $expire$
DECLARE r record; n integer := 0; v_reason text;
BEGIN
 IF p_max_age_minutes IS NULL OR p_max_age_minutes NOT BETWEEN 5 AND 43200
  OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
 THEN RAISE EXCEPTION 'invalid expiry bounds'; END IF;
 -- FOR UPDATE re-evaluates the age/status predicate on the latest row
 -- version, so a button tap that just advanced the run (new updated_at)
 -- drops it from the batch; rows locked by an in-flight tap are skipped.
 FOR r IN
  SELECT run.tenant_id,run.id,run.run_status,
   EXISTS(SELECT 1 FROM public.automation_flow_activations a
    WHERE a.tenant_id=run.tenant_id AND a.channel_account_id=run.channel_account_id
     AND a.platform=run.platform AND a.flow_key=run.flow_key
     AND a.revision=run.publication_revision AND a.is_active) AS active
  FROM public.automation_flow_runs run
  WHERE run.run_status IN('ready','awaiting_input')
   AND (run.updated_at<=now()-make_interval(mins=>p_max_age_minutes)
    OR (run.run_status='awaiting_input' AND NOT EXISTS(
     SELECT 1 FROM public.automation_flow_activations a
     WHERE a.tenant_id=run.tenant_id AND a.channel_account_id=run.channel_account_id
      AND a.platform=run.platform AND a.flow_key=run.flow_key
      AND a.revision=run.publication_revision AND a.is_active)))
  ORDER BY run.updated_at,run.id
  FOR UPDATE OF run SKIP LOCKED
  LIMIT p_limit
 LOOP
  v_reason := CASE
   WHEN r.run_status='awaiting_input' AND NOT r.active THEN 'revision_inactive'
   WHEN r.run_status='awaiting_input' THEN 'input_timeout'
   ELSE 'stale' END;
  IF public.flow_cancel_run(r.tenant_id,r.id,v_reason,r.run_status) THEN
   n := n+1;
  END IF;
 END LOOP;
 RETURN n;
END
$expire$;

-- ---------------------------------------------------------------------------
-- (B) Lease due runs. Same signature and return shape as 20261028225000.
-- Changes: runs holding a live lease are excluded before LIMIT (they no
-- longer consume batch slots); ineligible runs are ended as 'blocked' instead
-- of staying 'sleeping'; a run leased more than 3 times without a committed
-- step is ended as 'lease_exhausted'. Paused tenants (switch off) are still
-- skipped without being modified, and global OFF still returns nothing.
-- ---------------------------------------------------------------------------
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
 FOR r IN SELECT run.tenant_id AS t_id,run.id AS r_id,run.channel_account_id,
   run.conversation_id,run.platform,run.flow_key,run.publication_revision
  FROM public.automation_flow_runs run
  JOIN public.automation_flow_tenant_switches x
   ON x.tenant_id=run.tenant_id AND x.enabled
     AND (x.test_only OR (x.production_approved AND run.platform='instagram'))
  WHERE run.run_status='sleeping' AND run.wake_at<=now()
   AND NOT EXISTS(SELECT 1 FROM public.automation_flow_run_leases l
     WHERE l.tenant_id=run.tenant_id AND l.run_id=run.id AND l.expires_at>now())
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
  IF v_reason IS NULL THEN
   SELECT to_jsonb(tn) INTO j FROM public.tenants tn WHERE tn.id=r.t_id;
   IF j IS NULL OR (j ? 'is_active' AND (j->>'is_active') IS DISTINCT FROM 'true')
   THEN v_reason := 'ineligible'; END IF;
  END IF;
  IF v_reason IS NULL THEN
   SELECT to_jsonb(ca) INTO j FROM public.channel_accounts ca
   WHERE ca.tenant_id=r.t_id AND ca.id=r.channel_account_id;
   IF j IS NULL
    OR (j ? 'is_active' AND (j->>'is_active') IS DISTINCT FROM 'true')
    OR (j ? 'agent_enabled' AND (j->>'agent_enabled') IS DISTINCT FROM 'true')
    OR (j ? 'auto_reply' AND (j->>'auto_reply') IS DISTINCT FROM 'true')
   THEN v_reason := 'ineligible'; END IF;
  END IF;
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

-- ---------------------------------------------------------------------------
-- (C) Skip effects that must never be sent later.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flow_skip_outbox_effect(
 p_tenant uuid,p_outbox uuid,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $skip_one$
BEGIN
 IF p_tenant IS NULL OR p_outbox IS NULL OR p_reason IS NULL OR p_reason NOT IN(
     'input_timeout','stale','free_text','revision_inactive','superseded',
     'ineligible','human_takeover','lease_exhausted','duplicate_active','manual')
 THEN RETURN false; END IF;
 UPDATE public.automation_flow_outbox
 SET delivery_status='cancelled',cancel_reason=p_reason,cancelled_at=now()
 WHERE tenant_id=p_tenant AND id=p_outbox
  AND delivery_status IN('pending','retry_wait');
 RETURN FOUND;
END
$skip_one$;

-- Sweep customer-visible effects (message/question) still unsent whose run
-- ended, whose revision is inactive, whose conversation is under human
-- takeover, or that are older than p_max_age_minutes. Internal effects
-- (tag/untag/staff_notification) are left alone: a handoff notification is
-- precisely what staff need during a takeover.
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
    AND o.effect_kind IN('message','question')
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

-- ---------------------------------------------------------------------------
-- (E) At most one active (ready/awaiting_input/sleeping) run per conversation.
-- The trigger is the guaranteed guard: it is safe even if duplicates already
-- exist (existing runs keep advancing between active states; only a NEW
-- activation is refused) and it serializes concurrent starts with a
-- transaction-scoped advisory lock. The unique index is defense in depth and
-- is only built when no duplicates exist. Cleanup for pre-existing
-- duplicates is the explicit, operator-invoked
-- flow_resolve_duplicate_active_runs(); after it returns 0 the index can be
-- created by a follow-up migration with the same definition.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flow_guard_one_active_run()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $guard$
BEGIN
 IF TG_OP='UPDATE' AND OLD.run_status IN('ready','awaiting_input','sleeping')
  AND OLD.tenant_id=NEW.tenant_id AND OLD.conversation_id=NEW.conversation_id
 THEN RETURN NEW; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  'flow_active_run:'||NEW.tenant_id::text||':'||NEW.conversation_id::text,0));
 IF EXISTS(SELECT 1 FROM public.automation_flow_runs o
   WHERE o.tenant_id=NEW.tenant_id AND o.conversation_id=NEW.conversation_id
    AND o.id<>NEW.id AND o.run_status IN('ready','awaiting_input','sleeping'))
 THEN
  RAISE EXCEPTION 'flow_active_run_exists'
   USING ERRCODE='23505',
         DETAIL='Another active durable flow run exists for this conversation';
 END IF;
 RETURN NEW;
END
$guard$;

CREATE OR REPLACE TRIGGER flow_one_active_run_guard
 BEFORE INSERT OR UPDATE OF run_status,tenant_id,conversation_id
 ON public.automation_flow_runs
 FOR EACH ROW
 WHEN (NEW.run_status IN ('ready','awaiting_input','sleeping'))
 EXECUTE FUNCTION public.flow_guard_one_active_run();
COMMENT ON TRIGGER flow_one_active_run_guard ON public.automation_flow_runs
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';

DO $unique$
BEGIN
 IF to_regclass('public.flow_one_active_run_per_conversation') IS NOT NULL THEN
  RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM public.automation_flow_runs
   WHERE run_status IN('ready','awaiting_input','sleeping')
   GROUP BY tenant_id,conversation_id HAVING count(*)>1) THEN
  RAISE NOTICE 'Duplicate active flow runs exist; unique index deferred (trigger guard active). Run flow_resolve_duplicate_active_runs().';
  RETURN;
 END IF;
 CREATE UNIQUE INDEX flow_one_active_run_per_conversation
  ON public.automation_flow_runs(tenant_id,conversation_id)
  WHERE run_status IN ('ready','awaiting_input','sleeping');
 COMMENT ON INDEX public.flow_one_active_run_per_conversation
  IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
END
$unique$;

-- Keeps the most recently updated active run per conversation (ties: highest
-- id) and ends the others as blocked/'duplicate_active'. Never auto-invoked.
CREATE OR REPLACE FUNCTION public.flow_resolve_duplicate_active_runs(
 p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $dedupe$
DECLARE r record; n integer := 0;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'invalid duplicate cleanup bound'; END IF;
 FOR r IN
  SELECT q.tenant_id,q.id FROM (
   SELECT run.tenant_id,run.id,
    row_number() OVER(PARTITION BY run.tenant_id,run.conversation_id
     ORDER BY run.updated_at DESC,run.id DESC) AS rn
   FROM public.automation_flow_runs run
   WHERE run.run_status IN('ready','awaiting_input','sleeping')
  ) q WHERE q.rn>1
  ORDER BY q.tenant_id,q.id
  LIMIT p_limit
 LOOP
  IF public.flow_cancel_run(r.tenant_id,r.id,'duplicate_active',NULL) THEN
   n := n+1;
  END IF;
 END LOOP;
 RETURN n;
END
$dedupe$;

-- ---------------------------------------------------------------------------
-- Ownership markers and privileges: service_role only.
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION public.flow_conversation_human_takeover(uuid,uuid)
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
COMMENT ON FUNCTION public.flow_cancel_run(uuid,uuid,text,text)
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
COMMENT ON FUNCTION public.flow_expire_waiting_runs(integer,integer)
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
COMMENT ON FUNCTION public.flow_lease_due_runs(integer)
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
COMMENT ON FUNCTION public.flow_skip_outbox_effect(uuid,uuid,text)
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
COMMENT ON FUNCTION public.flow_skip_blocked_outbox(integer,integer)
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
COMMENT ON FUNCTION public.flow_resolve_duplicate_active_runs(integer)
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
COMMENT ON FUNCTION public.flow_guard_one_active_run()
 IS 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';

REVOKE ALL ON FUNCTION public.flow_conversation_human_takeover(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_cancel_run(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_expire_waiting_runs(integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_lease_due_runs(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_skip_outbox_effect(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_skip_blocked_outbox(integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_resolve_duplicate_active_runs(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_guard_one_active_run() FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION public.flow_conversation_human_takeover(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_cancel_run(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_expire_waiting_runs(integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_lease_due_runs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_skip_outbox_effect(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_skip_blocked_outbox(integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_resolve_duplicate_active_runs(integer) TO service_role;
COMMIT;
