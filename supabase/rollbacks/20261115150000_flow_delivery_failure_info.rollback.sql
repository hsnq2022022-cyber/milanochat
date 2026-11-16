-- REVIEW ONLY rollback for 20261115150000_flow_delivery_failure_info.
-- NOT applied anywhere by this repository.
--
-- Drops ONLY what 20261115150000 created: the function
-- public.flow_fail_outbox_delivery(uuid,uuid,text,text,integer,integer,integer,text)
-- (only while it carries the marker CREATED_BY_20261115150000_FLOW_DELIVERY_FAILURE_INFO
-- AND the exact 20261115150000 body), the marked CHECK
-- automation_flow_delivery_attempts_failure_info_chk and the five columns
-- failure_class, provider_http_status, provider_error_code,
-- provider_error_subcode, provider_error_type of
-- public.automation_flow_delivery_attempts. Any other or partial state is
-- refused, never dropped. Running it a second time is refused (nothing to
-- roll back) and changes nothing.
-- NOT touched: public.flow_finish_outbox_delivery (20261115150000 never
-- changed it; its 20261029210000 body, marker and privileges are verified
-- before and after), every other function, CHECK, row, grant and policy.
--
-- Data guard: dropping the columns destroys the stored failure info, which
-- cannot be restored. The rollback therefore REFUSES while any attempt row
-- has failure_class IS NOT NULL, unless the operator explicitly opts in
-- (after exporting the rows if they are needed):
--   PGOPTIONS='-c flow.rollback_20261115150000=discard-failure-info' \
--     psql ... -f supabase/rollbacks/20261115150000_flow_delivery_failure_info.rollback.sql
-- Delivery state is never changed: attempts finished 'rejected' and outbox
-- rows in 'dead_letter' for a text effect refused by Meta (4xx code 100)
-- stay terminal (never resent, never billed); both values are already legal
-- under the 20261029210000 CHECKs and the restored worker treats them like
-- any other dead_letter row.
--
-- Order: deploy flow-outbox-worker / flow-delivery-review builds that do not
-- call/select these objects FIRST (the T6-S4 builds also degrade safely: the
-- worker falls back to flow_finish_outbox_delivery, the review hides the
-- provider-failure list), then run this rollback BEFORE any older flow
-- rollback (20261029300000 .. 20261029210000, 20261028226000).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path = '';

DO $g$
DECLARE
 v_marker constant text := 'CREATED_BY_20261115150000_FLOW_DELIVERY_FAILURE_INFO';
 v_self_md5 constant text := 'd2a81dda62fd43b336e3a07dbe6ef13d';
 v_fn regprocedure := to_regprocedure('public.flow_fail_outbox_delivery(uuid,uuid,text,text,integer,integer,integer,text)');
 v_cols integer;
 v_con boolean;
 v_rows bigint;
BEGIN
 IF to_regclass('public.automation_flow_delivery_attempts') IS NULL THEN
  RAISE EXCEPTION '20261115150000_flow_delivery_failure_info not installed; nothing to roll back';
 END IF;
 SELECT count(*) INTO v_cols FROM pg_catalog.pg_attribute a
 WHERE a.attrelid='public.automation_flow_delivery_attempts'::regclass AND a.attnum>0 AND NOT a.attisdropped
  AND a.attname IN('failure_class','provider_http_status','provider_error_code','provider_error_subcode','provider_error_type');
 v_con := EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
  WHERE c.conrelid='public.automation_flow_delivery_attempts'::regclass
   AND c.conname='automation_flow_delivery_attempts_failure_info_chk');
 IF v_fn IS NULL AND v_cols=0 AND NOT v_con THEN
  RAISE EXCEPTION '20261115150000_flow_delivery_failure_info not installed; nothing to roll back';
 END IF;
 IF v_fn IS NULL OR v_cols<>5 OR NOT v_con THEN
  RAISE EXCEPTION 'Refusing 20261115150000 rollback: partial or unrecognized state (function=%, columns=% of 5, check=%)',
   v_fn IS NOT NULL, v_cols, v_con;
 END IF;
 IF obj_description(v_fn,'pg_proc') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Refusing to drop unrecognized function public.flow_fail_outbox_delivery (marker=%)',
   coalesce(obj_description(v_fn,'pg_proc'),'-');
 END IF;
 IF (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p WHERE p.oid=v_fn)
    IS DISTINCT FROM v_self_md5 THEN
  RAISE EXCEPTION 'Refusing to drop public.flow_fail_outbox_delivery: marked but its body is not the 20261115150000 definition';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
   AND p.proname='flow_fail_outbox_delivery' AND p.oid<>v_fn) THEN
  RAISE EXCEPTION 'Refusing 20261115150000 rollback: unrecognized overload of public.flow_fail_outbox_delivery exists';
 END IF;
 IF (SELECT obj_description(c.oid,'pg_constraint') FROM pg_catalog.pg_constraint c
     WHERE c.conrelid='public.automation_flow_delivery_attempts'::regclass
      AND c.conname='automation_flow_delivery_attempts_failure_info_chk') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'Refusing 20261115150000 rollback: automation_flow_delivery_attempts_failure_info_chk is not marked by 20261115150000';
 END IF;
 IF (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p
     WHERE p.oid=to_regprocedure('public.flow_finish_outbox_delivery(uuid,uuid,text,text)'))
    IS DISTINCT FROM '1c6ec477519f8c91c24fc2ab82d4b9c4' THEN
  RAISE EXCEPTION 'Refusing 20261115150000 rollback: flow_finish_outbox_delivery is not the 20261029210000 body (a later migration?)';
 END IF;
 EXECUTE 'SELECT count(*) FROM public.automation_flow_delivery_attempts WHERE failure_class IS NOT NULL' INTO v_rows;
 IF v_rows>0 AND coalesce(current_setting('flow.rollback_20261115150000',true),'') IS DISTINCT FROM 'discard-failure-info' THEN
  RAISE EXCEPTION 'Refusing 20261115150000 rollback: % attempt row(s) hold provider failure info that would be lost; export them, then re-run with PGOPTIONS ''-c flow.rollback_20261115150000=discard-failure-info''', v_rows;
 END IF;
END
$g$;

DROP FUNCTION public.flow_fail_outbox_delivery(uuid,uuid,text,text,integer,integer,integer,text);
ALTER TABLE public.automation_flow_delivery_attempts
 DROP CONSTRAINT automation_flow_delivery_attempts_failure_info_chk;
ALTER TABLE public.automation_flow_delivery_attempts
 DROP COLUMN failure_class,
 DROP COLUMN provider_http_status,
 DROP COLUMN provider_error_code,
 DROP COLUMN provider_error_subcode,
 DROP COLUMN provider_error_type;

DO $post$
BEGIN
 IF to_regprocedure('public.flow_fail_outbox_delivery(uuid,uuid,text,text,integer,integer,integer,text)') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
   WHERE a.attrelid='public.automation_flow_delivery_attempts'::regclass AND a.attnum>0 AND NOT a.attisdropped
    AND a.attname IN('failure_class','provider_http_status','provider_error_code','provider_error_subcode','provider_error_type'))
  OR (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p
     WHERE p.oid=to_regprocedure('public.flow_finish_outbox_delivery(uuid,uuid,text,text)'))
    IS DISTINCT FROM '1c6ec477519f8c91c24fc2ab82d4b9c4'
  OR pg_catalog.has_function_privilege('anon','public.flow_finish_outbox_delivery(uuid,uuid,text,text)','EXECUTE')
  OR pg_catalog.has_function_privilege('authenticated','public.flow_finish_outbox_delivery(uuid,uuid,text,text)','EXECUTE')
  OR NOT pg_catalog.has_function_privilege('service_role','public.flow_finish_outbox_delivery(uuid,uuid,text,text)','EXECUTE') THEN
  RAISE EXCEPTION '20261115150000 rollback postcondition failed';
 END IF;
END
$post$;
COMMIT;
