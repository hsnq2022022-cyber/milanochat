/**
 * S8: public Widget answers are paid for BEFORE any embedding / LLM work.
 *
 * Flow in index.ts widget_message (after the S3 rate limits and the existing
 * inactive / credits <= 0 refusals):
 *   1. reserveWidgetAnswer  -> widget_credit_reserve (one credit debited
 *      atomically, idempotent per key; 20261029280000)
 *   2. answerFromKnowledge  (only for kind "charge" or "off")
 *   3. commitWidgetAnswer   after the answer row is saved, or
 *      releaseWidgetAnswer  when no answer is delivered (LLM error, refusal,
 *      save failure) -> the credit is given back (widget_credit_release).
 *
 * WIDGET_BILLING_V2_ENABLED: billing is ON unless the variable is exactly
 * "false" (operator kill switch; then the legacy uncharged path runs and only
 * the credits <= 0 refusal applies).
 *
 * Idempotency key (never contains customer text): "w1:" + SHA-256 hex of the
 * widget session id + either the optional body.clientMessageId (replay window
 * 24 h) or a SHA-256 of the message text (replay window 120 s, so a double
 * submit / retry of the same text is charged once while the same question
 * asked again later is a new paid answer).
 *
 * Any RPC failure fails CLOSED (no LLM call). Logs carry coarse codes only.
 */

export type WidgetReservation =
  | { kind: "off" }
  | { kind: "charge"; key: string }
  | { kind: "replay"; answerMessageId: string | null }
  | { kind: "busy" }
  | { kind: "no_credit" }
  | { kind: "unavailable" };

type RpcResult = { data: unknown; error: { code?: string } | null };
export type RpcClient = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult> };
type Q = any; // supabase-js query builder (kept untyped: pure module, no npm import)
export type FromClient = { from(table: string): Q };

export const WIDGET_REPLAY_SECONDS_TEXT = 120;
export const WIDGET_REPLAY_SECONDS_CLIENT_ID = 86400;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export const WIDGET_UNAVAILABLE_REPLY = "عذرًا، المساعد غير متاح حاليًا.";
export const WIDGET_BUSY_REPLY = "رسالتك قيد المعالجة، يرجى الانتظار قليلًا.";

/** ON unless explicitly "false" (case / surrounding whitespace ignored). */
export function widgetBillingEnabled(flag: string | undefined | null): boolean {
  return String(flag ?? "").trim().toLowerCase() !== "false";
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function widgetIdempotencyKey(
  sessionId: string,
  message: string,
  clientMessageId?: unknown,
): Promise<{ key: string; replaySeconds: number }> {
  const cid = typeof clientMessageId === "string" && CLIENT_ID_RE.test(clientMessageId) ? clientMessageId : null;
  const basis = cid !== null ? "c\n" + cid : "m\n" + (await sha256Hex(message));
  return {
    key: "w1:" + (await sha256Hex("milan-widget-v1\n" + sessionId + "\n" + basis)),
    replaySeconds: cid !== null ? WIDGET_REPLAY_SECONDS_CLIENT_ID : WIDGET_REPLAY_SECONDS_TEXT,
  };
}

export async function reserveWidgetAnswer(
  sb: RpcClient,
  p: { enabled: boolean; tenantId: string; sessionId: string; message: string; clientMessageId?: unknown },
): Promise<WidgetReservation> {
  if (!p.enabled) return { kind: "off" };
  try {
    const { key, replaySeconds } = await widgetIdempotencyKey(p.sessionId, p.message, p.clientMessageId);
    const { data, error } = await sb.rpc("widget_credit_reserve", {
      p_tenant_id: p.tenantId,
      p_session_id: p.sessionId,
      p_key: key,
      p_replay_seconds: replaySeconds,
    });
    if (error) {
      console.error("[widget_billing] reserve failed", { code: error.code ?? "unknown" });
      return { kind: "unavailable" };
    }
    const r = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    switch (r.status) {
      case "reserved":
      case "resumed":
        return { kind: "charge", key };
      case "duplicate":
        return { kind: "replay", answerMessageId: typeof r.answer_message_id === "string" ? r.answer_message_id : null };
      case "in_flight":
        return { kind: "busy" };
      case "no_credit":
        return { kind: "no_credit" };
      default:
        console.error("[widget_billing] reserve refused", { code: "reserve_" + String(r.status ?? "unknown").slice(0, 20) });
        return { kind: "unavailable" };
    }
  } catch {
    console.error("[widget_billing] reserve failed", { code: "exception" });
    return { kind: "unavailable" };
  }
}

/** Marks the reserved credit as spent on the saved answer. Never throws. */
export async function commitWidgetAnswer(
  sb: RpcClient,
  tenantId: string,
  r: WidgetReservation,
  answerMessageId: string,
): Promise<"deferred" | "charged" | "pending"> {
  if (r.kind !== "charge") return "deferred";
  try {
    const { data, error } = await sb.rpc("widget_credit_commit", {
      p_tenant_id: tenantId,
      p_key: r.key,
      p_answer_message_id: answerMessageId,
    });
    if (!error && (data === "committed" || data === "already")) return "charged";
    console.error("[widget_billing] commit failed", { code: error?.code ?? String(data ?? "unknown").slice(0, 20) });
  } catch {
    console.error("[widget_billing] commit failed", { code: "exception" });
  }
  return "pending";
}

/** Gives the reserved credit back when no answer is delivered. Never throws. */
export async function releaseWidgetAnswer(sb: RpcClient, tenantId: string, r: WidgetReservation): Promise<void> {
  if (r.kind !== "charge") return;
  try {
    const { error } = await sb.rpc("widget_credit_release", { p_tenant_id: tenantId, p_key: r.key });
    if (error) console.error("[widget_billing] release failed", { code: error.code ?? "unknown" });
  } catch {
    console.error("[widget_billing] release failed", { code: "exception" });
  }
}

/**
 * Response for every reservation that must NOT reach the LLM
 * (no_credit / busy / unavailable / replay). Returns null for "off" / "charge".
 * no_credit / unavailable store the same refusal row as the existing
 * inactive / credits <= 0 path; replay returns the already saved answer.
 */
export async function widgetBillingEarlyReply(
  sb: FromClient,
  r: WidgetReservation,
  ids: { tenantId: string; widgetId: string; sessionId: string },
): Promise<{ reply: string; kind: string } | null> {
  if (r.kind === "off" || r.kind === "charge") return null;
  if (r.kind === "replay" && r.answerMessageId) {
    try {
      const { data } = await sb
        .from("widget_messages")
        .select("body")
        .eq("id", r.answerMessageId)
        .eq("tenant_id", ids.tenantId)
        .eq("session_id", ids.sessionId)
        .maybeSingle();
      if (data && typeof data.body === "string") return { reply: data.body, kind: "answer" };
    } catch {
      /* fall through to the busy reply */
    }
  }
  if (r.kind === "replay" || r.kind === "busy") return { reply: WIDGET_BUSY_REPLY, kind: "error" };
  try {
    await sb.from("widget_messages").insert({
      session_id: ids.sessionId,
      widget_id: ids.widgetId,
      tenant_id: ids.tenantId,
      direction: "out",
      body: WIDGET_UNAVAILABLE_REPLY,
      kind: "error",
    });
  } catch {
    console.error("[widget_billing] refusal insert failed", { code: "exception" });
  }
  return { reply: WIDGET_UNAVAILABLE_REPLY, kind: "error" };
}
