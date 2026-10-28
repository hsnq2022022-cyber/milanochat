/**
 * Passive flow observation gate for the existing milan-api webhook path.
 * It NEVER selects a responder, persists runs, debits, or sends messages.
 *
 * Existing reply behavior must be unchanged even when both database flags
 * are on: until a durable runner and a real Meta canary pass, legacy AI owns
 * every supported event. This module only allows diagnostic observation.
 */
export type FlowShadowFlags = {
  enabled: boolean;
  test_only?: boolean;
};
export type FlowShadowReader = {
  readGlobal(): Promise<FlowShadowFlags | null>;
  readTenant(tenantId: string): Promise<FlowShadowFlags | null>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Fail closed on every error or missing row; use only server-verified IDs. */
export async function flowShadowMayObserve(
  mode: string | undefined,
  verifiedTenantId: string,
  verifiedAccountId: string,
  reader: FlowShadowReader,
): Promise<boolean> {
  // No reads, logging, or work when off. This is the default.
  if (mode !== "observe") return false;
  if (!UUID.test(verifiedTenantId) || !UUID.test(verifiedAccountId)) {
    return false;
  }
  try {
    const global = await reader.readGlobal();
    if (global?.enabled !== true) return false;
    const tenant = await reader.readTenant(verifiedTenantId);
    // A normal tenant may not be used as an observation canary.
    return tenant?.enabled === true && tenant?.test_only === true;
  } catch {
    // Missing tables, network errors, RLS/config problems: legacy AI remains
    // the only responder; a diagnostic must never interrupt customer support.
    return false;
  }
}
