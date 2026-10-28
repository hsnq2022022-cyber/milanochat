-- REVIEW ONLY. Requires a new, exact owner GO before production SQL.
-- Atomic, cross-instance, per-tenant fixed-window limit: 30 requests / UTC minute.
-- Never use an Edge-instance local counter for this authorization boundary.
BEGIN;
DO $preflight$
BEGIN
 IF to_regclass('public.automation_flow_global_switch') IS NULL OR
    to_regclass('public.automation_flow_publications') IS NULL THEN
  RAISE EXCEPTION 'Flow runtime migrations must be installed first';
 END IF;
 IF to_regclass('public.flow_publication_rate_windows') IS NOT NULL OR
    to_regprocedure('public.flow_publication_rate_allow(uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'Unknown existing flow publication limiter; refusing overwrite';
 END IF;
END
$preflight$;

CREATE TABLE public.flow_publication_rate_windows (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 window_start timestamptz NOT NULL,
 request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 30),
 PRIMARY KEY (tenant_id,window_start),
 CHECK (window_start = date_trunc('minute',window_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
);
COMMENT ON TABLE public.flow_publication_rate_windows
 IS 'CREATED_BY_20261028200000_FLOW_PUBLICATION_RATE_LIMIT';
ALTER TABLE public.flow_publication_rate_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.flow_publication_rate_windows FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.flow_publication_rate_windows TO service_role;

CREATE FUNCTION public.flow_publication_rate_allow(p_tenant_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $limit$
DECLARE
 v_bucket timestamptz := date_trunc('minute',now());
 v_count integer;
BEGIN
 IF p_tenant_id IS NULL OR NOT EXISTS
  (SELECT 1 FROM public.tenants WHERE id=p_tenant_id) THEN
  RETURN FALSE;
 END IF;
 -- The PK row lock serializes increments across every Edge instance.
 INSERT INTO public.flow_publication_rate_windows(tenant_id,window_start,request_count)
 VALUES(p_tenant_id,v_bucket,1)
 ON CONFLICT(tenant_id,window_start) DO UPDATE
    SET request_count=public.flow_publication_rate_windows.request_count+1
    WHERE public.flow_publication_rate_windows.request_count < 30
 RETURNING request_count INTO v_count;
 -- Tenant-scoped retention: no global scan, no old customer rows changed.
 DELETE FROM public.flow_publication_rate_windows
 WHERE tenant_id=p_tenant_id AND window_start < v_bucket - interval '48 hours';
 RETURN v_count IS NOT NULL;
END
$limit$;
COMMENT ON FUNCTION public.flow_publication_rate_allow(uuid)
 IS 'CREATED_BY_20261028200000_FLOW_PUBLICATION_RATE_LIMIT';
REVOKE ALL ON FUNCTION public.flow_publication_rate_allow(uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_publication_rate_allow(uuid) TO service_role;
COMMIT;
