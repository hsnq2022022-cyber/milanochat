-- Production flow authorization, fail closed.
-- Does not enable any tenant, activate a flow, change balance, or touch Wayl.
-- Current functions are invoker-security and callable only by service_role.
ALTER TABLE public.automation_flow_tenant_switches
  ADD COLUMN IF NOT EXISTS production_approved boolean NOT NULL DEFAULT false;

DO $migration$
DECLARE
  function_text text;
  old_fragment text;
  new_fragment text;
BEGIN
  SELECT pg_get_functiondef('public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid)'::regprocedure)
    INTO function_text;
  old_fragment := 'AND s.test_only FOR SHARE';
  new_fragment := 'AND (s.test_only OR s.production_approved) FOR SHARE';
  IF function_text IS NULL OR strpos(function_text,old_fragment)=0
    OR strpos(function_text,new_fragment)>0 THEN
    RAISE EXCEPTION 'flow_activate_revision changed; manual review required';
  END IF;
  EXECUTE replace(function_text,old_fragment,new_fragment);

  SELECT pg_get_functiondef('public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)'::regprocedure)
    INTO function_text;
  old_fragment := 'AND enabled AND test_only)';
  new_fragment := 'AND enabled AND (test_only OR production_approved))';
  IF function_text IS NULL OR strpos(function_text,old_fragment)=0
    OR strpos(function_text,new_fragment)>0 THEN
    RAISE EXCEPTION 'flow_claim_inbound changed; manual review required';
  END IF;
  EXECUTE replace(function_text,old_fragment,new_fragment);
END $migration$;

-- Never grant tenant approval or runtime RPC execution to public roles.
REVOKE ALL ON TABLE public.automation_flow_tenant_switches FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)
  FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.automation_flow_tenant_switches.production_approved IS
 'Operator-approved production flow eligibility; does not enable automation without tenant and global switches, activated revision and server gate.';
