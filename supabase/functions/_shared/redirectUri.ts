/**
 * Single normalization for the Instagram OAuth redirect URI secret
 * (INSTAGRAM_REDIRECT_URI), shared by the connect path (channels) and the
 * callback token exchange (meta-auth) so both always send Meta the SAME
 * redirect_uri. Pure: no Deno globals, Node-testable.
 *
 * Trims surrounding whitespace, then removes every trailing "/".
 * Returns "" when the value is missing, empty or only whitespace / slashes,
 * so callers can keep their existing missing-secret behavior (connect: error,
 * callback: documented fallback URL).
 */
export function normalizeRedirectUri(raw: string | undefined | null): string {
  return (raw ?? "").trim().replace(/\/+$/, "");
}
