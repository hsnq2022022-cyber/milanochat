/**
 * Instagram (Instagram Login) per-account webhook subscription, called by the
 * meta-auth Instagram callback after the account row is saved.
 *
 *   POST {IG_GRAPH_V}/me/subscribed_apps?subscribed_fields=<fields>
 *   Authorization: Bearer <token>        (T5-S5: never a token in the URL)
 *
 * Fields: the DM fields consumed by milan-api (messages, messaging_postbacks,
 * messaging_seen) + `comments`, consumed by milan-api/commentIngress.ts
 * (commentTrigger.ts parses changes[].field === "comments"). live_comments /
 * mentions are NOT requested: no code consumes them.
 *
 * Fail safe for DMs: if Meta refuses the request with `comments` (e.g. the
 * app has no comments webhook / permission yet; documented knowledge,
 * unverified in this session, that one unsupported field fails the call), the
 * previous DM-only field list is subscribed instead, so a new link never
 * loses DM webhooks. Only an explicit Meta refusal (a Graph `error` object)
 * falls back; a network error or an unexpected body does not (outcome
 * unknown). A failed
 * subscription never fails the link (unchanged).
 * Logs carry codes only (never the token, URL or Meta free text).
 *
 * Pure module (no Deno globals, no npm imports): fetch is injected.
 */
import { metaAuthHeaders } from "../_shared/metaGraph.ts";

export const IG_SUBSCRIBED_FIELDS = "messages,messaging_postbacks,messaging_seen,comments";
/** The pre-comment-automation list (fallback only). */
export const IG_DM_SUBSCRIBED_FIELDS = "messages,messaging_postbacks,messaging_seen";

export type IgSubscribeResult = "subscribed" | "dm_only" | "failed";
export type IgSubscribeDeps = {
  fetch: typeof fetch;
  /** Safe Meta error code extraction (meta-auth metaErrCode). */
  errCode: (body: unknown) => unknown;
};

export async function subscribeInstagramWebhooks(
  graphBase: string,
  token: string,
  deps: IgSubscribeDeps,
): Promise<IgSubscribeResult> {
  const attempt = async (fields: string): Promise<"ok" | "refused" | "error"> => {
    try {
      const sRes = await deps.fetch(
        `${graphBase}/me/subscribed_apps?subscribed_fields=${fields}`,
        { method: "POST", headers: metaAuthHeaders(token) },
      );
      const sJson: any = await sRes.json().catch(() => ({}));
      if (sJson?.success) return "ok";
      console.error("[meta-auth] subscribed_apps failed", deps.errCode(sJson));
      // Only an explicit Graph error object is a refusal; anything else is unknown.
      return sJson?.error && typeof sJson.error === "object" ? "refused" : "error";
    } catch (e) {
      console.error("[meta-auth] subscribed_apps error", e instanceof Error ? e.name : "unknown");
      return "error";
    }
  };
  const first = await attempt(IG_SUBSCRIBED_FIELDS);
  if (first === "ok") return "subscribed";
  // Network/unknown outcome: no fallback (the first call may have succeeded;
  // a DM-only call could then drop `comments`). Reconnect re-subscribes.
  if (first === "error") return "failed";
  console.warn("[meta-auth] subscribed_apps with comments refused — DM-only fallback");
  return (await attempt(IG_DM_SUBSCRIBED_FIELDS)) === "ok" ? "dm_only" : "failed";
}
