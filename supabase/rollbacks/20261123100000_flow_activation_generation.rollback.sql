-- REVIEW ONLY rollback for 20261123100000_flow_activation_generation.
-- NOT applied anywhere by this repository.
--
-- Restores the nine patched functions to their exact pre-migration bodies
-- (md5(prosrc) verified before AND after; any other state is refused), drops
-- the two triggers, their two trigger functions, the two CHECKs and the two
-- activation_generation columns. Nothing else is touched.
-- Consequence: the generation stamps are lost; run eligibility goes back to
-- "active activation with the run's revision", i.e. the same-revision
-- reactivation hazard is back (see the migration header).
-- Order (runbook: docs/ACTIVATION_GENERATION_DEPLOYMENT.md): redeploy the previous TypeScript
-- (flow-runtime-worker, flow-outbox-worker, flow-internal-worker, milan-api) FIRST, confirm
-- in the logs that nothing selects activation_generation any more, THEN run this file.
-- Run with the new TypeScript still live it stalls the durable path (fail closed).
-- A second run is refused (nothing to roll back).
-- Not undone (data): runs ended 'revision_inactive', effects cancelled 'revision_inactive',
-- and abandoned reply_comment effects moved to 'uncertain' stay as they are.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='120s';
SET LOCAL search_path = '';

-- Take every lock this rollback needs UP FRONT, without ever queueing for it. A plain
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


DO $rollback$
DECLARE s record; p record; v_def text; v_orig text; v_sig regprocedure; v_n integer;
BEGIN
  IF to_regprocedure('public.flow_activation_generation_guard()') IS NULL
     OR to_regprocedure('public.flow_run_generation_guard()') IS NULL
     OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
       AND table_name='automation_flow_runs' AND column_name='activation_generation')
     OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
       AND table_name='automation_flow_activations' AND column_name='activation_generation') THEN
    RAISE EXCEPTION 'activation generation rollback: not installed (or partially); refuse';
  END IF;
  FOR s IN SELECT * FROM (VALUES
    (1,'public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid)','79c77d2c234ac7587368bd531624d814','365673115a22b53c61535152c37c78f8'),
    (2,'public.flow_lease_due_runs(integer)','e17a10af729565b8f74118bbedd3b47f','130bba5dd3c48c1e16398d921e53c6af'),
    (3,'public.flow_expire_waiting_runs(integer,integer)','10b694c49d36b8e1bf37c780c8c0515a','4397b9588093462f6833b87ac217edce'),
    (4,'public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamp with time zone,jsonb)','d43909cbd21acae85df7649158f71255','971af0ec215a68a2281ac8791194edf4'),
    (5,'public.flow_reserve_outbox_delivery(uuid,uuid)','3cb82569c3a58f13cfa757bda9fa69df','0ca73aa826e2088dffd8879964c6ee47'),
    (6,'public.flow_apply_internal_effect(uuid,uuid)','1cdecb73a8a58653148f3e6e9b10d558','fa8c86694f1c74dd10b1679b7ac0a237'),
    (7,'public.flow_claim_comment_reply(uuid,uuid,integer)','46254136151d521bd9d09cd8d806cf7c','dd1eca86c5daab73e142d9e07ab7fc61'),
    (8,'public.flow_skip_blocked_outbox(integer,integer)','ef5a3251738c0636512a41e4f3932f98','b19044e4c14f6d7b03c03d4b021a81f2'),
    (9,'public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamp with time zone,jsonb,text,uuid)','1f4d180ae46a04109fafc9b79d816761','aa304ad2f783a1c202a06693ac250e0e')
  ) v(fn,sig,patched,original) ORDER BY fn LOOP
    v_sig := to_regprocedure(s.sig);
    IF v_sig IS NULL THEN RAISE EXCEPTION 'activation generation rollback: % missing', s.sig; END IF;
    IF (SELECT md5(p2.prosrc) FROM pg_proc p2 WHERE p2.oid=v_sig) IS DISTINCT FROM s.patched THEN
      RAISE EXCEPTION 'activation generation rollback: % is not the patched body (manual review required)', s.sig;
    END IF;
    v_def := pg_get_functiondef(v_sig);
    v_orig := v_def;
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
    ) v(fn,step,old_text,new_text,expect) WHERE v.fn=s.fn ORDER BY v.step DESC LOOP
      v_n := (length(v_def)-length(replace(v_def,p.new_text,'')))/length(p.new_text);
      IF v_n IS DISTINCT FROM p.expect THEN
        RAISE EXCEPTION 'activation generation rollback: % step % found % times, expected %',
          s.sig,p.step,v_n,p.expect;
      END IF;
      v_def := replace(v_def,p.new_text,p.old_text);
    END LOOP;
    IF v_def IS NOT DISTINCT FROM v_orig THEN
      RAISE EXCEPTION 'activation generation rollback: % was not restored', s.sig;
    END IF;
    EXECUTE v_def;
    IF (SELECT md5(p2.prosrc) FROM pg_proc p2 WHERE p2.oid=v_sig) IS DISTINCT FROM s.original THEN
      RAISE EXCEPTION 'activation generation rollback: % does not match the original body', s.sig;
    END IF;
  END LOOP;
END
$rollback$;

DROP TRIGGER automation_flow_runs_generation_trg ON public.automation_flow_runs;
DROP TRIGGER automation_flow_activations_generation_trg ON public.automation_flow_activations;
DROP FUNCTION public.flow_run_generation_guard();
DROP FUNCTION public.flow_activation_generation_guard();
ALTER TABLE public.automation_flow_runs DROP CONSTRAINT automation_flow_runs_generation_chk;
ALTER TABLE public.automation_flow_activations DROP CONSTRAINT automation_flow_activations_generation_chk;
ALTER TABLE public.automation_flow_runs DROP COLUMN activation_generation;
ALTER TABLE public.automation_flow_activations DROP COLUMN activation_generation;
COMMIT;
