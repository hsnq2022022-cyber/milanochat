/**
 * Operator-only, value-free diagnostics for the OAuth redirect secrets
 * (GET /meta-auth/debug). Pure of Deno globals (env and identity are injected)
 * so it is Node-testable.
 *
 * Authorization reuses the established flow-publication operator mechanism:
 * the caller's verified Supabase Auth user id (auth.getUser(jwt)) must be in
 * FLOW_OPERATOR_USER_IDS (strict whole-list parser, fail closed).
 *
 * Every failure (no/oversized/invalid bearer, identity lookup error, allowlist
 * missing or malformed, not an operator) returns the SAME 404 body as an
 * unknown route, so the endpoint reveals nothing to non-operators.
 *
 * The response carries ONLY booleans. Raw secret values are compared
 * in-memory and never returned, logged, hashed or measured (no length).
 */
import { isOperator, parseOperatorAllowlist } from "../flow-publication/operatorAuth.ts";

const MAX_AUTH_HEADER_LENGTH = 8192;

export type RedirectDiagnostic = {
  present: boolean;
  exact_match: boolean;
  has_whitespace_or_quote: boolean;
  has_trailing_slash: boolean;
};

/** Booleans only. `raw` is compared against `expected` and then discarded. */
export function diagnoseRedirect(raw: string | undefined | null, expected: string | null): RedirectDiagnostic {
  if (typeof raw !== "string" || raw.length === 0) {
    return { present: false, exact_match: false, has_whitespace_or_quote: false, has_trailing_slash: false };
  }
  return {
    present: true,
    exact_match: expected !== null && raw === expected,
    has_whitespace_or_quote: /[\s"']/.test(raw),
    has_trailing_slash: raw.endsWith("/"),
  };
}

export type RedirectDiagnosticsDeps = {
  env: (key: string) => string | undefined;
  /** Verified Supabase Auth user id for the JWT, or null. */
  getUserId: (jwt: string) => Promise<string | null>;
};

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function notFound(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: JSON_HEADERS });
}

export async function handleRedirectDiagnostics(req: Request, deps: RedirectDiagnosticsDeps): Promise<Response> {
  try {
    const header = req.headers.get("authorization") ?? "";
    if (header.length > MAX_AUTH_HEADER_LENGTH || !header.startsWith("Bearer ")) return notFound();
    const jwt = header.slice("Bearer ".length).trim();
    if (!jwt) return notFound();

    const allowlist = parseOperatorAllowlist(deps.env("FLOW_OPERATOR_USER_IDS"));
    if (!allowlist.ok) return notFound();

    const userId = await deps.getUserId(jwt);
    if (!isOperator(userId, allowlist)) return notFound();

    const base = (deps.env("SUPABASE_URL") ?? "").replace(/\/+$/, "");
    const expectedIg = base ? `${base}/functions/v1/meta-auth/instagram/callback` : null;
    const expectedFb = base ? `${base}/functions/v1/meta-auth/facebook/callback` : null;

    return new Response(
      JSON.stringify({
        instagram_redirect: diagnoseRedirect(deps.env("INSTAGRAM_REDIRECT_URI"), expectedIg),
        facebook_redirect: diagnoseRedirect(deps.env("META_REDIRECT_URI"), expectedFb),
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  } catch {
    return notFound();
  }
}
