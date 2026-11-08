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
