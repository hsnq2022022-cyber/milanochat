-- FUTURE APPROVAL ONLY: per-outbox attempt journal linked to existing exclusive claim.
-- Existing automation_delivery_attempts has claim_id PRIMARY KEY, supporting only ONE
-- send per inbound claim. A separate per-effect table is REQUIRED for multi-node flows.
-- No data writes to existing runtime, no change to old milan-api.
BEGIN;
DO $guard$
BEGIN
 IF to_regclass('public.automation_flow_delivery_attempts') IS NOT NULL
 OR to_regprocedure('public.flow_reserve_outbox_delivery(uuid,uuid)') IS NOT NULL
 OR to_regprocedure('public.flow_finish_outbox_delivery(uuid,uuid,text,text)') IS NOT NULL
 THEN RAISE EXCEPTION 'Outbox delivery schema already exists; fail closed'; END IF;
 IF to_regclass('public.automation_delivery_attempts') IS NULL
 OR to_regclass('public.automation_flow_outbox') IS NULL
 OR to_regclass('public.automation_message_claims') IS NULL
 THEN RAISE EXCEPTION 'Required existing delivery / claim / outbox schema absent'; END IF;
END $guard$;

CREATE TABLE public.automation_flow_delivery_attempts(
 tenant_id uuid NOT NULL,
 outbox_id uuid NOT NULL,
 claim_id uuid NOT NULL REFERENCES public.automation_message_claims(id) ON DELETE CASCADE,
 outgoing_message_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'attempting' CHECK(status IN ('attempting','confirmed','uncertain')),
 provider_message_id text CHECK(provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 255),
 attempted_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz,
 uncertain_at timestamptz,
 review_status text NOT NULL DEFAULT 'none' CHECK(review_status IN('none','queued','resolved')),
 review_requested_at timestamptz,
 PRIMARY KEY(tenant_id,outbox_id),
 UNIQUE(tenant_id,outgoing_message_id),
 FOREIGN KEY(tenant_id,outbox_id)
   REFERENCES public.automation_flow_outbox(tenant_id,id) ON DELETE CASCADE,
 CHECK((status='confirmed')=(confirmed_at IS NOT NULL)),
 CHECK(status<>'uncertain' OR uncertain_at IS NOT NULL),
 CHECK(review_status<>'queued' OR review_requested_at IS NOT NULL)
);
COMMENT ON TABLE public.automation_flow_delivery_attempts
 IS 'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY';
ALTER TABLE public.automation_flow_delivery_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.automation_flow_delivery_attempts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.automation_flow_delivery_attempts TO service_role;

-- Atomic reservation before network. A duplicate cannot reenter provider sending.
CREATE FUNCTION public.flow_reserve_outbox_delivery(p_tenant uuid,p_outbox uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $reserve$
DECLARE row_data record;
BEGIN
 IF p_tenant IS NULL OR p_outbox IS NULL THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch WHERE singleton AND enabled)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches
   WHERE tenant_id=p_tenant AND enabled AND test_only)
 THEN RETURN false;END IF;
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
  AND o.delivery_status='pending' AND o.effect_kind='message'
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

CREATE FUNCTION public.flow_finish_outbox_delivery(
 p_tenant uuid,p_outbox uuid,p_result text,p_provider_message_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $finish$
DECLARE final_status text;
BEGIN
 IF p_tenant IS NULL OR p_outbox IS NULL OR p_result NOT IN('confirmed','uncertain')
 OR (p_provider_message_id IS NOT NULL AND
     length(p_provider_message_id) NOT BETWEEN 1 AND 255) THEN RETURN false;END IF;
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

-- Only human review after 15+ minutes; NEVER resend, never debit automatically.
CREATE FUNCTION public.flow_queue_outbox_human_review(
 p_min_age_minutes integer DEFAULT 15,p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $review$
DECLARE changed integer;
BEGIN
 IF p_min_age_minutes NOT BETWEEN 1 AND 10080 OR p_limit NOT BETWEEN 1 AND 500
 THEN RAISE EXCEPTION 'invalid review bounds'; END IF;
 WITH queue AS(
  SELECT tenant_id,outbox_id FROM public.automation_flow_delivery_attempts
  WHERE review_status='none' AND
   ((status='attempting' AND attempted_at <= now()-make_interval(mins=>p_min_age_minutes))
    OR (status='uncertain' AND uncertain_at <= now()-make_interval(mins=>p_min_age_minutes)))
  ORDER BY attempted_at FOR UPDATE SKIP LOCKED LIMIT p_limit
 ), changed_rows AS(
  UPDATE public.automation_flow_delivery_attempts d
  SET status='uncertain',uncertain_at=coalesce(d.uncertain_at,now()),
   review_status='queued',review_requested_at=now()
  FROM queue q WHERE d.tenant_id=q.tenant_id AND d.outbox_id=q.outbox_id
  RETURNING d.tenant_id,d.outbox_id
 )
 UPDATE public.automation_flow_outbox o
 SET delivery_status='uncertain',lease_token=NULL,lease_expires_at=NULL
 FROM changed_rows c WHERE o.tenant_id=c.tenant_id AND o.id=c.outbox_id
  AND o.delivery_status IN('leased','uncertain');
 GET DIAGNOSTICS changed=ROW_COUNT;
 RETURN changed;
END $review$;
COMMENT ON FUNCTION public.flow_reserve_outbox_delivery(uuid,uuid)
 IS 'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY';
COMMENT ON FUNCTION public.flow_finish_outbox_delivery(uuid,uuid,text,text)
 IS 'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY';
COMMENT ON FUNCTION public.flow_queue_outbox_human_review(integer,integer)
 IS 'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY';
REVOKE ALL ON FUNCTION public.flow_reserve_outbox_delivery(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_finish_outbox_delivery(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.flow_queue_outbox_human_review(integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_reserve_outbox_delivery(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_finish_outbox_delivery(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_queue_outbox_human_review(integer,integer) TO service_role;
COMMIT;
