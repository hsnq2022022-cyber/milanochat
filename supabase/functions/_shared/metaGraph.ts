/**
 * T5-S5: Meta Graph API credentials travel in the Authorization header, never
 * in a request URL (URLs end up in fetch error messages, proxy/CDN logs and
 * Meta-returned paging links).
 *
 * Pure module (no Deno globals, no npm imports) so node tests can import it.
 *
 * Documented exceptions (credential still in the query string, see the call
 * sites): the OAuth code -> token and token -> long-lived token exchanges
 * (graph.facebook.com/oauth/access_token, graph.instagram.com/access_token),
 * which Meta documents only as GET with client_secret / code / token params.
 */

/** Graph API hosts that receive a Bearer token from this code. */
export const META_GRAPH_HOSTS: readonly string[] = Object.freeze([
  "graph.facebook.com",
  "graph.instagram.com",
]);

/** `Authorization: Bearer <token>` for a Graph API request. */
export function metaAuthHeaders(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/**
 * A Meta-returned URL (e.g. `paging.next`) without an `access_token` query
 * parameter, or null when it is not an https URL on a Graph host. Meta echoes
 * the token into paging links; the caller sends it in the header instead.
 */
export function graphUrlWithoutToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !META_GRAPH_HOSTS.includes(u.hostname)) {
    return null;
  }
  u.searchParams.delete("access_token");
  return u.toString();
}
