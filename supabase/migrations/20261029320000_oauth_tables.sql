-- REVIEW ONLY: OAuth 2.1 storage for the remote MCP HTTP server
-- (mcp-server/, MCP_OAUTH_ENABLED=true). NOT applied anywhere by this
-- repository; apply only with an explicit owner GO. Live state was NOT
-- inspected; existing objects without the marker are refused, never taken over.
--
-- Creates (all marked CREATED_BY_20261029320000_OAUTH_TABLES):
--   public.mcp_oauth_clients               Dynamic Client Registration (RFC 7591).
--     client_secret_hash = SHA-256 hex of the client secret (confidential
--     clients only); the plaintext secret is returned once and never stored.
--   public.mcp_oauth_grant_families        one row per consent (authorization
--     code exchange); every refresh token of the grant belongs to it. Revoking
--     the family (refresh-token reuse, code reuse, /revoke) kills every refresh
--     token AND every access token (JWT claim fam) issued from it.
--   public.mcp_oauth_codes                 authorization codes: code_hash only,
--     single use (consumed_at), TTL <= 10 minutes (server uses 5), bound to
--     client_id + redirect_uri + code_challenge (PKCE S256) + user_id.
--   public.mcp_oauth_refresh_tokens        token_hash only, rotated on every use
--     (used_at), TTL <= 31 days (server uses 30).
--   public.mcp_oauth_revoked_access_tokens jti denylist for revoked JWT access
--     tokens, kept until the token's own expiry.
--   public.mcp_oauth_cleanup(timestamptz) RETURNS integer: deletes expired /
--     dead rows (bounded); called by the server on startup and periodically.
--   All tables: RLS enabled with NO policies; PUBLIC/anon/authenticated have no
--   privilege; service_role SELECT/INSERT/UPDATE/DELETE. The MCP server uses
--   the owner connection (DATABASE_URL). The function is SECURITY DEFINER,
--   SET search_path = '', EXECUTE for service_role only.
-- No secret, password or token is ever stored in plaintext.
-- user_id references auth.users(id) ON DELETE CASCADE (a deleted user loses
-- every grant). Tenants are NOT stored here: the server resolves
-- public.tenants by user_id on every request.
-- Idempotent: existing objects are accepted only with the marker; the function
-- is (re)created. Preflight refuses unless roles anon/authenticated/
-- service_role and auth.users(id) exist.
-- Order: independent of every other migration.
-- Rollback: supabase/rollbacks/20261029320000_oauth_tables.rollback.sql
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $preflight$
DECLARE
 v_marker constant text := 'CREATED_BY_20261029320000_OAUTH_TABLES';
 v_name text;
BEGIN
 FOREACH v_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_name) THEN
   RAISE EXCEPTION 'mcp oauth prerequisite missing: role %', v_name;
  END IF;
 END LOOP;
 IF to_regclass('auth.users') IS NULL THEN
  RAISE EXCEPTION 'mcp oauth prerequisite missing: table auth.users';
 END IF;
 FOREACH v_name IN ARRAY ARRAY['public.mcp_oauth_clients','public.mcp_oauth_grant_families',
                               'public.mcp_oauth_codes','public.mcp_oauth_refresh_tokens',
                               'public.mcp_oauth_revoked_access_tokens'] LOOP
  IF to_regclass(v_name) IS NOT NULL
     AND obj_description(to_regclass(v_name),'pg_class') IS DISTINCT FROM v_marker THEN
   RAISE EXCEPTION '% exists without marker %; refusing to take it over', v_name, v_marker;
  END IF;
 END LOOP;
 IF to_regprocedure('public.mcp_oauth_cleanup(timestamptz)') IS NOT NULL
    AND obj_description(to_regprocedure('public.mcp_oauth_cleanup(timestamptz)'),'pg_proc') IS DISTINCT FROM v_marker THEN
  RAISE EXCEPTION 'public.mcp_oauth_cleanup(timestamptz) exists without marker %; refusing to replace it', v_marker;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc
            WHERE pronamespace='public'::regnamespace AND proname = 'mcp_oauth_cleanup'
              AND oid <> coalesce(to_regprocedure('public.mcp_oauth_cleanup(timestamptz)'),0)) THEN
  RAISE EXCEPTION 'unexpected overload of public.mcp_oauth_cleanup; refusing';
 END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.mcp_oauth_clients (
 client_id text PRIMARY KEY CHECK (client_id ~ '^[A-Za-z0-9_-]{16,64}$'),
 client_secret_hash text CHECK (client_secret_hash IS NULL OR client_secret_hash ~ '^[0-9a-f]{64}$'),
 client_secret_expires_at timestamptz,
 client_name text CHECK (client_name IS NULL OR char_length(client_name) <= 100),
 redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
 token_endpoint_auth_method text NOT NULL CHECK (token_endpoint_auth_method IN ('none','client_secret_post')),
 grant_types text[] NOT NULL,
 response_types text[] NOT NULL,
 scope text NOT NULL CHECK (char_length(scope) <= 200),
 created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz,
 CONSTRAINT mcp_oauth_clients_secret_chk CHECK (
  (token_endpoint_auth_method = 'none' AND client_secret_hash IS NULL) OR
  (token_endpoint_auth_method = 'client_secret_post' AND client_secret_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mcp_oauth_clients_created_idx ON public.mcp_oauth_clients (created_at);

CREATE TABLE IF NOT EXISTS public.mcp_oauth_grant_families (
 family_id uuid PRIMARY KEY,
 client_id text NOT NULL REFERENCES public.mcp_oauth_clients(client_id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 scope text NOT NULL CHECK (char_length(scope) <= 200),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 revoked_reason text CHECK (revoked_reason IS NULL OR revoked_reason IN ('refresh_reuse','code_reuse','revoked')),
 CONSTRAINT mcp_oauth_grant_families_revoked_chk CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS mcp_oauth_grant_families_expires_idx ON public.mcp_oauth_grant_families (expires_at);
CREATE INDEX IF NOT EXISTS mcp_oauth_grant_families_user_idx ON public.mcp_oauth_grant_families (user_id);
CREATE INDEX IF NOT EXISTS mcp_oauth_grant_families_client_idx ON public.mcp_oauth_grant_families (client_id);

CREATE TABLE IF NOT EXISTS public.mcp_oauth_codes (
 code_hash text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
 client_id text NOT NULL REFERENCES public.mcp_oauth_clients(client_id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 redirect_uri text NOT NULL CHECK (char_length(redirect_uri) <= 2000),
 code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
 scope text NOT NULL CHECK (char_length(scope) <= 200),
 resource text NOT NULL CHECK (char_length(resource) <= 2000),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 family_id uuid REFERENCES public.mcp_oauth_grant_families(family_id) ON DELETE SET NULL,
 CONSTRAINT mcp_oauth_codes_ttl_chk CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX IF NOT EXISTS mcp_oauth_codes_expires_idx ON public.mcp_oauth_codes (expires_at);
CREATE INDEX IF NOT EXISTS mcp_oauth_codes_client_idx ON public.mcp_oauth_codes (client_id);
CREATE INDEX IF NOT EXISTS mcp_oauth_codes_family_idx ON public.mcp_oauth_codes (family_id);

CREATE TABLE IF NOT EXISTS public.mcp_oauth_refresh_tokens (
 token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 family_id uuid NOT NULL REFERENCES public.mcp_oauth_grant_families(family_id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 CONSTRAINT mcp_oauth_refresh_tokens_ttl_chk CHECK (expires_at > created_at AND expires_at <= created_at + interval '31 days')
);
CREATE INDEX IF NOT EXISTS mcp_oauth_refresh_tokens_family_idx ON public.mcp_oauth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS mcp_oauth_refresh_tokens_expires_idx ON public.mcp_oauth_refresh_tokens (expires_at);

CREATE TABLE IF NOT EXISTS public.mcp_oauth_revoked_access_tokens (
 jti uuid PRIMARY KEY,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_oauth_revoked_access_tokens_expires_idx ON public.mcp_oauth_revoked_access_tokens (expires_at);

COMMENT ON TABLE public.mcp_oauth_clients IS 'CREATED_BY_20261029320000_OAUTH_TABLES';
COMMENT ON TABLE public.mcp_oauth_grant_families IS 'CREATED_BY_20261029320000_OAUTH_TABLES';
COMMENT ON TABLE public.mcp_oauth_codes IS 'CREATED_BY_20261029320000_OAUTH_TABLES';
COMMENT ON TABLE public.mcp_oauth_refresh_tokens IS 'CREATED_BY_20261029320000_OAUTH_TABLES';
COMMENT ON TABLE public.mcp_oauth_revoked_access_tokens IS 'CREATED_BY_20261029320000_OAUTH_TABLES';
ALTER TABLE public.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_grant_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_revoked_access_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_oauth_clients FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.mcp_oauth_grant_families FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.mcp_oauth_codes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.mcp_oauth_refresh_tokens FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.mcp_oauth_revoked_access_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mcp_oauth_clients TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mcp_oauth_grant_families TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mcp_oauth_codes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mcp_oauth_refresh_tokens TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mcp_oauth_revoked_access_tokens TO service_role;

-- Deletes dead rows; returns the number of deleted rows (cascades not counted).
--  * codes expired more than 1 hour ago (kept briefly so a replayed code is still
--    recognised and revokes its grant family)
--  * refresh tokens past their expiry
--  * grant families past their expiry, or revoked more than 1 day ago
--  * denylisted jti past the access token's expiry
--  * clients never used 7 days after registration, or idle 180 days with no grant
CREATE OR REPLACE FUNCTION public.mcp_oauth_cleanup(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $cleanup$
DECLARE
 v_now constant timestamptz := coalesce(p_now, pg_catalog.now());
 v_n integer;
 v_total integer := 0;
BEGIN
 DELETE FROM public.mcp_oauth_codes c WHERE c.expires_at < v_now - interval '1 hour';
 GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
 DELETE FROM public.mcp_oauth_refresh_tokens r WHERE r.expires_at < v_now;
 GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
 DELETE FROM public.mcp_oauth_grant_families f
  WHERE f.expires_at < v_now OR f.revoked_at < v_now - interval '1 day';
 GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
 DELETE FROM public.mcp_oauth_revoked_access_tokens a WHERE a.expires_at < v_now;
 GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
 DELETE FROM public.mcp_oauth_clients k
  WHERE (k.last_used_at IS NULL AND k.created_at < v_now - interval '7 days')
     OR (k.last_used_at < v_now - interval '180 days'
         AND NOT EXISTS (SELECT 1 FROM public.mcp_oauth_grant_families f WHERE f.client_id = k.client_id));
 GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
 RETURN v_total;
END
$cleanup$;

COMMENT ON FUNCTION public.mcp_oauth_cleanup(timestamptz) IS 'CREATED_BY_20261029320000_OAUTH_TABLES';
REVOKE ALL ON FUNCTION public.mcp_oauth_cleanup(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_cleanup(timestamptz) TO service_role;

COMMIT;
