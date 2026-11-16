// T5-D2: milan-api CORS by action (the action is in the query string, so it
// is known for an OPTIONS preflight too, which carries no body / widget token).
//
// - Public website Widget actions (widget.js and the widget_* calls made by
//   widget.js from arbitrary customer sites): `*`, never with credentials.
//   widget.js sends only Content-Type, no cookies (fetch default credentials
//   "same-origin"), no Authorization; the capability is the widget's public
//   token, and the server-side controls are the per-IP / per-widget rate
//   limits and widget billing, not CORS.
// - Everything else (dashboard JWT actions, claim-token actions, create_tenant,
//   and the server-to-server webhook / cron actions, which have no browser
//   caller): the trusted application origins only (../_shared/cors.ts).
import {
  applyCors, corsHeadersFor, PUBLIC_CORS_POLICY, trustedCorsPolicy, type CorsPolicy,
} from "../_shared/cors.ts";

export const WIDGET_PUBLIC_ACTIONS: ReadonlySet<string> = new Set([
  "widget.js",
  "widget_public",
  "widget_session",
  "widget_message",
]);

/** Same action lookup as the handler: `?action=` (first value), else "". */
function actionOf(req: Request): string {
  try {
    return new URL(req.url).searchParams.get("action") ?? "";
  } catch {
    return "";
  }
}

export function milanApiCorsPolicy(req: Request, env: (name: string) => string | undefined | null): CorsPolicy {
  return WIDGET_PUBLIC_ACTIONS.has(actionOf(req)) ? PUBLIC_CORS_POLICY : trustedCorsPolicy(env);
}

/** `res` with the CORS headers milan-api's policy gives this request. */
export function withMilanCors(
  req: Request,
  res: Response,
  env: (name: string) => string | undefined | null,
): Response {
  return applyCors(res, corsHeadersFor(req, milanApiCorsPolicy(req, env)));
}
