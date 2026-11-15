-- REVIEW ONLY: retryable inbound processing when FLOW ELIGIBILITY IS UNKNOWN.
-- NOT applied anywhere by this repository; apply only with an explicit owner GO.
--
-- Problem: milan-api persists the inbound message (messages.wa_message_id is
-- the provider dedupe key) BEFORE routing. When the flow routing data
-- (automation_flow_activations / automation_flow_publications, or the
-- automation switches) cannot be READ, no flow may run and the legacy AI must
-- not answer (a flow may own the message). Without state, a Meta redelivery of
-- that event is dropped by the duplicate pre-check and the message is never
-- answered.
--
-- Adds (service_role only, additive):
--  * table public.automation_inbound_routing_retries, one row per provider
--    event whose routing failed: key (tenant_id, channel_account_id,
--    platform, provider_event_id) = the automation_message_claims key;
--    status 'retrying' -> 'resolved' (a later lookup succeeded) or
--    'exhausted' (max attempts reached: terminal, OBSERVABLE, never a
--    success); attempts, first/last failure and resolution times. No
--    message text, no customer identifiers beyond the existing ids.
--  * public.flow_inbound_routing_failed(tenant,account,platform,event,
--    conversation,inbound,max_attempts) RETURNS text: validates ownership with
--    the same rule as flow_claim_inbound (message/conversation/account of the
--    tenant, direction 'in', wa_message_id = event); returns NULL for
--    anything else (nothing written), 'claimed' when the event already has a
--    claim (nothing written: it was processed), else inserts attempt 1 or
--    increments a 'retrying' row (never a 'resolved'/'exhausted' one) and
--    returns the resulting status ('retrying' | 'exhausted'), or the
--    existing terminal status.
--  * public.flow_inbound_routing_resolved(tenant,account,platform,event)
--    RETURNS boolean: 'retrying' -> 'resolved' (true) when the redelivered
--    event's lookup succeeded; anything else unchanged (false).
-- The Edge (milan-api) answers the webhook with 503 while a row is
-- 'retrying' so the provider redelivers with its own backoff, and re-drives a
-- redelivered duplicate ONLY when its row is 'retrying'. Exactly-once is still
-- owned by automation_message_claims / flow_claim_inbound(_durable) /
-- flow_claim_begin_durable_run, which this migration does NOT change.
--
-- No existing table, row, function, trigger, index or privilege is changed;
-- flow_claim_inbound, flow_claim_inbound_durable, flow_begin_durable_run(_superseding)
-- and flow_claim_begin_durable_run are not referenced or replaced.
-- Billing/credits are not referenced.
-- Ownership marker: CREATED_BY_20261029340000_FLOW_INBOUND_ROUTING_RETRY
-- Re-apply only over this migration's own objects (marker AND the pinned
-- normalized body md5 of both functions:
-- md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g')))).
--
-- Owner diagnostic (metadata only, read-only):
--   SELECT status, count(*), min(first_failed_at), max(last_failed_at), max(attempts)
--   FROM public.automation_inbound_routing_retries GROUP BY status;
--   SELECT tenant_id, channel_account_id, platform, inbound_message_id, attempts,
--          first_failed_at, last_failed_at
--   FROM public.automation_inbound_routing_retries
--   WHERE status = 'exhausted'
--      OR (status = 'retrying' AND last_failed_at < now() - interval '2 days')
--   ORDER BY last_failed_at DESC LIMIT 100;
--
-- Order: apply BEFORE the milan-api build that calls these functions. That
-- build without this migration: the record RPC fails, the event is NOT
-- retried (logged "retry state unavailable"), no flow and no AI run for it.
-- Rollback: supabase/rollbacks/20261029340000_flow_inbound_routing_retry.rollback.sql
-- (revert milan-api FIRST).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029340000_FLOW_INBOUND_ROUTING_RETRY';
 v_failed_md5 constant text := '0fd176d432d9a7008bacf8cd75dcb4d2';
 v_resolved_md5 constant text := '762b7e1a84df93bd0e3331314ffd5e22';
 v_name text;
 r record;
 v_fn regprocedure;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_name) THEN
   RAISE EXCEPTION 'Inbound routing retry prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY['tenants','channel_accounts','conversations','messages'] LOOP
  IF to_regclass('public.'||v_name) IS NULL THEN
   RAISE EXCEPTION 'Inbound routing retry prerequisite missing: public.%', v_name;
  END IF;
 END LOOP;
 IF to_regclass('public.automation_message_claims') IS NULL OR
    obj_description(to_regclass('public.automation_message_claims'),'pg_class')
     IS DISTINCT FROM 'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM' THEN
  RAISE EXCEPTION 'Inbound routing retry prerequisite missing: public.automation_message_claims (20261028220000)';
 END IF;
 -- The composite account key the claims table already references.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.contype='f' AND c.conrelid='public.automation_message_claims'::regclass
    AND c.confrelid='public.channel_accounts'::regclass AND array_length(c.confkey,1)=3) THEN
  RAISE EXCEPTION 'Inbound routing retry prerequisite missing: channel_accounts(tenant_id,id,platform) key';
 END IF;
 IF to_regclass('public.automation_inbound_routing_retries') IS NOT NULL AND
    obj_description(to_regclass('public.automation_inbound_routing_retries'),'pg_class') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'public.automation_inbound_routing_retries exists without marker %; refusing to take it over', v_marker;
 END IF;
 FOR r IN SELECT * FROM (VALUES
   ('flow_inbound_routing_failed','public.flow_inbound_routing_failed(uuid,uuid,text,text,uuid,uuid,integer)',v_failed_md5),
   ('flow_inbound_routing_resolved','public.flow_inbound_routing_resolved(uuid,uuid,text,text)',v_resolved_md5)) t(name,sig,body_md5)
 LOOP
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NOT NULL THEN
   IF obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
    RAISE EXCEPTION 'Unrecognized existing function %; refusing to overwrite', r.sig;
   END IF;
   IF (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p WHERE p.oid=v_fn)
      IS DISTINCT FROM r.body_md5 THEN
    RAISE EXCEPTION 'Existing % carries the marker but not this migration''s body; refusing to overwrite', r.sig;
   END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname=r.name AND p.oid IS DISTINCT FROM v_fn) THEN
   RAISE EXCEPTION 'Unrecognized overload of public.% exists; refusing to install', r.name;
  END IF;
 END LOOP;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.automation_inbound_routing_retries (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 channel_account_id uuid NOT NULL,
 platform text NOT NULL CHECK (platform IN ('instagram','facebook','whatsapp')),
 provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 256),
 conversation_id uuid NOT NULL,
 inbound_message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
 attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 100),
 status text NOT NULL CHECK (status IN ('retrying','exhausted','resolved')),
 first_failed_at timestamptz NOT NULL DEFAULT now(),
 last_failed_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 PRIMARY KEY (tenant_id, channel_account_id, platform, provider_event_id),
 FOREIGN KEY (tenant_id, channel_account_id, platform)
  REFERENCES public.channel_accounts(tenant_id, id, platform),
 CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS automation_inbound_routing_retries_status_idx
 ON public.automation_inbound_routing_retries (status, last_failed_at);
COMMENT ON TABLE public.automation_inbound_routing_retries IS 'CREATED_BY_20261029340000_FLOW_INBOUND_ROUTING_RETRY';
ALTER TABLE public.automation_inbound_routing_retries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_inbound_routing_retries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.automation_inbound_routing_retries TO service_role;

CREATE OR REPLACE FUNCTION public.flow_inbound_routing_failed(
 p_tenant uuid,p_account uuid,p_platform text,p_event text,p_conversation uuid,p_inbound uuid,
 p_max_attempts integer
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $failed$
DECLARE v_status text;
BEGIN
 IF p_tenant IS NULL OR p_account IS NULL OR p_conversation IS NULL OR p_inbound IS NULL OR
    p_platform IS NULL OR p_platform NOT IN('instagram','facebook','whatsapp') OR
    p_event IS NULL OR length(p_event) NOT BETWEEN 1 AND 256 OR
    p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 20
 THEN RETURN NULL; END IF;
 -- Same ownership rule as flow_claim_inbound: never record an event against
 -- the wrong tenant/account/conversation or an unrelated message.
 IF NOT EXISTS (
   SELECT 1 FROM public.messages m JOIN public.conversations c
     ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id
     JOIN public.channel_accounts a ON a.id=p_account AND a.tenant_id=c.tenant_id
   WHERE m.id=p_inbound AND m.tenant_id=p_tenant AND m.direction='in'
     AND m.conversation_id=p_conversation AND m.wa_message_id=p_event
     AND (c.account_id=p_account OR c.account_id IS NULL) AND a.platform=p_platform
 ) THEN RETURN NULL; END IF;
 -- Already owned by a claim: processed; nothing to retry, nothing written.
 IF EXISTS(SELECT 1 FROM public.automation_message_claims cl
   WHERE cl.tenant_id=p_tenant AND cl.channel_account_id=p_account
     AND cl.platform=p_platform AND cl.provider_event_id=p_event)
 THEN RETURN 'claimed'; END IF;
 INSERT INTO public.automation_inbound_routing_retries AS r(
  tenant_id,channel_account_id,platform,provider_event_id,conversation_id,
  inbound_message_id,attempts,status)
 VALUES(p_tenant,p_account,p_platform,p_event,p_conversation,p_inbound,1,
  CASE WHEN p_max_attempts<=1 THEN 'exhausted' ELSE 'retrying' END)
 ON CONFLICT (tenant_id,channel_account_id,platform,provider_event_id) DO UPDATE
  SET attempts=r.attempts+1,last_failed_at=now(),
      status=CASE WHEN r.attempts+1>=p_max_attempts THEN 'exhausted' ELSE 'retrying' END
  WHERE r.status='retrying' AND r.inbound_message_id=EXCLUDED.inbound_message_id
 RETURNING r.status INTO v_status;
 IF v_status IS NULL THEN
  -- Terminal rows ('exhausted' / 'resolved') are never reopened.
  SELECT r.status INTO v_status FROM public.automation_inbound_routing_retries r
  WHERE r.tenant_id=p_tenant AND r.channel_account_id=p_account
    AND r.platform=p_platform AND r.provider_event_id=p_event;
 END IF;
 RETURN v_status;
END
$failed$;
COMMENT ON FUNCTION public.flow_inbound_routing_failed(uuid,uuid,text,text,uuid,uuid,integer)
 IS 'CREATED_BY_20261029340000_FLOW_INBOUND_ROUTING_RETRY';
REVOKE ALL ON FUNCTION public.flow_inbound_routing_failed(uuid,uuid,text,text,uuid,uuid,integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_inbound_routing_failed(uuid,uuid,text,text,uuid,uuid,integer)
 TO service_role;

CREATE OR REPLACE FUNCTION public.flow_inbound_routing_resolved(
 p_tenant uuid,p_account uuid,p_platform text,p_event text
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $resolved$
BEGIN
 IF p_tenant IS NULL OR p_account IS NULL OR p_platform IS NULL OR p_event IS NULL
 THEN RETURN false; END IF;
 UPDATE public.automation_inbound_routing_retries r
 SET status='resolved',resolved_at=now()
 WHERE r.tenant_id=p_tenant AND r.channel_account_id=p_account
   AND r.platform=p_platform AND r.provider_event_id=p_event AND r.status='retrying';
 RETURN FOUND;
END
$resolved$;
COMMENT ON FUNCTION public.flow_inbound_routing_resolved(uuid,uuid,text,text)
 IS 'CREATED_BY_20261029340000_FLOW_INBOUND_ROUTING_RETRY';
REVOKE ALL ON FUNCTION public.flow_inbound_routing_resolved(uuid,uuid,text,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_inbound_routing_resolved(uuid,uuid,text,text)
 TO service_role;
COMMIT;
