export type StorageMode = "columns" | "drafts";

export type Config = {
  supabaseUrl: string;
  serviceRoleKey: string;
  storage: StorageMode;
  table: string;
  allowedTenantId: string | null;
};

export class ConfigError extends Error {}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/** Reads configuration from env only. Error messages never include secret values. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing: string[] = [];
  const url = (env.SUPABASE_URL ?? "").trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url) missing.push("SUPABASE_URL");
  if (!key) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) throw new ConfigError("Missing required environment variable(s): " + missing.join(", ") + ". See mcp-server/.env.example.");

  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ConfigError("SUPABASE_URL is not a valid URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:"))
    throw new ConfigError("SUPABASE_URL must use https (http is accepted only for localhost).");
  if (parsed.username || parsed.password) throw new ConfigError("SUPABASE_URL must not contain credentials.");

  const storageRaw = (env.MILANO_FLOWS_STORAGE ?? "").trim() || "columns";
  if (storageRaw !== "columns" && storageRaw !== "drafts")
    throw new ConfigError("MILANO_FLOWS_STORAGE must be 'columns' or 'drafts'.");
  const storage: StorageMode = storageRaw;

  const table = (env.MILANO_FLOWS_TABLE ?? "").trim() || (storage === "drafts" ? "automation_flow_drafts" : "automation_flows");
  if (!TABLE_RE.test(table)) throw new ConfigError("MILANO_FLOWS_TABLE must be a plain lowercase table name (a-z, 0-9, _).");

  const tenant = (env.MILANO_ALLOWED_TENANT_ID ?? "").trim();
  if (tenant && !UUID_RE.test(tenant)) throw new ConfigError("MILANO_ALLOWED_TENANT_ID must be a uuid.");

  return { supabaseUrl: parsed.origin, serviceRoleKey: key, storage, table, allowedTenantId: tenant ? tenant.toLowerCase() : null };
}

export type OAuthConfig = {
  /** Public origin of this server (MCP_PUBLIC_URL), no trailing slash, e.g. https://abc.ngrok.app */
  publicOrigin: string;
  /** Authorization server issuer = MCP_PUBLIC_URL as URL.href (trailing slash), used in metadata and the JWT iss claim. */
  issuer: string;
  /** Protected resource = <origin>/mcp (JWT aud). */
  resource: string;
  signingSecret: string;
  sessionSecret: string;
  anonKey: string;
  databaseUrl: string | null;
  databaseSsl: "verify" | "no-verify" | "disable";
  databaseSslCaFile: string | null;
  /** false only with MCP_INSECURE_COOKIES=true (local non-production http dev). */
  cookieSecure: boolean;
  maxClientsPerHour: number;
};

export type HttpConfig = Config & {
  port: number;
  /** Supabase JWT secret; "" when MCP_ALLOW_STATIC_BEARER is off. */
  jwtSecret: string;
  /** TESTING ONLY: honor X-Milano-Tenant without a token. Refused when NODE_ENV=production. */
  allowSecretHeader: boolean;
  /** Accept Supabase user access tokens (HS256, SUPABASE_JWT_SECRET) as Bearer. Default: off in production, on elsewhere. */
  allowStaticBearer: boolean;
  /** Express "trust proxy" value: false (default) or a hop count (1 behind ngrok/Railway). */
  trustProxy: false | number;
  production: boolean;
  oauth: OAuthConfig | null;
};

export const MIN_JWT_SECRET_LENGTH = 32;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function boolFlag(env: NodeJS.ProcessEnv, name: string, dflt: boolean): boolean {
  const v = (env[name] ?? "").trim().toLowerCase();
  if (!v) return dflt;
  if (v !== "true" && v !== "false") throw new ConfigError(`${name} must be 'true' or 'false'.`);
  return v === "true";
}

/**
 * Configuration for the remote HTTP server only (stdio never needs the JWT secret).
 * Lists every missing required name at once; never echoes values.
 */
export function loadHttpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const production = (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
  const allowSecretHeader = boolFlag(env, "MCP_ALLOW_SECRET_HEADER", false);
  const allowStaticBearer = boolFlag(env, "MCP_ALLOW_STATIC_BEARER", !production);
  const oauthEnabled = boolFlag(env, "MCP_OAUTH_ENABLED", false);
  const insecureCookies = boolFlag(env, "MCP_INSECURE_COOKIES", false);

  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  if (allowStaticBearer) required.push("SUPABASE_JWT_SECRET");
  if (oauthEnabled) {
    required.push("MCP_PUBLIC_URL", "MCP_OAUTH_SIGNING_SECRET", "SESSION_SECRET", "SUPABASE_ANON_KEY");
    if (production) required.push("DATABASE_URL");
  }
  const missing = required.filter(n => !(env[n] ?? "").trim());
  if (missing.length) {
    const why = oauthEnabled && production && missing.includes("DATABASE_URL")
      ? " (DATABASE_URL is required in production: the in-memory OAuth store is for local development only)" : "";
    throw new ConfigError("Missing required environment variable(s): " + missing.join(", ") + why + ". See mcp-server/.env.example.");
  }
  const jwtSecret = allowStaticBearer ? (env.SUPABASE_JWT_SECRET ?? "").trim() : "";
  if (allowStaticBearer && jwtSecret.length < MIN_JWT_SECRET_LENGTH)
    throw new ConfigError(`SUPABASE_JWT_SECRET is too short (minimum ${MIN_JWT_SECRET_LENGTH} characters). Use the project's JWT secret.`);
  const base = loadConfig(env);

  const portRaw = (env.PORT ?? "").trim() || "8080";
  if (!/^\d{1,5}$/.test(portRaw) || Number(portRaw) > 65535) throw new ConfigError("PORT must be an integer between 0 and 65535.");

  if (allowSecretHeader && production)
    throw new ConfigError("Refusing to start: MCP_ALLOW_SECRET_HEADER=true is a testing-only auth bypass and is not allowed when NODE_ENV=production.");
  if (insecureCookies && production)
    throw new ConfigError("Refusing to start: MCP_INSECURE_COOKIES=true is for local http development only and is not allowed when NODE_ENV=production.");
  if (production && !oauthEnabled && !allowStaticBearer)
    throw new ConfigError("Refusing to start: no authentication method is enabled. Set MCP_OAUTH_ENABLED=true (or MCP_ALLOW_STATIC_BEARER=true).");

  const tp = (env.TRUST_PROXY ?? "").trim().toLowerCase();
  let trustProxy: false | number = false;
  if (tp && tp !== "false" && tp !== "0") {
    if (!/^\d{1,2}$/.test(tp)) throw new ConfigError("TRUST_PROXY must be 'false' or the number of proxy hops in front of this server (e.g. 1 for ngrok/Railway).");
    trustProxy = Number(tp);
  }

  let oauth: OAuthConfig | null = null;
  if (oauthEnabled) {
    let pub: URL;
    try { pub = new URL((env.MCP_PUBLIC_URL ?? "").trim()); } catch { throw new ConfigError("MCP_PUBLIC_URL is not a valid URL."); }
    const local = LOCAL_HOSTS.has(pub.hostname);
    if (pub.protocol !== "https:" && !(pub.protocol === "http:" && local))
      throw new ConfigError("MCP_PUBLIC_URL must use https (http is accepted only for localhost / 127.0.0.1).");
    if (production && pub.protocol !== "https:") throw new ConfigError("MCP_PUBLIC_URL must use https when NODE_ENV=production.");
    if (pub.username || pub.password || pub.search || pub.hash || (pub.pathname !== "/" && pub.pathname !== ""))
      throw new ConfigError("MCP_PUBLIC_URL must be a bare origin (scheme://host[:port]) without path, query, fragment or credentials.");
    const signingSecret = (env.MCP_OAUTH_SIGNING_SECRET ?? "").trim();
    const sessionSecret = (env.SESSION_SECRET ?? "").trim();
    if (signingSecret.length < MIN_JWT_SECRET_LENGTH)
      throw new ConfigError(`MCP_OAUTH_SIGNING_SECRET is too short (minimum ${MIN_JWT_SECRET_LENGTH} characters, random).`);
    if (sessionSecret.length < MIN_JWT_SECRET_LENGTH)
      throw new ConfigError(`SESSION_SECRET is too short (minimum ${MIN_JWT_SECRET_LENGTH} characters, random).`);
    const supaSecret = (env.SUPABASE_JWT_SECRET ?? "").trim();
    if (supaSecret && signingSecret === supaSecret)
      throw new ConfigError("MCP_OAUTH_SIGNING_SECRET must differ from SUPABASE_JWT_SECRET.");
    if (sessionSecret === signingSecret) throw new ConfigError("SESSION_SECRET must differ from MCP_OAUTH_SIGNING_SECRET.");

    const dbRaw = (env.DATABASE_URL ?? "").trim();
    let databaseUrl: string | null = null;
    if (dbRaw) {
      let u: URL;
      try { u = new URL(dbRaw); } catch { throw new ConfigError("DATABASE_URL is not a valid postgres:// URL."); }
      if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new ConfigError("DATABASE_URL must start with postgres:// or postgresql://.");
      // TLS is configured explicitly below (DATABASE_SSL); libpq-style ssl* parameters would silently override it.
      for (const k of [...u.searchParams.keys()]) if (k.toLowerCase().startsWith("ssl")) u.searchParams.delete(k);
      databaseUrl = u.toString();
    }
    const sslRaw = (env.DATABASE_SSL ?? "").trim().toLowerCase() || "verify";
    if (sslRaw !== "verify" && sslRaw !== "no-verify" && sslRaw !== "disable")
      throw new ConfigError("DATABASE_SSL must be 'verify', 'no-verify' or 'disable'.");
    if (sslRaw === "disable" && databaseUrl) {
      const h = new URL(databaseUrl).hostname;
      if (!(LOCAL_HOSTS.has(h) || h === "")) throw new ConfigError("DATABASE_SSL=disable is allowed only for a local database host.");
    }
    const caFile = (env.DATABASE_SSL_CA_FILE ?? "").trim() || null;

    const capRaw = (env.MCP_OAUTH_MAX_CLIENTS_PER_HOUR ?? "").trim() || "100";
    if (!/^\d{1,5}$/.test(capRaw) || Number(capRaw) < 1) throw new ConfigError("MCP_OAUTH_MAX_CLIENTS_PER_HOUR must be a positive integer.");

    oauth = {
      publicOrigin: pub.origin, issuer: new URL(pub.origin).href, resource: pub.origin + "/mcp",
      signingSecret, sessionSecret, anonKey: (env.SUPABASE_ANON_KEY ?? "").trim(),
      databaseUrl, databaseSsl: sslRaw, databaseSslCaFile: caFile,
      cookieSecure: !insecureCookies, maxClientsPerHour: Number(capRaw),
    };
  }
  return { ...base, port: Number(portRaw), jwtSecret, allowSecretHeader, allowStaticBearer, trustProxy, production, oauth };
}
