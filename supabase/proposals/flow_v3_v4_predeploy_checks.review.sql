-- REVIEW ONLY: READ-ONLY pre-deployment checks for Flow V3/V4
-- (20261029125000_flow_durable_button_run, 20261029130000_flow_run_lifecycle,
-- 20261029140000_flow_outbox_ai_retry, and the 20261029150000 /
-- 20261029160000 / 20261029170000 / 20261029180000 / 20261029190000 /
-- 20261029210000 follow-ups; section (g):
-- 20261028227000_tenant_staff_memberships and
-- 20261028228000_flow_internal_actions).
-- NOT a migration.
-- Changes nothing.
--
-- Run ONLY with psql (uses \gset / \if, psql 10+), as the table owner
-- (postgres) or a role with SELECT and BYPASSRLS: the flow tables use
-- row-level security, and a filtered role would see empty tables. Sections
-- (a)-(c) detect that (row_security_active) and print a MISSING row instead
-- of false zero counts. Prefer a read replica or a read-only session on top
-- of the READ ONLY transaction below:
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql -X -v ON_ERROR_STOP=1 -f supabase/proposals/flow_v3_v4_predeploy_checks.review.sql "<conn>"
--
-- Guarantees:
--  * One READ ONLY transaction ended by ROLLBACK; bounded statement/lock
--    timeouts so it never queues behind (or in front of) a migration lock.
--  * Only SELECT / SET LOCAL / psql \gset \if \echo. No dynamic SQL.
--  * Output is ids, counts, ages and catalog metadata only: never message
--    text, payload contents, customer names/phones or stored AI answers.
--  * Works BEFORE and AFTER the migrations: it never names a column the
--    migrations add in a query; such columns are read through to_jsonb(row)
--    (like flow_conversation_human_takeover) or looked up in pg_catalog.
--    Missing objects produce a 'MISSING: <object>' row instead of an error.
--
-- Every result row has the same columns:
--   section | item | status | tenant_id | n | ids | detail
-- status: OK | FOUND (data needing attention) | WARN | INFO |
--         MISSING: <object> (prerequisite / optional column not present) |
--         ABSENT (object a migration creates; normal before deploy) |
--         CONFLICT: <object> (exists without the migration ownership marker,
--         or a function body that is not the version the installed
--         migrations imply)
--
-- Blocking results (do not apply / do not continue the rollout):
--   any CONFLICT row; any MISSING row in (d) except the optional flag
--   columns explicitly accepted for the target environment; a WARN on
--   column:public.conversations.human_agent_until; FOUND in (a) until the
--   legacy charge_pending rows are resolved. FOUND in (b)/(c) is handled by
--   the cleanup functions after 20261029130000 (see each section). Before
--   FLOW_DURABLE_INGRESS_ENABLED=true: (f) unique_index must be OK.
--   (g): any CONFLICT or MISSING row is blocking; ABSENT/INFO only means
--   20261028227000 / 20261028228000 are not applied (separate GO).
--
-- OPERATOR RULE (20261029150000 hazard; enforced only by these checks):
--   Never re-apply 20261029130000_flow_run_lifecycle after
--   20261029150000_flow_takeover_resume. 150000 replaces
--   flow_lease_due_runs and flow_conversation_human_takeover but keeps the
--   130000 ownership marker on them, so a re-applied 130000 passes its own
--   preflight and silently restores the 130000 bodies (paused runs are ended
--   'ineligible' again; the takeover expiry column is ignored). Section (d)
--   detects this by body hash (function_version:* = CONFLICT). Recovery:
--   re-apply 20261029150000 (idempotent) and re-run these checks.
--   Lock/statement timeouts: 20261029125000 .. 20261029210000 (including
--   130000/140000, since audit B3) and their rollbacks set SET LOCAL
--   lock_timeout='3s' and statement_timeout='60s' right after BEGIN, so no
--   PGOPTIONS is needed for them. PGOPTIONS='-c lock_timeout=3s -c
--   statement_timeout=60s' is still required only for 20261028227000 /
--   20261028228000 and their rollbacks, which set no timeout themselves
--   (see (g) lock_impact:public.conversations).
--   With 20261029160000_flow_credits_pause installed, a re-applied 150000 is
--   refused by its own preflight (the pause probe carries the 160000 marker):
--   recover with the 160000 rollback, then 150000, then 160000 again.
--   credits_pause = ABSENT means 160000 is not applied: sleeping runs of
--   tenants without credit are still leased and their messages expire.
--   20261029170000_flow_canary_claim_durable (production canary claim):
--   canary_claim_function / canary_table:* = ABSENT means not applied (the
--   production canary always falls back to V2). Before enabling the canary
--   run these checks with -c flow.canary_tenant=<uuid> -c
--   flow.canary_account=<uuid> in PGOPTIONS: canary_registration must be OK.
--   claim_v2_unchanged must be OK (V2's flow_claim_inbound is never changed).
--   20261029125000_flow_durable_button_run (V3 durable start/button RPCs):
--   durable_button_run:* = ABSENT means neither the migration nor the older
--   proposal installed them; durable_ingress_for_20261029170000 must be OK
--   before 20261029170000. OK with installed_by=proposal is expected where the
--   proposal was applied earlier (the migration is then a no-op).
--   20261029180000_flow_durable_button_run_guards (applied after 170000)
--   replaces both bodies: durable_button_run:* then shows
--   body_version=20261029180000. preflight:20261029180000 must be OK before
--   applying it, durable_button_run_guards must be OK after.
--   20261029190000_flow_begin_durable_run_superseding (applied after
--   180000, BEFORE deploying the milan-api build that calls it) adds the
--   atomic supersede + start RPC (audit B4). preflight:20261029190000 must be
--   OK before applying it; superseding_begin:* must be OK after (ABSENT = not
--   applied). Rollback order (revert milan-api first): 190000, 180000,
--   170000, 160000, 150000, 140000, 130000, 125000.
--   20261029210000_flow_media_effects (newest flow migration; applied after
--   190000; 20261029200000 flow-media storage is independent) lets the
--   database store, reserve and finish 'message_image' effects (outcome
--   rejected = dead_letter). preflight:20261029210000 must be OK before
--   applying it; media_effects must be OK after (ABSENT = not applied).
--   Keep FLOW_MEDIA_SEND_ENABLED off until the operator GO. Its rollback runs
--   FIRST: 210000, then 190000 .. 125000 (each refuses while a 210000 body is
--   installed).
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
\set ON_ERROR_STOP on

-- Gate flags for the data sections (a)-(c). Catalog lookups only.
SELECT
 coalesce(to_regclass('public.automation_flow_outbox') IS NOT NULL
  AND has_table_privilege(to_regclass('public.automation_flow_outbox'),'SELECT')
  AND (SELECT count(*) FROM pg_catalog.pg_attribute a
       WHERE a.attrelid=to_regclass('public.automation_flow_outbox')
        AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname IN('tenant_id','id','effect_kind','payload','delivery_status','created_at'))=6,
  false)
  AND NOT coalesce(row_security_active(to_regclass('public.automation_flow_outbox')),false) AS pdc_outbox_ok,
 coalesce(to_regclass('public.automation_flow_runs') IS NOT NULL
  AND has_table_privilege(to_regclass('public.automation_flow_runs'),'SELECT')
  AND (SELECT count(*) FROM pg_catalog.pg_attribute a
       WHERE a.attrelid=to_regclass('public.automation_flow_runs')
        AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname IN('tenant_id','id','conversation_id','run_status','updated_at'))=5,
  false)
  AND NOT coalesce(row_security_active(to_regclass('public.automation_flow_runs')),false) AS pdc_runs_ok,
 coalesce((SELECT bool_and(to_regclass('public.'||t) IS NOT NULL
   AND has_table_privilege(to_regclass('public.'||t),'SELECT')
   AND NOT coalesce(row_security_active(to_regclass('public.'||t)),false))
  FROM unnest(ARRAY['automation_flow_canary_accounts','automation_flow_tenant_switches',
   'automation_flow_global_switch','automation_flow_activations','channel_accounts']) t),false) AS pdc_canary_ok,
 coalesce(to_regclass('public.messages') IS NOT NULL
  AND has_table_privilege(to_regclass('public.messages'),'SELECT')
  AND (SELECT count(*) FROM pg_catalog.pg_attribute a
       WHERE a.attrelid=to_regclass('public.messages')
        AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname IN('tenant_id','wa_message_id'))=2,
  false)
  AND NOT coalesce(row_security_active(to_regclass('public.messages')),false) AS pdc_messages_ok
\gset

-- ===========================================================================
-- (a) Legacy charge_pending knowledge_ai effects. Before 20261029140000 no
-- answer is stored on the effect; the new worker recovers charge_pending
-- knowledge_ai rows ONLY from the stored encrypted answer, so these rows
-- would report billing_pending forever. Resolve them before deploying.
-- ===========================================================================
\echo '== (a) legacy charge_pending knowledge_ai outbox effects'
\if :pdc_outbox_ok
WITH c AS (
 SELECT o.tenant_id,o.id,o.created_at,
  coalesce(jsonb_typeof(to_jsonb(o)->'ai_answer_encrypted')='string',false) AS has_answer
 FROM public.automation_flow_outbox o
 WHERE o.delivery_status='charge_pending' AND o.payload->>'source'='knowledge_ai'
), s AS (SELECT * FROM c WHERE NOT has_answer),
per AS (
 SELECT s.tenant_id,count(*) AS n,(array_agg(s.id ORDER BY s.created_at,s.id))[1:50] AS ids,
  min(s.created_at) AS oldest
 FROM s GROUP BY s.tenant_id
)
SELECT section,item,status,tenant_id,n,ids,detail FROM (
 SELECT 0 AS ord,'a_legacy_charge_pending'::text AS section,'summary'::text AS item,
  CASE WHEN (SELECT count(*) FROM s)=0 THEN 'OK' ELSE 'FOUND' END AS status,
  NULL::uuid AS tenant_id,(SELECT count(*) FROM s) AS n,NULL::text AS ids,
  format('charge_pending knowledge_ai rows without a stored answer=%s tenants=%s; with stored answer (recoverable)=%s',
   (SELECT count(*) FROM s),(SELECT count(*) FROM per),(SELECT count(*) FROM c WHERE has_answer)) AS detail
 UNION ALL
 SELECT 1,'a_legacy_charge_pending','tenant','FOUND',per.tenant_id,per.n,array_to_string(per.ids,','),
  format('outbox ids (oldest first, max 50 shown); oldest_age_minutes=%s',
   floor(extract(epoch FROM now()-per.oldest)/60)::bigint)
 FROM per
) x ORDER BY ord,n DESC,tenant_id;
\else
SELECT 'a_legacy_charge_pending' AS section,'prerequisite' AS item,m.status,NULL::uuid AS tenant_id,
 NULL::bigint AS n,NULL::text AS ids,'section skipped' AS detail
FROM (
 SELECT 'MISSING: public.automation_flow_outbox' AS status
 WHERE to_regclass('public.automation_flow_outbox') IS NULL
 UNION ALL
 SELECT 'MISSING: read privilege on public.automation_flow_outbox'
 WHERE to_regclass('public.automation_flow_outbox') IS NOT NULL
  AND NOT has_table_privilege(to_regclass('public.automation_flow_outbox'),'SELECT')
 UNION ALL
 SELECT 'MISSING: RLS bypass on public.automation_flow_outbox'
 WHERE coalesce(row_security_active(to_regclass('public.automation_flow_outbox')),false)
 UNION ALL
 SELECT 'MISSING: public.automation_flow_outbox.'||col
 FROM unnest(ARRAY['tenant_id','id','effect_kind','payload','delivery_status','created_at']) col
 WHERE to_regclass('public.automation_flow_outbox') IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
   WHERE a.attrelid=to_regclass('public.automation_flow_outbox')
    AND a.attname=col AND a.attnum>0 AND NOT a.attisdropped)
) m;
\endif

-- ===========================================================================
-- (b) Duplicate active durable runs per (tenant_id, conversation_id).
-- Active statuses in this repo: ready, awaiting_input, sleeping (there is no
-- 'running' status; the run_status CHECK allows ready, awaiting_input,
-- sleeping, handoff, completed, blocked).
-- ===========================================================================
\echo '== (b) duplicate active durable runs'
\if :pdc_runs_ok
WITH g AS (
 SELECT r.tenant_id,r.conversation_id,count(*) AS n,
  array_agg(r.id ORDER BY r.updated_at DESC,r.id DESC) AS ids,
  string_agg(r.run_status,',' ORDER BY r.updated_at DESC,r.id DESC) AS statuses
 FROM public.automation_flow_runs r
 WHERE r.run_status IN('ready','awaiting_input','sleeping')
 GROUP BY r.tenant_id,r.conversation_id
 HAVING count(*)>1
), top AS (SELECT * FROM g ORDER BY n DESC,tenant_id,conversation_id LIMIT 200)
SELECT section,item,status,tenant_id,n,ids,detail FROM (
 SELECT 0 AS ord,'b_duplicate_active_runs'::text AS section,'summary'::text AS item,
  CASE WHEN (SELECT count(*) FROM g)=0 THEN 'OK' ELSE 'FOUND' END AS status,
  NULL::uuid AS tenant_id,(SELECT count(*) FROM g) AS n,NULL::text AS ids,
  format('duplicate groups=%s surplus runs=%s; unique index flow_one_active_run_per_conversation %s. '
   'While duplicates exist 20261029130000 skips that index (notice; the guard still blocks new duplicates). '
   'public.flow_resolve_duplicate_active_runs(limit) keeps the FIRST id of each group (latest updated_at) '
   'and ends the others as blocked/duplicate_active; a follow-up is then needed to build the index.',
   (SELECT count(*) FROM g),coalesce((SELECT sum(n-1) FROM g),0),
   CASE WHEN to_regclass('public.flow_one_active_run_per_conversation') IS NULL
    THEN 'absent' ELSE 'present' END) AS detail
 UNION ALL
 SELECT 1,'b_duplicate_active_runs','group','FOUND',top.tenant_id,top.n,
  array_to_string(top.ids[1:20],','),
  format('conversation_id=%s statuses=%s (run ids newest first, max 20 shown; max 200 groups)',
   top.conversation_id,top.statuses)
 FROM top
) x ORDER BY ord,n DESC,tenant_id,detail;
\else
SELECT 'b_duplicate_active_runs' AS section,'prerequisite' AS item,m.status,NULL::uuid AS tenant_id,
 NULL::bigint AS n,NULL::text AS ids,'section skipped' AS detail
FROM (
 SELECT 'MISSING: public.automation_flow_runs' AS status
 WHERE to_regclass('public.automation_flow_runs') IS NULL
 UNION ALL
 SELECT 'MISSING: read privilege on public.automation_flow_runs'
 WHERE to_regclass('public.automation_flow_runs') IS NOT NULL
  AND NOT has_table_privilege(to_regclass('public.automation_flow_runs'),'SELECT')
 UNION ALL
 SELECT 'MISSING: RLS bypass on public.automation_flow_runs'
 WHERE coalesce(row_security_active(to_regclass('public.automation_flow_runs')),false)
 UNION ALL
 SELECT 'MISSING: public.automation_flow_runs.'||col
 FROM unnest(ARRAY['tenant_id','id','conversation_id','run_status','updated_at']) col
 WHERE to_regclass('public.automation_flow_runs') IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
   WHERE a.attrelid=to_regclass('public.automation_flow_runs')
    AND a.attname=col AND a.attnum>0 AND NOT a.attisdropped)
) m;
\endif

-- ===========================================================================
-- (c) Customer-visible effects (message/question) still pending/retry_wait
-- and older than 60 minutes: flow_skip_blocked_outbox(60, ...) cancels them
-- as 'stale' on its first tick (earlier reasons such as an ended run,
-- inactive revision or human takeover take precedence). Counts only.
-- ===========================================================================
\echo '== (c) pending/retry_wait message effects older than 60 minutes'
\if :pdc_outbox_ok
WITH m AS (
 SELECT o.tenant_id,o.delivery_status,now()-o.created_at AS age
 FROM public.automation_flow_outbox o
 WHERE o.delivery_status IN('pending','retry_wait') AND o.effect_kind IN('message','question')
), old AS (SELECT * FROM m WHERE age>interval '60 minutes'),
per AS (
 SELECT old.tenant_id,old.delivery_status,count(*) AS n,
  count(*) FILTER(WHERE age<=interval '6 hours') AS b1,
  count(*) FILTER(WHERE age>interval '6 hours' AND age<=interval '24 hours') AS b2,
  count(*) FILTER(WHERE age>interval '24 hours' AND age<=interval '7 days') AS b3,
  count(*) FILTER(WHERE age>interval '7 days') AS b4
 FROM old GROUP BY old.tenant_id,old.delivery_status
)
SELECT section,item,status,tenant_id,n,ids,detail FROM (
 SELECT 0 AS ord,'c_stale_messages'::text AS section,'summary'::text AS item,
  CASE WHEN (SELECT count(*) FROM old)=0 THEN 'OK' ELSE 'FOUND' END AS status,
  NULL::uuid AS tenant_id,(SELECT count(*) FROM old) AS n,NULL::text AS ids,
  format('older_than_60m=%s (pending=%s retry_wait=%s) tenants=%s; fresh_within_60m=%s (not swept as stale)',
   (SELECT count(*) FROM old),
   (SELECT count(*) FROM old WHERE delivery_status='pending'),
   (SELECT count(*) FROM old WHERE delivery_status='retry_wait'),
   (SELECT count(DISTINCT tenant_id) FROM old),
   (SELECT count(*) FROM m WHERE age<=interval '60 minutes')) AS detail
 UNION ALL
 SELECT 1,'c_stale_messages','tenant_status:'||per.delivery_status,'FOUND',per.tenant_id,per.n,NULL,
  format('age 60m-6h=%s 6h-24h=%s 1d-7d=%s over_7d=%s',per.b1,per.b2,per.b3,per.b4)
 FROM per
) x ORDER BY ord,item,n DESC,tenant_id;
\else
SELECT 'c_stale_messages' AS section,'prerequisite' AS item,m.status,NULL::uuid AS tenant_id,
 NULL::bigint AS n,NULL::text AS ids,'section skipped' AS detail
FROM (
 SELECT 'MISSING: public.automation_flow_outbox' AS status
 WHERE to_regclass('public.automation_flow_outbox') IS NULL
 UNION ALL
 SELECT 'MISSING: read privilege on public.automation_flow_outbox'
 WHERE to_regclass('public.automation_flow_outbox') IS NOT NULL
  AND NOT has_table_privilege(to_regclass('public.automation_flow_outbox'),'SELECT')
 UNION ALL
 SELECT 'MISSING: RLS bypass on public.automation_flow_outbox'
 WHERE coalesce(row_security_active(to_regclass('public.automation_flow_outbox')),false)
 UNION ALL
 SELECT 'MISSING: public.automation_flow_outbox.'||col
 FROM unnest(ARRAY['tenant_id','id','effect_kind','payload','delivery_status','created_at']) col
 WHERE to_regclass('public.automation_flow_outbox') IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
   WHERE a.attrelid=to_regclass('public.automation_flow_outbox')
    AND a.attname=col AND a.attnum>0 AND NOT a.attisdropped)
) m;
\endif

-- ===========================================================================
-- (d) Prerequisites / environment (catalog only; never errors on absence).
-- Mirrors the 20261029130000, 20261029140000 and 20261029150000 preflight
-- blocks (credits_pause: the 20261029160000 pause probe), plus the objects the lifecycle functions read at runtime and the
-- columns the flow-runtime-worker / flow-outbox-worker PostgREST selects
-- name (a missing selected column fails every worker request). The
-- function_version rows compare md5(prosrc) of the two functions 150000
-- replaces with the exact 130000 / 150000 bodies (see OPERATOR RULE above).
-- ===========================================================================
\echo '== (d) prerequisites and environment'
WITH
tbl(name,why) AS (VALUES
 ('automation_flow_runs','130000 preflight'),('automation_flow_outbox','130000+140000 preflight'),
 ('automation_flow_run_leases','130000 preflight'),('automation_flow_activations','130000 preflight'),
 ('automation_flow_global_switch','130000 preflight'),('automation_flow_tenant_switches','130000 preflight'),
 ('tenants','130000 preflight'),('channel_accounts','130000 preflight'),('conversations','130000 preflight')),
col(tbl,name,kind,why) AS (VALUES
 ('automation_flow_runs','tenant_id','req','130000 preflight'),('automation_flow_runs','id','req','130000 preflight'),
 ('automation_flow_runs','conversation_id','req','130000 preflight'),('automation_flow_runs','channel_account_id','req','130000 preflight'),
 ('automation_flow_runs','platform','req','130000 preflight'),('automation_flow_runs','flow_key','req','130000 preflight'),
 ('automation_flow_runs','publication_revision','req','130000 preflight'),('automation_flow_runs','run_status','req','130000 preflight'),
 ('automation_flow_runs','wake_at','req','130000 preflight'),('automation_flow_runs','updated_at','req','130000 preflight'),
 ('automation_flow_outbox','tenant_id','req','130000+140000 preflight'),('automation_flow_outbox','id','req','130000+140000 preflight'),
 ('automation_flow_outbox','run_id','req','130000 preflight'),('automation_flow_outbox','effect_kind','req','130000+140000 preflight'),
 ('automation_flow_outbox','delivery_status','req','130000+140000 preflight'),('automation_flow_outbox','created_at','req','130000 preflight'),
 ('automation_flow_outbox','payload','req','worker source=knowledge_ai'),
 ('automation_flow_outbox','retry_at','new140','140000 adds if absent (installed shape has it)'),
 ('automation_flow_outbox','cancel_reason','new130','added by 130000; required by 140000 preflight'),
 ('automation_flow_outbox','cancelled_at','new130','added by 130000; required by 140000 preflight'),
 ('automation_flow_runs','ended_reason','new130','added by 130000'),('automation_flow_runs','ended_at','new130','added by 130000'),
 ('automation_flow_run_leases','attempts','new130','added by 130000'),
 ('automation_flow_outbox','ai_attempts','new140','added by 140000'),('automation_flow_outbox','ai_last_error_code','new140','added by 140000'),
 ('automation_flow_outbox','ai_lease_token','new140','added by 140000'),('automation_flow_outbox','ai_lease_expires_at','new140','added by 140000'),
 ('automation_flow_outbox','ai_answer_encrypted','new140','added by 140000'),
 ('automation_flow_run_leases','tenant_id','req','lease functions'),('automation_flow_run_leases','run_id','req','lease functions'),
 ('automation_flow_run_leases','token','req','lease functions'),('automation_flow_run_leases','expires_at','req','lease functions'),
 ('automation_flow_activations','tenant_id','req','lifecycle functions'),('automation_flow_activations','channel_account_id','req','lifecycle functions'),
 ('automation_flow_activations','platform','req','lifecycle functions'),('automation_flow_activations','flow_key','req','lifecycle functions'),
 ('automation_flow_activations','revision','req','lifecycle functions'),('automation_flow_activations','is_active','req','lifecycle functions'),
 ('automation_flow_global_switch','singleton','req','flow_lease_due_runs'),('automation_flow_global_switch','enabled','req','flow_lease_due_runs'),
 ('automation_flow_tenant_switches','tenant_id','req','flow_lease_due_runs'),('automation_flow_tenant_switches','enabled','req','flow_lease_due_runs'),
 ('automation_flow_tenant_switches','test_only','req','flow_lease_due_runs'),
 ('automation_flow_tenant_switches','production_approved','req','flow_lease_due_runs, flow_begin_durable_run, flow_resume_button_run (runtime error if absent)'),
 ('conversations','tenant_id','req','lifecycle functions'),('conversations','id','req','lifecycle functions'),
 ('conversations','account_id','req','flow_lease_due_runs account match'),
 ('conversations','transferred','takeover','read via to_jsonb by flow_conversation_human_takeover; selected by flow-runtime-worker and flow-outbox-worker (PostgREST error if absent)'),
 ('conversations','human_agent_expires_at','takeover','canonical takeover expiry: read by the 150000 flow_conversation_human_takeover and milan-api; selected by both workers (PostgREST error if absent)'),
 ('conversations','auto_paused_reason','takeover','manual_takeover expiry rule of the 150000 helper and milan-api; selected by both workers (PostgREST error if absent)'),
 ('conversations','human_agent_until','forbidden','must not exist: no schema file creates it and only the superseded 130000 helper reads it (schema drift)'),
 ('conversations','wa_chat_id','worker','selected by flow-outbox-worker'),
 ('tenants','is_active','flag','absent = active for the SQL functions; selected by both workers (PostgREST error if absent); flow_begin_durable_run reads it directly (an invocation errors if absent)'),
 ('tenants','credits_remaining','worker','selected by flow-outbox-worker; read via to_jsonb by the 160000 flow_channel_temporarily_paused (no credit = paused)'),
 ('tenants','business_name','worker','selected by flow-outbox-worker'),
 ('channel_accounts','platform','worker','selected by both workers'),
 ('channel_accounts','is_active','flag','absent = enabled for the SQL functions; selected by both workers (PostgREST error if absent); flow_begin_durable_run reads it directly (an invocation errors if absent)'),
 ('channel_accounts','agent_enabled','flag','absent = enabled for the SQL functions; selected by both workers (PostgREST error if absent); flow_begin_durable_run reads it directly (an invocation errors if absent)'),
 ('channel_accounts','auto_reply','flag','absent = enabled for the SQL functions; selected by both workers (PostgREST error if absent); flow_begin_durable_run reads it directly (an invocation errors if absent)'),
 ('channel_accounts','external_id','worker','selected by flow-outbox-worker'),
 ('channel_accounts','access_token_encrypted','worker','selected by flow-outbox-worker')),
fn(sig,marker,kind) AS (VALUES
 ('flow_lease_due_runs(integer)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','replaced'),
 ('flow_reserve_outbox_delivery(uuid,uuid)',NULL,'prereq'),
 ('flow_conversation_human_takeover(uuid,uuid)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','new'),
 ('flow_cancel_run(uuid,uuid,text,text)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','new'),
 ('flow_expire_waiting_runs(integer,integer)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','new'),
 ('flow_skip_outbox_effect(uuid,uuid,text)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','new'),
 ('flow_skip_blocked_outbox(integer,integer)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','new'),
 ('flow_resolve_duplicate_active_runs(integer)','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','new'),
 ('flow_guard_one_active_run()','CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE','new'),
 ('flow_claim_outbox_ai(uuid,uuid,integer,integer)','CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY','new'),
 ('flow_store_outbox_ai_answer(uuid,uuid,uuid,text)','CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY','new'),
 ('flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer)','CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY','new'),
 ('flow_channel_temporarily_paused(uuid,uuid)','CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME','new'),
 ('flow_end_stale_paused_runs(integer,integer)','CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME','new'),
 ('flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)','CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE','new')),
-- Exact bodies (md5 of pg_proc.prosrc) of the two functions 150000 replaces.
ver AS (
 SELECT f.sig,f.h130,f.h150,to_regprocedure('public.'||f.sig) AS oid,
  obj_description(to_regprocedure('public.'||f.sig),'pg_proc') AS marker,
  (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.'||f.sig)) AS h
 FROM (VALUES
  ('flow_lease_due_runs(integer)','ed6961df33f69d10c74e891159e5a87c','21fdd410db21235835b7cc6906a50e70'),
  ('flow_conversation_human_takeover(uuid,uuid)','307b5158632719c52feaa5b85c61061b','672f8fc3daa1225af8a88f3102f9d29b')
 ) f(sig,h130,h150)
),
vv AS (
 SELECT ver.sig,ver.h,
  CASE WHEN ver.oid IS NULL THEN 'absent'
   WHEN ver.marker='CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE' THEN '20261028225000'
   WHEN ver.marker IS DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE' THEN 'unrecognized'
   WHEN ver.h=ver.h150 THEN '20261029150000'
   WHEN ver.h=ver.h130 THEN '20261029130000'
   ELSE 'unrecognized' END AS v
 FROM ver
),
s150 AS (
 SELECT count(*) FILTER(WHERE to_regprocedure(x) IS NOT NULL) AS n
 FROM unnest(ARRAY['public.flow_channel_temporarily_paused(uuid,uuid)',
  'public.flow_end_stale_paused_runs(integer,integer)']) x
),
have AS (
 SELECT c.relname AS tbl,a.attname AS name
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
 WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') AND a.attnum>0 AND NOT a.attisdropped
),
-- 20261029150000 preflight, requirement by requirement (unmet ones listed).
pf150 AS (
 SELECT r.label FROM (VALUES
  ('130000 marker on flow_lease_due_runs(integer)',obj_description(to_regprocedure('public.flow_lease_due_runs(integer)'),'pg_proc')
    IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'),
  ('130000 marker on flow_conversation_human_takeover(uuid,uuid)',obj_description(to_regprocedure('public.flow_conversation_human_takeover(uuid,uuid)'),'pg_proc')
    IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'),
  ('130000 marker on flow_cancel_run(uuid,uuid,text,text)',obj_description(to_regprocedure('public.flow_cancel_run(uuid,uuid,text,text)'),'pg_proc')
    IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'),
  ('130000 marker on flow_skip_blocked_outbox(integer,integer)',obj_description(to_regprocedure('public.flow_skip_blocked_outbox(integer,integer)'),'pg_proc')
    IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'),
  ('column automation_flow_runs.ended_reason',EXISTS(SELECT 1 FROM have WHERE tbl='automation_flow_runs' AND name='ended_reason')),
  ('column automation_flow_runs.ended_at',EXISTS(SELECT 1 FROM have WHERE tbl='automation_flow_runs' AND name='ended_at')),
  ('column automation_flow_run_leases.attempts',EXISTS(SELECT 1 FROM have WHERE tbl='automation_flow_run_leases' AND name='attempts')),
  ('automation_flow_runs_ended_reason_chk allowing stale and human_takeover',EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid=to_regclass('public.automation_flow_runs') AND c.conname='automation_flow_runs_ended_reason_chk'
     AND position('''stale''' IN pg_get_constraintdef(c.oid))>0 AND position('''human_takeover''' IN pg_get_constraintdef(c.oid))>0)),
  ('140000 marker on flow_claim_outbox_ai(uuid,uuid,integer,integer)',obj_description(to_regprocedure('public.flow_claim_outbox_ai(uuid,uuid,integer,integer)'),'pg_proc')
    IS NOT DISTINCT FROM 'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY'),
  ('140000 marker on flow_store_outbox_ai_answer(uuid,uuid,uuid,text)',obj_description(to_regprocedure('public.flow_store_outbox_ai_answer(uuid,uuid,uuid,text)'),'pg_proc')
    IS NOT DISTINCT FROM 'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY'),
  ('140000 marker on flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer)',obj_description(to_regprocedure('public.flow_finish_outbox_ai(uuid,uuid,uuid,text,text,integer,integer)'),'pg_proc')
    IS NOT DISTINCT FROM 'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY'),
  ('column automation_flow_outbox.ai_attempts',EXISTS(SELECT 1 FROM have WHERE tbl='automation_flow_outbox' AND name='ai_attempts')),
  ('150000 functions absent or carrying the 150000 marker',NOT EXISTS(SELECT 1 FROM unnest(ARRAY[
    'public.flow_channel_temporarily_paused(uuid,uuid)','public.flow_end_stale_paused_runs(integer,integer)']) x
    WHERE to_regprocedure(x) IS NOT NULL
     AND obj_description(to_regprocedure(x),'pg_proc') IS DISTINCT FROM 'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME'))
 ) r(label,ok) WHERE NOT r.ok
),
-- 20261029160000 pause probe (credit check): marker and exact body.
cpm AS (
 SELECT obj_description(to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)'),'pg_proc') AS marker,
  (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)')) AS h
),
idx(name) AS (VALUES ('flow_one_active_run_per_conversation'),('automation_flow_runs_waiting_idx')),
named_chk(tbl,name,why) AS (VALUES
 ('automation_flow_outbox','automation_flow_outbox_cancel_reason_chk','added by 130000; replaced by 140000 with a superset'),
 ('automation_flow_runs','automation_flow_runs_ended_reason_chk','added by 130000'),
 ('automation_flow_outbox','automation_flow_outbox_ai_state_chk','added by 140000')),
status_chk AS (
 SELECT c.conrelid::regclass::text AS tbl,c.conname,pg_get_constraintdef(c.oid) AS def
 FROM pg_catalog.pg_constraint c
 WHERE c.contype='c' AND (
  (c.conrelid=to_regclass('public.automation_flow_outbox') AND pg_get_constraintdef(c.oid) LIKE '%delivery_status%')
  OR (c.conrelid=to_regclass('public.automation_flow_runs') AND pg_get_constraintdef(c.oid) LIKE '%run_status%'))
)
SELECT section,item,status,tenant_id,n,ids,detail FROM (
 SELECT 0 AS ord,'d_prerequisites'::text AS section,'environment'::text AS item,
  CASE WHEN current_setting('server_version_num')::int>=140000 THEN 'OK'
   ELSE 'MISSING: PostgreSQL 14+ (130000 uses or-replace trigger syntax)' END AS status,
  NULL::uuid AS tenant_id,NULL::bigint AS n,NULL::text AS ids,
  format('server_version=%s current_user=%s transaction_read_only=%s',
   current_setting('server_version'),current_user,current_setting('transaction_read_only')) AS detail
 UNION ALL
 SELECT 1,'d_prerequisites','table:public.'||tbl.name,
  CASE WHEN to_regclass('public.'||tbl.name) IS NULL THEN 'MISSING: public.'||tbl.name ELSE 'OK' END,
  NULL,NULL,NULL,tbl.why
 FROM tbl
 UNION ALL
 SELECT 2,'d_prerequisites','column:public.'||col.tbl||'.'||col.name,
  CASE
   WHEN col.kind='forbidden' THEN CASE WHEN a.attname IS NULL THEN 'OK' ELSE 'WARN' END
   WHEN a.attname IS NOT NULL THEN 'OK'
   WHEN col.kind IN('new130','new140') THEN 'ABSENT'
   ELSE 'MISSING: public.'||col.tbl||'.'||col.name END,
  NULL,NULL,NULL,
  CASE WHEN col.kind='forbidden' AND a.attname IS NULL THEN 'not present (expected); '||col.why
   WHEN a.attname IS NOT NULL THEN format('type=%s; %s',format_type(a.atttypid,a.atttypmod),col.why)
   ELSE col.why END
 FROM col
 LEFT JOIN pg_catalog.pg_attribute a
  ON a.attrelid=to_regclass('public.'||col.tbl) AND a.attname=col.name AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL
 SELECT 3,'d_prerequisites','takeover_coverage',
  CASE
   WHEN NOT EXISTS(SELECT 1 FROM have WHERE tbl='conversations' AND name='human_agent_expires_at')
     OR NOT EXISTS(SELECT 1 FROM have WHERE tbl='conversations' AND name='auto_paused_reason')
     OR NOT EXISTS(SELECT 1 FROM have WHERE tbl='conversations' AND name='transferred')
    THEN 'MISSING: canonical takeover columns on public.conversations'
   WHEN tk.v='20261029150000' THEN 'OK'
   WHEN tk.v='20261029130000' THEN 'WARN'
   ELSE 'INFO' END,
  NULL,NULL,NULL,
  format('installed helper version=%s. The 150000 helper follows milan-api (transferred, '
   'human_agent_expires_at, auto_paused_reason=manual_takeover expiry); the 130000 helper ignores '
   'the expiry, so an expired manual takeover still ends runs as human_takeover until 150000 is applied',tk.v)
 FROM vv tk WHERE tk.sig='flow_conversation_human_takeover(uuid,uuid)'
 UNION ALL
 SELECT 10,'d_prerequisites','function_version:public.'||vv.sig,
  CASE
   WHEN vv.v='absent' AND vv.sig='flow_lease_due_runs(integer)' THEN 'MISSING: public.'||vv.sig
   WHEN vv.v='absent' AND s150.n=0 THEN 'ABSENT'
   WHEN s150.n>0 AND vv.v<>'20261029150000' THEN 'CONFLICT: public.'||vv.sig||' body'
   WHEN s150.n=0 AND vv.v='20261029150000' THEN 'CONFLICT: public.'||vv.sig||' body'
   WHEN vv.v='unrecognized' THEN 'CONFLICT: public.'||vv.sig||' body'
   ELSE 'OK' END,
  NULL,s150.n,NULL,
  format('installed_version=%s body_md5=%s; 150000 helper functions present=%s/2%s',vv.v,coalesce(vv.h,'-'),s150.n,
   CASE
    WHEN s150.n>0 AND vv.v<>'20261029150000' THEN '; body is not the 20261029150000 version while 150000 objects exist: '
     '20261029130000 was most likely re-applied after 20261029150000 (same ownership marker, so its preflight passes). '
     'Re-apply 20261029150000 (idempotent) to restore it; never re-apply 20261029130000 after 20261029150000'
    WHEN s150.n=0 AND vv.v='20261029150000' THEN '; 20261029150000 body without its helper functions (partial rollback?): '
     'run the 20261029150000 rollback or re-apply 20261029150000'
    WHEN vv.v='unrecognized' THEN '; body or marker matches no known migration version'
    ELSE '' END)
 FROM vv CROSS JOIN s150
 UNION ALL
 SELECT 11,'d_prerequisites','preflight:20261029150000',
  CASE WHEN (SELECT count(*) FROM pf150)=0 THEN 'OK'
   WHEN cpm.marker IS NOT DISTINCT FROM 'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE'
    AND NOT EXISTS(SELECT 1 FROM pf150 WHERE label NOT LIKE '150000 functions %')
    THEN 'INFO'
   WHEN NOT EXISTS(SELECT 1 FROM pf150 WHERE label LIKE '130000 %' OR label LIKE '140000 %' OR label LIKE 'column %'
     OR label LIKE 'automation_flow_runs_ended%')
    THEN 'CONFLICT: 20261029150000 objects'
   WHEN obj_description(to_regprocedure('public.flow_lease_due_runs(integer)'),'pg_proc')
     IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'
    AND to_regprocedure('public.flow_claim_outbox_ai(uuid,uuid,integer,integer)') IS NOT NULL
    THEN 'MISSING: '||(SELECT min(label) FROM pf150)
   ELSE 'INFO' END,
  NULL,(SELECT count(*) FROM pf150),NULL,
  CASE WHEN (SELECT count(*) FROM pf150)=0 THEN 'all 20261029150000 preflight requirements satisfied'
   WHEN cpm.marker IS NOT DISTINCT FROM 'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE'
    AND NOT EXISTS(SELECT 1 FROM pf150 WHERE label NOT LIKE '150000 functions %')
    THEN 'superseded: 20261029160000 is installed, so a re-applied 20261029150000 is refused by its preflight '
     '(expected); run the 20261029160000 rollback first if 20261029150000 must be re-applied'
   ELSE 'unmet (normal until 20261029130000 and 20261029140000 are applied): '
    ||(SELECT string_agg(label,'; ' ORDER BY label) FROM pf150) END
 FROM cpm
 UNION ALL
 SELECT 12,'d_prerequisites','credits_pause',
  CASE
   WHEN cpm.marker IS NULL OR cpm.marker='CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME' THEN 'ABSENT'
   WHEN cpm.marker<>'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE'
    THEN 'CONFLICT: public.flow_channel_temporarily_paused(uuid,uuid)'
   WHEN cpm.h IS DISTINCT FROM '9cf2e5d1568032d181bf3a0afbafb627'
    THEN 'CONFLICT: public.flow_channel_temporarily_paused(uuid,uuid) body'
   WHEN NOT EXISTS(SELECT 1 FROM have WHERE tbl='tenants' AND name='credits_remaining')
    THEN 'MISSING: public.tenants.credits_remaining'
   ELSE 'OK' END,
  NULL,NULL,NULL,
  format('pause probe marker=%s body_md5=%s; %s',coalesce(cpm.marker,'-'),coalesce(cpm.h,'-'),
   CASE WHEN cpm.marker IS NOT DISTINCT FROM 'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE'
    THEN '20261029160000 installed: sleeping runs of tenants without credit stay sleeping (not leased) '
     'until credits are positive; the 24h stale bound still applies'
    ELSE '20261029160000 not applied: sleeping runs of tenants with credits_remaining<=0 are leased and advanced, '
     'their messages stay pending at the send gate and are cancelled as stale after 60 minutes' END)
 FROM cpm
 UNION ALL
 SELECT 4,'d_prerequisites','constraint:automation_flow_run_leases_pkey',
  CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid=to_regclass('public.automation_flow_run_leases') AND c.conname='automation_flow_run_leases_pkey')
   THEN 'OK' ELSE 'MISSING: constraint automation_flow_run_leases_pkey' END,
  NULL,NULL,NULL,'named in ON CONFLICT by flow_lease_due_runs'
 UNION ALL
 SELECT 5,'d_prerequisites','status_check:'||s.tbl||'.'||s.conname,
  CASE
   WHEN s.tbl LIKE '%automation_flow_outbox' THEN
    CASE WHEN s.def LIKE '%''pending''%' AND s.def LIKE '%''retry_wait''%'
      AND s.def LIKE '%''dead_letter''%' AND s.def LIKE '%''cancelled''%' THEN 'OK'
     ELSE 'MISSING: pending/retry_wait/dead_letter/cancelled in outbox status check' END
   ELSE CASE WHEN s.def LIKE '%''blocked''%' THEN 'OK'
     ELSE 'MISSING: blocked in run status check' END
  END,
  NULL,NULL,NULL,'definition (not replaced by the migrations): '||s.def
 FROM status_chk s
 UNION ALL
 SELECT 5,'d_prerequisites','status_check:'||t.name,'MISSING: '||t.name||' status check',NULL,NULL,NULL,
  CASE WHEN t.name='automation_flow_outbox'
   THEN '140000 preflight requires a delivery_status check'
   ELSE 'no run_status check found (130000 preflight passes, but status vocabulary unverified)' END
 FROM (VALUES ('automation_flow_outbox','%automation_flow_outbox'),('automation_flow_runs','%automation_flow_runs')) t(name,pat)
 WHERE to_regclass('public.'||t.name) IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM status_chk s WHERE s.tbl LIKE t.pat)
 UNION ALL
 SELECT 6,'d_prerequisites','named_check:'||nc.name,
  CASE WHEN c.oid IS NULL THEN 'ABSENT' ELSE 'OK' END,NULL,NULL,NULL,
  CASE WHEN c.oid IS NULL THEN nc.why
   ELSE nc.why||'; current definition: '||pg_get_constraintdef(c.oid) END
 FROM named_chk nc
 LEFT JOIN pg_catalog.pg_constraint c
  ON c.conrelid=to_regclass('public.'||nc.tbl) AND c.conname=nc.name
 UNION ALL
 SELECT 7,'d_prerequisites','function:public.'||fn.sig,
  CASE
   WHEN to_regprocedure('public.'||fn.sig) IS NULL THEN
    CASE WHEN fn.kind='new' THEN 'ABSENT' ELSE 'MISSING: public.'||fn.sig END
   WHEN fn.kind='prereq' THEN 'OK'
   WHEN fn.sig='flow_channel_temporarily_paused(uuid,uuid)' AND obj_description(to_regprocedure('public.'||fn.sig),'pg_proc')
     IS NOT DISTINCT FROM 'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE' THEN 'OK'
   WHEN fn.kind='replaced' AND obj_description(to_regprocedure('public.'||fn.sig),'pg_proc')
     IN('CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE',fn.marker) THEN 'OK'
   WHEN obj_description(to_regprocedure('public.'||fn.sig),'pg_proc') IS NOT DISTINCT FROM fn.marker THEN 'OK'
   ELSE 'CONFLICT: public.'||fn.sig END,
  NULL,NULL,NULL,
  format('kind=%s marker=%s',fn.kind,
   coalesce(obj_description(to_regprocedure('public.'||fn.sig),'pg_proc'),'-'))
 FROM fn
 UNION ALL
 SELECT 8,'d_prerequisites','index:public.'||idx.name,
  CASE WHEN to_regclass('public.'||idx.name) IS NULL THEN 'ABSENT'
   WHEN obj_description(to_regclass('public.'||idx.name),'pg_class')
    IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE' THEN 'OK'
   ELSE 'CONFLICT: public.'||idx.name END,
  NULL,NULL,NULL,'built by 20261029130000'
 FROM idx
 UNION ALL
 SELECT 9,'d_prerequisites','trigger:flow_one_active_run_guard',
  CASE WHEN t.oid IS NULL THEN 'ABSENT'
   WHEN obj_description(t.oid,'pg_trigger') IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE' THEN 'OK'
   ELSE 'CONFLICT: trigger flow_one_active_run_guard' END,
  NULL,NULL,NULL,'row guard on automation_flow_runs added by 20261029130000'
 FROM (SELECT 1) one
 LEFT JOIN pg_catalog.pg_trigger t
  ON t.tgrelid=to_regclass('public.automation_flow_runs') AND t.tgname='flow_one_active_run_guard'
) x ORDER BY ord,item;

-- (d) 20261029170000_flow_canary_claim_durable objects (catalog only).
--  * claim_v2_unchanged: flow_claim_inbound (V2) still has the exact
--    20261028220000 body; 170000 never touches it.
--  * canary_claim_function: flow_claim_inbound_durable has the exact 170000
--    body, SECURITY INVOKER, search_path='' and no PUBLIC/anon/authenticated
--    privilege.
--  * canary_table:*: marker, RLS enabled, no policy, no PUBLIC/anon/
--    authenticated privilege; service_role may only SELECT the registration
--    table (only an operator session can register a canary) and SELECT/INSERT
--    the claim audit table.
WITH
v2 AS (
 SELECT obj_description(p.oid,'pg_proc') AS marker,md5(p.prosrc) AS h
 FROM (SELECT to_regprocedure('public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)') AS oid) f
 LEFT JOIN pg_catalog.pg_proc p ON p.oid=f.oid
),
cf AS (
 SELECT p.oid,obj_description(p.oid,'pg_proc') AS marker,md5(p.prosrc) AS h,p.prosecdef,
  coalesce(array_to_string(p.proconfig,','),'') AS cfg,
  p.proacl IS NULL OR EXISTS(SELECT 1 FROM unnest(p.proacl) e
   WHERE e::text LIKE '=%' OR e::text LIKE 'anon=%' OR e::text LIKE 'authenticated=%') AS exposed
 FROM (SELECT to_regprocedure('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)') AS oid) f
 LEFT JOIN pg_catalog.pg_proc p ON p.oid=f.oid
),
ct AS (
 SELECT w.name,w.svc,c.oid,obj_description(c.oid,'pg_class') AS marker,c.relrowsecurity,
  EXISTS(SELECT 1 FROM pg_catalog.pg_policy po WHERE po.polrelid=c.oid) AS has_policy,
  c.relacl IS NULL OR EXISTS(SELECT 1 FROM unnest(c.relacl) e
   WHERE e::text LIKE '=%' OR e::text LIKE 'anon=%' OR e::text LIKE 'authenticated=%') AS exposed,
  (SELECT string_agg(split_part(e::text,'/',1),',') FROM unnest(c.relacl) e
   WHERE e::text LIKE 'service_role=%') AS svc_acl
 FROM (VALUES ('automation_flow_canary_accounts','service_role=r'),
  ('automation_flow_canary_claims','service_role=ar')) w(name,svc)
 LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass('public.'||w.name)
)
SELECT section,item,status,tenant_id,n,ids,detail FROM (
 SELECT 0 AS ord,'d_prerequisites'::text AS section,
  'claim_v2_unchanged:public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)'::text AS item,
  CASE WHEN v2.h IS NULL THEN 'MISSING: public.flow_claim_inbound(uuid,uuid,text,text,uuid,uuid,boolean)'
   WHEN v2.marker IS NOT DISTINCT FROM 'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM'
    AND v2.h='3ca29d9bca4eb176079140a99909e3ed' THEN 'OK'
   ELSE 'WARN' END AS status,
  NULL::uuid AS tenant_id,NULL::bigint AS n,NULL::text AS ids,
  format('marker=%s body_md5=%s; V2 claim function must keep the exact 20261028220000 body (test_only tenants only route to flow)',
   coalesce(v2.marker,'-'),coalesce(v2.h,'-')) AS detail
 FROM v2
 UNION ALL
 SELECT 1,'d_prerequisites','canary_claim_function',
  CASE WHEN cf.oid IS NULL THEN 'ABSENT'
   WHEN cf.marker IS DISTINCT FROM 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE'
    THEN 'CONFLICT: public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)'
   WHEN cf.h IS DISTINCT FROM '1ecee844f09b8c505800015a9e02158b' OR cf.prosecdef OR cf.cfg<>'search_path=""'
    THEN 'CONFLICT: public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid) body'
   WHEN cf.exposed THEN 'CONFLICT: public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid) privileges'
   ELSE 'OK' END,
  NULL,NULL,NULL,
  CASE WHEN cf.oid IS NULL THEN '20261029170000 not applied: production canary inbound always falls back to V2'
   ELSE format('marker=%s body_md5=%s security_definer=%s config=%s public_or_client_privilege=%s',
    coalesce(cf.marker,'-'),cf.h,cf.prosecdef,cf.cfg,cf.exposed) END
 FROM cf
 UNION ALL
 SELECT 2,'d_prerequisites','canary_table:public.'||ct.name,
  CASE WHEN ct.oid IS NULL THEN 'ABSENT'
   WHEN ct.marker IS DISTINCT FROM 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE'
    THEN 'CONFLICT: public.'||ct.name
   WHEN NOT ct.relrowsecurity OR ct.has_policy OR ct.exposed OR ct.svc_acl IS DISTINCT FROM ct.svc
    THEN 'CONFLICT: public.'||ct.name||' privileges'
   ELSE 'OK' END,
  NULL,NULL,NULL,
  CASE WHEN ct.oid IS NULL THEN 'created by 20261029170000'
   ELSE format('marker=%s rls=%s policies=%s public_or_client_privilege=%s service_role=%s (expected %s)',
    coalesce(ct.marker,'-'),ct.relrowsecurity,ct.has_policy,ct.exposed,coalesce(ct.svc_acl,'-'),ct.svc) END
 FROM ct
) x ORDER BY ord,item;

-- (d) 20261029125000_flow_durable_button_run: the V3 durable start / button
-- continuation RPCs (flow_begin_durable_run, flow_resume_button_run) that
-- milan-api calls and the 20261029170000 preflight requires. Catalog only.
--  * durable_button_run:<fn>: normalized body (whitespace collapsed, trimmed)
--    equals either the reviewed 125000 body (identical in the migration and
--    in supabase/proposals/flow_durable_button_ingress.review.sql) or the
--    20261029180000_flow_durable_button_run_guards body (body_version shows
--    which), not security definer, search_path='', no PUBLIC/anon/
--    authenticated privilege, no other overload. Functions installed earlier
--    from the proposal (no marker) are OK: 20261029125000 leaves them
--    unchanged and its rollback keeps them. Any other body is CONFLICT
--    (125000 and 180000 both refuse to overwrite it), and so is a 180000
--    marker on a body that is not the 180000 body.
--  * durable_ingress_for_20261029170000: both functions present, i.e. the
--    170000 preflight requirement (its message still names the proposal) is
--    met by 20261029125000, by the pre-installed proposal functions, or after
--    20261029180000 (which keeps both functions). Not blocking when OK.
--  * preflight:20261029125000: the migration's hard prerequisites.
--  * durable_button_run_guards (20261029180000): OK = both functions carry
--    the 180000 marker and body (resume re-checks the account/tenant flags;
--    the claim's message must belong to the conversation); ABSENT = not
--    applied; CONFLICT = partial or inconsistent state.
--  * preflight:20261029180000: its prerequisites (125000/proposal or 180000
--    bodies, the 20261029130000..170000 markers, messages.conversation_id);
--    INFO while unmet (normal until 125000..170000 are applied).
--  * superseding_begin:<fn> (20261029190000): the atomic supersede + start
--    RPC flow_begin_durable_run_superseding. OK = marker, exact body (md5 of
--    prosrc), not security definer, search_path='', no PUBLIC/anon/
--    authenticated privilege, service_role privilege present, no other
--    overload, AND 20261029180000 installed (ordering: 190000 requires the
--    180000 bodies; durable_button_run_guards OK). ABSENT = not applied.
--    CONFLICT otherwise (unmarked function of that name, other body,
--    privileges, overload, or 190000 present without 180000).
--  * preflight:20261029190000: its prerequisites (20261029130000
--    flow_cancel_run / flow_guard_one_active_run markers and the enabled
--    flow_one_active_run_guard trigger; 20261029180000 marker on both durable
--    functions and its flow_begin_durable_run body; no foreign function or
--    overload of the name); INFO while unmet (normal until 130000..180000
--    are applied).
WITH
g180(sig,h180) AS (VALUES
 ('flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
  '80953ca6c0b52e627699748b59f383f9'),
 ('flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)',
  '7a65417ddf106671862eea0da80d8c73')
),
sp AS (
 SELECT p.oid,obj_description(p.oid,'pg_proc') AS marker,md5(p.prosrc) AS h,p.prosecdef,
  coalesce(array_to_string(p.proconfig,','),'') AS cfg,
  p.oid IS NOT NULL AND (p.proacl IS NULL OR EXISTS(SELECT 1 FROM unnest(p.proacl) e
   WHERE e::text LIKE '=%' OR e::text LIKE 'anon=%' OR e::text LIKE 'authenticated=%')) AS exposed,
  coalesce(EXISTS(SELECT 1 FROM unnest(p.proacl) e WHERE e::text LIKE 'service_role=X%'),false) AS svc,
  (SELECT count(*) FROM pg_catalog.pg_proc x
   WHERE x.pronamespace='public'::regnamespace AND x.proname='flow_begin_durable_run_superseding'
    AND x.oid IS DISTINCT FROM f.oid) AS overloads
 FROM (SELECT to_regprocedure('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)') AS oid) f
 LEFT JOIN pg_catalog.pg_proc p ON p.oid=f.oid
),
dr AS (
 SELECT f.sig,f.h,(SELECT g.h180 FROM g180 g WHERE g.sig=f.sig) AS h180,p.oid,obj_description(p.oid,'pg_proc') AS marker,
  split_part(coalesce(obj_description(p.oid,'pg_proc'),''),' ',1)='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS' AS m180,
  md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) AS ph,p.prosecdef,
  coalesce(array_to_string(p.proconfig,','),'') AS cfg,
  p.oid IS NOT NULL AND (p.proacl IS NULL OR EXISTS(SELECT 1 FROM unnest(p.proacl) e
   WHERE e::text LIKE '=%' OR e::text LIKE 'anon=%' OR e::text LIKE 'authenticated=%')) AS exposed,
  (SELECT count(*) FROM pg_catalog.pg_proc x
   WHERE x.pronamespace='public'::regnamespace AND x.proname=split_part(f.sig,'(',1)
    AND x.oid IS DISTINCT FROM p.oid) AS overloads
 FROM (VALUES
  ('flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
   '8f4347bbd9bd200d64511658e0f85c88'),
  ('flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)',
   '760d4e4fb8e0b4af9abf6438f79d7f78')
 ) f(sig,h)
 LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure('public.'||f.sig)
),
pf125 AS (
 SELECT r.label FROM (VALUES
  ('table public.messages',to_regclass('public.messages') IS NOT NULL),
  ('table public.automation_flow_publications',to_regclass('public.automation_flow_publications') IS NOT NULL),
  ('table public.automation_flow_event_receipts',to_regclass('public.automation_flow_event_receipts') IS NOT NULL),
  ('20261028220000 marker on automation_message_claims',
   obj_description(to_regclass('public.automation_message_claims'),'pg_class')
    IS NOT DISTINCT FROM 'CREATED_BY_20261028220000_WEBHOOK_EXCLUSIVE_CLAIM'),
  ('20261028225000 marker on flow_commit_run_step',
   obj_description(to_regprocedure('public.flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)'),'pg_proc')
    IS NOT DISTINCT FROM 'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE'),
  ('unique (tenant_id,channel_account_id,platform,provider_event_id) on automation_flow_event_receipts',
   EXISTS(SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indrelid=to_regclass('public.automation_flow_event_receipts')
     AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
          FROM unnest(i.indkey::int2[]) k(attnum)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)
         =ARRAY['channel_account_id','platform','provider_event_id','tenant_id']))
 ) r(label,ok) WHERE NOT r.ok
),
pf180 AS (
 SELECT r.label FROM (VALUES
  ('column public.messages.conversation_id',EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=to_regclass('public.messages') AND a.attname='conversation_id' AND a.attnum>0 AND NOT a.attisdropped)),
  ('both durable functions with the 20261029125000/proposal or 20261029180000 body',
   (SELECT count(*) FROM dr WHERE dr.oid IS NOT NULL AND dr.ph IN(dr.h,dr.h180))=2),
  ('20261029130000 marker on flow_lease_due_runs / flow_cancel_run',
   obj_description(to_regprocedure('public.flow_lease_due_runs(integer)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'
   AND obj_description(to_regprocedure('public.flow_cancel_run(uuid,uuid,text,text)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'),
  ('20261029140000 marker on flow_claim_outbox_ai',
   obj_description(to_regprocedure('public.flow_claim_outbox_ai(uuid,uuid,integer,integer)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY'),
  ('20261029150000 marker on flow_end_stale_paused_runs',
   obj_description(to_regprocedure('public.flow_end_stale_paused_runs(integer,integer)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME'),
  ('20261029160000 marker on flow_channel_temporarily_paused',
   obj_description(to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE'),
  ('20261029170000 markers on flow_claim_inbound_durable and the canary tables',
   obj_description(to_regprocedure('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE'
   AND obj_description(to_regclass('public.automation_flow_canary_accounts'),'pg_class') IS NOT DISTINCT FROM 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE'
   AND obj_description(to_regclass('public.automation_flow_canary_claims'),'pg_class') IS NOT DISTINCT FROM 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE')
 ) r(label,ok) WHERE NOT r.ok
),
pf190 AS (
 SELECT r.label FROM (VALUES
  ('20261029130000 marker on flow_cancel_run / flow_guard_one_active_run',
   obj_description(to_regprocedure('public.flow_cancel_run(uuid,uuid,text,text)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'
   AND obj_description(to_regprocedure('public.flow_guard_one_active_run()'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'),
  ('20261029130000 trigger flow_one_active_run_guard enabled on automation_flow_runs',
   EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid=to_regclass('public.automation_flow_runs') AND t.tgname='flow_one_active_run_guard'
     AND t.tgfoid=to_regprocedure('public.flow_guard_one_active_run()') AND t.tgenabled<>'D'
     AND obj_description(t.oid,'pg_trigger') IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE')),
  ('20261029180000 marker on both durable functions and its flow_begin_durable_run body',
   (SELECT count(*) FROM dr WHERE dr.m180)=2
   AND EXISTS(SELECT 1 FROM dr WHERE dr.sig LIKE 'flow_begin_durable_run(%' AND dr.ph=dr.h180)),
  ('no unmarked function or other overload named flow_begin_durable_run_superseding',
   (SELECT sp.overloads=0 AND (sp.oid IS NULL OR sp.marker IS NOT DISTINCT FROM 'CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING') FROM sp))
 ) r(label,ok) WHERE NOT r.ok
)
SELECT section,item,status,tenant_id,n,ids,detail FROM (
 SELECT 0 AS ord,'d_prerequisites'::text AS section,'durable_button_run:public.'||dr.sig AS item,
  CASE WHEN dr.oid IS NULL THEN 'ABSENT'
   WHEN dr.ph IS DISTINCT FROM dr.h AND dr.ph IS DISTINCT FROM dr.h180 OR dr.prosecdef OR dr.cfg<>'search_path=""'
    OR dr.m180 AND dr.ph IS DISTINCT FROM dr.h180
    THEN 'CONFLICT: public.'||dr.sig||' body'
   WHEN dr.overloads>0 THEN 'CONFLICT: public.'||split_part(dr.sig,'(',1)||' overload'
   WHEN dr.exposed THEN 'CONFLICT: public.'||dr.sig||' privileges'
   ELSE 'OK' END AS status,
  NULL::uuid AS tenant_id,dr.overloads AS n,NULL::text AS ids,
  CASE WHEN dr.oid IS NULL
    THEN '20261029125000 not applied (and the proposal not installed): milan-api durable start/resume fails and the 20261029170000 preflight refuses'
   ELSE format('installed_by=%s marker=%s body_md5=%s body_version=%s security_definer=%s config=%s public_or_client_privilege=%s other_overloads=%s%s',
    CASE WHEN dr.m180 THEN '20261029180000 (replaced the 20261029125000/proposal body; its rollback restores it and the previous_comment)'
     WHEN dr.marker='CREATED_BY_20261029125000_FLOW_DURABLE_BUTTON_RUN' THEN '20261029125000'
     WHEN dr.marker IS NULL THEN 'proposal flow_durable_button_ingress.review.sql (pre-existing; 20261029125000 keeps it unchanged and its rollback keeps it)'
     ELSE 'unknown' END,
    coalesce(dr.marker,'-'),dr.ph,
    CASE WHEN dr.ph=dr.h THEN '20261029125000' WHEN dr.ph=dr.h180 THEN '20261029180000' ELSE 'unrecognized' END,
    dr.prosecdef,dr.cfg,dr.exposed,dr.overloads,
    CASE WHEN dr.ph IS DISTINCT FROM dr.h AND dr.ph IS DISTINCT FROM dr.h180 OR dr.prosecdef OR dr.cfg<>'search_path=""'
      THEN '; not the reviewed definition: 20261029125000 refuses to overwrite it (and 20261029180000 refuses to replace it)'
     WHEN dr.m180 AND dr.ph IS DISTINCT FROM dr.h180
      THEN '; carries the 20261029180000 marker without its body: 20261029180000 and its rollback refuse'
     WHEN dr.overloads>0 THEN '; another overload exists: 20261029125000 refuses to install'
     WHEN dr.exposed THEN '; re-applying 20261029125000 restores service_role-only privileges'
     ELSE '' END) END AS detail
 FROM dr
 UNION ALL
 SELECT 1,'d_prerequisites','durable_ingress_for_20261029170000',
  CASE WHEN bool_and(dr.oid IS NOT NULL) THEN 'OK' ELSE 'ABSENT' END,
  NULL,count(dr.oid),NULL,
  CASE WHEN bool_and(dr.oid IS NOT NULL)
    THEN 'both durable ingress functions present: the 20261029170000 preflight requirement (message names the proposal) is met by 20261029125000 or the pre-installed proposal functions, and stays met after 20261029180000 (not blocking)'
   ELSE 'apply 20261029125000_flow_durable_button_run before 20261029170000 (its preflight refuses until both functions exist)' END
 FROM dr
 UNION ALL
 SELECT 3,'d_prerequisites','durable_button_run_guards',
  CASE WHEN count(*) FILTER(WHERE dr.m180 OR dr.ph=dr.h180)=0 THEN 'ABSENT'
   WHEN count(*) FILTER(WHERE dr.m180 AND dr.ph=dr.h180)=2 THEN 'OK'
   ELSE 'CONFLICT: 20261029180000 objects' END,
  NULL,count(*) FILTER(WHERE dr.m180),NULL,
  CASE WHEN count(*) FILTER(WHERE dr.m180 OR dr.ph=dr.h180)=0
    THEN '20261029180000 not applied: flow_resume_button_run does not re-check the account/tenant flags and neither function checks that the claim message belongs to the conversation'
   WHEN count(*) FILTER(WHERE dr.m180 AND dr.ph=dr.h180)=2
    THEN 'installed by 20261029180000 (both functions carry its marker and body); rollback: supabase/rollbacks/20261029180000_flow_durable_button_run_guards.rollback.sql FIRST'
   ELSE format('partial or inconsistent 20261029180000 state: %s of 2 functions carry its marker, %s of 2 have its body',
    count(*) FILTER(WHERE dr.m180),count(*) FILTER(WHERE dr.ph=dr.h180)) END
 FROM dr
 UNION ALL
 SELECT 4,'d_prerequisites','preflight:20261029180000',
  CASE WHEN (SELECT count(*) FROM pf180)=0 THEN 'OK' ELSE 'INFO' END,
  NULL,(SELECT count(*) FROM pf180),NULL,
  CASE WHEN (SELECT count(*) FROM pf180)=0 THEN 'all 20261029180000 preflight requirements satisfied'
   ELSE 'unmet (normal until 20261029125000..170000 are applied): '||(SELECT string_agg(label,'; ' ORDER BY label) FROM pf180) END
 UNION ALL
 SELECT 5,'d_prerequisites','superseding_begin:public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)',
  CASE WHEN sp.oid IS NULL THEN
    CASE WHEN sp.overloads>0 THEN 'CONFLICT: public.flow_begin_durable_run_superseding overload' ELSE 'ABSENT' END
   WHEN sp.marker IS DISTINCT FROM 'CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING'
    THEN 'CONFLICT: public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)'
   WHEN sp.h IS DISTINCT FROM '526c9b3c04d9632fbf7d187ce9c5c658' OR sp.prosecdef OR sp.cfg<>'search_path=""'
    THEN 'CONFLICT: public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb) body'
   WHEN sp.overloads>0 THEN 'CONFLICT: public.flow_begin_durable_run_superseding overload'
   WHEN sp.exposed OR NOT sp.svc THEN 'CONFLICT: public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb) privileges'
   WHEN (SELECT count(*) FROM dr WHERE dr.m180 AND dr.ph=dr.h180)<>2
    THEN 'CONFLICT: 20261029190000 without 20261029180000'
   ELSE 'OK' END,
  NULL,sp.overloads,NULL,
  CASE WHEN sp.oid IS NULL
    THEN '20261029190000 not applied: the atomic supersede + start RPC is missing; a milan-api build that calls it fails closed on a new durable run (no reply from that path), older builds supersede before the start (audit B4)'
   ELSE format('marker=%s body_md5=%s security_definer=%s config=%s public_or_client_privilege=%s service_role=%s other_overloads=%s durable_button_run_guards_ok=%s; rollback (revert milan-api first): supabase/rollbacks/20261029190000_flow_begin_durable_run_superseding.rollback.sql FIRST, before 20261029180000',
    coalesce(sp.marker,'-'),sp.h,sp.prosecdef,sp.cfg,sp.exposed,sp.svc,sp.overloads,
    (SELECT count(*) FROM dr WHERE dr.m180 AND dr.ph=dr.h180)=2) END
 FROM sp
 UNION ALL
 SELECT 6,'d_prerequisites','preflight:20261029190000',
  CASE WHEN (SELECT count(*) FROM pf190)=0 THEN 'OK' ELSE 'INFO' END,
  NULL,(SELECT count(*) FROM pf190),NULL,
  CASE WHEN (SELECT count(*) FROM pf190)=0 THEN 'all 20261029190000 preflight requirements satisfied'
   ELSE 'unmet (normal until 20261029130000..180000 are applied): '||(SELECT string_agg(label,'; ' ORDER BY label) FROM pf190) END
 UNION ALL
 SELECT 2,'d_prerequisites','preflight:20261029125000',
  CASE WHEN (SELECT count(*) FROM pf125)=0 THEN 'OK' ELSE 'MISSING: '||(SELECT min(label) FROM pf125) END,
  NULL,(SELECT count(*) FROM pf125),NULL,
  CASE WHEN (SELECT count(*) FROM pf125)=0 THEN 'all 20261029125000 hard prerequisites satisfied'
   ELSE 'unmet: '||(SELECT string_agg(label,'; ' ORDER BY label) FROM pf125) END
) x ORDER BY ord,item;

-- (d) 20261029210000_flow_media_effects ('message_image' Outbox effects;
-- sending stays behind FLOW_MEDIA_SEND_ENABLED, default OFF). Catalog only.
--  * media_effects:<fn> for flow_commit_run_step, flow_reserve_outbox_delivery
--    and flow_finish_outbox_delivery: OK = the previous 20261028225000 /
--    20261028226000 body or the 20261029210000 body (md5 of the
--    whitespace-normalized prosrc; body_version shows which), the
--    225000/226000 marker kept (210000 never changes it), not security
--    definer, search_path='', no PUBLIC/anon/authenticated privilege, no other
--    overload. MISSING = function absent. CONFLICT otherwise (210000 and its
--    rollback refuse any other body).
--  * media_check:<table>.<column>: the single-column CHECK on
--    automation_flow_outbox(effect_kind) and automation_flow_delivery_attempts(status).
--    OK = exactly the previous list, or the 210000 list (adds message_image /
--    rejected) carrying the 210000 marker. INFO = unrecognized shape while no
--    210000 body is installed (the 210000 preflight refuses it: review the live
--    definition first). CONFLICT = 210000 list without its marker, or an
--    unrecognized shape while a 210000 body is installed.
--  * media_effects: OK = all three 210000 bodies and both marked CHECKs;
--    ABSENT = not applied; INFO = rolled back with
--    flow.rollback_210000=keep-media-checks (previous bodies, widened CHECKs
--    kept because rows need them); CONFLICT = any other partial state.
--  * preflight:20261029210000: its prerequisites (20261029130000 ..
--    20261029190000 markers and the 180000 begin body, the three functions and
--    the two CHECKs as above, outbox delivery_status allowing dead_letter);
--    INFO while unmet.
WITH
mf(sig,marker,h_old,h_new,v_old) AS (VALUES
 ('flow_commit_run_step(uuid,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb,text,uuid)',
  'CREATED_BY_20261028225000_FLOW_RUNTIME_ADVANCE','3d6031bb218b29cb0ffaed0286bd3b1b','94a87bc016ad93e609897025d259bf3e','20261028225000'),
 ('flow_reserve_outbox_delivery(uuid,uuid)',
  'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY','1b7108ae5c17bb190015aa64b4297f98','1b7a6fe3f6a9ee97203d50d5e0e0baa7','20261028226000'),
 ('flow_finish_outbox_delivery(uuid,uuid,text,text)',
  'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY','4cc4008c25291a1db951b595514efc56','1c6ec477519f8c91c24fc2ab82d4b9c4','20261028226000')
),
mfx AS (
 SELECT mf.*,p.oid,obj_description(p.oid,'pg_proc') AS m,
  md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) AS ph,p.prosecdef,
  coalesce(array_to_string(p.proconfig,','),'') AS cfg,
  p.oid IS NOT NULL AND (p.proacl IS NULL OR EXISTS(SELECT 1 FROM unnest(p.proacl) e
   WHERE e::text LIKE '=%' OR e::text LIKE 'anon=%' OR e::text LIKE 'authenticated=%')) AS exposed,
  (SELECT count(*) FROM pg_catalog.pg_proc x
   WHERE x.pronamespace='public'::regnamespace AND x.proname=split_part(mf.sig,'(',1)
    AND x.oid IS DISTINCT FROM p.oid) AS overloads
 FROM mf LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure('public.'||mf.sig)
),
mck(tbl,col,def_old,def_new) AS (VALUES
 ('automation_flow_outbox','effect_kind',
  'CHECK ((effect_kind = ANY (ARRAY[''message''::text, ''question''::text, ''delay''::text, ''handoff''::text, ''tag''::text, ''untag''::text, ''staff_notification''::text])))',
  'CHECK ((effect_kind = ANY (ARRAY[''message''::text, ''question''::text, ''delay''::text, ''handoff''::text, ''tag''::text, ''untag''::text, ''staff_notification''::text, ''message_image''::text])))'),
 ('automation_flow_delivery_attempts','status',
  'CHECK ((status = ANY (ARRAY[''attempting''::text, ''confirmed''::text, ''uncertain''::text])))',
  'CHECK ((status = ANY (ARRAY[''attempting''::text, ''confirmed''::text, ''uncertain''::text, ''rejected''::text])))')
),
mcc AS (
 SELECT mck.tbl,mck.col,c.oid,pg_catalog.pg_get_constraintdef(c.oid) AS def,
  split_part(coalesce(obj_description(c.oid,'pg_constraint'),''),' ',1) AS mk
 FROM mck
 JOIN pg_catalog.pg_attribute a ON a.attrelid=to_regclass('public.'||mck.tbl) AND a.attname=mck.col
  AND a.attnum>0 AND NOT a.attisdropped
 JOIN pg_catalog.pg_constraint c ON c.conrelid=a.attrelid AND c.contype='c' AND c.conkey=ARRAY[a.attnum]
),
mcx AS (
 SELECT mck.*,to_regclass('public.'||mck.tbl) AS rel,
  (SELECT count(*) FROM mcc WHERE mcc.tbl=mck.tbl) AS n,
  (SELECT min(mcc.def) FROM mcc WHERE mcc.tbl=mck.tbl) AS def,
  (SELECT min(mcc.mk) FROM mcc WHERE mcc.tbl=mck.tbl) AS mk,
  (SELECT count(*) FROM pg_catalog.pg_constraint c
   WHERE c.conrelid=to_regclass('public.'||mck.tbl) AND c.contype='c'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%effect_kind%') AS mentions
 FROM mck
),
mcs AS (
 SELECT mcx.*,
  mcx.n=1 AND mcx.def=mcx.def_old AND (mcx.col<>'effect_kind' OR mcx.mentions=1) AS is_old,
  mcx.n=1 AND mcx.def=mcx.def_new AND mcx.mk='CREATED_BY_20261029210000_FLOW_MEDIA_EFFECTS'
   AND (mcx.col<>'effect_kind' OR mcx.mentions=1) AS is_new
 FROM mcx
),
mfs AS (
 SELECT mfx.*,
  CASE WHEN mfx.oid IS NULL THEN 'MISSING: public.'||mfx.sig
   WHEN mfx.m IS DISTINCT FROM mfx.marker THEN 'CONFLICT: public.'||mfx.sig
   WHEN mfx.ph IS DISTINCT FROM mfx.h_old AND mfx.ph IS DISTINCT FROM mfx.h_new OR mfx.prosecdef OR mfx.cfg<>'search_path=""'
    THEN 'CONFLICT: public.'||mfx.sig||' body'
   WHEN mfx.overloads>0 THEN 'CONFLICT: public.'||split_part(mfx.sig,'(',1)||' overload'
   WHEN mfx.exposed THEN 'CONFLICT: public.'||mfx.sig||' privileges'
   ELSE 'OK' END AS st
 FROM mfx
),
mtot AS (
 SELECT (SELECT count(*) FROM mfs WHERE mfs.ph=mfs.h_new) AS fn_new,
  (SELECT count(*) FROM mcs WHERE mcs.is_new) AS ck_new
),
pf210 AS (
 SELECT r.label FROM (VALUES
  ('20261029130000 .. 20261029170000 markers',
   obj_description(to_regprocedure('public.flow_lease_due_runs(integer)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'
   AND obj_description(to_regprocedure('public.flow_cancel_run(uuid,uuid,text,text)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029130000_FLOW_RUN_LIFECYCLE'
   AND obj_description(to_regprocedure('public.flow_claim_outbox_ai(uuid,uuid,integer,integer)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029140000_FLOW_OUTBOX_AI_RETRY'
   AND obj_description(to_regprocedure('public.flow_end_stale_paused_runs(integer,integer)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029150000_FLOW_TAKEOVER_RESUME'
   AND obj_description(to_regprocedure('public.flow_channel_temporarily_paused(uuid,uuid)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029160000_FLOW_CREDITS_PAUSE'
   AND obj_description(to_regprocedure('public.flow_claim_inbound_durable(uuid,uuid,text,text,uuid,uuid)'),'pg_proc') IS NOT DISTINCT FROM 'CREATED_BY_20261029170000_FLOW_CANARY_CLAIM_DURABLE'),
  ('20261029180000 marker on both durable functions and its flow_begin_durable_run body',
   split_part(coalesce(obj_description(to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
    ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
   AND split_part(coalesce(obj_description(to_regprocedure('public.flow_resume_button_run(uuid,uuid,text,uuid,integer,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc'),''),' ',1)
    ='CREATED_BY_20261029180000_FLOW_DURABLE_BUTTON_RUN_GUARDS'
   AND (SELECT md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) FROM pg_catalog.pg_proc p
    WHERE p.oid=to_regprocedure('public.flow_begin_durable_run(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)'))
    IS NOT DISTINCT FROM '80953ca6c0b52e627699748b59f383f9'),
  ('20261029190000 marker on flow_begin_durable_run_superseding',
   obj_description(to_regprocedure('public.flow_begin_durable_run_superseding(uuid,uuid,uuid,uuid,text,text,bigint,text,text,integer,text,jsonb,timestamptz,jsonb)'),'pg_proc')
    IS NOT DISTINCT FROM 'CREATED_BY_20261029190000_FLOW_BEGIN_DURABLE_RUN_SUPERSEDING'),
  ('20261028226000 marker on automation_flow_delivery_attempts',
   obj_description(to_regclass('public.automation_flow_delivery_attempts'),'pg_class') IS NOT DISTINCT FROM 'CREATED_BY_20261028226000_FLOW_OUTBOX_DELIVERY'),
  ('flow_commit_run_step, flow_reserve_outbox_delivery, flow_finish_outbox_delivery with their markers and the previous or 20261029210000 body',
   (SELECT count(*) FROM mfs WHERE mfs.st='OK')=3),
  ('single-column effect_kind and status CHECKs with the previous or 20261029210000 list',
   (SELECT count(*) FROM mcs WHERE mcs.is_old OR mcs.is_new)=2),
  ('outbox delivery_status CHECK allowing dead_letter',
   EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid=to_regclass('public.automation_flow_outbox') AND c.contype='c'
     AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%delivery_status%'
     AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''dead_letter''%'))
 ) r(label,ok) WHERE NOT r.ok
)
SELECT section,item,status,tenant_id,n,ids,detail FROM (
 SELECT 0 AS ord,'d_prerequisites'::text AS section,'media_effects:public.'||mfs.sig AS item,mfs.st AS status,
  NULL::uuid AS tenant_id,mfs.overloads AS n,NULL::text AS ids,
  CASE WHEN mfs.oid IS NULL THEN mfs.v_old||' not applied: 20261029210000 requires it'
   ELSE format('marker=%s body_md5=%s body_version=%s security_definer=%s config=%s public_or_client_privilege=%s other_overloads=%s',
    coalesce(mfs.m,'-'),mfs.ph,
    CASE WHEN mfs.ph=mfs.h_new THEN '20261029210000' WHEN mfs.ph=mfs.h_old THEN mfs.v_old ELSE 'unrecognized' END,
    mfs.prosecdef,mfs.cfg,mfs.exposed,mfs.overloads) END AS detail
 FROM mfs
 UNION ALL
 SELECT 1,'d_prerequisites','media_check:public.'||mcs.tbl||'.'||mcs.col,
  CASE WHEN mcs.rel IS NULL THEN 'MISSING: public.'||mcs.tbl
   WHEN mcs.is_old OR mcs.is_new THEN 'OK'
   WHEN mcs.n=1 AND mcs.def=mcs.def_new THEN 'CONFLICT: public.'||mcs.tbl||'.'||mcs.col||' check'
   WHEN (SELECT fn_new FROM mtot)>0 THEN 'CONFLICT: public.'||mcs.tbl||'.'||mcs.col||' check'
   ELSE 'INFO' END,
  NULL,mcs.n,NULL,
  CASE WHEN mcs.rel IS NULL THEN 'table absent'
   WHEN mcs.is_old THEN format('previous list (20261029210000 not applied: %s not allowed); definition: %s',
    CASE WHEN mcs.col='effect_kind' THEN 'message_image' ELSE 'rejected' END,mcs.def)
   WHEN mcs.is_new THEN format('20261029210000 list with its marker (%s allowed); definition: %s',
    CASE WHEN mcs.col='effect_kind' THEN 'message_image' ELSE 'rejected' END,mcs.def)
   WHEN mcs.n=1 AND mcs.def=mcs.def_new THEN '20261029210000 list without its marker: 20261029210000 refuses to re-apply and its rollback refuses'
   ELSE format('unrecognized: single-column checks=%s other effect_kind checks=%s definition=%s; the 20261029210000 preflight refuses to replace it (review the live definition first)',
    mcs.n,CASE WHEN mcs.col='effect_kind' THEN mcs.mentions-mcs.n ELSE 0 END,coalesce(mcs.def,'-')) END
 FROM mcs
 UNION ALL
 SELECT 2,'d_prerequisites','media_effects',
  CASE WHEN t.fn_new=3 AND t.ck_new=2 THEN 'OK'
   WHEN t.fn_new=0 AND t.ck_new=0 THEN 'ABSENT'
   WHEN t.fn_new=0 AND t.ck_new=2 THEN 'INFO'
   ELSE 'CONFLICT: 20261029210000 objects' END,
  NULL,t.fn_new,NULL,
  CASE WHEN t.fn_new=3 AND t.ck_new=2
    THEN 'installed by 20261029210000 (message_image effects can be stored, reserved and finished; rejected = dead_letter); sending still needs FLOW_MEDIA_SEND_ENABLED; rollback: supabase/rollbacks/20261029210000_flow_media_effects.rollback.sql FIRST, before 20261029190000'
   WHEN t.fn_new=0 AND t.ck_new=0
    THEN '20261029210000 not applied: message_image effects are refused by the database (planner/worker builds that emit them fail closed)'
   WHEN t.fn_new=0 AND t.ck_new=2
    THEN 'rolled back with flow.rollback_210000=keep-media-checks: previous function bodies, widened CHECKs kept for existing rows; a re-apply of 20261029210000 is accepted'
   ELSE format('partial or inconsistent 20261029210000 state: %s of 3 functions have its body, %s of 2 CHECKs carry its list and marker',t.fn_new,t.ck_new) END
 FROM mtot t
 UNION ALL
 SELECT 3,'d_prerequisites','preflight:20261029210000',
  CASE WHEN (SELECT count(*) FROM pf210)=0 THEN 'OK' ELSE 'INFO' END,
  NULL,(SELECT count(*) FROM pf210),NULL,
  CASE WHEN (SELECT count(*) FROM pf210)=0 THEN 'all 20261029210000 preflight requirements satisfied'
   ELSE 'unmet (normal until 20261029130000..190000 are applied): '||(SELECT string_agg(label,'; ' ORDER BY label) FROM pf210) END
) x ORDER BY ord,item;

-- (d) Canary registration for the INTENDED tenant/account (read only).
-- Pass the intended canary as session settings (never stored anywhere):
--   PGOPTIONS='-c default_transaction_read_only=on -c flow.canary_tenant=<tenant uuid> -c flow.canary_account=<account uuid>'
-- canary_registration status:
--   ABSENT   20261029170000 not applied;
--   INFO     no intended tenant/account given (lists the registered accounts);
--   OK       registered for exactly that tenant/account on instagram, and the
--            tenant is eligible now (global + tenant switch on,
--            production approved, test_only off, active activation);
--   WARN     registered but not eligible yet (detail lists what is unmet), or
--            the settings are not valid UUIDs;
--   MISSING: canary registration   nothing registered for that tenant;
--   CONFLICT: canary registration  the tenant's registration names a
--            different account (or the account is not that tenant's).
\if :pdc_canary_ok
WITH w0 AS (
 SELECT nullif(current_setting('flow.canary_tenant',true),'') AS t_raw,
  nullif(current_setting('flow.canary_account',true),'') AS a_raw
),
w AS (
 SELECT t_raw,a_raw,
  CASE WHEN t_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t_raw::uuid END AS t,
  CASE WHEN a_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN a_raw::uuid END AS a
 FROM w0
),
reg AS (
 SELECT r.tenant_id,r.channel_account_id,r.platform FROM public.automation_flow_canary_accounts r
),
mine AS (
 SELECT reg.channel_account_id FROM reg CROSS JOIN w WHERE reg.tenant_id=w.t AND reg.platform='instagram'
),
unmet AS (
 SELECT x.label FROM w CROSS JOIN LATERAL (VALUES
  ('global switch enabled',EXISTS(SELECT 1 FROM public.automation_flow_global_switch g WHERE g.singleton AND g.enabled)),
  ('tenant switch enabled',EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches s WHERE s.tenant_id=w.t AND s.enabled)),
  ('tenant production approved',EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches s
    WHERE s.tenant_id=w.t AND to_jsonb(s)->>'production_approved'='true')),
  ('tenant test_only off',EXISTS(SELECT 1 FROM public.automation_flow_tenant_switches s WHERE s.tenant_id=w.t AND s.test_only IS FALSE)),
  ('active instagram activation for the account',EXISTS(SELECT 1 FROM public.automation_flow_activations f
    WHERE f.tenant_id=w.t AND f.channel_account_id=w.a AND f.platform='instagram' AND to_jsonb(f)->>'is_active'='true'))
 ) x(label,ok) WHERE NOT x.ok
)
SELECT 'd_prerequisites' AS section,'canary_registration' AS item,
 CASE
  WHEN w.t_raw IS NULL AND w.a_raw IS NULL THEN 'INFO'
  WHEN w.t IS NULL OR w.a IS NULL THEN 'WARN'
  WHEN NOT EXISTS(SELECT 1 FROM public.channel_accounts ca WHERE ca.tenant_id=w.t AND ca.id=w.a AND ca.platform='instagram')
   THEN 'CONFLICT: canary registration'
  WHEN NOT EXISTS(SELECT 1 FROM mine) THEN 'MISSING: canary registration'
  WHEN NOT EXISTS(SELECT 1 FROM mine WHERE mine.channel_account_id=w.a) THEN 'CONFLICT: canary registration'
  WHEN EXISTS(SELECT 1 FROM unmet) THEN 'WARN'
  ELSE 'OK' END AS status,
 w.t AS tenant_id,(SELECT count(*) FROM reg) AS n,
 CASE WHEN w.t_raw IS NULL AND w.a_raw IS NULL
  THEN (SELECT string_agg(reg.channel_account_id::text,',' ORDER BY reg.channel_account_id) FROM reg)
  ELSE (SELECT string_agg(mine.channel_account_id::text,',' ORDER BY mine.channel_account_id) FROM mine) END AS ids,
 CASE
  WHEN w.t_raw IS NULL AND w.a_raw IS NULL THEN
   format('registered canaries=%s (ids: accounts); set flow.canary_tenant and flow.canary_account to verify the intended canary',
    (SELECT count(*) FROM reg))
  WHEN w.t IS NULL OR w.a IS NULL THEN 'flow.canary_tenant / flow.canary_account are not valid UUIDs'
  WHEN NOT EXISTS(SELECT 1 FROM public.channel_accounts ca WHERE ca.tenant_id=w.t AND ca.id=w.a AND ca.platform='instagram')
   THEN 'the intended account is not an instagram account of the intended tenant'
  WHEN NOT EXISTS(SELECT 1 FROM mine) THEN 'no canary registration for the intended tenant on instagram: the canary falls back to V2'
  WHEN NOT EXISTS(SELECT 1 FROM mine WHERE mine.channel_account_id=w.a)
   THEN 'the tenant''s instagram canary registration names a different account (ids)'
  WHEN EXISTS(SELECT 1 FROM unmet)
   THEN 'registered; not eligible yet: '||(SELECT string_agg(label,'; ' ORDER BY label) FROM unmet)
  ELSE 'registered and eligible: inbound of this account is claimed by flow_claim_inbound_durable' END AS detail
FROM w;
\else
SELECT 'd_prerequisites' AS section,'canary_registration' AS item,
 CASE WHEN to_regclass('public.automation_flow_canary_accounts') IS NULL THEN 'ABSENT'
  WHEN EXISTS(SELECT 1 FROM unnest(ARRAY['automation_flow_canary_accounts','automation_flow_tenant_switches',
    'automation_flow_global_switch','automation_flow_activations','channel_accounts']) t
   WHERE to_regclass('public.'||t) IS NULL)
   THEN 'MISSING: flow switch, activation or account tables'
  WHEN EXISTS(SELECT 1 FROM unnest(ARRAY['automation_flow_canary_accounts','automation_flow_tenant_switches',
    'automation_flow_global_switch','automation_flow_activations','channel_accounts']) t
   WHERE NOT has_table_privilege(to_regclass('public.'||t),'SELECT'))
   THEN 'MISSING: read privilege on public.automation_flow_canary_accounts or the flow switch tables'
  ELSE 'MISSING: RLS bypass on public.automation_flow_canary_accounts or the flow switch tables' END AS status,
 NULL::uuid AS tenant_id,NULL::bigint AS n,NULL::text AS ids,
 CASE WHEN to_regclass('public.automation_flow_canary_accounts') IS NULL
  THEN '20261029170000 not applied' ELSE 'section skipped' END AS detail;
\endif

-- ===========================================================================
-- (e) Lock-impact estimators. Planner statistics only (no table scans).
-- Each migration is ONE transaction: the AccessExclusive lock taken by its
-- first column addition is held until commit, so the constraint validation
-- scans and index builds that follow block all reads and writes on that
-- table for the whole migration. Run it when the counts below are low.
-- ===========================================================================
\echo '== (e) lock-impact estimators'
WITH t(name,work) AS (VALUES
 ('automation_flow_runs','130000: +2 nullable columns, ended_reason check validated (full scan), '
  'waiting_idx partial index build, unique partial index build if no duplicates, row guard'),
 ('automation_flow_outbox','130000: +2 nullable columns, cancel_reason check validated (full scan); '
  '140000: +6 columns (one NOT NULL constant default, no rewrite), ai_state + cancel_reason checks validated (full scans)'),
 ('automation_flow_run_leases','130000: +1 NOT NULL DEFAULT 0 column (constant default, no rewrite)')),
rel AS (SELECT t.name,t.work,to_regclass('public.'||t.name) AS oid FROM t),
lk AS (
 SELECT l.relation,l.pid,l.mode,l.granted
 FROM pg_catalog.pg_locks l
 WHERE l.locktype='relation' AND l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
  AND l.pid IS DISTINCT FROM pg_backend_pid()
  AND l.relation IN(SELECT oid FROM rel WHERE oid IS NOT NULL)
),
act AS (
 SELECT a.pid,a.state,a.xact_start,a.wait_event_type
 FROM pg_catalog.pg_stat_activity a
 WHERE a.pid<>pg_backend_pid() AND a.datname=current_database() AND a.backend_type='client backend'
)
SELECT section,item,status,tenant_id,n,ids,detail FROM (
 SELECT 0 AS ord,'e_lock_impact'::text AS section,'table:public.'||rel.name AS item,
  CASE WHEN rel.oid IS NULL THEN 'MISSING: public.'||rel.name ELSE 'INFO' END AS status,
  NULL::uuid AS tenant_id,
  CASE WHEN c.reltuples>=0 THEN c.reltuples::bigint END AS n,NULL::text AS ids,
  CASE WHEN rel.oid IS NULL THEN rel.work ELSE
   format('estimated_rows=%s total_size=%s (%s bytes); %s',
    CASE WHEN c.reltuples<0 THEN 'unknown (never analyzed)' ELSE c.reltuples::bigint::text END,
    pg_size_pretty(pg_total_relation_size(rel.oid)),pg_total_relation_size(rel.oid),rel.work) END AS detail
 FROM rel LEFT JOIN pg_catalog.pg_class c ON c.oid=rel.oid
 UNION ALL
 SELECT 1,'e_lock_impact','locks:public.'||rel.name,
  CASE WHEN count(lk.pid)=0 THEN 'OK' ELSE 'WARN' END,NULL,count(lk.pid),
  nullif(string_agg(DISTINCT lk.pid::text,','),''),
  format('other sessions holding/awaiting locks: granted=%s waiting=%s modes=%s',
   count(lk.pid) FILTER(WHERE lk.granted),count(lk.pid) FILTER(WHERE NOT lk.granted),
   coalesce(string_agg(DISTINCT lk.mode,','),'-'))
 FROM rel LEFT JOIN lk ON lk.relation=rel.oid
 WHERE rel.oid IS NOT NULL
 GROUP BY rel.name
 UNION ALL
 SELECT 2,'e_lock_impact','long_transactions',
  CASE WHEN count(*) FILTER(WHERE xact_start<now()-interval '60 seconds')=0 THEN 'OK' ELSE 'WARN' END,
  NULL,count(*) FILTER(WHERE xact_start<now()-interval '60 seconds'),
  nullif(string_agg(pid::text,',' ORDER BY xact_start) FILTER(WHERE xact_start<now()-interval '60 seconds'),''),
  format('client sessions in this database: open transaction >60s=%s, idle in transaction=%s, waiting on a lock=%s, '
   'oldest_xact_seconds=%s, not visible to this role=%s (pids only; no query text)',
   count(*) FILTER(WHERE xact_start<now()-interval '60 seconds'),
   count(*) FILTER(WHERE state LIKE 'idle in transaction%'),
   count(*) FILTER(WHERE wait_event_type='Lock'),
   coalesce(floor(extract(epoch FROM now()-min(xact_start)))::bigint::text,'-'),
   count(*) FILTER(WHERE state IS NULL))
 FROM act
) x ORDER BY ord,item;

-- ===========================================================================
-- (f) Inbound dedupe index on public.messages(wa_message_id) (audit B1).
-- milan-api persistInboundOnce maps a unique violation (23505) of the inbound
-- insert to "duplicate delivery". Only the test bootstrap builds that index
-- (global, WHERE wa_message_id IS NOT NULL); no repo migration or schema file
-- does, so production must be verified here. The durable Instagram ingress
-- refuses repeat deliveries by itself (read-only claim/inbound lookup), but
-- the index is still the first dedupe barrier for every channel.
-- unique_index:
--   OK       a valid, ready UNIQUE index on (wa_message_id) [scope=global] or
--            (tenant_id, wa_message_id) [scope=tenant], plain columns, no
--            predicate or exactly (wa_message_id IS NOT NULL);
--   MISSING: unique index on public.messages(wa_message_id)
--            none (detail lists unsuitable/invalid unique indexes found, e.g.
--            an invalid leftover of a failed concurrent build). BLOCKING
--            before FLOW_DURABLE_INGRESS_ENABLED=true.
-- duplicates_global / duplicates_tenant: provider ids stored more than once
-- (all directions; groups and surplus rows). Scanned only when no suitable
-- index of that scope exists (full scan of public.messages, bounded by the
-- statement_timeout above). FOUND must be resolved before an index of that
-- scope can be built. Build it outside these checks, as a separately reviewed
-- step with its own rollback, using a non-transactional CONCURRENTLY build
-- (it cannot run inside the one-transaction migrations of this repo);
-- re-run these checks afterwards and require unique_index = OK.
-- Counts only: never provider ids, message ids or contents.
-- ===========================================================================
\echo '== (f) inbound dedupe index on public.messages(wa_message_id)'
\if :pdc_messages_ok
WITH ix AS (
 SELECT i.indexrelid::regclass::text AS name,(i.indisvalid AND i.indisready) AS usable,
  i.indexprs IS NULL AS plain,pg_catalog.pg_get_expr(i.indpred,i.indrelid) AS pred,
  (SELECT array_agg(a.attname::text ORDER BY k.n)
   FROM unnest((i.indkey::int2[])[0:i.indnkeyatts-1]) WITH ORDINALITY k(attnum,n)
   JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum) AS cols
 FROM pg_catalog.pg_index i
 WHERE i.indrelid=to_regclass('public.messages') AND i.indisunique
),
s AS (
 SELECT ix.*,
  CASE WHEN ix.cols=ARRAY['wa_message_id'] THEN 'global'
   WHEN ix.cols=ARRAY['tenant_id','wa_message_id'] THEN 'tenant' END AS scope,
  (ix.usable AND ix.plain AND ix.cols IN(ARRAY['wa_message_id'],ARRAY['tenant_id','wa_message_id'])
   AND (ix.pred IS NULL OR ix.pred='(wa_message_id IS NOT NULL)')) AS suitable
 FROM ix WHERE 'wa_message_id'=ANY(ix.cols) OR NOT ix.plain
),
dg AS (
 SELECT count(*) AS groups,coalesce(sum(d.n-1),0) AS surplus FROM (
  SELECT count(*) AS n FROM public.messages m
  WHERE m.wa_message_id IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM s WHERE s.suitable AND s.scope='global')
  GROUP BY m.wa_message_id HAVING count(*)>1) d
),
dt AS (
 SELECT count(*) AS groups,coalesce(sum(d.n-1),0) AS surplus FROM (
  SELECT count(*) AS n FROM public.messages m
  WHERE m.wa_message_id IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM s WHERE s.suitable)
  GROUP BY m.tenant_id,m.wa_message_id HAVING count(*)>1) d
)
SELECT section,item,status,tenant_id,n,ids,detail FROM (
 SELECT 0 AS ord,'f_inbound_dedupe'::text AS section,'unique_index'::text AS item,
  CASE WHEN EXISTS(SELECT 1 FROM s WHERE s.suitable) THEN 'OK'
   ELSE 'MISSING: unique index on public.messages(wa_message_id)' END AS status,
  NULL::uuid AS tenant_id,(SELECT count(*) FROM s WHERE s.suitable) AS n,NULL::text AS ids,
  coalesce('suitable: '||(SELECT string_agg(s.name||' scope='||s.scope,'; ' ORDER BY s.name) FROM s WHERE s.suitable),
   'BLOCKING before FLOW_DURABLE_INGRESS_ENABLED=true: persistInboundOnce cannot detect repeat deliveries')||
  coalesce('; unsuitable or invalid: '||(SELECT string_agg(format('%s cols=%s valid=%s predicate=%s',s.name,
   coalesce(array_to_string(s.cols,','),'expression'),CASE WHEN s.usable THEN 'true' ELSE 'false' END,
   coalesce(s.pred,'none')),'; ' ORDER BY s.name)
   FROM s WHERE NOT s.suitable),'') AS detail
 UNION ALL
 SELECT 1,'f_inbound_dedupe','duplicates_global',
  CASE WHEN EXISTS(SELECT 1 FROM s WHERE s.suitable AND s.scope='global') THEN 'OK'
   WHEN (SELECT groups FROM dg)=0 THEN 'OK' ELSE 'FOUND' END,
  NULL,(SELECT groups FROM dg),NULL,
  CASE WHEN EXISTS(SELECT 1 FROM s WHERE s.suitable AND s.scope='global')
   THEN 'not scanned: the global unique index guarantees none'
   ELSE format('provider ids stored more than once across all tenants: groups=%s surplus rows=%s (blocks a global index)',
    (SELECT groups FROM dg),(SELECT surplus FROM dg)) END
 UNION ALL
 SELECT 2,'f_inbound_dedupe','duplicates_tenant',
  CASE WHEN EXISTS(SELECT 1 FROM s WHERE s.suitable) THEN 'OK'
   WHEN (SELECT groups FROM dt)=0 THEN 'OK' ELSE 'FOUND' END,
  NULL,(SELECT groups FROM dt),NULL,
  CASE WHEN EXISTS(SELECT 1 FROM s WHERE s.suitable)
   THEN 'not scanned: a suitable unique index guarantees none per tenant'
   ELSE format('provider ids stored more than once within one tenant: groups=%s surplus rows=%s (blocks a (tenant_id, wa_message_id) index)',
    (SELECT groups FROM dt),(SELECT surplus FROM dt)) END
) x ORDER BY ord,item;
\else
SELECT 'f_inbound_dedupe' AS section,'prerequisite' AS item,m.status,NULL::uuid AS tenant_id,
 NULL::bigint AS n,NULL::text AS ids,'section skipped' AS detail
FROM (
 SELECT 'MISSING: public.messages' AS status
 WHERE to_regclass('public.messages') IS NULL
 UNION ALL
 SELECT 'MISSING: read privilege on public.messages'
 WHERE to_regclass('public.messages') IS NOT NULL
  AND NOT has_table_privilege(to_regclass('public.messages'),'SELECT')
 UNION ALL
 SELECT 'MISSING: RLS bypass on public.messages'
 WHERE coalesce(row_security_active(to_regclass('public.messages')),false)
 UNION ALL
 SELECT 'MISSING: public.messages.'||col
 FROM unnest(ARRAY['tenant_id','wa_message_id']) col
 WHERE to_regclass('public.messages') IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
   WHERE a.attrelid=to_regclass('public.messages')
    AND a.attname=col AND a.attnum>0 AND NOT a.attisdropped)
) m;
\endif

-- ===========================================================================
-- (g) 20261028227000_tenant_staff_memberships and
-- 20261028228000_flow_internal_actions (staff roles / conversation
-- assignments; internal tag, untag and staff_notification effects). Catalog
-- only: no table is read (row counts are planner estimates), so it never
-- needs RLS bypass and works before and after both migrations. Both are
-- separately approved ("Separate production migration GO required"); no
-- 20261029125000..180000 migration depends on them, but flow-staff-inbox and
-- flow-internal-worker do (the worker writes flow_conversation_tags /
-- flow_staff_notifications directly as service_role).
--  * migration:<version>: ABSENT = not applied; OK = every object present
--    with its ownership marker; CONFLICT = partial or unrecognized (the
--    migration guard refuses a re-apply while any object exists, and the
--    rollbacks require the markers). Rollback order: 228000, then 227000;
--    each rollback refuses while its tables hold rows.
--  * preflight:<version>: the migration's requirements plus the runtime
--    columns its functions read (tenants.user_id = the tenant's primary
--    user). INFO while unmet and not applied; MISSING once applied.
--  * table:*: marker, columns, primary key, foreign keys (tenant-scoped
--    composite keys to conversations / automation_flow_outbox), RLS enabled,
--    policies (only tenant_staff_self_read on tenant_staff_memberships),
--    no PUBLIC/anon privilege, authenticated only SELECT on
--    tenant_staff_memberships, service_role at least the privileges the
--    workers need.
--  * index:*, function:* (exact body md5, not security definer,
--    search_path='', no PUBLIC/anon/authenticated privilege, service_role
--    may run it).
--  * lock_impact:public.conversations: 227000 builds a unique index on
--    conversations inside its transaction (writes blocked meanwhile).
-- ===========================================================================
\echo '== (g) staff memberships and internal actions (20261028227000 / 20261028228000)'
WITH
st(name,mig,marker,svc,client,pol,cols,pk,fks) AS (VALUES
 ('tenant_staff_memberships','20261028227000','CREATED_BY_20261028227000_TENANT_STAFF','arwd','authenticated=r',
  'tenant_staff_self_read',ARRAY['tenant_id','user_id','role','status','invited_by','created_at','updated_at'],
  'tenant_id,user_id','invited_by>auth.users(id);tenant_id>public.tenants(id);user_id>auth.users(id)'),
 ('tenant_conversation_assignments','20261028227000','CREATED_BY_20261028227000_TENANT_STAFF','arwd','',
  NULL,ARRAY['tenant_id','conversation_id','user_id','assigned_by','status','created_at'],
  'tenant_id,conversation_id,user_id',
  'assigned_by>auth.users(id);tenant_id,conversation_id>public.conversations(tenant_id,id);tenant_id,user_id>public.tenant_staff_memberships(tenant_id,user_id)'),
 ('flow_conversation_tags','20261028228000','CREATED_BY_20261028228000_INTERNAL_ACTIONS','ard','',
  NULL,ARRAY['tenant_id','conversation_id','tag','created_by_outbox','created_at'],
  'tenant_id,conversation_id,tag',
  'tenant_id,conversation_id>public.conversations(tenant_id,id);tenant_id,created_by_outbox>public.automation_flow_outbox(tenant_id,id)'),
 ('flow_staff_notifications','20261028228000','CREATED_BY_20261028228000_INTERNAL_ACTIONS','arw','',
  NULL,ARRAY['tenant_id','outbox_id','conversation_id','recipient_user_id','body','status','created_at'],
  'tenant_id,outbox_id',
  'recipient_user_id>auth.users(id);tenant_id,conversation_id>public.conversations(tenant_id,id);tenant_id,outbox_id>public.automation_flow_outbox(tenant_id,id)')),
sc AS (
 SELECT st.*,c.oid,obj_description(c.oid,'pg_class') AS m,c.relrowsecurity AS rls,c.reltuples,
  coalesce((SELECT string_agg(split_part(e::text,'/',1),',' ORDER BY split_part(e::text,'/',1) COLLATE "C")
   FROM unnest(c.relacl) e
   WHERE e::text LIKE '=%' OR e::text LIKE 'anon=%' OR e::text LIKE 'authenticated=%'),'') AS cl,
  coalesce((SELECT string_agg(split_part(split_part(e::text,'/',1),'=',2),'')
   FROM unnest(c.relacl) e WHERE e::text LIKE 'service_role=%'),'') AS sv,
  (SELECT count(*) FROM pg_catalog.pg_policy po WHERE po.polrelid=c.oid) AS npol,
  coalesce((SELECT string_agg(po.polname::text,',' ORDER BY po.polname) FROM pg_catalog.pg_policy po
   WHERE po.polrelid=c.oid),'-') AS pols,
  EXISTS(SELECT 1 FROM pg_catalog.pg_policy po
   WHERE po.polrelid=c.oid AND po.polname=st.pol AND po.polcmd='r' AND po.polpermissive
    AND po.polwithcheck IS NULL
    AND (SELECT array_agg(r.rolname::text) FROM pg_catalog.pg_roles r WHERE r.oid=ANY(po.polroles))=ARRAY['authenticated']
    AND position('user_id' IN coalesce(pg_catalog.pg_get_expr(po.polqual,po.polrelid),''))>0
    AND position('auth.uid()' IN coalesce(pg_catalog.pg_get_expr(po.polqual,po.polrelid),''))>0) AS pol_ok,
  (SELECT string_agg(x,',') FROM unnest(st.cols) x
   WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=c.oid AND a.attname=x AND a.attnum>0 AND NOT a.attisdropped)) AS miss_cols,
  (SELECT string_agg(a.attname::text,',' ORDER BY k.n)
   FROM pg_catalog.pg_constraint pc
   CROSS JOIN LATERAL unnest(pc.conkey) WITH ORDINALITY k(attnum,n)
   JOIN pg_catalog.pg_attribute a ON a.attrelid=pc.conrelid AND a.attnum=k.attnum
   WHERE pc.conrelid=c.oid AND pc.contype='p') AS pkc,
  (SELECT string_agg(f.sig,';' ORDER BY f.sig COLLATE "C") FROM (
    SELECT format('%s>%s.%s(%s)',
     (SELECT string_agg(a.attname::text,',' ORDER BY k.n) FROM unnest(pc.conkey) WITH ORDINALITY k(attnum,n)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=pc.conrelid AND a.attnum=k.attnum),
     rn.nspname,rc.relname,
     (SELECT string_agg(a.attname::text,',' ORDER BY k.n) FROM unnest(pc.confkey) WITH ORDINALITY k(attnum,n)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=pc.confrelid AND a.attnum=k.attnum)) AS sig
    FROM pg_catalog.pg_constraint pc
    JOIN pg_catalog.pg_class rc ON rc.oid=pc.confrelid
    JOIN pg_catalog.pg_namespace rn ON rn.oid=rc.relnamespace
    WHERE pc.conrelid=c.oid AND pc.contype='f') f) AS fkc,
  (SELECT string_agg(x,';' ORDER BY x COLLATE "C") FROM unnest(string_to_array(st.fks,';')) x) AS fkw
 FROM st LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass('public.'||st.name)
),
sx AS (
 SELECT sc.*,
  CASE WHEN sc.pol IS NULL THEN sc.npol>0 ELSE NOT(sc.npol=1 AND sc.pol_ok) END AS pol_bad,
  EXISTS(SELECT 1 FROM regexp_split_to_table(sc.svc,'') ch WHERE position(ch IN sc.sv)=0) AS svc_bad
 FROM sc
),
ix(name,tbl,mig,cols,uniq,marker) AS (VALUES
 ('conversations_staff_scope_uq','conversations','20261028227000','tenant_id,id',true,'CREATED_BY_20261028227000_TENANT_STAFF'),
 ('tenant_staff_memberships_user_idx','tenant_staff_memberships','20261028227000','user_id,status',false,NULL),
 ('tenant_conversation_assignments_user_idx','tenant_conversation_assignments','20261028227000','tenant_id,user_id,status',false,NULL),
 ('flow_staff_notifications_recipient_idx','flow_staff_notifications','20261028228000','tenant_id,recipient_user_id,created_at',false,NULL)),
ic AS (
 SELECT ix.*,to_regclass('public.'||ix.name) AS oid,obj_description(to_regclass('public.'||ix.name),'pg_class') AS m,
  i.indrelid=to_regclass('public.'||ix.tbl) AS on_tbl,i.indisunique,(i.indisvalid AND i.indisready) AS usable,
  i.indpred IS NULL AND i.indexprs IS NULL AS plain,
  (SELECT string_agg(a.attname::text,',' ORDER BY k.n)
   FROM unnest((i.indkey::int2[])[0:i.indnkeyatts-1]) WITH ORDINALITY k(attnum,n)
   JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum) AS icols
 FROM ix LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=to_regclass('public.'||ix.name)
),
fx(sig,mig,marker,h,why) AS (VALUES
 ('flow_staff_can(uuid,uuid,text,uuid)','20261028227000','CREATED_BY_20261028227000_TENANT_STAFF',
  '02d990366a9e299a14424af08813b278','server-only permission decision (actor from auth.getUser, never a request field)'),
 ('flow_apply_internal_effect(uuid,uuid)','20261028228000','CREATED_BY_20261028228000_INTERNAL_ACTIONS',
  'fa8c86694f1c74dd10b1679b7ac0a237','test_only tenants; flow-internal-worker now writes the tables directly')),
fc AS (
 SELECT fx.*,p.oid,obj_description(p.oid,'pg_proc') AS m,md5(p.prosrc) AS ph,p.prosecdef,
  coalesce(array_to_string(p.proconfig,','),'') AS cfg,
  p.oid IS NOT NULL AND (p.proacl IS NULL OR EXISTS(SELECT 1 FROM unnest(p.proacl) e
   WHERE e::text LIKE '=%' OR e::text LIKE 'anon=%' OR e::text LIKE 'authenticated=%')) AS exposed,
  EXISTS(SELECT 1 FROM unnest(p.proacl) e WHERE split_part(e::text,'/',1) LIKE 'service_role=%X%') AS svc_ok
 FROM fx LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure('public.'||fx.sig)
),
ob(mig,name,kind,marker) AS (VALUES
 ('20261028227000','conversations_staff_scope_uq','r','CREATED_BY_20261028227000_TENANT_STAFF'),
 ('20261028227000','tenant_staff_memberships','r','CREATED_BY_20261028227000_TENANT_STAFF'),
 ('20261028227000','tenant_conversation_assignments','r','CREATED_BY_20261028227000_TENANT_STAFF'),
 ('20261028227000','flow_staff_can(uuid,uuid,text,uuid)','f','CREATED_BY_20261028227000_TENANT_STAFF'),
 ('20261028228000','flow_conversation_tags','r','CREATED_BY_20261028228000_INTERNAL_ACTIONS'),
 ('20261028228000','flow_staff_notifications','r','CREATED_BY_20261028228000_INTERNAL_ACTIONS'),
 ('20261028228000','flow_apply_internal_effect(uuid,uuid)','f','CREATED_BY_20261028228000_INTERNAL_ACTIONS')),
oc AS (
 SELECT ob.*,
  CASE WHEN ob.kind='f' THEN to_regprocedure('public.'||ob.name)::oid ELSE to_regclass('public.'||ob.name)::oid END AS oid,
  CASE WHEN ob.kind='f' THEN obj_description(to_regprocedure('public.'||ob.name),'pg_proc')
   ELSE obj_description(to_regclass('public.'||ob.name),'pg_class') END AS m
 FROM ob
),
mg AS (
 SELECT oc.mig,count(*) AS total,count(oc.oid) AS present,count(*) FILTER(WHERE oc.m IS NOT DISTINCT FROM oc.marker) AS marked
 FROM oc GROUP BY oc.mig
),
uid_col AS (
 SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=to_regclass('public.tenants')
  AND a.attname='user_id' AND a.attnum>0 AND NOT a.attisdropped) AS ok
),
pf AS (
 SELECT r.mig,r.label FROM uid_col CROSS JOIN LATERAL (VALUES
  ('20261028227000','table public.tenants',to_regclass('public.tenants') IS NOT NULL),
  ('20261028227000','table public.conversations',to_regclass('public.conversations') IS NOT NULL),
  ('20261028227000','table auth.users',to_regclass('auth.users') IS NOT NULL),
  ('20261028227000','function auth.uid() (tenant_staff_self_read policy)',to_regprocedure('auth.uid()') IS NOT NULL),
  ('20261028227000','roles anon, authenticated, service_role',
   (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN('anon','authenticated','service_role'))=3),
  ('20261028227000','column public.tenants.user_id (read by flow_staff_can, flow-staff-inbox, flow-internal-worker)',uid_col.ok),
  ('20261028228000','20261028227000 markers on tenant_staff_memberships, tenant_conversation_assignments, conversations_staff_scope_uq',
   obj_description(to_regclass('public.tenant_staff_memberships'),'pg_class') IS NOT DISTINCT FROM 'CREATED_BY_20261028227000_TENANT_STAFF'
   AND obj_description(to_regclass('public.tenant_conversation_assignments'),'pg_class') IS NOT DISTINCT FROM 'CREATED_BY_20261028227000_TENANT_STAFF'
   AND obj_description(to_regclass('public.conversations_staff_scope_uq'),'pg_class') IS NOT DISTINCT FROM 'CREATED_BY_20261028227000_TENANT_STAFF'),
  ('20261028228000','unique key (tenant_id,id) on public.automation_flow_outbox (foreign key target)',
   EXISTS(SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indrelid=to_regclass('public.automation_flow_outbox')
     AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
          FROM unnest(i.indkey::int2[]) k(attnum)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)=ARRAY['id','tenant_id'])),
  ('20261028228000','outbox effect_kind check allowing tag, untag, staff_notification',
   EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid=to_regclass('public.automation_flow_outbox') AND c.contype='c'
     AND pg_get_constraintdef(c.oid) LIKE '%effect_kind%' AND pg_get_constraintdef(c.oid) LIKE '%''tag''%'
     AND pg_get_constraintdef(c.oid) LIKE '%''untag''%' AND pg_get_constraintdef(c.oid) LIKE '%''staff_notification''%')),
  ('20261028228000','outbox delivery_status check allowing settled',
   EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid=to_regclass('public.automation_flow_outbox') AND c.contype='c'
     AND pg_get_constraintdef(c.oid) LIKE '%delivery_status%' AND pg_get_constraintdef(c.oid) LIKE '%''settled''%')),
  ('20261028228000','tables automation_flow_runs, automation_flow_activations, automation_flow_global_switch, automation_flow_tenant_switches',
   to_regclass('public.automation_flow_runs') IS NOT NULL AND to_regclass('public.automation_flow_activations') IS NOT NULL
   AND to_regclass('public.automation_flow_global_switch') IS NOT NULL AND to_regclass('public.automation_flow_tenant_switches') IS NOT NULL),
  ('20261028228000','column public.tenants.user_id (staff_notification fallback recipient)',uid_col.ok)
 ) r(mig,label,ok) WHERE NOT r.ok
)
SELECT section,item,status,tenant_id,n,ids,detail FROM (
 SELECT 0 AS ord,'g_staff_internal_actions'::text AS section,'migration:'||mg.mig AS item,
  CASE WHEN mg.present=0 THEN 'ABSENT'
   WHEN mg.present=mg.total AND mg.marked=mg.total THEN 'OK'
   ELSE 'CONFLICT: '||mg.mig||' objects' END AS status,
  NULL::uuid AS tenant_id,mg.present AS n,NULL::text AS ids,
  CASE WHEN mg.present=0
    THEN mg.mig||' not applied (separately approved; no 20261029125000..180000 migration depends on it; '
     ||CASE WHEN mg.mig='20261028227000' THEN 'flow-staff-inbox and 20261028228000 need it)'
      ELSE 'flow-internal-worker tag/untag/staff_notification effects need it)' END
   WHEN mg.present=mg.total AND mg.marked=mg.total
    THEN format('installed (%s of %s objects carry its marker); a re-apply is refused by its guard (expected); '
     'rollback order: 20261028228000 then 20261028227000; each rollback refuses while its tables hold rows',mg.marked,mg.total)
   ELSE format('partial or unrecognized state: present=%s/%s with marker=%s/%s; its guard refuses a re-apply while any object exists '
     'and its rollback requires the markers',mg.present,mg.total,mg.marked,mg.total) END AS detail
 FROM mg
 UNION ALL
 SELECT 1,'g_staff_internal_actions','preflight:'||mg.mig,
  CASE WHEN NOT EXISTS(SELECT 1 FROM pf WHERE pf.mig=mg.mig) THEN 'OK'
   WHEN mg.present>0 THEN 'MISSING: '||(SELECT min(pf.label) FROM pf WHERE pf.mig=mg.mig)
   ELSE 'INFO' END,
  NULL,(SELECT count(*) FROM pf WHERE pf.mig=mg.mig),NULL,
  CASE WHEN NOT EXISTS(SELECT 1 FROM pf WHERE pf.mig=mg.mig) THEN 'all '||mg.mig||' requirements satisfied'
   WHEN mg.present>0 THEN 'installed but unmet: '||(SELECT string_agg(pf.label,'; ' ORDER BY pf.label) FROM pf WHERE pf.mig=mg.mig)
   ELSE 'unmet (normal until its prerequisites are applied): '||(SELECT string_agg(pf.label,'; ' ORDER BY pf.label) FROM pf WHERE pf.mig=mg.mig) END
 FROM mg
 UNION ALL
 SELECT 2,'g_staff_internal_actions','table:public.'||sx.name,
  CASE WHEN sx.oid IS NULL THEN 'ABSENT'
   WHEN sx.m IS DISTINCT FROM sx.marker THEN 'CONFLICT: public.'||sx.name
   WHEN sx.miss_cols IS NOT NULL OR sx.pkc IS DISTINCT FROM sx.pk OR sx.fkc IS DISTINCT FROM sx.fkw
    THEN 'CONFLICT: public.'||sx.name||' definition'
   WHEN NOT sx.rls OR sx.pol_bad OR sx.cl<>sx.client OR sx.svc_bad
    THEN 'CONFLICT: public.'||sx.name||' privileges'
   ELSE 'OK' END,
  NULL,CASE WHEN sx.reltuples>=0 THEN sx.reltuples::bigint END,NULL,
  CASE WHEN sx.oid IS NULL THEN 'created by '||sx.mig
   ELSE format('marker=%s rls=%s policies=%s client_privileges=%s (expected %s) service_role=%s (needs %s) '
    'estimated_rows=%s%s%s%s',
    coalesce(sx.m,'-'),sx.rls,sx.pols,coalesce(nullif(sx.cl,''),'none'),coalesce(nullif(sx.client,''),'none'),
    coalesce(nullif(sx.sv,''),'none'),sx.svc,
    CASE WHEN sx.reltuples<0 THEN 'unknown' ELSE sx.reltuples::bigint::text END,
    CASE WHEN sx.miss_cols IS NOT NULL THEN '; missing columns: '||sx.miss_cols ELSE '' END,
    CASE WHEN sx.pkc IS DISTINCT FROM sx.pk THEN format('; primary key (%s) expected (%s)',coalesce(sx.pkc,'none'),sx.pk) ELSE '' END,
    CASE WHEN sx.fkc IS DISTINCT FROM sx.fkw THEN format('; foreign keys %s expected %s',coalesce(sx.fkc,'none'),sx.fkw) ELSE '' END) END
 FROM sx
 UNION ALL
 SELECT 3,'g_staff_internal_actions','index:public.'||ic.name,
  CASE WHEN ic.oid IS NULL THEN 'ABSENT'
   WHEN ic.marker IS NOT NULL AND ic.m IS DISTINCT FROM ic.marker THEN 'CONFLICT: public.'||ic.name
   WHEN NOT coalesce(ic.on_tbl,false) OR ic.icols IS DISTINCT FROM ic.cols OR ic.indisunique IS DISTINCT FROM ic.uniq
     OR NOT coalesce(ic.usable,false) OR NOT coalesce(ic.plain,false)
    THEN 'CONFLICT: public.'||ic.name||' definition'
   ELSE 'OK' END,
  NULL,NULL,NULL,
  CASE WHEN ic.oid IS NULL THEN 'built by '||ic.mig
   ELSE format('marker=%s columns=%s unique=%s valid=%s plain=%s (expected public.%s(%s) unique=%s)',
    coalesce(ic.m,'-'),coalesce(ic.icols,'-'),ic.indisunique,ic.usable,ic.plain,ic.tbl,ic.cols,ic.uniq) END
 FROM ic
 UNION ALL
 SELECT 4,'g_staff_internal_actions','function:public.'||fc.sig,
  CASE WHEN fc.oid IS NULL THEN 'ABSENT'
   WHEN fc.m IS DISTINCT FROM fc.marker THEN 'CONFLICT: public.'||fc.sig
   WHEN fc.ph IS DISTINCT FROM fc.h OR fc.prosecdef OR fc.cfg<>'search_path=""' THEN 'CONFLICT: public.'||fc.sig||' body'
   WHEN fc.exposed OR NOT fc.svc_ok THEN 'CONFLICT: public.'||fc.sig||' privileges'
   ELSE 'OK' END,
  NULL,NULL,NULL,
  CASE WHEN fc.oid IS NULL THEN 'created by '||fc.mig||'; '||fc.why
   ELSE format('marker=%s body_md5=%s security_definer=%s config=%s public_or_client_privilege=%s service_role_may_run=%s; %s',
    coalesce(fc.m,'-'),fc.ph,fc.prosecdef,fc.cfg,fc.exposed,fc.svc_ok,fc.why) END
 FROM fc
 UNION ALL
 SELECT 5,'g_staff_internal_actions','lock_impact:public.conversations',
  CASE WHEN c.oid IS NULL THEN 'MISSING: public.conversations'
   WHEN to_regclass('public.conversations_staff_scope_uq') IS NOT NULL THEN 'OK' ELSE 'INFO' END,
  NULL,CASE WHEN c.reltuples>=0 THEN c.reltuples::bigint END,NULL,
  CASE WHEN c.oid IS NULL THEN '20261028227000 requires public.conversations'
   WHEN to_regclass('public.conversations_staff_scope_uq') IS NOT NULL THEN 'conversations_staff_scope_uq already built'
   ELSE format('estimated_rows=%s total_size=%s (%s bytes); 20261028227000 builds the unique index conversations_staff_scope_uq '
    'non-concurrently in its transaction (writes to conversations, i.e. inbound handling, wait until it ends) and adds '
    'foreign keys referencing conversations; 20261028228000 adds foreign keys referencing conversations and '
    'automation_flow_outbox. Neither sets lock_timeout: run with PGOPTIONS=''-c lock_timeout=3s -c statement_timeout=60s''',
    CASE WHEN c.reltuples<0 THEN 'unknown (never analyzed)' ELSE c.reltuples::bigint::text END,
    pg_size_pretty(pg_total_relation_size(c.oid)),pg_total_relation_size(c.oid)) END
 FROM (SELECT 1) one LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass('public.conversations')
) x ORDER BY ord,item;

ROLLBACK;
