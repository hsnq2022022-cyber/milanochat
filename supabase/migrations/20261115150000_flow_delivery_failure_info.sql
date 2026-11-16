-- REVIEW ONLY: durable provider-failure metadata for Flow Outbox deliveries
-- (T6-S4). NOT applied anywhere by this repository; apply only with an
-- explicit owner GO.
--
-- Problem: a failed provider send (Meta HTTP 4xx/5xx) was finished through
-- public.flow_finish_outbox_delivery(tenant,outbox,'uncertain',NULL) and the
-- error was discarded, so delivery review could not tell "Meta refused the
-- request" from "maybe delivered", and a definite text refusal (Meta 4xx with
-- code 100, nothing delivered) sat in 'uncertain' like an ambiguous timeout.
--
-- Changes (additive; nothing existing is redefined):
--  1. public.automation_flow_delivery_attempts gains five NULLABLE columns
--     (existing rows keep NULL; no row is rewritten):
--       failure_class          text     closed list (CHECK)
--       provider_http_status   integer  100..599
--       provider_error_code    integer  0..999999999 (Meta error.code)
--       provider_error_subcode integer  0..999999999 (Meta error.error_subcode)
--       provider_error_type    text     ^[A-Za-z][A-Za-z0-9_]{0,63}$ (Meta error.type)
--     and ONE CHECK, automation_flow_delivery_attempts_failure_info_chk
--     (marker comment below): either all five are NULL, or failure_class is
--     set, the attempt status is 'uncertain' / 'rejected', every field is in
--     range, and class and Meta code are consistent (definite classes need an
--     HTTP 4xx other than 408 and their documented code). The CHECK is wrapped
--     in coalesce(...,false) so a NULL can never slip through. Only validated
--     numbers / identifiers are storable: never message text, tokens, URLs,
--     headers, raw bodies, Meta messages or fbtrace_id.
--  2. NEW function public.flow_fail_outbox_delivery(p_tenant uuid,
--     p_outbox uuid, p_result text, p_failure_class text, p_http_status
--     integer, p_error_code integer, p_error_subcode integer, p_error_type
--     text) RETURNS boolean: finishes a reserved delivery that FAILED and
--     records its failure info in the same transaction. Invalid input -> false,
--     nothing changed. Every statement is keyed by p_tenant.
--      * 'uncertain' (any class): delegates to the UNCHANGED
--        flow_finish_outbox_delivery(p_tenant,p_outbox,'uncertain',NULL)
--        (identical state transition), then stores the info on that attempt.
--      * 'rejected' for a 'message_image' effect: only with class
--        'media_rejected'; delegates to the unchanged
--        flow_finish_outbox_delivery(...,'rejected',NULL) (image dead_letter,
--        exactly as 20261029210000), then stores the info.
--      * 'rejected' for a 'message' / 'question' effect: ONLY with class
--        'rejected_invalid' AND HTTP 400..499 except 408/429 AND Meta code
--        100 (Meta refused the request: nothing was delivered). The attempt
--        'attempting' -> 'rejected' and the outbox 'leased' -> 'dead_letter'
--        with the same statements/guards as the image outcome of
--        flow_finish_outbox_delivery (no provider id, never billed, never
--        resent, never queued for human review). Anything else -> false.
--     A second / late call returns false and never overwrites stored info
--     (the info is written only by the call that moved the attempt out of
--     'attempting'; an attempt with info is refused by the guarded UPDATE).
--     LANGUAGE plpgsql, SECURITY INVOKER, SET search_path='', EXECUTE revoked
--     from PUBLIC/anon/authenticated and granted to service_role only.
-- NOT changed: flow_finish_outbox_delivery (no overload is added; its
-- 20261029210000 body, hash 1c6ec477519f8c91c24fc2ab82d4b9c4, its marker and
-- its four-argument callers incl. the T6-S2 lease recovery stay exactly as
-- they are), flow_reserve_outbox_delivery, flow_queue_outbox_human_review,
-- every status CHECK, billing/credits (not referenced), RLS and table grants
-- (service_role keeps SELECT/INSERT/UPDATE; anon/authenticated nothing).
-- Ownership marker: CREATED_BY_20261115150000_FLOW_DELIVERY_FAILURE_INFO
-- Body md5: md5(btrim(regexp_replace(prosrc,'[[:space:]]+',' ','g'))).
--
-- Preflight refuses unless: roles anon/authenticated/service_role exist; the
-- attempts table carries the 20261028226000 marker and its expected columns;
-- its status CHECK is the marked 20261029210000 list (with 'rejected'); the
-- outbox delivery_status CHECK allows 'uncertain' and 'dead_letter';
-- flow_finish_outbox_delivery(uuid,uuid,text,text) has its 226000 marker and
-- the 20261029210000 body and no other overload; the five columns are either
-- all absent or all present with this migration's types and marked CHECK
-- (re-apply); flow_fail_outbox_delivery is absent or this migration's marked
-- body, with no other overload.
-- Lock impact: ALTER TABLE on automation_flow_delivery_attempts (ACCESS
-- EXCLUSIVE for the transaction; nullable columns without default = catalog
-- only; VALIDATE scans the table once). lock_timeout 3s / statement_timeout 60s.
-- Idempotent: re-applying is a no-op (IF NOT EXISTS / marked objects only).
--
-- Deploy order: apply this migration FIRST, then deploy the flow-outbox-worker
-- and flow-delivery-review builds that use it. Both builds also run safely
-- WITHOUT it: the worker falls back to the unchanged flow_finish_outbox_delivery
-- call (previous behaviour, no failure info, text never dead_lettered) and the
-- review lists no provider failures. Rollback:
-- supabase/rollbacks/20261115150000_flow_delivery_failure_info.rollback.sql
-- (run it BEFORE any older flow rollback, e.g. 20261029210000 / 20261028226000).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path = '';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261115150000_FLOW_DELIVERY_FAILURE_INFO';
 v_media constant text := 'CREATED_BY_20261029210000_FLOW_MEDIA_EFFECTS';
 v_finish_md5 constant text := '1c6ec477519f8c91c24fc2ab82d4b9c4';
 -- md5 of this migration's own normalized flow_fail_outbox_delivery body.
 v_self_md5 constant text := 'd2a81dda62fd43b336e3a07dbe6ef13d';
 v_status_210 constant text := 'CHECK ((status = ANY (ARRAY[''attempting''::text, ''confirmed''::text, ''uncertain''::text, ''rejected''::text])))';
 v_sig constant text := 'public.flow_fail_outbox_delivery(uuid,uuid,text,text,integer,integer,integer,text)';
 v_fn regprocedure;
 v_name text;
 v_n integer;
 v_def text;
 v_cmt text;
 r record;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_name) THEN
   RAISE EXCEPTION 'Delivery failure info prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 IF to_regclass('public.automation_flow_outbox') IS NULL
  OR to_regclass('public.automation_flow_delivery_attempts') IS NULL THEN
  RAISE EXCEPTION 'Delivery failure info prerequisite missing: automation_flow_outbox / automation_flow_delivery_attempts';
 END IF;
 IF obj_description('public.automation_flow_delivery_attempts'::regclass,'pg_class')
    IS DISTINCT FROM 'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY' THEN
  RAISE EXCEPTION 'Missing or unrecognized public.automation_flow_delivery_attempts; apply 20261028226000_flow_outbox_delivery_attempts first';
 END IF;
 FOR r IN SELECT * FROM (VALUES
   ('automation_flow_delivery_attempts','tenant_id','uuid'),('automation_flow_delivery_attempts','outbox_id','uuid'),
   ('automation_flow_delivery_attempts','status','text'),('automation_flow_delivery_attempts','provider_message_id','text'),
   ('automation_flow_delivery_attempts','attempted_at','timestamp with time zone'),
   ('automation_flow_delivery_attempts','confirmed_at','timestamp with time zone'),
   ('automation_flow_delivery_attempts','uncertain_at','timestamp with time zone'),
   ('automation_flow_outbox','tenant_id','uuid'),('automation_flow_outbox','id','uuid'),
   ('automation_flow_outbox','effect_kind','text'),('automation_flow_outbox','delivery_status','text'),
   ('automation_flow_outbox','provider_message_id','text'),('automation_flow_outbox','delivered_at','timestamp with time zone'),
   ('automation_flow_outbox','lease_token','uuid'),('automation_flow_outbox','lease_expires_at','timestamp with time zone')
  ) t(rel,col,typ)
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=to_regclass('public.'||r.rel) AND a.attname=r.col AND a.attnum>0
     AND NOT a.attisdropped AND pg_catalog.format_type(a.atttypid,a.atttypmod)=r.typ) THEN
   RAISE EXCEPTION 'Delivery failure info prerequisite missing: public.%.% %', r.rel, r.col, r.typ;
  END IF;
 END LOOP;
 -- Attempt status CHECK: exactly the marked 20261029210000 list (allows 'rejected').
 SELECT count(*),min(pg_catalog.pg_get_constraintdef(c.oid)),min(obj_description(c.oid,'pg_constraint'))
 INTO v_n,v_def,v_cmt FROM pg_catalog.pg_constraint c
 WHERE c.conrelid='public.automation_flow_delivery_attempts'::regclass AND c.contype='c'
  AND c.conkey=ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
    WHERE a.attrelid='public.automation_flow_delivery_attempts'::regclass AND a.attname='status')]::int2[];
 IF v_n<>1 OR v_def IS DISTINCT FROM v_status_210 OR split_part(coalesce(v_cmt,''),' ',1) IS DISTINCT FROM v_media THEN
  RAISE EXCEPTION 'Attempt status CHECK is not the 20261029210000 definition (count=%, definition=%); apply 20261029210000_flow_media_effects first',
   v_n, coalesce(v_def,'-');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='public.automation_flow_outbox'::regclass AND c.contype='c'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%delivery_status%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''dead_letter''%'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''uncertain''%') THEN
  RAISE EXCEPTION 'Delivery failure info prerequisite missing: outbox delivery_status CHECK allowing uncertain and dead_letter';
 END IF;
 -- flow_finish_outbox_delivery: the unchanged 20261029210000 body this function delegates to.
 v_fn := to_regprocedure('public.flow_finish_outbox_delivery(uuid,uuid,text,text)');
 IF v_fn IS NULL OR obj_description(v_fn,'pg_proc') IS DISTINCT FROM 'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY'
  OR (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p WHERE p.oid=v_fn)
     IS DISTINCT FROM v_finish_md5 THEN
  RAISE EXCEPTION 'public.flow_finish_outbox_delivery is missing or not the 20261029210000 definition; apply 20261029210000_flow_media_effects first';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
   AND p.proname='flow_finish_outbox_delivery' AND p.oid<>v_fn) THEN
  RAISE EXCEPTION 'Unrecognized overload of public.flow_finish_outbox_delivery exists; refusing to install';
 END IF;
 -- Columns: all absent (fresh) or all present with this migration's types and marked CHECK (re-apply).
 SELECT count(*) INTO v_n FROM pg_catalog.pg_attribute a
 WHERE a.attrelid='public.automation_flow_delivery_attempts'::regclass AND a.attnum>0 AND NOT a.attisdropped
  AND a.attname IN('failure_class','provider_http_status','provider_error_code','provider_error_subcode','provider_error_type');
 IF v_n<>0 THEN
  IF v_n<>5 OR (SELECT count(*) FROM pg_catalog.pg_attribute a
     WHERE a.attrelid='public.automation_flow_delivery_attempts'::regclass AND a.attnum>0 AND NOT a.attisdropped
      AND (a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod)) IN(('failure_class','text'),
       ('provider_http_status','integer'),('provider_error_code','integer'),
       ('provider_error_subcode','integer'),('provider_error_type','text')))<>5
   OR split_part(coalesce((SELECT obj_description(c.oid,'pg_constraint') FROM pg_catalog.pg_constraint c
      WHERE c.conrelid='public.automation_flow_delivery_attempts'::regclass
       AND c.conname='automation_flow_delivery_attempts_failure_info_chk'),''),' ',1) IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'Unrecognized failure-info columns on public.automation_flow_delivery_attempts (% of 5 present); refusing to install', v_n;
  END IF;
 ELSIF EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='public.automation_flow_delivery_attempts'::regclass
    AND c.conname='automation_flow_delivery_attempts_failure_info_chk') THEN
  RAISE EXCEPTION 'Constraint automation_flow_delivery_attempts_failure_info_chk exists without its columns; refusing to install';
 END IF;
 -- Re-apply only over this migration's own function; no other overload.
 v_fn := to_regprocedure(v_sig);
 IF v_fn IS NOT NULL THEN
  IF obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION 'Unrecognized existing function %; refusing to overwrite', v_sig;
  END IF;
  IF (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p WHERE p.oid=v_fn)
     IS DISTINCT FROM v_self_md5 THEN
   RAISE EXCEPTION 'Existing % carries the marker but not this migration''s body; refusing to overwrite', v_sig;
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
   AND p.proname='flow_fail_outbox_delivery' AND p.oid IS DISTINCT FROM v_fn) THEN
  RAISE EXCEPTION 'Unrecognized overload of public.flow_fail_outbox_delivery exists; refusing to install';
 END IF;
END
$preflight$;

-- (1) Nullable columns: existing rows keep NULL (no default, no rewrite).
ALTER TABLE public.automation_flow_delivery_attempts
 ADD COLUMN IF NOT EXISTS failure_class text,
 ADD COLUMN IF NOT EXISTS provider_http_status integer,
 ADD COLUMN IF NOT EXISTS provider_error_code integer,
 ADD COLUMN IF NOT EXISTS provider_error_subcode integer,
 ADD COLUMN IF NOT EXISTS provider_error_type text;

DO $checks$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint
   WHERE conrelid='public.automation_flow_delivery_attempts'::regclass
    AND conname='automation_flow_delivery_attempts_failure_info_chk') THEN
  ALTER TABLE public.automation_flow_delivery_attempts
   ADD CONSTRAINT automation_flow_delivery_attempts_failure_info_chk CHECK(coalesce(
    (failure_class IS NULL AND provider_http_status IS NULL AND provider_error_code IS NULL
     AND provider_error_subcode IS NULL AND provider_error_type IS NULL)
    OR (failure_class IN('outside_window','auth','throttled','rejected_invalid','permanent_other','ambiguous','media_rejected')
     AND status IN('uncertain','rejected')
     AND (provider_http_status IS NULL OR provider_http_status BETWEEN 100 AND 599)
     AND (provider_error_code IS NULL OR provider_error_code BETWEEN 0 AND 999999999)
     AND (provider_error_subcode IS NULL OR provider_error_subcode BETWEEN 0 AND 999999999)
     AND (provider_error_type IS NULL OR provider_error_type ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$')
     AND (failure_class='ambiguous'
      OR (provider_http_status BETWEEN 400 AND 499 AND provider_http_status<>408))
     AND (failure_class<>'rejected_invalid' OR provider_error_code=100)
     AND (failure_class<>'outside_window' OR provider_error_code=131047
      OR (provider_error_code=10 AND provider_error_subcode=2018278))
     AND (failure_class<>'auth' OR provider_error_code=190
      OR (provider_error_code IS NULL AND provider_http_status IN(401,403)))
     AND (failure_class<>'throttled' OR provider_error_code IN(4,17,32,613,130429,131056))
     AND (failure_class<>'permanent_other'
      OR (provider_error_code=10 AND provider_error_subcode IS DISTINCT FROM 2018278))
     AND (failure_class<>'media_rejected'
      OR (provider_http_status NOT IN(401,403,429) AND provider_error_code IS DISTINCT FROM 190)))
   ,false)) NOT VALID;
  ALTER TABLE public.automation_flow_delivery_attempts
   VALIDATE CONSTRAINT automation_flow_delivery_attempts_failure_info_chk;
  COMMENT ON CONSTRAINT automation_flow_delivery_attempts_failure_info_chk
   ON public.automation_flow_delivery_attempts IS 'CREATED_BY_20261115150000_FLOW_DELIVERY_FAILURE_INFO';
 END IF;
END
$checks$;

-- (2) Failure finish with validated metadata (see header).
CREATE OR REPLACE FUNCTION public.flow_fail_outbox_delivery(
 p_tenant uuid,p_outbox uuid,p_result text,p_failure_class text,
 p_http_status integer,p_error_code integer,p_error_subcode integer,p_error_type text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fail$
DECLARE v_kind text;
BEGIN
 -- Same rules as automation_flow_delivery_attempts_failure_info_chk: invalid -> false.
 IF p_tenant IS NULL OR p_outbox IS NULL OR p_result IS NULL OR p_result NOT IN('uncertain','rejected')
 OR NOT coalesce(
   p_failure_class IN('outside_window','auth','throttled','rejected_invalid','permanent_other','ambiguous','media_rejected')
   AND (p_http_status IS NULL OR p_http_status BETWEEN 100 AND 599)
   AND (p_error_code IS NULL OR p_error_code BETWEEN 0 AND 999999999)
   AND (p_error_subcode IS NULL OR p_error_subcode BETWEEN 0 AND 999999999)
   AND (p_error_type IS NULL OR p_error_type ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$')
   AND (p_failure_class='ambiguous' OR (p_http_status BETWEEN 400 AND 499 AND p_http_status<>408))
   AND (p_failure_class<>'rejected_invalid' OR p_error_code=100)
   AND (p_failure_class<>'outside_window' OR p_error_code=131047 OR (p_error_code=10 AND p_error_subcode=2018278))
   AND (p_failure_class<>'auth' OR p_error_code=190 OR (p_error_code IS NULL AND p_http_status IN(401,403)))
   AND (p_failure_class<>'throttled' OR p_error_code IN(4,17,32,613,130429,131056))
   AND (p_failure_class<>'permanent_other' OR (p_error_code=10 AND p_error_subcode IS DISTINCT FROM 2018278))
   AND (p_failure_class<>'media_rejected' OR (p_http_status NOT IN(401,403,429) AND p_error_code IS DISTINCT FROM 190)),
  false)
 THEN RETURN false;END IF;
 IF p_result='rejected' THEN
  SELECT o.effect_kind INTO v_kind FROM public.automation_flow_outbox o
  WHERE o.tenant_id=p_tenant AND o.id=p_outbox;
  IF NOT FOUND THEN RETURN false;END IF;
  IF v_kind='message_image' THEN
   -- Image refused by the provider: the unchanged 20261029210000 outcome.
   IF p_failure_class<>'media_rejected' THEN RETURN false;END IF;
   IF NOT public.flow_finish_outbox_delivery(p_tenant,p_outbox,'rejected',NULL) THEN RETURN false;END IF;
  ELSIF v_kind IN('message','question') THEN
   -- Text refused by Meta (4xx, code 100: invalid parameter): nothing was
   -- delivered. Ambiguous / throttled / auth / window / 5xx never get here.
   IF NOT coalesce(p_failure_class='rejected_invalid' AND p_http_status BETWEEN 400 AND 499
     AND p_http_status NOT IN(408,429) AND p_error_code=100,false)
   THEN RETURN false;END IF;
   UPDATE public.automation_flow_delivery_attempts
   SET status='rejected',provider_message_id=NULL,confirmed_at=NULL,uncertain_at=NULL
   WHERE tenant_id=p_tenant AND outbox_id=p_outbox AND status='attempting';
   IF NOT FOUND THEN RETURN false;END IF;
   UPDATE public.automation_flow_outbox
   SET delivery_status='dead_letter',provider_message_id=NULL,delivered_at=NULL,
    lease_token=NULL,lease_expires_at=NULL
   WHERE tenant_id=p_tenant AND id=p_outbox AND delivery_status='leased';
   IF NOT FOUND THEN RAISE EXCEPTION 'Outbox status changed after delivery';END IF;
  ELSE
   RETURN false;
  END IF;
 ELSE
  IF NOT public.flow_finish_outbox_delivery(p_tenant,p_outbox,'uncertain',NULL) THEN RETURN false;END IF;
 END IF;
 -- Only the call that just finished this attempt (row locked, still without info) stores it.
 UPDATE public.automation_flow_delivery_attempts
 SET failure_class=p_failure_class,provider_http_status=p_http_status,
  provider_error_code=p_error_code,provider_error_subcode=p_error_subcode,
  provider_error_type=p_error_type
 WHERE tenant_id=p_tenant AND outbox_id=p_outbox AND status=p_result AND failure_class IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Delivery failure info already recorded';END IF;
 RETURN true;
END $fail$;
COMMENT ON FUNCTION public.flow_fail_outbox_delivery(uuid,uuid,text,text,integer,integer,integer,text)
 IS 'CREATED_BY_20261115150000_FLOW_DELIVERY_FAILURE_INFO';
REVOKE ALL ON FUNCTION public.flow_fail_outbox_delivery(uuid,uuid,text,text,integer,integer,integer,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.flow_fail_outbox_delivery(uuid,uuid,text,text,integer,integer,integer,text)
 TO service_role;

DO $postcondition$
DECLARE
 v_fn regprocedure := to_regprocedure('public.flow_fail_outbox_delivery(uuid,uuid,text,text,integer,integer,integer,text)');
 v_finish regprocedure := to_regprocedure('public.flow_finish_outbox_delivery(uuid,uuid,text,text)');
BEGIN
 IF v_fn IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=v_fn AND NOT p.prosecdef
   AND p.prorettype='pg_catalog.bool'::regtype AND NOT p.proretset AND p.pronargdefaults=0
   AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']
   AND obj_description(p.oid,'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261115150000_FLOW_DELIVERY_FAILURE_INFO') THEN
  RAISE EXCEPTION 'flow_fail_outbox_delivery was not installed as a marked SECURITY INVOKER boolean function with search_path=''''';
 END IF;
 IF pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p,
              LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
              WHERE p.oid=v_fn AND a.grantee=0)
    OR NOT pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
  RAISE EXCEPTION 'flow_fail_outbox_delivery EXECUTE privileges are not service_role-only';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='public.automation_flow_delivery_attempts'::regclass
    AND c.conname='automation_flow_delivery_attempts_failure_info_chk' AND c.contype='c' AND c.convalidated
    AND obj_description(c.oid,'pg_constraint') IS NOT DISTINCT FROM 'CREATED_BY_20261115150000_FLOW_DELIVERY_FAILURE_INFO') THEN
  RAISE EXCEPTION 'automation_flow_delivery_attempts_failure_info_chk missing, not validated or unmarked';
 END IF;
 -- The four-argument finish is untouched (body, marker, single signature, privileges).
 IF v_finish IS NULL
    OR (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p WHERE p.oid=v_finish)
       IS DISTINCT FROM '1c6ec477519f8c91c24fc2ab82d4b9c4'
    OR (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
        AND p.proname='flow_finish_outbox_delivery')<>1
    OR pg_catalog.has_function_privilege('anon', v_finish, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_finish, 'EXECUTE') THEN
  RAISE EXCEPTION 'flow_finish_outbox_delivery changed unexpectedly';
 END IF;
END
$postcondition$;
COMMIT;
