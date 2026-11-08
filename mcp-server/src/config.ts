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

export type HttpConfig = Config & {
  port: number;
  jwtSecret: string;
  /** TESTING ONLY: honor X-Milano-Tenant without a token. Refused when NODE_ENV=production. */
  allowSecretHeader: boolean;
  /** Express "trust proxy" value: false (default) or a hop count (1 behind ngrok/Railway). */
  trustProxy: false | number;
};

export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Configuration for the remote HTTP server only (stdio never needs the JWT secret).
 * Lists every missing required name at once; never echoes values.
 */
export function loadHttpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_JWT_SECRET"].filter(n => !(env[n] ?? "").trim());
  if (missing.length) throw new ConfigError("Missing required environment variable(s): " + missing.join(", ") + ". See mcp-server/.env.example.");
  const jwtSecret = (env.SUPABASE_JWT_SECRET ?? "").trim();
  if (jwtSecret.length < MIN_JWT_SECRET_LENGTH)
    throw new ConfigError(`SUPABASE_JWT_SECRET is too short (minimum ${MIN_JWT_SECRET_LENGTH} characters). Use the project's JWT secret.`);
  const base = loadConfig(env);

  const portRaw = (env.PORT ?? "").trim() || "8080";
  if (!/^\d{1,5}$/.test(portRaw) || Number(portRaw) > 65535) throw new ConfigError("PORT must be an integer between 0 and 65535.");

  const flag = (env.MCP_ALLOW_SECRET_HEADER ?? "").trim().toLowerCase();
  if (flag && flag !== "true" && flag !== "false") throw new ConfigError("MCP_ALLOW_SECRET_HEADER must be 'true' or 'false'.");
  const allowSecretHeader = flag === "true";
  if (allowSecretHeader && (env.NODE_ENV ?? "").trim().toLowerCase() === "production")
    throw new ConfigError("Refusing to start: MCP_ALLOW_SECRET_HEADER=true is a testing-only auth bypass and is not allowed when NODE_ENV=production.");

  const tp = (env.TRUST_PROXY ?? "").trim().toLowerCase();
  let trustProxy: false | number = false;
  if (tp && tp !== "false" && tp !== "0") {
    if (!/^\d{1,2}$/.test(tp)) throw new ConfigError("TRUST_PROXY must be 'false' or the number of proxy hops in front of this server (e.g. 1 for ngrok/Railway).");
    trustProxy = Number(tp);
  }
  return { ...base, port: Number(portRaw), jwtSecret, allowSecretHeader, trustProxy };
}
