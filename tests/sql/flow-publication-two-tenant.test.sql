-- Two-tenant isolation regression. Disposable PostgreSQL 17 only.
-- Simulates a trusted RPC caller whose actor is tenant A's verified JWT user.
-- No production database rows, credentials, or Meta events are used.
\set ON_ERROR_STOP on
BEGIN;
GRANT SELECT,UPDATE ON public.tenants TO service_role;
GRANT SELECT ON public.channel_accounts TO service_role;
SET ROLE service_role;
DO $isolation$
DECLARE
  tenant_a uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  tenant_b uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  account_a uuid := '11111111-1111-4111-8111-111111111111';
  account_b uuid := '22222222-2222-4222-8222-222222222222';
  user_a uuid := '99999999-9999-4999-8999-999999999999';
  user_b uuid := '88888888-8888-4888-8888-888888888888';
  document jsonb := '{"version":3,"nodes":[],"edges":[]}'::jsonb;
BEGIN
  -- The preceding CI test deliberately disables account A; restore it only
  -- inside this rolled-back transaction to keep this regression independent.
  UPDATE public.channel_accounts SET is_active=true WHERE id IN (account_a,account_b);
  IF public.flow_publish_revision(tenant_a,account_a,'instagram','a_flow',user_a,document) IS DISTINCT FROM 1
    OR public.flow_publish_revision(tenant_b,account_b,'facebook','b_flow',user_b,document) IS DISTINCT FROM 1
  THEN RAISE EXCEPTION 'VALID_OWNER_PUBLISH_FAILED'; END IF;

  -- A cannot become B by changing tenant_id, account_id or platform.
  IF public.flow_publish_revision(tenant_b,account_b,'facebook','a_attack',user_a,document) IS NOT NULL
    OR public.flow_publish_revision(tenant_a,account_b,'facebook','a_attack',user_a,document) IS NOT NULL
    OR public.flow_publish_revision(tenant_b,account_a,'instagram','a_attack',user_a,document) IS NOT NULL
  THEN RAISE EXCEPTION 'CROSS_TENANT_PUBLICATION_ALLOWED'; END IF;
  IF (SELECT COUNT(*) FROM public.automation_flow_publications WHERE tenant_id=tenant_b) <> 1
  THEN RAISE EXCEPTION 'TENANT_B_PUBLICATION_MODIFIED'; END IF;

  -- Only isolated test DB: arm both switches to verify activation ownership
  -- even when the global kill switch is ON. Entire transaction is rolled back.
  INSERT INTO public.automation_flow_tenant_switches(tenant_id,enabled,test_only)
    VALUES(tenant_a,true,true),(tenant_b,true,true)
    ON CONFLICT (tenant_id) DO UPDATE
      SET enabled=EXCLUDED.enabled,test_only=EXCLUDED.test_only;
  UPDATE public.automation_flow_global_switch SET enabled=true WHERE singleton;

  IF public.flow_activate_revision(tenant_b,account_b,'facebook','b_flow',1,user_a)
    OR public.flow_activate_revision(tenant_a,account_b,'facebook','b_flow',1,user_a)
    OR public.flow_activate_revision(tenant_b,account_a,'instagram','a_flow',1,user_a)
  THEN RAISE EXCEPTION 'CROSS_TENANT_ACTIVATION_ALLOWED'; END IF;
  IF EXISTS(SELECT 1 FROM public.automation_flow_activations WHERE tenant_id=tenant_b)
  THEN RAISE EXCEPTION 'UNAUTHORIZED_ACTIVATION_WROTE_ROW'; END IF;

  IF NOT public.flow_activate_revision(tenant_b,account_b,'facebook','b_flow',1,user_b)
  THEN RAISE EXCEPTION 'VALID_B_ACTIVATION_FAILED'; END IF;
  IF public.flow_activate_revision(tenant_b,account_b,'facebook','b_flow',1,user_a)
    OR public.flow_deactivate_revision(tenant_b,account_b,'facebook','b_flow',user_a)
  THEN RAISE EXCEPTION 'TENANT_A_TOUCHED_B_ACTIVE_FLOW'; END IF;
  IF (SELECT COUNT(*) FROM public.automation_flow_activations
      WHERE tenant_id=tenant_b AND is_active AND revision=1) <> 1
  THEN RAISE EXCEPTION 'TENANT_B_ACTIVE_FLOW_CHANGED'; END IF;
END
$isolation$;
RESET ROLE;
ROLLBACK;
SELECT 'PASS: tenant A denied publishing, activation and deactivation of tenant B; owner B succeeds; transaction rolled back' AS result;
