-- REVIEW ONLY. No sends, no cron scheduling, no schema changes to existing claims.
BEGIN;
DO $g$
BEGIN
 IF to_regclass('public.automation_delivery_attempts') IS NOT NULL OR
    to_regprocedure('public.flow_begin_delivery(uuid,text)') IS NOT NULL OR
    to_regprocedure('public.flow_finish_delivery(uuid,text,text)') IS NOT NULL OR
    to_regprocedure('public.flow_queue_uncertain_deliveries(integer,integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'Delivery tracking schema already installed; refusing overwrite'; END IF;
 IF to_regclass('public.automation_message_claims') IS NULL THEN
  RAISE EXCEPTION 'Install approved exclusive claims first'; END IF;
END $g$;

CREATE TABLE public.automation_delivery_attempts(
 claim_id uuid PRIMARY KEY REFERENCES public.automation_message_claims(id) ON DELETE RESTRICT,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 outgoing_message_id uuid NOT NULL UNIQUE,
 platform text NOT NULL CHECK(platform IN ('instagram','facebook','whatsapp')),
 status text NOT NULL DEFAULT 'attempting' CHECK(status IN('attempting','confirmed','uncertain')),
 request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
 provider_message_id text CHECK(provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 255),
 attempted_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz,
 uncertain_at timestamptz,
 review_status text NOT NULL DEFAULT 'none' CHECK(review_status IN('none','queued','resolved')),
 review_requested_at timestamptz,
 reviewed_at timestamptz,
 CHECK((status='confirmed')=(confirmed_at IS NOT NULL)),
 CHECK((status<>'uncertain' OR uncertain_at IS NOT NULL)),
 CHECK(review_status<>'queued' OR review_requested_at IS NOT NULL)
);
COMMENT ON TABLE public.automation_delivery_attempts IS 'CREATED_BY_20261028224000_DELIVERY_ATTEMPTS';
CREATE INDEX automation_delivery_review_idx ON public.automation_delivery_attempts(status,review_status,attempted_at)
 WHERE review_status='none';
ALTER TABLE public.automation_delivery_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.automation_delivery_attempts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.automation_delivery_attempts TO service_role;

-- Single reservation before sending. Duplicate invocation never sends again.
CREATE FUNCTION public.flow_begin_delivery(p_claim_id uuid,p_request_fingerprint text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $f$
DECLARE c record;
BEGIN
 IF p_claim_id IS NULL OR p_request_fingerprint IS NULL OR
    p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
 SELECT id,tenant_id,outgoing_message_id,platform INTO c
 FROM public.automation_message_claims WHERE id=p_claim_id;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO public.automation_delivery_attempts(
  claim_id,tenant_id,outgoing_message_id,platform,request_fingerprint)
 VALUES(c.id,c.tenant_id,c.outgoing_message_id,c.platform,p_request_fingerprint)
 ON CONFLICT DO NOTHING;
 RETURN FOUND;
END $f$;

-- Never claim success for a timeout; err on UNCERTAIN, not on retry.
CREATE FUNCTION public.flow_finish_delivery(p_claim_id uuid,p_status text,p_provider_message_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $f$
BEGIN
 IF p_claim_id IS NULL OR p_status NOT IN('confirmed','uncertain') OR
    (p_provider_message_id IS NOT NULL AND
      length(p_provider_message_id) NOT BETWEEN 1 AND 255) THEN RETURN false; END IF;
 UPDATE public.automation_delivery_attempts
 SET status=p_status,
  provider_message_id=CASE WHEN p_status='confirmed' THEN p_provider_message_id ELSE NULL END,
  confirmed_at=CASE WHEN p_status='confirmed' THEN now() ELSE NULL END,
  uncertain_at=CASE WHEN p_status='uncertain' THEN now() ELSE NULL END
 WHERE claim_id=p_claim_id AND status='attempting';
 RETURN FOUND;
END $f$;

-- Operational reconciliation TASK: no provider API writes, no resend,
-- and no automatic charging. Identify stale attempts as UNCERTAIN and queue
-- them for explicitly human resolution. Call manually or via later-approved
-- scheduler with service-role authentication.
CREATE FUNCTION public.flow_queue_uncertain_deliveries(
 p_min_age_minutes integer DEFAULT 15,p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $f$
DECLARE affected integer;
BEGIN
 IF p_min_age_minutes NOT BETWEEN 1 AND 10080 OR p_limit NOT BETWEEN 1 AND 500
 THEN RAISE EXCEPTION 'Invalid bounded reconciliation parameters'; END IF;
 WITH selected AS (
  SELECT claim_id FROM public.automation_delivery_attempts
  WHERE ((status='attempting' AND attempted_at <= now()-make_interval(mins=>p_min_age_minutes))
   OR (status='uncertain' AND uncertain_at <= now()-make_interval(mins=>p_min_age_minutes)))
   AND review_status='none'
  ORDER BY attempted_at,claim_id
  FOR UPDATE SKIP LOCKED LIMIT p_limit
 )
 UPDATE public.automation_delivery_attempts d
 SET status='uncertain',uncertain_at=coalesce(d.uncertain_at,now()),
     review_status='queued',review_requested_at=now()
 FROM selected s WHERE d.claim_id=s.claim_id;
 GET DIAGNOSTICS affected=ROW_COUNT;
 RETURN affected;
END $f$;
COMMENT ON FUNCTION public.flow_begin_delivery(uuid,text) IS 'CREATED_BY_20261028224000_DELIVERY_ATTEMPTS';
COMMENT ON FUNCTION public.flow_finish_delivery(uuid,text,text) IS 'CREATED_BY_20261028224000_DELIVERY_ATTEMPTS';
COMMENT ON FUNCTION public.flow_queue_uncertain_deliveries(integer,integer) IS 'CREATED_BY_20261028224000_DELIVERY_ATTEMPTS';
REVOKE ALL ON FUNCTION public.flow_begin_delivery(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_finish_delivery(uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_queue_uncertain_deliveries(integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_begin_delivery(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_finish_delivery(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_queue_uncertain_deliveries(integer,integer) TO service_role;
COMMIT;
