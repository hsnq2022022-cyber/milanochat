-- REVIEW ONLY: activation generations for Flow runs (same-revision
-- reactivation). NOT applied anywhere by this repository; apply only with an
-- explicit owner GO, after the TypeScript consumers are ready (see Order).
--
-- Problem: eligibility of a run / effect was "the activation row of its flow
-- key has the run's revision and is_active". Nothing recorded WHICH activation
-- a run was created under, so deactivate -> reactivate of the same revision
-- (or A -> B -> A) revived every old sleeping run, awaiting run and pending
-- effect that no worker happened to end during the off window.
--
-- Semantics (confirmed):
--  1. Every genuine transition to active (inactive -> active, or active with a
--     different revision) is a NEW generation, even with an unchanged revision.
--  2. Activating an already-active revision is a true no-op: generation,
--     activated_at (and the row) stay as they are.
--  3. Work created under an older generation never resumes and never delivers
--     NEW effects once a newer generation is active.
--  4. Legacy NULL stamps are explicit (see "Legacy" below).
--  5. Effects already 'leased' / 'uncertain' / 'charge_pending' keep going
--     through the unchanged delivery-review mechanism (no predicate here
--     touches those statuses).
--
-- Data model (additive):
--   automation_flow_activations.activation_generation bigint NOT NULL DEFAULT 1
--   automation_flow_runs.activation_generation        bigint NULL
--   Effects (automation_flow_outbox) carry no column: they belong to their
--   run, so every predicate joins the run (also when the run is 'completed':
--   a run completes as soon as its effects are queued, delivery is later).
--
-- Objects:
--  * flow_activation_generation_guard() + BEFORE INSERT OR UPDATE trigger on
--    automation_flow_activations. INSERT -> generation 1. UPDATE: bump by 1
--    exactly when the new row is active AND (the old row was inactive OR the
--    revision changed); otherwise the generation is kept (a direct write can
--    never set it) and an active -> active same-revision write keeps the old
--    activated_at (true no-op). Because it is a trigger it also covers writers
--    that bypass flow_activate_revision.
--  * flow_run_generation_guard() + BEFORE INSERT OR UPDATE trigger on
--    automation_flow_runs. INSERT: reads the matching ACTIVE activation row
--    FOR SHARE in the same transaction and stamps its generation (a caller
--    supplied value is ignored). If there is no active matching activation the
--    insert fails (SQLSTATE FB191): no run is ever created without a valid
--    generation, and a concurrent activation write waits for the creating
--    transaction, so a run is never stamped with a generation other than the
--    one current at its insert. UPDATE: a non-NULL stamp is immutable.
--    The run creators (flow_begin_durable_run, flow_begin_comment_run and the
--    wrappers) are therefore NOT redefined - their production bodies differ
--    from the repository (20261029350000 is not applied in production).
--  * Guarded patches (pg_get_functiondef + exact fragment replace, abort on
--    any drift; md5(prosrc) of every function is verified before and after):
--      flow_activate_revision      idempotent (DO UPDATE ... WHERE NOT already
--                                  active with the same revision)
--      flow_lease_due_runs         sleeping run of an older generation ->
--                                  cancelled 'revision_inactive' at lease time
--      flow_expire_waiting_runs    awaiting run of an older generation ->
--                                  cancelled 'revision_inactive'
--      flow_resume_button_run      refuses an older-generation awaiting run
--      flow_reserve_outbox_delivery / flow_apply_internal_effect /
--      flow_claim_comment_reply    refuse effects of an older generation
--      flow_skip_blocked_outbox    cancels pending/retry_wait effects of an
--                                  older generation as 'revision_inactive'; and
--                                  ends an ABANDONED reply_comment effect (lease
--                                  expired, run no longer live) as 'uncertain':
--                                  flow_claim_comment_reply now refuses it for
--                                  good, lease recovery excludes reply_comment,
--                                  and the cancelling sweep ignores 'leased', so
--                                  it would otherwise stay 'leased' / 'attempting'
--                                  forever (and be re-listed by every outbox
--                                  tick). A post may have been in flight, so the
--                                  state is 'uncertain' (delivery review), never
--                                  'cancelled' and never resent; the comment-
--                                  reply row becomes 'uncertain' with code
--                                  abandoned_revision_inactive and its DM is
--                                  skipped. The same predicate also resolves the
--                                  identical stuck state of a merely DEACTIVATED
--                                  revision, which existed before this migration.
--      flow_commit_run_step        a sleeping / awaiting run can only commit
--                                  while its generation is current
--    No new ended_reason / cancel_reason: 'revision_inactive' is reused so no
--    CHECK, flow_cancel_run list or TypeScript list changes.
--
-- Legacy: predicates treat a NULL run stamp as legacy-permissive (exactly the
-- previous behaviour: active activation with the run's revision). The backfill
-- below leaves NULL ONLY on runs that can no longer produce work (terminal run
-- with no non-final effect). Every other existing run is stamped: with the
-- CURRENT generation when its activation is active with the run's revision,
-- otherwise with 0, which no activation ever has - so inactive-today work is
-- dead and cannot be revived by a later activation. New runs never get NULL
-- (trigger above).
--
-- Locking: both tables are locked up front with LOCK ... NOWAIT in a 30 s retry loop (see the
-- block before step 1), so the migration never queues other traffic and cannot deadlock with
-- a worker; the 3 s lock_timeout below only bounds the few ordinary lock waits after that.
-- Order (runbook: docs/ACTIVATION_GENERATION_DEPLOYMENT.md): APPLY = this migration ->
-- verify -> the four TypeScript consumers (flow-runtime-worker, flow-outbox-worker,
-- flow-internal-worker, milan-api; they SELECT the new columns). ROLLBACK = the previous
-- TypeScript first -> verify -> the rollback SQL. Out of order is fail-closed (nothing
-- is sent) but stalls the durable path: new TypeScript on the old schema returns
-- 'retry' / 'blocked' for every run and effect. New SQL with the old TypeScript is
-- safe; the only visible effect is the durable ingress logging "pending manual review"
-- for a tap on a stale awaiting run until the new ingress is deployed.
--
-- Not touched: flow_deactivate_revision, flow_cancel_run, flow_begin_*,
-- flow_claim_*, delivery attempts / review, every table CHECK, RLS, grants.
-- Ownership marker: CREATED_BY_20261123100000_FLOW_ACTIVATION_GENERATION
-- Rollback: supabase/rollbacks/20261123100000_flow_activation_generation.rollback.sql

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='120s';
SET LOCAL search_path = '';

DO $preflight$
DECLARE s record; v_sig regprocedure;
BEGIN
  IF to_regclass('public.automation_flow_activations') IS NULL
     OR to_regclass('public.automation_flow_runs') IS NULL
     OR to_regclass('public.automation_flow_outbox') IS NULL THEN
    RAISE EXCEPTION 'activation generation: flow runtime tables missing';
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND column_name='activation_generation'
        AND table_name IN('automation_flow_activations','automation_flow_runs'))
     OR to_regprocedure('public.flow_activation_generation_guard()') IS NOT NULL
     OR to_regprocedure('public.flow_run_generation_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'activation generation already installed (or partially); refuse';
  END IF;
  -- Every function patched below must be EXACTLY the verified production
  -- body (md5 of the stored source), otherwise nothing is changed.
  FOR s IN SELECT * FROM (VALUES
    ('public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid)','365673115a22b53c61535152c37c78f8'),
    ('public.flow_apply_internal_effect(uuid,uuid)','fa8c86694f1c74dd10b1679b7ac0a237'),
    ('public.flow_claim_comment_reply(uuid,uuid,integer)','dd1eca86c5daab73e142d9e07ab7fc61'),
    ('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamp with time zone,jsonb,text,uuid)','aa304ad2f783a1c202a06693ac250e0e'),
    ('public.flow_expire_waiting_runs(integer,integer)','4397b9588093462f6833b87ac217edce'),
    ('public.flow_lease_due_runs(integer)','130bba5dd3c48c1e16398d921e53c6af'),
    ('public.flow_reserve_outbox_delivery(uuid,uuid)','0ca73aa826e2088dffd8879964c6ee47'),
    ('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamp with time zone,jsonb)','971af0ec215a68a2281ac8791194edf4'),
    ('public.flow_skip_blocked_outbox(integer,integer)','b19044e4c14f6d7b03c03d4b021a81f2')
  ) v(sig,h) LOOP
    v_sig := to_regprocedure(s.sig);
    IF v_sig IS NULL THEN RAISE EXCEPTION 'activation generation: % missing', s.sig; END IF;
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid=v_sig) IS DISTINCT FROM s.h THEN
      RAISE EXCEPTION 'activation generation: % changed (manual review required)', s.sig;
    END IF;
  END LOOP;
END
$preflight$;

-- Take every lock this migration needs UP FRONT, without ever queueing for it. A plain
-- ALTER TABLE waits in the lock queue and, while it waits, every other statement on that
-- table queues behind it; two ALTERs in the opposite order of the workers (runs, then
-- activations) can also deadlock with a worker transaction. LOCK ... NOWAIT never waits:
-- if either table is busy the whole attempt is undone (locks of the failed attempt are
-- released with its subtransaction) and retried every 0.5 s for up to 30 s. Both tables
-- are locked in ONE statement, runs first, the order the workers take them. If they stay
-- busy the migration aborts with nothing changed; run it again in a quiet moment.
DO $lock$
DECLARE v_try integer;
BEGIN
  FOR v_try IN 1..60 LOOP
    BEGIN
      LOCK TABLE public.automation_flow_runs, public.automation_flow_activations
        IN ACCESS EXCLUSIVE MODE NOWAIT;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try=60 THEN
        RAISE EXCEPTION 'activation generation: automation_flow_runs / automation_flow_activations stayed busy for 30 s; nothing was changed, retry in a quiet moment';
      END IF;
      PERFORM pg_sleep(0.5);
    END;
  END LOOP;
END
$lock$;

-- 1. Columns.
ALTER TABLE public.automation_flow_activations
  ADD COLUMN activation_generation bigint NOT NULL DEFAULT 1;
ALTER TABLE public.automation_flow_activations
  ADD CONSTRAINT automation_flow_activations_generation_chk CHECK(activation_generation>=1);
ALTER TABLE public.automation_flow_runs
  ADD COLUMN activation_generation bigint;
ALTER TABLE public.automation_flow_runs
  ADD CONSTRAINT automation_flow_runs_generation_chk CHECK(activation_generation IS NULL OR activation_generation>=0);
COMMENT ON COLUMN public.automation_flow_activations.activation_generation
  IS 'CREATED_BY_20261123100000_FLOW_ACTIVATION_GENERATION: bumped by trigger on every genuine transition to active';
COMMENT ON COLUMN public.automation_flow_runs.activation_generation
  IS 'CREATED_BY_20261123100000_FLOW_ACTIVATION_GENERATION: generation of the activation the run was created under (NULL = legacy, 0 = dead)';

-- 2. Activation transition trigger.
CREATE OR REPLACE FUNCTION public.flow_activation_generation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $gen$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.activation_generation := 1;
    RETURN NEW;
  END IF;
  IF NEW.is_active AND (NOT OLD.is_active OR NEW.revision IS DISTINCT FROM OLD.revision) THEN
    NEW.activation_generation := OLD.activation_generation+1;
  ELSE
    NEW.activation_generation := OLD.activation_generation;
    IF NEW.is_active AND OLD.is_active THEN
      NEW.activated_at := OLD.activated_at;  -- active -> active, same revision: no-op
    END IF;
  END IF;
  RETURN NEW;
END
$gen$;
COMMENT ON FUNCTION public.flow_activation_generation_guard()
  IS 'CREATED_BY_20261123100000_FLOW_ACTIVATION_GENERATION';
CREATE TRIGGER automation_flow_activations_generation_trg
  BEFORE INSERT OR UPDATE ON public.automation_flow_activations
  FOR EACH ROW EXECUTE FUNCTION public.flow_activation_generation_guard();

-- 3. Run stamp trigger.
CREATE OR REPLACE FUNCTION public.flow_run_generation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $gen$
DECLARE v_gen bigint;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT a.activation_generation INTO v_gen
    FROM public.automation_flow_activations a
    WHERE a.tenant_id=NEW.tenant_id AND a.channel_account_id=NEW.channel_account_id
      AND a.platform=NEW.platform AND a.flow_key=NEW.flow_key
      AND a.revision=NEW.publication_revision AND a.is_active
    FOR SHARE;
    IF v_gen IS NULL THEN
      RAISE EXCEPTION 'flow_run_requires_active_activation' USING ERRCODE='FB191';
    END IF;
    NEW.activation_generation := v_gen;
    RETURN NEW;
  END IF;
  IF OLD.activation_generation IS NOT NULL
     AND NEW.activation_generation IS DISTINCT FROM OLD.activation_generation THEN
    RAISE EXCEPTION 'flow_run_generation_immutable' USING ERRCODE='FB191';
  END IF;
  RETURN NEW;
END
$gen$;
COMMENT ON FUNCTION public.flow_run_generation_guard()
  IS 'CREATED_BY_20261123100000_FLOW_ACTIVATION_GENERATION';
CREATE TRIGGER automation_flow_runs_generation_trg
  BEFORE INSERT OR UPDATE ON public.automation_flow_runs
  FOR EACH ROW EXECUTE FUNCTION public.flow_run_generation_guard();
REVOKE ALL ON FUNCTION public.flow_activation_generation_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_run_generation_guard() FROM PUBLIC,anon,authenticated;

-- 4. Guarded function patches.
DO $patch$
DECLARE s record; p record; v_def text; v_orig text; v_sig regprocedure; v_n integer;
BEGIN
  FOR s IN SELECT * FROM (VALUES
    (1,'public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid)'),
    (2,'public.flow_lease_due_runs(integer)'),
    (3,'public.flow_expire_waiting_runs(integer,integer)'),
    (4,'public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamp with time zone,jsonb)'),
    (5,'public.flow_reserve_outbox_delivery(uuid,uuid)'),
    (6,'public.flow_apply_internal_effect(uuid,uuid)'),
    (7,'public.flow_claim_comment_reply(uuid,uuid,integer)'),
    (8,'public.flow_skip_blocked_outbox(integer,integer)'),
    (9,'public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamp with time zone,jsonb,text,uuid)')
  ) v(fn,sig) ORDER BY fn LOOP
    v_sig := to_regprocedure(s.sig);
    v_def := pg_get_functiondef(v_sig);
    v_orig := v_def;
    IF strpos(v_def,'activation_generation')>0
       OR (s.fn=1 AND strpos(v_def,'EXCLUDED.revision)')>0) THEN
      RAISE EXCEPTION 'activation generation: % already patched', s.sig;
    END IF;
    FOR p IN SELECT * FROM (VALUES
      -- flow_activate_revision: idempotent activation.
      (1,1,$q$activated_at=now(),updated_at=now();$q$,
         $q$activated_at=now(),updated_at=now()
  WHERE NOT (public.automation_flow_activations.is_active
    AND public.automation_flow_activations.revision=EXCLUDED.revision);$q$,1),
      -- flow_lease_due_runs.
      (2,1,$q$run.flow_key,run.publication_revision
  FROM public.automation_flow_runs run$q$,
         $q$run.flow_key,run.publication_revision,run.activation_generation
  FROM public.automation_flow_runs run$q$,1),
      (2,2,$q$AND a.revision=r.publication_revision AND a.is_active)$q$,
         $q$AND a.revision=r.publication_revision AND a.is_active
     AND (r.activation_generation IS NULL
      OR r.activation_generation=a.activation_generation))$q$,1),
      -- flow_expire_waiting_runs (both the active flag and the awaiting sweep).
      (3,1,$q$AND a.revision=run.publication_revision AND a.is_active)$q$,
         $q$AND a.revision=run.publication_revision AND a.is_active
     AND (run.activation_generation IS NULL
      OR run.activation_generation=a.activation_generation))$q$,2),
      -- flow_resume_button_run.
      (4,1,$q$AND revision=old_run.publication_revision AND is_active)$q$,
         $q$AND revision=old_run.publication_revision AND is_active
     AND (old_run.activation_generation IS NULL
      OR old_run.activation_generation=public.automation_flow_activations.activation_generation))$q$,1),
      -- flow_reserve_outbox_delivery / flow_apply_internal_effect.
      (5,1,$q$AND a.revision=r.publication_revision AND a.is_active
 WHERE o.tenant_id=p_tenant AND o.id=p_outbox$q$,
         $q$AND a.revision=r.publication_revision AND a.is_active
  AND (r.activation_generation IS NULL
   OR r.activation_generation=a.activation_generation)
 WHERE o.tenant_id=p_tenant AND o.id=p_outbox$q$,1),
      (6,1,$q$AND a.revision=r.publication_revision AND a.is_active
 WHERE o.tenant_id=p_tenant AND o.id=p_outbox$q$,
         $q$AND a.revision=r.publication_revision AND a.is_active
  AND (r.activation_generation IS NULL
   OR r.activation_generation=a.activation_generation)
 WHERE o.tenant_id=p_tenant AND o.id=p_outbox$q$,1),
      -- flow_claim_comment_reply.
      (7,1,$q$AND a.revision=r.publication_revision AND a.is_active
 WHERE x.tenant_id=p_tenant AND x.id=p_outbox$q$,
         $q$AND a.revision=r.publication_revision AND a.is_active
  AND (r.activation_generation IS NULL
   OR r.activation_generation=a.activation_generation)
 WHERE x.tenant_id=p_tenant AND x.id=p_outbox$q$,1),
      -- flow_skip_blocked_outbox.
      (8,1,$q$AND a.revision=run.publication_revision AND a.is_active)$q$,
         $q$AND a.revision=run.publication_revision AND a.is_active
        AND (run.activation_generation IS NULL
         OR run.activation_generation=a.activation_generation))$q$,1),
      (8,2,$q$ END LOOP;
 RETURN n;$q$,
         $q$ END LOOP;
 -- Abandoned reply_comment effects of a run that is no longer live (see header).
 FOR r IN
  SELECT o.tenant_id,o.id,o.run_id
  FROM public.automation_flow_outbox o
  JOIN public.automation_flow_runs run
   ON run.tenant_id=o.tenant_id AND run.id=o.run_id
  WHERE o.delivery_status='leased' AND o.effect_kind='reply_comment'
   AND o.lease_expires_at<=now()
   AND NOT EXISTS(SELECT 1 FROM public.automation_flow_activations a
    WHERE a.tenant_id=run.tenant_id AND a.channel_account_id=run.channel_account_id
     AND a.platform=run.platform AND a.flow_key=run.flow_key
     AND a.revision=run.publication_revision AND a.is_active
     AND (run.activation_generation IS NULL
      OR run.activation_generation=a.activation_generation))
  ORDER BY o.lease_expires_at,o.id
  LIMIT p_limit
  FOR UPDATE OF o SKIP LOCKED
 LOOP
  UPDATE public.automation_flow_outbox
  SET delivery_status='uncertain',lease_token=NULL,lease_expires_at=NULL
  WHERE tenant_id=r.tenant_id AND id=r.id AND delivery_status='leased'
   AND lease_expires_at<=now();
  IF FOUND THEN
   UPDATE public.automation_comment_replies
   SET reply_status='uncertain',reply_error_code='abandoned_revision_inactive',
       dm_status=CASE WHEN dm_status='pending' THEN 'skipped' ELSE dm_status END,
       dm_updated_at=now(),updated_at=now()
   WHERE tenant_id=r.tenant_id AND run_id=r.run_id AND reply_status='attempting';
  END IF;
 END LOOP;
 RETURN n;$q$,1),
      -- flow_commit_run_step: a sleeping / awaiting run commits only in its generation.
      (9,1,$q$SELECT run_status,step_count,wake_at INTO old$q$,
         $q$SELECT run_status,step_count,wake_at,activation_generation,
  channel_account_id,platform,flow_key,publication_revision INTO old$q$,1),
      (9,2,$q$old.run_status IN('completed','handoff','blocked')
 THEN RETURN false; END IF;$q$,
         $q$old.run_status IN('completed','handoff','blocked')
 THEN RETURN false; END IF;
 IF old.run_status IN('sleeping','awaiting_input') AND NOT EXISTS(
   SELECT 1 FROM public.automation_flow_activations a
   WHERE a.tenant_id=p_tenant AND a.channel_account_id=old.channel_account_id
    AND a.platform=old.platform AND a.flow_key=old.flow_key
    AND a.revision=old.publication_revision AND a.is_active
    AND (old.activation_generation IS NULL
     OR old.activation_generation=a.activation_generation))
 THEN RETURN false; END IF;$q$,1)
    ) v(fn,step,old_text,new_text,expect) WHERE v.fn=s.fn ORDER BY v.step LOOP
      v_n := (length(v_def)-length(replace(v_def,p.old_text,'')))/length(p.old_text);
      IF v_n IS DISTINCT FROM p.expect THEN
        RAISE EXCEPTION 'activation generation: % fragment % step % found % times, expected %',
          s.sig,p.fn,p.step,v_n,p.expect;
      END IF;
      v_def := replace(v_def,p.old_text,p.new_text);
    END LOOP;
    IF v_def IS NOT DISTINCT FROM v_orig THEN
      RAISE EXCEPTION 'activation generation: % was not patched', s.sig;
    END IF;
    EXECUTE v_def;
  END LOOP;
END
$patch$;

-- 5. Backfill (only rows that can still produce work; see Legacy above).
UPDATE public.automation_flow_runs r
SET activation_generation=coalesce((
  SELECT a.activation_generation FROM public.automation_flow_activations a
  WHERE a.tenant_id=r.tenant_id AND a.channel_account_id=r.channel_account_id
    AND a.platform=r.platform AND a.flow_key=r.flow_key
    AND a.revision=r.publication_revision AND a.is_active),0)
WHERE r.activation_generation IS NULL
  AND (r.run_status IN('ready','awaiting_input','sleeping')
   OR EXISTS(SELECT 1 FROM public.automation_flow_outbox o
     WHERE o.tenant_id=r.tenant_id AND o.run_id=r.id
       AND o.delivery_status IN('pending','retry_wait','leased','uncertain','charge_pending')));

-- 6. Post-conditions.
DO $checks$
DECLARE s record;
BEGIN
  FOR s IN SELECT * FROM (VALUES
    ('public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid)','79c77d2c234ac7587368bd531624d814'),
    ('public.flow_apply_internal_effect(uuid,uuid)','1cdecb73a8a58653148f3e6e9b10d558'),
    ('public.flow_claim_comment_reply(uuid,uuid,integer)','46254136151d521bd9d09cd8d806cf7c'),
    ('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamp with time zone,jsonb,text,uuid)','1f4d180ae46a04109fafc9b79d816761'),
    ('public.flow_expire_waiting_runs(integer,integer)','10b694c49d36b8e1bf37c780c8c0515a'),
    ('public.flow_lease_due_runs(integer)','e17a10af729565b8f74118bbedd3b47f'),
    ('public.flow_reserve_outbox_delivery(uuid,uuid)','3cb82569c3a58f13cfa757bda9fa69df'),
    ('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamp with time zone,jsonb)','d43909cbd21acae85df7649158f71255'),
    ('public.flow_skip_blocked_outbox(integer,integer)','ef5a3251738c0636512a41e4f3932f98')
  ) v(sig,h) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid=to_regprocedure(s.sig)) IS DISTINCT FROM s.h THEN
      RAISE EXCEPTION 'activation generation: % does not have the expected patched body', s.sig;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.automation_flow_runs r
      WHERE r.activation_generation IS NULL
        AND (r.run_status IN('ready','awaiting_input','sleeping')
         OR EXISTS(SELECT 1 FROM public.automation_flow_outbox o
           WHERE o.tenant_id=r.tenant_id AND o.run_id=r.id
             AND o.delivery_status IN('pending','retry_wait','leased','uncertain','charge_pending')))) THEN
    RAISE EXCEPTION 'activation generation: backfill left a live run unstamped';
  END IF;
END
$checks$;
COMMIT;
