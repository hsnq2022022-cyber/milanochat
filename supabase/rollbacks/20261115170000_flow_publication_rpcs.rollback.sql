-- REVIEW ONLY rollback of 20261115170000_flow_publication_rpcs. NOT applied anywhere by this repository.
-- Never `supabase db push`.
--
-- Removes ONLY what that migration created, recognised by its marker CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS:
-- on a database where the migration created the functions (and the rate window table), they are dropped;
-- adopted objects (production: they pre-existed, no marker or the historical rate limiter marker) are
-- left exactly as they are, so this rollback can never remove the publication RPCs production runs.
-- Same guards as the migration: every present function must be the verified definition (attributes and
-- body md5), the rate table must have the installed shape, and no other overload may exist; otherwise it
-- aborts with nothing changed. The rate window table is dropped only when it carries this marker AND is
-- empty, unless the operator opts in with PGOPTIONS="-c flow.rollback_20261115170000=discard-rate-windows".
-- Idempotent: over a rolled back state it changes nothing.
-- ROLLBACK ORDER: roll this back before anything that depends on the publication functions.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE r record; v_fn regprocedure; p record; v_rel regclass; v_created text := '|';
BEGIN
 -- (1) The installed tables and columns the four functions read and write must exist. This migration
 -- never creates or alters them (production-installed objects; fixtures mirror them for tests).
 FOR r IN SELECT * FROM (VALUES
  ('tenants','id'),('tenants','user_id'),('tenants','is_active'),
  ('channel_accounts','id'),('channel_accounts','tenant_id'),('channel_accounts','platform'),
  ('channel_accounts','is_active'),('channel_accounts','agent_enabled'),('channel_accounts','auto_reply'),
  ('automation_flow_global_switch','singleton'),('automation_flow_global_switch','enabled'),
  ('automation_flow_tenant_switches','tenant_id'),('automation_flow_tenant_switches','enabled'),
  ('automation_flow_tenant_switches','test_only'),('automation_flow_tenant_switches','production_approved'),
  ('automation_flow_publications','tenant_id'),('automation_flow_publications','flow_key'),
  ('automation_flow_publications','revision'),('automation_flow_publications','channel_account_id'),
  ('automation_flow_publications','platform'),('automation_flow_publications','document'),
  ('automation_flow_publications','published_by'),
  ('automation_flow_activations','tenant_id'),('automation_flow_activations','channel_account_id'),
  ('automation_flow_activations','platform'),('automation_flow_activations','flow_key'),
  ('automation_flow_activations','revision'),('automation_flow_activations','is_active'),
  ('automation_flow_activations','activated_at'),('automation_flow_activations','updated_at')
 ) c(t,col) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=to_regclass('public.'||r.t) AND a.attname=r.col AND a.attnum>0 AND NOT a.attisdropped) THEN
   RAISE EXCEPTION 'Missing public.%.%; the installed Flow runtime, switch and tenant tables are required first', r.t, r.col;
  END IF;
 END LOOP;
 -- flow_activate_revision upserts on this exact unique key.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
   WHERE i.indrelid='public.automation_flow_activations'::regclass AND i.indisunique
    AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
         JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)
        = ARRAY['tenant_id','channel_account_id','platform','flow_key']) THEN
  RAISE EXCEPTION 'public.automation_flow_activations lacks its unique (tenant_id,channel_account_id,platform,flow_key) key';
 END IF;
 -- (2) The rate window table: absent (created below) or exactly the installed shape; anything else is refused.
 v_rel := to_regclass('public.flow_publication_rate_windows');
 IF v_rel IS NULL THEN
  v_created := v_created||'rate_windows|';
 ELSE
  IF split_part(coalesce(obj_description(v_rel,'pg_class'),''),' ',1) NOT IN('CREATED_BY_20261028200000_FLOW_PUBLICATION_RATE_LIMIT','CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS')
   OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid=v_rel)
   OR (SELECT string_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||CASE WHEN a.attnotnull THEN ' NN' ELSE '' END,',' ORDER BY a.attnum)
       FROM pg_catalog.pg_attribute a WHERE a.attrelid=v_rel AND a.attnum>0 AND NOT a.attisdropped)
      IS DISTINCT FROM 'tenant_id uuid NN,window_start timestamp with time zone NN,request_count integer NN'
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=v_rel AND k.contype='p'
      AND pg_catalog.pg_get_constraintdef(k.oid)='PRIMARY KEY (tenant_id, window_start)')
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=v_rel AND k.contype='c'
      AND pg_catalog.pg_get_constraintdef(k.oid)='CHECK (((request_count >= 1) AND (request_count <= 30)))') THEN
   RAISE EXCEPTION 'Existing public.flow_publication_rate_windows is not the recognised rate limiter table; refusing to use it';
  END IF;
 END IF;
 -- (3) The four functions: no other overload; absent (created below) or exactly the verified production
 -- definition (attributes and body md5 of the whitespace-normalised prosrc). The comment may be empty,
 -- this migration's marker or the historical rate limiter marker. Anything else is drift: refuse.
 FOR r IN SELECT * FROM (VALUES
  ('flow_publish_revision','public.flow_publish_revision(uuid,uuid,text,text,uuid,jsonb)','p_tenant_id uuid, p_account_id uuid, p_platform text, p_flow_key text, p_actor_id uuid, p_document jsonb','bigint','0af572406d18d48d737d89fe4aa6b4db'),
  ('flow_activate_revision','public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid)','p_tenant_id uuid, p_account_id uuid, p_platform text, p_flow_key text, p_revision bigint, p_actor_id uuid','boolean','3b11ae1b179956791b1d13a663b03b03'),
  ('flow_deactivate_revision','public.flow_deactivate_revision(uuid,uuid,text,text,uuid)','p_tenant_id uuid, p_account_id uuid, p_platform text, p_flow_key text, p_actor_id uuid','boolean','c24977b58a9873b3946c25d186fad9d4'),
  ('flow_publication_rate_allow','public.flow_publication_rate_allow(uuid)','p_tenant_id uuid','boolean','539eecaaa05b083eda3b402e5b8b2193')
 ) f(name,sig,args,res,h) LOOP
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc x
    WHERE x.pronamespace='public'::regnamespace AND x.proname=r.name
     AND x.oid IS DISTINCT FROM to_regprocedure(r.sig)) THEN
   RAISE EXCEPTION 'Unrecognized overload of public.% exists; refusing to replace it', r.name;
  END IF;
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NULL THEN
   v_created := v_created||r.name||'|';
  ELSE
   SELECT x.* INTO p FROM pg_catalog.pg_proc x WHERE x.oid=v_fn;
   IF coalesce(obj_description(v_fn,'pg_proc'),'CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS') NOT IN('CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS','CREATED_BY_20261028200000_FLOW_PUBLICATION_RATE_LIMIT')
   OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
   OR p.prokind<>'f' OR p.prosecdef OR p.proisstrict OR p.provolatile<>'v'
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
   OR pg_catalog.pg_get_function_arguments(v_fn) IS DISTINCT FROM r.args
   OR pg_catalog.pg_get_function_result(v_fn) IS DISTINCT FROM r.res
   OR md5(btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))) IS DISTINCT FROM r.h THEN
    RAISE EXCEPTION 'Existing public.% differs from the verified production definition; refusing to replace it', r.name;
   END IF;
  END IF;
 END LOOP;
END
$guard$;

DO $drop$
DECLARE r record; v_fn regprocedure; v_rel regclass := to_regclass('public.flow_publication_rate_windows'); v_rows bigint;
BEGIN
 IF v_rel IS NOT NULL AND coalesce(obj_description(v_rel,'pg_class'),'')='CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS' THEN
  EXECUTE 'SELECT count(*) FROM public.flow_publication_rate_windows' INTO v_rows;
  IF v_rows>0 AND coalesce(current_setting('flow.rollback_20261115170000',true),'')<>'discard-rate-windows' THEN
   RAISE EXCEPTION 'Refusing 20261115170000 rollback: % rate window row(s) exist (they expire after 48 hours); empty the table or opt in with flow.rollback_20261115170000=discard-rate-windows', v_rows;
  END IF;
 END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.flow_publish_revision(uuid,uuid,text,text,uuid,jsonb)'),
  ('public.flow_activate_revision(uuid,uuid,text,text,bigint,uuid)'),
  ('public.flow_deactivate_revision(uuid,uuid,text,text,uuid)'),
  ('public.flow_publication_rate_allow(uuid)')) f(sig) LOOP
  v_fn := to_regprocedure(r.sig);
  IF v_fn IS NOT NULL AND obj_description(v_fn,'pg_proc')='CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS' THEN
   EXECUTE format('DROP FUNCTION %s',v_fn);
  ELSIF v_fn IS NOT NULL THEN
   RAISE NOTICE '% left in place: it pre-existed this migration (adopted, not created)', r.sig;
  END IF;
 END LOOP;
 IF v_rel IS NOT NULL AND coalesce(obj_description(v_rel,'pg_class'),'')='CREATED_BY_20261115170000_FLOW_PUBLICATION_RPCS' THEN
  DROP TABLE public.flow_publication_rate_windows;
 END IF;
END
$drop$;
COMMIT;
