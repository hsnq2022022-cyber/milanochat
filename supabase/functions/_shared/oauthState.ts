/**
 * S5: signed Meta OAuth state shared by `channels` (issuer, authenticated)
 * and `meta-auth` (callback, public).
 *
 * state = base64url(JSON payload) "." base64url(HMAC-SHA256(secret, body))
 * payload = { v:1, u:userId, t:tenantId, i:nonce, p:platform, iat, exp }
 *
 *  - secret: env OAUTH_STATE_SECRET (>= 32 chars). Missing/short -> fail
 *    CLOSED (issuer answers 503, callback refuses). Never hardcoded.
 *  - the tenant is resolved by the issuer from the verified user only
 *    (issueOAuthState has no tenant parameter at all)
 *  - verification is timing-safe (crypto.subtle.verify), checks shape and
 *    expiry BEFORE anything else; the callback uses ONLY u/t from the state
 *  - single use: the nonce row in meta_oauth_states is claimed atomically
 *    (consumed=false -> true, matching user/tenant/platform, not expired).
 *
 * Pure module: env, clock, nonce, tenant lookup and nonce storage injected.
 */

export type OAuthPlatform = "instagram" | "facebook";
export const OAUTH_PLATFORMS: readonly OAuthPlatform[] = ["instagram", "facebook"];
export const OAUTH_STATE_TTL_SEC = 600;
export const OAUTH_STATE_SECRET_ENV = "OAUTH_STATE_SECRET";
const MAX_STATE_LEN = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64URL = /^[A-Za-z0-9_-]+$/;

export type OAuthStatePayload = {
  v: 1;
  u: string;
  t: string;
  i: string;
  p: OAuthPlatform;
  iat: number;
  exp: number;
};

const enc = new TextEncoder();

/** Returns the configured secret or null (caller must fail closed). */
export function oauthStateSecret(getEnv: (k: string) => string | undefined | null): string | null {
  const s = String(getEnv(OAUTH_STATE_SECRET_ENV) ?? "").trim();
  return s.length >= 32 ? s : null;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  if (!B64URL.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function signOAuthState(
  secret: string,
  p: { userId: string; tenantId: string; platform: OAuthPlatform; nonce: string; nowSec: number },
): Promise<{ state: string; payload: OAuthStatePayload }> {
  if (!secret) throw new Error("oauth_state_secret_missing");
  const payload: OAuthStatePayload = {
    v: 1,
    u: p.userId,
    t: p.tenantId,
    i: p.nonce,
    p: p.platform,
    iat: p.nowSec,
    exp: p.nowSec + OAUTH_STATE_TTL_SEC,
  };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(body)));
  return { state: `${body}.${b64urlEncode(sig)}`, payload };
}

export type VerifyResult = { ok: true; payload: OAuthStatePayload } | { ok: false; reason: string };

export async function verifyOAuthState(secret: string | null, state: string, nowSec: number): Promise<VerifyResult> {
  if (!secret) return { ok: false, reason: "config_missing" };
  if (typeof state !== "string" || state.length === 0 || state.length > MAX_STATE_LEN) {
    return { ok: false, reason: "state_format" };
  }
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "state_format" };
  const [body, sigB64] = parts;
  const sig = b64urlDecode(sigB64);
  if (!body || !B64URL.test(body) || !sig || sig.length !== 32) return { ok: false, reason: "state_format" };
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sig, enc.encode(body));
  if (!valid) return { ok: false, reason: "state_signature" };
  let p: any;
  try {
    const raw = b64urlDecode(body);
    if (!raw) return { ok: false, reason: "state_format" };
    p = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ok: false, reason: "state_format" };
  }
  const keys = p && typeof p === "object" && !Array.isArray(p) ? Object.keys(p).sort().join(",") : "";
  if (
    keys !== "exp,i,iat,p,t,u,v" ||
    p.v !== 1 ||
    typeof p.u !== "string" || !UUID.test(p.u) ||
    typeof p.t !== "string" || !UUID.test(p.t) ||
    typeof p.i !== "string" || !UUID.test(p.i) ||
    !OAUTH_PLATFORMS.includes(p.p) ||
    !Number.isInteger(p.iat) || !Number.isInteger(p.exp) ||
    p.exp - p.iat !== OAUTH_STATE_TTL_SEC
  ) {
    return { ok: false, reason: "state_payload" };
  }
  if (p.iat > nowSec + 60) return { ok: false, reason: "state_payload" };
  if (nowSec >= p.exp) return { ok: false, reason: "state_expired" };
  return { ok: true, payload: p as OAuthStatePayload };
}

/* ─────────────────────────── issuer (channels) ─────────────────────────── */

export type IssueResult =
  | { ok: true; state: string; payload: OAuthStatePayload }
  | { ok: false; status: number; code: "config_missing" | "no_tenant" | "state_store_failed" };

/**
 * The tenant comes ONLY from ownedTenantOf(userId) (server-side, verified
 * user). There is deliberately no tenant parameter.
 */
export async function issueOAuthState(deps: {
  secret: string | null;
  userId: string;
  platform: OAuthPlatform;
  ownedTenantOf: (userId: string) => Promise<{ id: string } | null>;
  recordNonce: (row: { id: string; user_id: string; tenant_id: string; platform: OAuthPlatform; expires_at: string }) => Promise<boolean>;
  nowSec: number;
  newNonce: () => string;
}): Promise<IssueResult> {
  if (!deps.secret) return { ok: false, status: 503, code: "config_missing" };
  const tenant = await deps.ownedTenantOf(deps.userId);
  if (!tenant?.id || !UUID.test(String(tenant.id))) return { ok: false, status: 404, code: "no_tenant" };
  const { state, payload } = await signOAuthState(deps.secret, {
    userId: deps.userId,
    tenantId: String(tenant.id),
    platform: deps.platform,
    nonce: deps.newNonce(),
    nowSec: deps.nowSec,
  });
  const stored = await deps.recordNonce({
    id: payload.i,
    user_id: payload.u,
    tenant_id: payload.t,
    platform: payload.p,
    expires_at: new Date(payload.exp * 1000).toISOString(),
  }).catch(() => false);
  if (!stored) return { ok: false, status: 503, code: "state_store_failed" };
  return { ok: true, state, payload };
}

/* ─────────────────────────── callback (meta-auth) ─────────────────────────── */

export type ConsumeResult =
  | { ok: true; tenantId: string; userId: string; platform: OAuthPlatform }
  | { ok: false; reason: string };

/**
 * Verifies the state, then claims the nonce exactly once. claimNonce must be
 * an atomic "UPDATE ... SET consumed=true WHERE id=nonce AND consumed=false
 * AND user_id/tenant_id/platform match AND expires_at > now() RETURNING".
 * Returns ONLY the identity carried by the verified state.
 */
export async function consumeOAuthState(deps: {
  secret: string | null;
  state: string;
  expectedPlatform: OAuthPlatform;
  nowSec: number;
  claimNonce: (c: { nonce: string; userId: string; tenantId: string; platform: OAuthPlatform }) => Promise<"claimed" | "not_found" | "error">;
}): Promise<ConsumeResult> {
  const v = await verifyOAuthState(deps.secret, deps.state, deps.nowSec);
  if (!v.ok) return v;
  if (v.payload.p !== deps.expectedPlatform) return { ok: false, reason: "state_platform_mismatch" };
  const claim = await deps.claimNonce({
    nonce: v.payload.i,
    userId: v.payload.u,
    tenantId: v.payload.t,
    platform: v.payload.p,
  }).catch(() => "error" as const);
  if (claim === "error") return { ok: false, reason: "db_error" };
  if (claim !== "claimed") return { ok: false, reason: "state_reused" };
  return { ok: true, tenantId: v.payload.t, userId: v.payload.u, platform: v.payload.p };
}
