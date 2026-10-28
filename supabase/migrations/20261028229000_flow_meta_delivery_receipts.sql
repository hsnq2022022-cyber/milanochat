-- PROPOSED ONLY: strictly verified Meta provider receipts, no sends/charges.
-- Requires per-effect attempt migration 20261028226000.
BEGIN;
DO $guard$
BEGIN
 IF to_regclass('public.flow_meta_delivery_receipts') IS NOT NULL OR
    to_regprocedure('public.flow_record_meta_delivery(uuid,uuid,text,text,text)') IS NOT NULL OR
    to_regclass('public.flow_meta_attempt_provider_uq') IS NOT NULL
 THEN RAISE EXCEPTION 'Delivery receipt objects already exist';END IF;
 IF to_regclass('public.automation_flow_delivery_attempts') IS NULL
 THEN RAISE EXCEPTION 'Per-effect send attempts must exist';END IF;
END $guard$;
CREATE UNIQUE INDEX flow_meta_attempt_provider_uq
 ON public.automation_flow_delivery_attempts(tenant_id,provider_message_id)
 WHERE provider_message_id IS NOT NULL AND status='confirmed';
COMMENT ON INDEX public.flow_meta_attempt_provider_uq
 IS 'CREATED_BY_20261028229000_META_RECEIPTS';

CREATE TABLE public.flow_meta_delivery_receipts(
 tenant_id uuid NOT NULL,
 outbox_id uuid NOT NULL,
 provider_message_id text NOT NULL CHECK(length(provider_message_id) BETWEEN 1 AND 255),
 receipt_status text NOT NULL CHECK(receipt_status IN('delivered','read')),
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,outbox_id,receipt_status),
 FOREIGN KEY(tenant_id,outbox_id)
   REFERENCES public.automation_flow_delivery_attempts(tenant_id,outbox_id)
);
COMMENT ON TABLE public.flow_meta_delivery_receipts
 IS 'CREATED_BY_20261028229000_META_RECEIPTS';
ALTER TABLE public.flow_meta_delivery_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.flow_meta_delivery_receipts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.flow_meta_delivery_receipts TO service_role;

-- Called ONLY after raw X-Hub-Signature-256 and tenant account validation.
-- Provider 2xx confirmed a send; these are independent delivery/read signals.
CREATE FUNCTION public.flow_record_meta_delivery(
 p_tenant uuid,p_account uuid,p_platform text,p_provider_message_id text,
 p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $receipt$
DECLARE item record; first_receipt boolean; changed boolean;
BEGIN
 IF p_tenant IS NULL OR p_account IS NULL OR
  p_platform NOT IN('instagram','facebook') OR
  p_provider_message_id IS NULL OR length(p_provider_message_id) NOT BETWEEN 1 AND 255
  OR p_status NOT IN('delivered','read') THEN RETURN false;END IF;
 SELECT o.id,o.run_id INTO item
 FROM public.automation_flow_delivery_attempts d
 JOIN public.automation_flow_outbox o
  ON o.tenant_id=d.tenant_id AND o.id=d.outbox_id
 JOIN public.automation_flow_runs r
  ON r.tenant_id=o.tenant_id AND r.id=o.run_id
 WHERE d.tenant_id=p_tenant AND d.provider_message_id=p_provider_message_id
  AND d.status='confirmed' AND r.channel_account_id=p_account
  AND r.platform=p_platform AND o.delivery_status IN('charge_pending','settled')
 FOR UPDATE OF o;
 IF NOT FOUND THEN RETURN false;END IF;
 first_receipt:=NOT EXISTS(
  SELECT 1 FROM public.flow_meta_delivery_receipts x
   WHERE x.tenant_id=p_tenant AND x.outbox_id=item.id);
 INSERT INTO public.flow_meta_delivery_receipts(
  tenant_id,outbox_id,provider_message_id,receipt_status)
 VALUES(p_tenant,item.id,p_provider_message_id,p_status)
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed AND first_receipt THEN
  INSERT INTO public.automation_flow_metrics(tenant_id,run_id,event_key)
  VALUES(p_tenant,item.run_id,'delivered');
 END IF;
 RETURN changed;
END $receipt$;
COMMENT ON FUNCTION public.flow_record_meta_delivery(uuid,uuid,text,text,text)
 IS 'CREATED_BY_20261028229000_META_RECEIPTS';
REVOKE ALL ON FUNCTION public.flow_record_meta_delivery(uuid,uuid,text,text,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_record_meta_delivery(uuid,uuid,text,text,text)
 TO service_role;
COMMIT;
