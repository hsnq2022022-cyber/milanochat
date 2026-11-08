-- REVIEW ONLY rollback for 20261029320000_oauth_tables.
-- NOT applied anywhere by this repository.
--
-- Stop / redeploy the MCP HTTP server with MCP_OAUTH_ENABLED unset FIRST:
-- otherwise every OAuth request (register / authorize / token / MCP calls with
-- an OAuth access token) fails once these tables are gone.
--
-- Drops, in dependency order, public.mcp_oauth_cleanup(timestamptz),
-- public.mcp_oauth_revoked_access_tokens, public.mcp_oauth_refresh_tokens,
-- public.mcp_oauth_codes, public.mcp_oauth_grant_families and
-- public.mcp_oauth_clients, each ONLY when it carries the marker
-- CREATED_BY_20261029320000_OAUTH_TABLES (an unmarked object of the same name
-- makes the rollback REFUSE as a whole).
-- Data guard: the tables hold registered connector clients and live grants
-- (connected Claude.ai / ChatGPT / Cursor users). When ANY of them holds rows
-- the rollback REFUSES unless the session setting
-- milan.rollback_320000 = 'discard-mcp-oauth-grants' is set
-- (e.g. PGOPTIONS='-c milan.rollback_320000=discard-mcp-oauth-grants').
-- Discarding them disconnects every connector; users must connect again.
-- Only hashes are stored, so no secret can be recovered from a backup either.
-- Refuses when nothing of 320000 is installed (nothing to roll back).
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $rb$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029320000_OAUTH_TABLES';
 v_tables constant text[] := ARRAY['public.mcp_oauth_revoked_access_tokens','public.mcp_oauth_refresh_tokens',
                                   'public.mcp_oauth_codes','public.mcp_oauth_grant_families',
                                   'public.mcp_oauth_clients'];
 v_name text;
 v_rows boolean;
 v_any_rows boolean := false;
 v_installed boolean := to_regprocedure('public.mcp_oauth_cleanup(timestamptz)') IS NOT NULL;
BEGIN
 FOREACH v_name IN ARRAY v_tables LOOP
  IF to_regclass(v_name) IS NOT NULL THEN v_installed := true; END IF;
 END LOOP;
 IF NOT v_installed THEN
  RAISE EXCEPTION '20261029320000_oauth_tables is not installed; nothing to roll back';
 END IF;
 IF to_regprocedure('public.mcp_oauth_cleanup(timestamptz)') IS NOT NULL
    AND obj_description(to_regprocedure('public.mcp_oauth_cleanup(timestamptz)'),'pg_proc') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'public.mcp_oauth_cleanup(timestamptz) exists without marker %; refusing to drop it', v_marker;
 END IF;
 FOREACH v_name IN ARRAY v_tables LOOP
  IF to_regclass(v_name) IS NOT NULL THEN
   IF obj_description(to_regclass(v_name),'pg_class') IS DISTINCT FROM v_marker THEN
    RAISE EXCEPTION '% exists without marker %; refusing to drop it', v_name, v_marker;
   END IF;
   EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s)', v_name) INTO v_rows;
   v_any_rows := v_any_rows OR v_rows;
  END IF;
 END LOOP;
 IF v_any_rows AND current_setting('milan.rollback_320000', true) IS DISTINCT FROM 'discard-mcp-oauth-grants' THEN
  RAISE EXCEPTION 'mcp oauth tables hold rows (registered clients / live grants); set milan.rollback_320000=discard-mcp-oauth-grants to discard them';
 END IF;
END
$rb$;

DROP FUNCTION IF EXISTS public.mcp_oauth_cleanup(timestamptz);
DROP TABLE IF EXISTS public.mcp_oauth_revoked_access_tokens;
DROP TABLE IF EXISTS public.mcp_oauth_refresh_tokens;
DROP TABLE IF EXISTS public.mcp_oauth_codes;
DROP TABLE IF EXISTS public.mcp_oauth_grant_families;
DROP TABLE IF EXISTS public.mcp_oauth_clients;

COMMIT;
