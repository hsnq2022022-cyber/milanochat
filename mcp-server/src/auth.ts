import { jwtVerify, type JWTPayload } from "jose";
import type { SupabaseClient } from "@supabase/supabase-js";
import { UUID_RE } from "./config.js";

/**
 * Request authentication for the remote HTTP server.
 * - Bearer JWT (Supabase-style, HS256, SUPABASE_JWT_SECRET): exp verified, sub required,
 *   aud must be 'authenticated' when present, role must be 'authenticated' when present
 *   (rejects anon / service_role keys signed with the same secret).
 * - Tenant: `tenant_id` claim (top level or app_metadata; never user_metadata, which users can edit)
 *   when it is a uuid; otherwise tenants.id where tenants.user_id = sub (same lookup as the
 *   frontend's resolveCloudTenant), cached briefly.
 * - X-Milano-Tenant: TESTING ONLY, honored only when allowSecretHeader is true and no Bearer is sent.
 * Never logs tokens or verification details.
 */
export type AuthOutcome =
  | { ok: true; tenantId: string; via: "jwt" | "test-header" | "oauth" }
  | { ok: false; status: 401 | 403 | 503; reason: "missing" | "invalid" | "no_tenant" | "unavailable" };

export type TenantLookup = (userId: string) => Promise<{ tenantId: string | null } | { error: true }>;

export type AuthenticatorOptions = {
  jwtSecret: string;
  allowSecretHeader: boolean;
  /** Accept Supabase-style static Bearer JWTs (default true). When false every such Bearer is "invalid". */
  allowStaticBearer?: boolean;
  lookupTenant: TenantLookup;
  /** Defense in depth: when set, any other resolved tenant is refused (403). */
  allowedTenantId?: string | null;
  cacheTtlMs?: number;
  cacheMax?: number;
  clockToleranceSec?: number;
};

/** tenants.id for tenants.user_id = userId, via the service-role client. */
export function supabaseTenantLookup(db: Pick<SupabaseClient, "from">): TenantLookup {
  return async userId => {
    if (!UUID_RE.test(userId)) return { tenantId: null };
    const { data, error } = await db.from("tenants").select("id").eq("user_id", userId).maybeSingle();
    if (error) return error.code === "PGRST116" ? { tenantId: null } : { error: true }; // PGRST116: >1 row -> ambiguous
    const id = (data as { id?: unknown } | null)?.id;
    return { tenantId: typeof id === "string" && UUID_RE.test(id) ? id.toLowerCase() : null };
  };
}

function claimTenant(p: JWTPayload): string | null {
  const top = p.tenant_id;
  if (typeof top === "string" && UUID_RE.test(top)) return top.toLowerCase();
  const am = p.app_metadata;
  if (am && typeof am === "object" && !Array.isArray(am)) {
    const t = (am as Record<string, unknown>).tenant_id;
    if (typeof t === "string" && UUID_RE.test(t)) return t.toLowerCase();
  }
  return null;
}

export function createAuthenticator(opts: AuthenticatorOptions) {
  const key = new TextEncoder().encode(opts.jwtSecret);
  const ttl = opts.cacheTtlMs ?? 60_000, max = opts.cacheMax ?? 1000;
  const cache = new Map<string, { tenantId: string; exp: number }>();
  const allowed = opts.allowedTenantId?.toLowerCase() ?? null;

  async function tenantForUser(sub: string): Promise<string | null | "error"> {
    const hit = cache.get(sub);
    if (hit && hit.exp > Date.now()) return hit.tenantId;
    if (hit) cache.delete(sub);
    let r;
    try { r = await opts.lookupTenant(sub); } catch { return "error"; }
    if ("error" in r) return "error";
    if (r.tenantId) {
      if (cache.size >= max) cache.delete(cache.keys().next().value as string); // evict oldest
      cache.set(sub, { tenantId: r.tenantId, exp: Date.now() + ttl });
    }
    return r.tenantId; // negatives are not cached (a newly created workspace works immediately)
  }

  const scope = (tenantId: string, via: "jwt" | "test-header" | "oauth"): AuthOutcome =>
    allowed && tenantId !== allowed ? { ok: false, status: 403, reason: "no_tenant" } : { ok: true, tenantId, via };

  const allowStatic = opts.allowStaticBearer ?? true;

  return {
    /**
     * Tenant of an already verified user id (OAuth access token `sub`): tenants.user_id = sub only,
     * never a client-supplied value. Same cache and MILANO_ALLOWED_TENANT_ID lock as the JWT path.
     */
    async resolveUserTenant(sub: string): Promise<AuthOutcome> {
      if (!UUID_RE.test(sub)) return { ok: false, status: 403, reason: "no_tenant" };
      const t = await tenantForUser(sub.toLowerCase());
      if (t === "error") return { ok: false, status: 503, reason: "unavailable" };
      return t ? scope(t, "oauth") : { ok: false, status: 403, reason: "no_tenant" };
    },
    async authenticate(headers: { authorization?: string; xMilanoTenant?: string }): Promise<AuthOutcome> {
      const auth = headers.authorization?.trim();
      if (auth) {
        if (!allowStatic) return { ok: false, status: 401, reason: "invalid" };
        const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(auth);
        if (!m) return { ok: false, status: 401, reason: "invalid" };
        let payload: JWTPayload;
        try {
          ({ payload } = await jwtVerify(m[1]!, key, {
            algorithms: ["HS256"], requiredClaims: ["exp", "sub"], clockTolerance: opts.clockToleranceSec ?? 5,
          }));
        } catch { return { ok: false, status: 401, reason: "invalid" }; }
        if (typeof payload.sub !== "string" || !payload.sub.trim()) return { ok: false, status: 401, reason: "invalid" };
        if (payload.aud !== undefined) {
          const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
          if (!auds.includes("authenticated")) return { ok: false, status: 401, reason: "invalid" };
        }
        if (payload.role !== undefined && payload.role !== "authenticated") return { ok: false, status: 401, reason: "invalid" };
        const fromClaim = claimTenant(payload);
        if (fromClaim) return scope(fromClaim, "jwt");
        const t = await tenantForUser(payload.sub);
        if (t === "error") return { ok: false, status: 503, reason: "unavailable" };
        return t ? scope(t, "jwt") : { ok: false, status: 403, reason: "no_tenant" };
      }
      if (opts.allowSecretHeader) {
        const h = headers.xMilanoTenant?.trim();
        if (h && UUID_RE.test(h)) return scope(h.toLowerCase(), "test-header");
      }
      return { ok: false, status: 401, reason: "missing" };
    },
    /** For tests. */
    cacheSize: () => cache.size,
  };
}
