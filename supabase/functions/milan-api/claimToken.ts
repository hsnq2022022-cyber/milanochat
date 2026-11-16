/**
 * T5-D1: the account-claim token (tenants.claim_token, 128-bit lowercase hex
 * from the column default encode(gen_random_bytes(16),'hex')) authorizes the
 * unauthenticated setup wizard ONLY while its tenant is unclaimed.
 *
 *  - tenantByClaimToken: no match unless the supplied token is a well-formed
 *    32-char lowercase hex string, the tenant exists, tenants.user_id IS NULL
 *    and the stored token matches (constant-time SHA-256 digest compare).
 *    A claimed tenant and an unknown tenant / wrong token are the SAME result
 *    (null), so callers answer both identically (no oracle).
 *  - claimTenantByToken: ONE conditional UPDATE
 *      SET user_id = <user>, claim_token = <fresh random token>
 *      WHERE claim_token = <token> AND user_id IS NULL
 *    returning the row (maybeSingle). Postgres row locking re-checks the WHERE
 *    for a concurrent second UPDATE, so exactly one claim wins; user_id is
 *    never overwritten. Rotating the token in the same statement keeps the old
 *    token dead even if user_id later returns to NULL (auth user deleted ->
 *    ON DELETE SET NULL). The column stays NOT NULL / UNIQUE-compatible.
 *
 * No token value is ever logged or returned by this module.
 */

/** Exact format of tenants.claim_token (16 random bytes, lowercase hex). */
export const CLAIM_TOKEN_RE = /^[0-9a-f]{32}$/;

export function isClaimTokenFormat(v: unknown): v is string {
  return typeof v === "string" && v.length === 32 && CLAIM_TOKEN_RE.test(v);
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Constant-time compare of fixed-length (SHA-256) digests; no early exit. */
function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Constant-time token equality; both digests are always computed. */
export async function claimTokenMatches(stored: unknown, supplied: unknown): Promise<boolean> {
  const s = typeof stored === "string" ? stored : "";
  const p = typeof supplied === "string" ? supplied : "";
  const [a, b] = await Promise.all([sha256(s), sha256(p)]);
  const same = digestsEqual(a, b);
  return same && isClaimTokenFormat(s) && isClaimTokenFormat(p);
}

// deno-lint-ignore no-explicit-any
export type ClaimRow = { user_id?: unknown; claim_token?: unknown; [column: string]: any };

/** The token authorizes `row` only while the tenant is unclaimed (user_id IS NULL). */
export async function claimTokenAuthorizes(row: ClaimRow | null | undefined, supplied: unknown): Promise<boolean> {
  if (!row || typeof row !== "object") return false;
  const match = await claimTokenMatches(row.claim_token, supplied);
  // Strict null: a missing/undefined user_id is treated as claimed (fail closed).
  return match && row.user_id === null;
}

/** Minimal PostgREST surface used here (supabase-js client in production, fakes in tests). */
// deno-lint-ignore no-explicit-any
export type ClaimDb = { from(table: string): any };

/** Tenant row for the setup wizard, or null (unknown, claimed, wrong/malformed token). */
export async function tenantByClaimToken(
  sb: ClaimDb,
  tenantId: unknown,
  supplied: unknown
): Promise<ClaimRow | null> {
  if (!isClaimTokenFormat(supplied)) return null;
  if (typeof tenantId !== "string" || tenantId.length === 0) return null;
  const { data } = await sb
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .maybeSingle();
  if (!data) return null;
  return (await claimTokenAuthorizes(data, supplied)) ? data : null;
}

/** Fresh 128-bit lowercase hex token (same shape as the column default). */
export function newClaimToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Atomic one-time claim. data = { id } for the single winner; data = null
 * (no error) when the token is unknown or its tenant is already claimed.
 */
export async function claimTenantByToken(
  sb: ClaimDb,
  userId: string,
  claimToken: string
): Promise<{ data: { id: string } | null; error: unknown }> {
  if (!isClaimTokenFormat(claimToken)) return { data: null, error: null };
  const { data, error } = await sb
    .from("tenants")
    .update({
      user_id: userId,
      claim_token: newClaimToken(),
    })
    .eq("claim_token", claimToken)
    .is("user_id", null)
    .select("id")
    .maybeSingle();
  return { data: data ?? null, error: error ?? null };
}
