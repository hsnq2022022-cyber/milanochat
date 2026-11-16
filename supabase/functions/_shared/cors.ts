// T5-D2: CORS policy shared by the Edge functions.
//
// Rules:
// - Never reflect an arbitrary Origin. A "trusted" policy echoes the request
//   Origin only on an EXACT string match with the allow-list below, and always
//   sends `Vary: Origin` because the answer depends on the request Origin.
// - Access-Control-Allow-Credentials is never sent: every caller authenticates
//   with a Bearer token / x-tenant-token / apikey header, never with cookies.
// - A rejected or missing Origin gets no Access-Control-Allow-Origin. The
//   request itself is still served normally (CORS is not an auth control;
//   non-browser callers such as curl / webhooks / cron send no Origin).
// - "public" (`*`, no credentials) exists ONLY for the embeddable website
//   Widget actions of milan-api (milan-api/corsPolicy.ts), which run on
//   arbitrary customer sites and carry no ambient credentials.
//
// Trusted origins: the production GitHub Pages origin (same constant as
// create-payment / generate-flow / flow-publication), the local Vite dev
// origins, the https origin of SITE_URL (same rule as create-payment) and the
// optional ALLOWED_ORIGINS env var (comma-separated exact origins, e.g.
// "https://app.example.com,https://staging.example.com").
//
// Pure module: no Deno globals, unit-tested under Node
// (tests/edge-cors-policy.test.ts).

export const APP_ORIGIN = "https://hsnq2022022-cyber.github.io";

/** Local Vite dev server (vite.config.ts: port 3000) and the Vite default port. */
export const DEV_ORIGINS: readonly string[] = Object.freeze([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

const ALLOW_HEADERS = "authorization, x-client-info, apikey, content-type";

/**
 * Static headers for `api` (operator-only /health and /db-test; no browser
 * caller): deliberately WITHOUT Access-Control-Allow-Origin, so browsers can
 * never read its responses cross-origin. Non-browser callers are unaffected.
 */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Headers": ALLOW_HEADERS,
  "Access-Control-Allow-Methods":
    "GET, POST, PATCH, DELETE, OPTIONS",
};

export function handleCors(req: Request): Response | null {
  if (req.method !== "OPTIONS") {
    return null;
  }

  return new Response("ok", {
    status: 200,
    headers: corsHeaders,
  });
}

export type CorsPolicy =
  | { readonly kind: "public" }
  | { readonly kind: "trusted"; readonly origins: ReadonlySet<string> };

export const PUBLIC_CORS_POLICY: CorsPolicy = Object.freeze({ kind: "public" as const });

type EnvGet = (name: string) => string | undefined | null;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * `value` if it is already an exact, canonical origin (scheme://host[:port],
 * no path / query / fragment / userinfo / trailing slash), https or http on a
 * loopback host; otherwise null. "*" and "null" are never origins here.
 */
export function canonicalOrigin(value: string): string | null {
  const v = value.trim();
  if (!v || v === "*" || v === "null") return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  // DNS names / IPv4 only: no wildcard or other odd host characters.
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(u.hostname)) return null;
  const okScheme = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname));
  if (!okScheme || u.origin === "null" || u.origin !== v) return null;
  return u.origin;
}

/** https origin of SITE_URL (a full URL is allowed, as in create-payment), or null. */
function siteOrigin(siteUrl: string): string | null {
  try {
    const u = new URL(siteUrl.trim());
    return u.protocol === "https:" && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
}

/** The trusted application origins for dashboard / JWT / claim-token callers. */
export function trustedOrigins(env: EnvGet): Set<string> {
  const set = new Set<string>([APP_ORIGIN, ...DEV_ORIGINS]);
  const site = siteOrigin(env("SITE_URL") ?? "");
  if (site) set.add(site);
  for (const part of (env("ALLOWED_ORIGINS") ?? "").split(",")) {
    const o = canonicalOrigin(part);
    if (o) set.add(o);
  }
  return set;
}

export function trustedCorsPolicy(env: EnvGet): CorsPolicy {
  return { kind: "trusted", origins: trustedOrigins(env) };
}

/**
 * The CORS headers for this request under `policy`:
 * - public:  `Access-Control-Allow-Origin: *` (never with credentials).
 * - trusted: `Vary: Origin`, plus `Access-Control-Allow-Origin: <origin>` only
 *   when the request Origin is EXACTLY in the allow-list.
 */
export function corsHeadersFor(req: Request, policy: CorsPolicy): Record<string, string> {
  if (policy.kind === "public") return { "Access-Control-Allow-Origin": "*" };
  const h: Record<string, string> = { "Vary": "Origin" };
  const origin = req.headers.get("origin");
  if (origin !== null && policy.origins.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function mergeVary(h: Headers, value: string): void {
  const cur = h.get("vary");
  if (!cur) {
    h.set("Vary", value);
    return;
  }
  const parts = cur.split(",").map((s) => s.trim().toLowerCase());
  if (parts.includes("*") || parts.includes(value.toLowerCase())) return;
  h.set("Vary", `${cur}, ${value}`);
}

function setCors(h: Headers, cors: Record<string, string>): void {
  // Whatever the handler set is replaced by the policy's answer.
  h.delete("Access-Control-Allow-Origin");
  h.delete("Access-Control-Allow-Credentials");
  for (const [k, v] of Object.entries(cors)) {
    if (k.toLowerCase() === "vary") mergeVary(h, v);
    else h.set(k, v);
  }
}

/** `res` with its CORS origin headers replaced by `cors` (status / body unchanged). */
export function applyCors(res: Response, cors: Record<string, string>): Response {
  try {
    setCors(res.headers, cors);
    return res;
  } catch {
    // Immutable headers (e.g. Response.redirect): same status / body, new headers.
    const out = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: new Headers(res.headers),
    });
    setCors(out.headers, cors);
    return out;
  }
}

/** Wraps a Deno.serve handler: every response (incl. OPTIONS) gets the policy's CORS headers. */
export function withCors(
  policyFor: (req: Request) => CorsPolicy,
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => applyCors(await handler(req), corsHeadersFor(req, policyFor(req)));
}
