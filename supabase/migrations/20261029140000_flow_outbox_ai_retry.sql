-- REVIEW ONLY: bounded retry state for knowledge_ai outbox effects. NOT applied anywhere.
-- Depends on 20261028226000_flow_outbox_delivery_attempts.sql and
-- 20261029130000_flow_run_lifecycle.sql (cancel_reason / cancelled_at).
--
-- Problem: an empty knowledge answer used to cancel the effect permanently,
-- so a transient OpenAI/network failure silently lost the customer reply.
-- This migration adds the durable state that lets the worker separate:
--  * answer        -> encrypted answer stored on the effect before any send
--  * no_knowledge  -> cancelled / cancel_reason 'no_knowledge' (terminal)
--  * permanent     -> dead_letter / cancel_reason 'ai_unavailable' (terminal)
--  * transient     -> retry_wait + retry_at (next attempt time), bounded;
--                     exhaustion -> dead_letter / 'ai_retries_exhausted'
-- dead_letter is already listed by flow-delivery-review for the owner.
--
-- Additive and idempotent: nullable / constant-default columns, CREATE OR
-- REPLACE functions, the cancel_reason CHECK is replaced only by a strict
-- SUPERSET of its previous values. No row is rewritten, no status CHECK is
-- touched (retry_wait / dead_letter / cancelled must already be legal), no
-- cron, Vault, secrets or network calls. Provider sending stays one-shot via
-- flow_reserve_outbox_delivery (unchanged), which requires delivery_status
-- 'pending'; retry_wait rows can never be reserved.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_def text; v_fn regprocedure; v_name text;
 v_marker constant text := 'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY';
 v_seen boolean := false;
BEGIN
 IF to_regclass('public.automation_flow_outbox') IS NULL THEN
  RAISE EXCEPTION 'AI retry prerequisite missing: automation_flow_outbox'; END IF;
 IF (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='automation_flow_outbox'
      AND column_name IN ('tenant_id','id','effect_kind','delivery_status',
       'cancel_reason','cancelled_at'))<>6
 THEN RAISE EXCEPTION 'Outbox shape mismatch (lifecycle 20261029130000 required); abort';
 END IF;
 IF to_regprocedure('public.flow_reserve_outbox_delivery(uuid,uuid)') IS NULL THEN
  RAISE EXCEPTION 'AI retry prerequisite missing: flow_reserve_outbox_delivery'; END IF;
 -- Never relax the status CHECK: every status used here must already be legal.
 FOR v_def IN SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
  WHERE c.conrelid='public.automation_flow_outbox'::regclass AND c.contype='c'
   AND pg_get_constraintdef(c.oid) LIKE '%delivery_status%'
 LOOP
  v_seen := true;
  IF position('''retry_wait''' IN v_def)=0 OR position('''dead_letter''' IN v_def)=0
   OR position('''cancelled''' IN v_def)=0 OR position('''pending''' IN v_def)=0 THEN
   RAISE EXCEPTION 'Outbox status CHECK lacks retry_wait/dead_letter/cancelled; abort';
  END IF;
 END LOOP;
 IF NOT v_seen THEN RAISE EXCEPTION 'Outbox status CHECK not found; abort'; END IF;
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_claim_outbox_ai(uuid,uuid,integer,integer)',
  'public.flow_store_outbox_ai_answer(uuid,uuid,uuid,text)',
  'public.flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer)'
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NOT NULL AND obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'Unrecognized existing function %', v_name;
  END IF;
 END LOOP;
END
$preflight$;

-- retry_at already exists on the installed shape (used as next attempt time);
-- IF NOT EXISTS keeps this a no-op there.
ALTER TABLE public.automation_flow_outbox
 ADD COLUMN IF NOT EXISTS retry_at timestamptz,
 ADD COLUMN IF NOT EXISTS ai_attempts integer NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS ai_last_error_code text,
 ADD COLUMN IF NOT EXISTS ai_lease_token uuid,
 ADD COLUMN IF NOT EXISTS ai_lease_expires_at timestamptz,
 ADD COLUMN IF NOT EXISTS ai_answer_encrypted text;

DO $checks$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint
   WHERE conrelid='public.automation_flow_outbox'::regclass
    AND conname='automation_flow_outbox_ai_state_chk') THEN
  ALTER TABLE public.automation_flow_outbox
   ADD CONSTRAINT automation_flow_outbox_ai_state_chk CHECK(
    ai_attempts BETWEEN 0 AND 10
    AND (ai_last_error_code IS NULL OR ai_last_error_code ~ '^[a-z0-9_]{1,48}$')
    AND (ai_answer_encrypted IS NULL OR (ai_answer_encrypted LIKE 'enc:v1:%'
         AND length(ai_answer_encrypted) <= 20000))
    AND ((ai_lease_token IS NULL) = (ai_lease_expires_at IS NULL)))
   NOT VALID;
  ALTER TABLE public.automation_flow_outbox
   VALIDATE CONSTRAINT automation_flow_outbox_ai_state_chk;
 END IF;
 -- Superset of the lifecycle reasons plus the three AI reasons. Replaced only
 -- when the AI reasons are missing, so re-applying is a no-op.
 IF NOT EXISTS(SELECT 1 FROM pg_constraint
   WHERE conrelid='public.automation_flow_outbox'::regclass
    AND conname='automation_flow_outbox_cancel_reason_chk'
    AND position('''ai_retries_exhausted''' IN pg_get_constraintdef(oid))>0) THEN
  ALTER TABLE public.automation_flow_outbox
   DROP CONSTRAINT IF EXISTS automation_flow_outbox_cancel_reason_chk;
  ALTER TABLE public.automation_flow_outbox
   ADD CONSTRAINT automation_flow_outbox_cancel_reason_chk CHECK(
    cancel_reason IS NULL OR cancel_reason IN(
     'input_timeout','stale','free_text','revision_inactive','superseded',
     'ineligible','human_takeover','lease_exhausted','duplicate_active','manual',
     'no_knowledge','ai_unavailable','ai_retries_exhausted'))
   NOT VALID;
  ALTER TABLE public.automation_flow_outbox
   VALIDATE CONSTRAINT automation_flow_outbox_cancel_reason_chk;
 END IF;
END
$checks$;

-- ---------------------------------------------------------------------------
-- Claim one knowledge_ai effect for a single model attempt (tenant-scoped).
-- outcome: 'claimed' (attempt counted, lease token returned), 'cached' (an
-- answer already exists: reuse it, never call the model), 'busy' (row locked
-- or AI lease live), 'not_due' (backoff not elapsed), 'not_claimable' (not
-- pending/retry_wait, wrong tenant or kind), 'exhausted' (attempt budget used
-- up by crashed attempts: moved to dead_letter here).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flow_claim_outbox_ai(
 p_tenant uuid,p_outbox uuid,p_max_attempts integer DEFAULT 5,p_lease_seconds integer DEFAULT 120)
RETURNS TABLE(outcome text,claim_token uuid,attempt integer,answer_encrypted text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $claim$
DECLARE o record; v_token uuid;
BEGIN
 IF p_tenant IS NULL OR p_outbox IS NULL OR p_max_attempts IS NULL
  OR p_max_attempts NOT BETWEEN 1 AND 8
  OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 600
 THEN RAISE EXCEPTION 'invalid ai claim arguments'; END IF;
 PERFORM 1 FROM public.automation_flow_outbox x
 WHERE x.tenant_id=p_tenant AND x.id=p_outbox;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'not_claimable'::text,NULL::uuid,NULL::integer,NULL::text; RETURN;
 END IF;
 SELECT x.delivery_status,x.effect_kind,x.retry_at,x.ai_attempts,
        x.ai_lease_expires_at,x.ai_answer_encrypted
 INTO o FROM public.automation_flow_outbox x
 WHERE x.tenant_id=p_tenant AND x.id=p_outbox
 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'busy'::text,NULL::uuid,NULL::integer,NULL::text; RETURN;
 END IF;
 IF o.delivery_status NOT IN('pending','retry_wait')
  OR o.effect_kind NOT IN('message','question') THEN
  RETURN QUERY SELECT 'not_claimable'::text,NULL::uuid,NULL::integer,NULL::text; RETURN;
 END IF;
 IF o.retry_at IS NOT NULL AND o.retry_at>now() THEN
  RETURN QUERY SELECT 'not_due'::text,NULL::uuid,NULL::integer,NULL::text; RETURN;
 END IF;
 IF o.ai_lease_expires_at IS NOT NULL AND o.ai_lease_expires_at>now() THEN
  RETURN QUERY SELECT 'busy'::text,NULL::uuid,NULL::integer,NULL::text; RETURN;
 END IF;
 IF o.ai_answer_encrypted IS NOT NULL THEN
  UPDATE public.automation_flow_outbox
  SET delivery_status='pending',retry_at=NULL,ai_lease_token=NULL,ai_lease_expires_at=NULL
  WHERE tenant_id=p_tenant AND id=p_outbox;
  RETURN QUERY SELECT 'cached'::text,NULL::uuid,o.ai_attempts,o.ai_answer_encrypted; RETURN;
 END IF;
 IF o.ai_attempts>=p_max_attempts THEN
  UPDATE public.automation_flow_outbox
  SET delivery_status='dead_letter',cancel_reason='ai_retries_exhausted',
      retry_at=NULL,ai_lease_token=NULL,ai_lease_expires_at=NULL,
      ai_last_error_code=coalesce(ai_last_error_code,'ai_attempt_abandoned')
  WHERE tenant_id=p_tenant AND id=p_outbox;
  RETURN QUERY SELECT 'exhausted'::text,NULL::uuid,o.ai_attempts,NULL::text; RETURN;
 END IF;
 v_token := gen_random_uuid();
 UPDATE public.automation_flow_outbox
 SET delivery_status='pending',retry_at=NULL,ai_attempts=o.ai_attempts+1,
     ai_lease_token=v_token,ai_lease_expires_at=now()+make_interval(secs=>p_lease_seconds)
 WHERE tenant_id=p_tenant AND id=p_outbox;
 RETURN QUERY SELECT 'claimed'::text,v_token,o.ai_attempts+1,NULL::text;
END
$claim$;

-- Persist the generated answer (already encrypted by the worker with the
-- field key) under the live claim. Only after this does the worker reserve
-- and send; a later attempt finds 'cached' and never regenerates.
CREATE OR REPLACE FUNCTION public.flow_store_outbox_ai_answer(
 p_tenant uuid,p_outbox uuid,p_token uuid,p_answer_encrypted text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $store$
BEGIN
 IF p_tenant IS NULL OR p_outbox IS NULL OR p_token IS NULL OR p_answer_encrypted IS NULL
  OR p_answer_encrypted NOT LIKE 'enc:v1:%' OR length(p_answer_encrypted)>20000
 THEN RETURN false; END IF;
 UPDATE public.automation_flow_outbox
 SET ai_answer_encrypted=p_answer_encrypted,ai_last_error_code=NULL,
     ai_lease_token=NULL,ai_lease_expires_at=NULL
 WHERE tenant_id=p_tenant AND id=p_outbox AND delivery_status='pending'
  AND ai_lease_token=p_token AND ai_answer_encrypted IS NULL;
 RETURN FOUND;
END
$store$;

-- Record a non-answer outcome under the live claim. Returns the new
-- delivery_status, or NULL when the claim was lost / arguments are invalid.
--  no_knowledge | ineligible -> cancelled (cancel_reason = p_result)
--  permanent                 -> dead_letter / 'ai_unavailable'
--  retry                     -> retry_wait, retry_at = now()+delay (30..1800 s),
--                               or dead_letter / 'ai_retries_exhausted' once
--                               ai_attempts >= p_max_attempts
CREATE OR REPLACE FUNCTION public.flow_finish_outbox_ai(
 p_tenant uuid,p_outbox uuid,p_token uuid,p_result text,p_error_code text DEFAULT NULL,
 p_delay_seconds integer DEFAULT 60,p_max_attempts integer DEFAULT 5)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $finish$
DECLARE v_attempts integer; v_status text; v_code text;
BEGIN
 IF p_tenant IS NULL OR p_outbox IS NULL OR p_token IS NULL
  OR p_result IS NULL OR p_result NOT IN('no_knowledge','ineligible','permanent','retry')
  OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 8
 THEN RETURN NULL; END IF;
 v_code := CASE WHEN p_error_code ~ '^[a-z0-9_]{1,48}$' THEN p_error_code
  WHEN p_result IN('permanent','retry') THEN 'ai_unknown' END;
 SELECT x.ai_attempts INTO v_attempts FROM public.automation_flow_outbox x
 WHERE x.tenant_id=p_tenant AND x.id=p_outbox AND x.delivery_status='pending'
  AND x.ai_lease_token=p_token AND x.ai_answer_encrypted IS NULL
 FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF p_result IN('no_knowledge','ineligible') THEN
  UPDATE public.automation_flow_outbox
  SET delivery_status='cancelled',cancel_reason=p_result,cancelled_at=now(),
      retry_at=NULL,ai_lease_token=NULL,ai_lease_expires_at=NULL
  WHERE tenant_id=p_tenant AND id=p_outbox;
  RETURN 'cancelled';
 END IF;
 IF p_result='permanent' OR v_attempts>=p_max_attempts THEN
  UPDATE public.automation_flow_outbox
  SET delivery_status='dead_letter',
      cancel_reason=CASE WHEN p_result='permanent' THEN 'ai_unavailable' ELSE 'ai_retries_exhausted' END,
      ai_last_error_code=v_code,retry_at=NULL,ai_lease_token=NULL,ai_lease_expires_at=NULL
  WHERE tenant_id=p_tenant AND id=p_outbox;
  RETURN 'dead_letter';
 END IF;
 v_status := 'retry_wait';
 UPDATE public.automation_flow_outbox
 SET delivery_status=v_status,ai_last_error_code=v_code,
     retry_at=now()+make_interval(secs=>least(greatest(coalesce(p_delay_seconds,60),30),1800)),
     ai_lease_token=NULL,ai_lease_expires_at=NULL
 WHERE tenant_id=p_tenant AND id=p_outbox;
 RETURN v_status;
END
$finish$;

COMMENT ON FUNCTION public.flow_claim_outbox_ai(uuid,uuid,integer,integer)
 IS 'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY';
COMMENT ON FUNCTION public.flow_store_outbox_ai_answer(uuid,uuid,uuid,text)
 IS 'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY';
COMMENT ON FUNCTION public.flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer)
 IS 'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY';

REVOKE ALL ON FUNCTION public.flow_claim_outbox_ai(uuid,uuid,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_store_outbox_ai_answer(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_claim_outbox_ai(uuid,uuid,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_store_outbox_ai_answer(uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer) TO service_role;
COMMIT;
