-- REVIEW ONLY: durable recovery of persisted inbound events that were never
-- routed (B-3/B-4). NOT applied anywhere by this repository; apply only with
-- an explicit owner GO.
--
-- Problem: milan-api persists the inbound message (messages.wa_message_id is
-- the provider dedupe key) BEFORE routing. When the function dies or throws
-- between the insert and the exclusive claim, or a 'retrying' event
-- (20261029340000) is never redelivered by the provider, the provider's
-- redelivery is dropped by the duplicate pre-check and the message is never
-- answered. This migration adds the STATE for a bounded, opt-in sweeper that
-- re-drives such events through the SAME routing/claim functions as the
-- webhook (milan-api inboundRecovery.ts). It adds no second runtime and no
-- competing queue: exactly-once stays with automation_message_claims.
--
-- Adds (additive only):
--  * table public.automation_inbound_recovery_tenants: per-tenant OPT-IN.
--    No row or enabled=false (the default) = the tenant is never swept.
--    Only messages created at/after enabled_at are ever recovered (opting in
--    never replays history). Written by the table owner only (operator SQL);
--    service_role has SELECT only, like the canary registry.
--      INSERT INTO public.automation_inbound_recovery_tenants
--        (tenant_id, enabled, enabled_at, approved_by, note)
--      VALUES ('<tenant>', true, now(), '<operator>', '<ticket>');
--      -- off again:
--      UPDATE public.automation_inbound_recovery_tenants
--         SET enabled=false, updated_at=now() WHERE tenant_id='<tenant>';
--  * table public.automation_inbound_recovery: one row per swept inbound
--    message, key (tenant_id, inbound_message_id); status 'waiting' ->
--    'leased' -> 'resolved' | 'exhausted' (or back to 'waiting' with a
--    backoff). Ids, counters, timestamps and a short reason CODE only: no
--    message text, no customer identifier, no provider payload.
--  * public.flow_inbound_recovery_lease(limit,lease_seconds,max_age_hours,
--    max_attempts,grace_seconds,tenant) RETURNS TABLE: (1) discovers inbound
--    messages (direction 'in', wa_message_id present) of OPTED-IN tenants,
--    created at/after the opt-in, older than the grace (the live webhook is
--    done) and younger than the age cap, with NO claim
--    (automation_message_claims by inbound id or provider event id) and no
--    terminal ('resolved'/'exhausted') or just-failed routing-retry row;
--    (2) leases due rows with FOR UPDATE SKIP LOCKED (two concurrent callers
--    never receive the same row); a row that meanwhile has a claim is
--    'resolved' (reason claimed), older than the age cap 'exhausted' (reason
--    expired), out of attempts 'exhausted' (reason attempts). The age cap is
--    clamped to 48 hours in SQL.
--  * public.flow_inbound_recovery_finish(tenant,inbound,token,result,reason,
--    max_attempts) RETURNS text: lease-token-checked completion. 'retry' ->
--    'waiting' with backoff 1m, 5m, 15m, then 60m, or 'exhausted' when the
--    attempts or the 48 hour cap are reached.
--  * view public.automation_inbound_recovery_status (security_invoker):
--    counts per tenant/status/reason, metadata only.
--      SELECT * FROM public.automation_inbound_recovery_status;
--
-- No existing table, row, function, trigger, index or privilege is changed.
-- flow_claim_inbound, flow_claim_inbound_durable, flow_claim_begin_durable_run
-- and the 20261029340000 functions are not referenced or replaced; billing /
-- credits are not referenced. Lock impact: none on existing tables beyond the
-- foreign-key validation of the two NEW (empty) tables.
-- Cost note: the discovery reads public.messages by tenant / direction /
-- created_at for opted-in tenants only (48 hour window). Check its plan on
-- production data before enabling the worker; no index is created here.
--
-- Ownership marker: CREATED_BY_20261029360000_FLOW_INBOUND_RECOVERY
-- Re-apply only over this migration's own objects (marker AND the pinned
-- normalized body md5 of both functions:
-- md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g')))).
--
-- Order: after 20261029340000 (required). Apply BEFORE the milan-api build
-- that exposes inbound_recovery_tick (that build without this migration: the
-- tick answers "recovery state unavailable" and does nothing).
-- Rollback: supabase/rollbacks/20261029360000_flow_inbound_recovery.rollback.sql
-- (disable FLOW_INBOUND_RECOVERY_ENABLED / the cron job FIRST).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029360000_FLOW_INBOUND_RECOVERY';
 v_lease_md5 constant text := '407b44aceb8afd6c7674d28c1d89cc0b';
 v_finish_md5 constant text := 'cf208534b81d64a7dd0fd7e1768d0142';
 v_name text;
 r record;
 v_fn regprocedure;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_name) THEN
   RAISE EXCEPTION 'Inbound recovery prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY['tenants','conversations','messages'] LOOP
  IF to_regclass('public.'||v_name) IS NULL THEN
   RAISE EXCEPTION 'Inbound recovery prerequisite missing: public.%', v_name;
  END IF;
 END LOOP;
 IF to_regclass('public.automation_message_claims') IS NULL OR
    obj_description(to_regclass('public.automation_message_claims'),'pg_class')
     IS DISTINCT FROM 'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM' THEN
  RAISE EXCEPTION 'Inbound recovery prerequisite missing: public.automation_message_claims (20261028220000)';
 END IF;
 IF to_regclass('public.automation_inbound_routing_retries') IS NULL OR
    obj_description(to_regclass('public.automation_inbound_routing_retries'),'pg_class')
     IS DISTINCT FROM 'CREATED_BY_20261029340000_FLOW_INBOUND_ROUTING_RETRY' THEN
  RAISE EXCEPTION 'Inbound recovery prerequisite missing: public.automation_inbound_routing_retries (20261029340000)';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['automation_inbound_recovery_tenants','automation_inbound_recovery',
   'automation_inbound_recovery_status'] LOOP
  IF to_regclass('public.'||v_name) IS NOT NULL AND
     obj_description(to_regclass('public.'||v_name),'pg_class') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'public.% exists without marker %; refusing to take it over', v_name, v_marker;
  END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES
   ('flow_inbound_recovery_lease','public.flow_inbound_recovery_lease(integer,integer,integer,integer,integer,uuid)',v_lease_md5),
   ('flow_inbound_recovery_finish','public.flow_inbound_recovery_finish(uuid,uuid,uuid,text,text,integer)',v_finish_md5)) t(name,sig,body_md5)
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

CREATE TABLE IF NOT EXISTS public.automation_inbound_recovery_tenants (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,
 enabled_at timestamptz,
 approved_by text CHECK (approved_by IS NULL OR length(approved_by) BETWEEN 1 AND 200),
 note text CHECK (note IS NULL OR length(note) <= 500),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (NOT enabled OR enabled_at IS NOT NULL)
);
COMMENT ON TABLE public.automation_inbound_recovery_tenants IS 'CREATED_BY_20261029360000_FLOW_INBOUND_RECOVERY';
ALTER TABLE public.automation_inbound_recovery_tenants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_inbound_recovery_tenants FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.automation_inbound_recovery_tenants TO service_role;

CREATE TABLE IF NOT EXISTS public.automation_inbound_recovery (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 inbound_message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
 conversation_id uuid NOT NULL,
 status text NOT NULL CHECK (status IN ('waiting','leased','resolved','exhausted')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
 reason text CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
 lease_token uuid,
 lease_expires_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 message_created_at timestamptz NOT NULL,
 first_seen_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 PRIMARY KEY (tenant_id, inbound_message_id),
 CHECK ((status = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
 CHECK ((status IN ('resolved','exhausted')) = (finished_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS automation_inbound_recovery_due_idx
 ON public.automation_inbound_recovery (status, next_attempt_at);
COMMENT ON TABLE public.automation_inbound_recovery IS 'CREATED_BY_20261029360000_FLOW_INBOUND_RECOVERY';
ALTER TABLE public.automation_inbound_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_inbound_recovery FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.automation_inbound_recovery TO service_role;

CREATE OR REPLACE FUNCTION public.flow_inbound_recovery_lease(
 p_limit integer,p_lease_seconds integer,p_max_age_hours integer,p_max_attempts integer,
 p_grace_seconds integer,p_tenant uuid DEFAULT NULL
) RETURNS TABLE(tenant_id uuid,inbound_message_id uuid,conversation_id uuid,lease_token uuid,attempts integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $lease$
DECLARE r record; v_token uuid; v_age interval; v_grace interval;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR
    p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 OR
    p_max_age_hours IS NULL OR p_max_age_hours < 1 OR
    p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 10 OR
    p_grace_seconds IS NULL OR p_grace_seconds NOT BETWEEN 30 AND 3600
 THEN RETURN; END IF;
 -- Hard age cap: never more than 48 hours, whatever the caller asks.
 v_age := pg_catalog.make_interval(hours=>least(p_max_age_hours,48));
 v_grace := pg_catalog.make_interval(secs=>p_grace_seconds);
 -- (1) Discovery: persisted inbound events of OPTED-IN tenants with no owner.
 INSERT INTO public.automation_inbound_recovery AS x(
  tenant_id,inbound_message_id,conversation_id,status,message_created_at)
 SELECT m.tenant_id,m.id,m.conversation_id,'waiting',m.created_at
 FROM public.messages m
 JOIN public.automation_inbound_recovery_tenants o
   ON o.tenant_id=m.tenant_id AND o.enabled AND o.enabled_at IS NOT NULL
 WHERE m.direction='in' AND m.wa_message_id IS NOT NULL AND m.wa_message_id<>''
   AND m.conversation_id IS NOT NULL
   AND m.created_at>=o.enabled_at
   AND m.created_at>pg_catalog.now()-v_age
   AND m.created_at<=pg_catalog.now()-v_grace
   AND (p_tenant IS NULL OR m.tenant_id=p_tenant)
   AND NOT EXISTS(SELECT 1 FROM public.automation_message_claims cl
     WHERE cl.tenant_id=m.tenant_id
       AND (cl.inbound_message_id=m.id OR cl.provider_event_id=m.wa_message_id))
   AND NOT EXISTS(SELECT 1 FROM public.automation_inbound_routing_retries rr
     WHERE rr.tenant_id=m.tenant_id AND rr.inbound_message_id=m.id
       AND (rr.status IN('resolved','exhausted') OR rr.last_failed_at>pg_catalog.now()-v_grace))
   AND NOT EXISTS(SELECT 1 FROM public.automation_inbound_recovery y
     WHERE y.tenant_id=m.tenant_id AND y.inbound_message_id=m.id)
 ORDER BY m.created_at,m.id
 LIMIT p_limit*4
 ON CONFLICT ON CONSTRAINT automation_inbound_recovery_pkey DO NOTHING;
 -- (2) Lease due rows. SKIP LOCKED: concurrent callers never share a row.
 FOR r IN
  SELECT x.tenant_id AS t_id,x.inbound_message_id AS m_id,x.conversation_id AS c_id,
         x.attempts AS n,x.message_created_at AS created
  FROM public.automation_inbound_recovery x
  JOIN public.automation_inbound_recovery_tenants o
    ON o.tenant_id=x.tenant_id AND o.enabled AND o.enabled_at IS NOT NULL
  WHERE ((x.status='waiting' AND x.next_attempt_at<=pg_catalog.now())
      OR (x.status='leased' AND x.lease_expires_at<=pg_catalog.now()))
    AND (p_tenant IS NULL OR x.tenant_id=p_tenant)
  ORDER BY x.next_attempt_at,x.inbound_message_id
  FOR UPDATE OF x SKIP LOCKED
  LIMIT p_limit
 LOOP
  IF EXISTS(SELECT 1 FROM public.automation_message_claims cl JOIN public.messages m
      ON m.id=r.m_id AND m.tenant_id=r.t_id
     WHERE cl.tenant_id=r.t_id
       AND (cl.inbound_message_id=r.m_id OR cl.provider_event_id=m.wa_message_id)) THEN
   -- A webhook (re)delivery owns it meanwhile: nothing to recover.
   UPDATE public.automation_inbound_recovery u
   SET status='resolved',reason='claimed',lease_token=NULL,lease_expires_at=NULL,
       finished_at=pg_catalog.now(),updated_at=pg_catalog.now()
   WHERE u.tenant_id=r.t_id AND u.inbound_message_id=r.m_id;
  ELSIF r.created<=pg_catalog.now()-v_age THEN
   UPDATE public.automation_inbound_recovery u
   SET status='exhausted',reason='expired',lease_token=NULL,lease_expires_at=NULL,
       finished_at=pg_catalog.now(),updated_at=pg_catalog.now()
   WHERE u.tenant_id=r.t_id AND u.inbound_message_id=r.m_id;
  ELSIF r.n>=p_max_attempts THEN
   UPDATE public.automation_inbound_recovery u
   SET status='exhausted',reason='attempts',lease_token=NULL,lease_expires_at=NULL,
       finished_at=pg_catalog.now(),updated_at=pg_catalog.now()
   WHERE u.tenant_id=r.t_id AND u.inbound_message_id=r.m_id;
  ELSE
   v_token := pg_catalog.gen_random_uuid();
   UPDATE public.automation_inbound_recovery u
   SET status='leased',lease_token=v_token,
       lease_expires_at=pg_catalog.now()+pg_catalog.make_interval(secs=>p_lease_seconds),
       attempts=u.attempts+1,updated_at=pg_catalog.now()
   WHERE u.tenant_id=r.t_id AND u.inbound_message_id=r.m_id;
   tenant_id := r.t_id; inbound_message_id := r.m_id; conversation_id := r.c_id;
   lease_token := v_token; attempts := r.n+1;
   RETURN NEXT;
  END IF;
 END LOOP;
 RETURN;
END
$lease$;
COMMENT ON FUNCTION public.flow_inbound_recovery_lease(integer,integer,integer,integer,integer,uuid)
 IS 'CREATED_BY_20261029360000_FLOW_INBOUND_RECOVERY';
REVOKE ALL ON FUNCTION public.flow_inbound_recovery_lease(integer,integer,integer,integer,integer,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_inbound_recovery_lease(integer,integer,integer,integer,integer,uuid)
 TO service_role;

CREATE OR REPLACE FUNCTION public.flow_inbound_recovery_finish(
 p_tenant uuid,p_inbound uuid,p_token uuid,p_result text,p_reason text,p_max_attempts integer
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $finish$
DECLARE v_attempts integer; v_created timestamptz; v_status text; v_reason text; v_next timestamptz;
BEGIN
 IF p_tenant IS NULL OR p_inbound IS NULL OR p_token IS NULL OR
    p_result IS NULL OR p_result NOT IN('resolved','exhausted','retry') OR
    p_reason IS NULL OR p_reason !~ '^[a-z0-9_]{1,64}$' OR
    p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 10
 THEN RETURN NULL; END IF;
 -- Only the holder of the current lease may finish it.
 SELECT x.attempts,x.message_created_at INTO v_attempts,v_created
 FROM public.automation_inbound_recovery x
 WHERE x.tenant_id=p_tenant AND x.inbound_message_id=p_inbound
   AND x.status='leased' AND x.lease_token=p_token
 FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 v_status := p_result; v_reason := p_reason; v_next := pg_catalog.now();
 IF p_result='retry' THEN
  IF v_created<=pg_catalog.now()-interval '48 hours' THEN
   v_status := 'exhausted'; v_reason := 'expired';
  ELSIF v_attempts>=p_max_attempts THEN
   v_status := 'exhausted'; v_reason := 'attempts';
  ELSE
   v_status := 'waiting';
   v_next := pg_catalog.now()+CASE v_attempts WHEN 1 THEN interval '1 minute'
     WHEN 2 THEN interval '5 minutes' WHEN 3 THEN interval '15 minutes'
     ELSE interval '60 minutes' END;
  END IF;
 END IF;
 UPDATE public.automation_inbound_recovery u
 SET status=v_status,reason=v_reason,lease_token=NULL,lease_expires_at=NULL,
     next_attempt_at=v_next,updated_at=pg_catalog.now(),
     finished_at=CASE WHEN v_status IN('resolved','exhausted') THEN pg_catalog.now() ELSE NULL END
 WHERE u.tenant_id=p_tenant AND u.inbound_message_id=p_inbound;
 RETURN v_status;
END
$finish$;
COMMENT ON FUNCTION public.flow_inbound_recovery_finish(uuid,uuid,uuid,text,text,integer)
 IS 'CREATED_BY_20261029360000_FLOW_INBOUND_RECOVERY';
REVOKE ALL ON FUNCTION public.flow_inbound_recovery_finish(uuid,uuid,uuid,text,text,integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_inbound_recovery_finish(uuid,uuid,uuid,text,text,integer)
 TO service_role;

-- Owner status view: metadata only (ids, counters, times, reason codes).
CREATE OR REPLACE VIEW public.automation_inbound_recovery_status
WITH (security_invoker=true) AS
SELECT x.tenant_id,x.status,x.reason,count(*)::bigint AS events,
       max(x.attempts) AS max_attempts,min(x.message_created_at) AS oldest_message_at,
       max(x.updated_at) AS last_updated_at
FROM public.automation_inbound_recovery x
GROUP BY x.tenant_id,x.status,x.reason;
COMMENT ON VIEW public.automation_inbound_recovery_status IS 'CREATED_BY_20261029360000_FLOW_INBOUND_RECOVERY';
REVOKE ALL ON TABLE public.automation_inbound_recovery_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.automation_inbound_recovery_status TO service_role;
COMMIT;
