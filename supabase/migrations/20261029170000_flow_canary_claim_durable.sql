-- REVIEW ONLY: production canary inbound claim for the durable Flow V3/V4
-- Instagram path (milan-api flowDurableIngress.ts attemptDurableInstagram).
-- NOT applied anywhere.
-- Depends on 20261028220000_webhook_exclusive_claim.sql (claims table and
-- flow_claim_inbound), the durable ingress functions flow_begin_durable_run /
-- flow_resume_button_run, the production_approved switch column, and
-- 20261029130000 / 140000 / 150000 / 160000 (preflight refuses otherwise).
-- Rollback: supabase/rollbacks/20261029170000_flow_canary_claim_durable.rollback.sql
-- (order: 170000 FIRST, then 160000, 150000, 140000, 130000; the older
-- rollbacks refuse while any 170000 object exists).
--
-- Defect addressed: flow_claim_inbound (20261028220000) routes an inbound to
-- 'flow' only for test_only tenants, so a production_approved tenant with
-- test_only=false can never reach the durable engine. Changing that function
-- would change V2. Instead this migration adds a SEPARATE claim function used
-- only by the durable path. flow_claim_inbound, its grants and V2 are
-- untouched (byte-for-byte identical definition before and after).
--
-- Canary identity: FLOW_DURABLE_CANARY_ACCOUNT_ID is an Edge Function secret
-- and never reaches SQL. The approved canary is registered in the database
-- (automation_flow_canary_accounts) by an operator, and
-- flow_claim_inbound_durable verifies the caller's tenant, account and
-- platform against that row; the caller cannot assert canary status itself.
--  * composite FK (tenant_id,channel_account_id,platform) ->
--    channel_accounts(tenant_id,id,platform): a registration can only name an
--    account that really belongs to that tenant on that platform;
--  * PRIMARY KEY (tenant_id,platform): at most one canary per tenant/platform;
--  * RLS enabled with NO policy; anon/authenticated have no privilege;
--    service_role (Edge Functions) gets SELECT only, so no Edge Function or
--    leaked service key can register a canary. Only the table owner
--    (postgres, an operator session) can write it.
-- The env var remains in TypeScript as an additional defense-in-depth gate.
--
-- Operator registration (NOT done by this migration; run manually as the
-- table owner, once, after review; replace the placeholders):
--   INSERT INTO public.automation_flow_canary_accounts
--     (tenant_id,channel_account_id,platform,approved_by,note)
--   VALUES ('<tenant uuid>','<instagram channel_accounts.id>','instagram',
--     '<operator name>','production canary');
-- De-registration (stops new durable claims immediately; V2 answers):
--   DELETE FROM public.automation_flow_canary_accounts
--    WHERE tenant_id='<tenant uuid>' AND platform='instagram';
--
-- Eligibility of flow_claim_inbound_durable (ALL required, else NO claim row
-- is written and NO row is returned, so the caller falls back and V2's own
-- flow_claim_inbound claims the event normally):
--  * valid arguments, platform 'instagram';
--  * the inbound message, conversation and account belong to the same tenant
--    and platform (flow_claim_inbound's checks, plus: the conversation must be
--    bound to this account, as flow_begin_durable_run requires);
--  * a canary registration for exactly (tenant, account, platform);
--  * global switch enabled; tenant switch enabled AND production_approved AND
--    test_only=false (test_only tenants keep using flow_claim_inbound);
--  * an active activation for the tenant/account/platform;
--  * optional live flags (tenants.is_active, channel_accounts.is_active /
--    agent_enabled / auto_reply, read via to_jsonb; absent = enabled) are on,
--    the same flags flow_begin_durable_run requires.
-- Eligible: one claim with route 'flow' (same automation_message_claims
-- table and unique barrier as V2) plus one audit row in
-- automation_flow_canary_claims. A duplicate delivery returns the winner's
-- claim with acquired=false; a unique violation never escapes.
--
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE,
-- re-apply refuses objects without this migration's marker. No existing
-- table, column, function, row or grant is changed. No cron, Vault, secrets
-- or network calls; billing/credits untouched.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_name text;
 v_fn regprocedure;
 v_lc constant text := 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE';
 v_ai constant text := 'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY';
 v_tk constant text := 'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME';
 v_cp constant text := 'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE';
 v_wc constant text := 'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM';
 v_marker constant text := 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE';
BEGIN
 FOREACH v_name IN ARRAY ARRAY[
  'tenants','channel_accounts','conversations','messages',
  'automation_message_claims','automation_flow_global_switch',
  'automation_flow_tenant_switches','automation_flow_activations',
  'automation_flow_runs'
 ] LOOP
  IF to_regclass('public.'||v_name) IS NULL THEN
   RAISE EXCEPTION 'Canary claim prerequisite missing: public.%', v_name;
  END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY['enabled','test_only','production_approved'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=to_regclass('public.automation_flow_tenant_switches')
     AND a.attname=v_name AND a.attnum>0 AND NOT a.attisdropped
     AND a.atttypid='boolean'::regtype) THEN
   RAISE EXCEPTION 'Canary claim prerequisite missing: boolean column public.automation_flow_tenant_switches.%', v_name;
  END IF;
 END LOOP;
 -- 20261028220000 claim table and the V2 claim function (never modified here).
 IF obj_description(to_regclass('public.automation_message_claims'),'pg_class') IS DISTINCT FROM v_wc
 OR obj_description(to_regprocedure('public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)'),'pg_proc')
    IS DISTINCT FROM v_wc
 THEN
  RAISE EXCEPTION 'Missing or unrecognized 20261028220000 claim objects; apply 20261028220000_webhook_exclusive_claim first';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='public.automation_message_claims'::regclass AND c.contype='u'
    AND pg_get_constraintdef(c.oid)='UNIQUE (tenant_id, channel_account_id, platform, provider_event_id)')
 THEN
  RAISE EXCEPTION 'automation_message_claims has no UNIQUE (tenant_id, channel_account_id, platform, provider_event_id); abort';
 END IF;
 -- Composite owner key used by the registration FK.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
   WHERE i.indrelid='public.channel_accounts'::regclass AND i.indisunique AND i.indisvalid
    AND i.indpred IS NULL AND i.indexprs IS NULL
    AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
         FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum,ord)
         JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)
        =ARRAY['tenant_id','id','platform'])
 THEN
  RAISE EXCEPTION 'channel_accounts has no unique (tenant_id,id,platform) key; abort';
 END IF;
 -- Durable ingress functions that consume a route='flow' claim.
 IF to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)') IS NULL
 OR to_regprocedure('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)') IS NULL
 THEN
  RAISE EXCEPTION 'Durable ingress functions missing; apply supabase/proposals/flow_durable_button_ingress.review.sql first';
 END IF;
 -- 20261029130000 / 140000 / 150000 / 160000 (exact ownership markers).
 FOREACH v_name IN ARRAY ARRAY[
  'public.flow_lease_due_runs(integer)','public.flow_cancel_run(uuid,uuid,text,text)'
 ] LOOP
  v_fn := to_regprocedure(v_name);
  IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_lc THEN
   RAISE EXCEPTION 'Missing or unrecognized 20261029130000 object %; apply 20261029130000_flow_run_lifecycle first', v_name;
  END IF;
 END LOOP;
 v_fn := to_regprocedure('public.flow_claim_outbox_ai(uuid,uuid,integer,integer)');
 IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_ai THEN
  RAISE EXCEPTION 'Missing or unrecognized 20261029140000 object public.flow_claim_outbox_ai(uuid,uuid,integer,integer); apply 20261029140000_flow_outbox_ai_retry first';
 END IF;
 v_fn := to_regprocedure('public.flow_end_stale_paused_runs(integer,integer)');
 IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_tk THEN
  RAISE EXCEPTION 'Missing or unrecognized 20261029150000 object public.flow_end_stale_paused_runs(integer,integer); apply 20261029150000_flow_takeover_resume first';
 END IF;
 v_fn := to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)');
 IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_cp THEN
  RAISE EXCEPTION 'Missing or unrecognized 20261029160000 object public.flow_channel_temporarily_paused(uuid,uuid); apply 20261029160000_flow_credits_pause first';
 END IF;
 -- Re-apply only over this migration's own objects.
 FOREACH v_name IN ARRAY ARRAY['automation_flow_canary_accounts','automation_flow_canary_claims'] LOOP
  IF to_regclass('public.'||v_name) IS NOT NULL AND
     obj_description(to_regclass('public.'||v_name),'pg_class') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'Unrecognized existing table public.%; refuse blind replacement', v_name;
  END IF;
 END LOOP;
 v_fn := to_regprocedure('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)');
 IF v_fn IS NOT NULL AND obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Unrecognized existing function public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid); refuse blind replacement';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='flow_claim_inbound_durable'
    AND p.oid IS DISTINCT FROM v_fn) THEN
  RAISE EXCEPTION 'Unrecognized overload of public.flow_claim_inbound_durable; abort';
 END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- Operator-owned canary registration. One canary per tenant and platform;
-- the composite FK makes a tenant/account/platform mismatch impossible.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.automation_flow_canary_accounts(
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 channel_account_id uuid NOT NULL,
 platform text NOT NULL CONSTRAINT automation_flow_canary_accounts_platform_chk
  CHECK(platform='instagram'),
 approved_by text NOT NULL CONSTRAINT automation_flow_canary_accounts_approved_by_chk
  CHECK(length(btrim(approved_by)) BETWEEN 1 AND 200),
 note text CONSTRAINT automation_flow_canary_accounts_note_chk
  CHECK(note IS NULL OR length(note)<=500),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT automation_flow_canary_accounts_pkey PRIMARY KEY(tenant_id,platform),
 CONSTRAINT automation_flow_canary_accounts_account_uq UNIQUE(channel_account_id,platform),
 CONSTRAINT automation_flow_canary_accounts_owner_fk FOREIGN KEY(tenant_id,channel_account_id,platform)
  REFERENCES public.channel_accounts(tenant_id,id,platform) ON DELETE CASCADE
);
COMMENT ON TABLE public.automation_flow_canary_accounts
 IS 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE';

-- Audit of every claim made through flow_claim_inbound_durable (the claim
-- itself lives in automation_message_claims; this row records provenance).
CREATE TABLE IF NOT EXISTS public.automation_flow_canary_claims(
 tenant_id uuid NOT NULL,
 channel_account_id uuid NOT NULL,
 platform text NOT NULL,
 provider_event_id text NOT NULL,
 claimed_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT automation_flow_canary_claims_pkey
  PRIMARY KEY(tenant_id,channel_account_id,platform,provider_event_id),
 CONSTRAINT automation_flow_canary_claims_claim_fk
  FOREIGN KEY(tenant_id,channel_account_id,platform,provider_event_id)
  REFERENCES public.automation_message_claims(tenant_id,channel_account_id,platform,provider_event_id)
);
COMMENT ON TABLE public.automation_flow_canary_claims
 IS 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE';

ALTER TABLE public.automation_flow_canary_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_flow_canary_claims ENABLE ROW LEVEL SECURITY;
-- service_role is revoked too (Supabase default privileges grant ALL on new
-- tables), then gets only what the invoker-security function needs.
REVOKE ALL ON TABLE public.automation_flow_canary_accounts,public.automation_flow_canary_claims
 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.automation_flow_canary_accounts TO service_role;
GRANT SELECT,INSERT ON public.automation_flow_canary_claims TO service_role;

-- ---------------------------------------------------------------------------
-- Durable-path-only claim. Same return shape as flow_claim_inbound.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flow_claim_inbound_durable(
 p_tenant_id uuid,
 p_account_id uuid,
 p_platform text,
 p_provider_event_id text,
 p_conversation_id uuid,
 p_inbound_message_id uuid
) RETURNS TABLE(acquired boolean,route text,claim_id uuid,outgoing_message_id uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $claim$
DECLARE v_id uuid;v_route text;v_outgoing uuid;j jsonb;
BEGIN
 IF p_tenant_id IS NULL OR p_account_id IS NULL OR p_conversation_id IS NULL OR
    p_inbound_message_id IS NULL OR p_platform IS DISTINCT FROM 'instagram' OR
    p_provider_event_id IS NULL OR length(p_provider_event_id) NOT BETWEEN 1 AND 256
 THEN RETURN; END IF;
 -- Same ownership rule as flow_claim_inbound, and the conversation must be
 -- bound to this account (flow_begin_durable_run refuses anything else).
 IF NOT EXISTS (
   SELECT 1 FROM public.messages m JOIN public.conversations c
     ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id
     JOIN public.channel_accounts a
       ON a.id=p_account_id AND a.tenant_id=c.tenant_id
   WHERE m.id=p_inbound_message_id AND m.tenant_id=p_tenant_id
     AND m.direction='in' AND m.conversation_id=p_conversation_id
     AND m.wa_message_id=p_provider_event_id
     AND c.account_id=p_account_id
     AND a.platform=p_platform
 ) THEN RETURN; END IF;
 -- Operator-registered canary: tenant, account and platform must all match.
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_canary_accounts r
   WHERE r.tenant_id=p_tenant_id AND r.channel_account_id=p_account_id
     AND r.platform=p_platform)
 THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.automation_flow_global_switch g
    WHERE g.singleton AND g.enabled IS TRUE)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches s
    WHERE s.tenant_id=p_tenant_id AND s.enabled IS TRUE
      AND s.production_approved IS TRUE AND s.test_only IS FALSE)
 OR NOT EXISTS(SELECT 1 FROM public.automation_flow_activations f
    WHERE f.tenant_id=p_tenant_id AND f.channel_account_id=p_account_id
      AND f.platform=p_platform AND f.is_active)
 THEN RETURN; END IF;
 -- Optional live-only flags (absent column = enabled), as begin requires.
 SELECT to_jsonb(t) INTO j FROM public.tenants t WHERE t.id=p_tenant_id;
 IF j IS NULL OR (j ? 'is_active' AND (j->>'is_active') IS DISTINCT FROM 'true')
 THEN RETURN; END IF;
 SELECT to_jsonb(ca) INTO j FROM public.channel_accounts ca
 WHERE ca.tenant_id=p_tenant_id AND ca.id=p_account_id;
 IF j IS NULL
  OR (j ? 'is_active' AND (j->>'is_active') IS DISTINCT FROM 'true')
  OR (j ? 'agent_enabled' AND (j->>'agent_enabled') IS DISTINCT FROM 'true')
  OR (j ? 'auto_reply' AND (j->>'auto_reply') IS DISTINCT FROM 'true')
 THEN RETURN; END IF;

 -- PostgreSQL unique conflict serialization is the exclusivity barrier,
 -- shared with V2's flow_claim_inbound (same table, same keys).
 INSERT INTO public.automation_message_claims(
  tenant_id,channel_account_id,platform,provider_event_id,conversation_id,
  inbound_message_id,route)
 VALUES(p_tenant_id,p_account_id,p_platform,p_provider_event_id,
        p_conversation_id,p_inbound_message_id,'flow')
 ON CONFLICT DO NOTHING
 RETURNING automation_message_claims.id,automation_message_claims.route,
  automation_message_claims.outgoing_message_id
 INTO v_id,v_route,v_outgoing;

 IF v_id IS NOT NULL THEN
  INSERT INTO public.automation_flow_canary_claims(
   tenant_id,channel_account_id,platform,provider_event_id)
  VALUES(p_tenant_id,p_account_id,p_platform,p_provider_event_id);
  RETURN QUERY SELECT true,v_route,v_id,v_outgoing;
  RETURN; -- Winner must never also return a second duplicate result.
 END IF;
 -- Another request won (possibly while this request was blocked waiting).
 -- Never transfer ownership to the loser, even if the winner's path failed.
 RETURN QUERY SELECT false,c.route,c.id,c.outgoing_message_id
 FROM public.automation_message_claims c
 WHERE c.tenant_id=p_tenant_id AND c.channel_account_id=p_account_id
   AND c.platform=p_platform AND c.provider_event_id=p_provider_event_id;
END
$claim$;
COMMENT ON FUNCTION public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)
 IS 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE';
REVOKE ALL ON FUNCTION public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)
 TO service_role;
COMMIT;
