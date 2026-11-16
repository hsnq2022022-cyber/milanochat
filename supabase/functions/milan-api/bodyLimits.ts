/**
 * T5-S4: request body size limits and input boundaries for milan-api.
 *
 * milan-api reads the WHOLE request body once, at the top of the handler,
 * before routing on ?action=. That raw text is (a) the exact input of the
 * Meta / Moyasar HMAC signature checks and (b) the input of JSON.parse.
 * readBodyLimited() replaces `await req.text()` there: it enforces a
 * per-request-class byte limit BEFORE JSON.parse and BEFORE any signature
 * verification, against the declared Content-Length (early reject) AND the
 * bytes actually received (streamed; never trusts Content-Length alone), and
 * returns exactly the string req.text() would have returned.
 *
 * No Deno / Supabase imports: pure, unit tested under Node (tests/milan-body-limits.test.ts).
 */

const KiB = 1024;
const MiB = 1024 * KiB;

/* ── Request body classes (by ?action=, known before the body is read) ── */

/**
 * Meta webhook POSTs (whatsapp_webhook, instagram_webhook incl. object=page).
 * 4 MiB. Evidence level: documented knowledge, NOT live measurement: Meta's
 * WhatsApp Cloud API webhook docs state payloads can be up to 3 MB; Messenger
 * / Instagram webhooks may batch many entries per POST with no smaller
 * documented cap. 4 MiB leaves headroom over the documented 3 MB so a
 * legitimate (batched) delivery is never rejected; a rejected one would only
 * be retried by Meta like any other 4xx/5xx and then dropped.
 * The GET hub.challenge verification carries no body.
 */
export const META_WEBHOOK_BODY_MAX_BYTES = 4 * MiB;

/**
 * Unauthenticated / public or tiny-body endpoints (read before any auth):
 * create_tenant, widget_public, widget_session, widget_message, widget.js,
 * pay_webhook (Moyasar; small JSON event), inbound_recovery_tick
 * (server-to-server, body {"mode":"tick"}). 64 KiB. Evidence: verified in
 * code: the largest legitimate field is widget_message.message, capped at
 * 4,000 characters server-side (<= 12 KB UTF-8); create_tenant sends 4 short
 * fields; widget.js sends {token, visitorId|sessionId, message, origin}.
 * Moyasar payload size: assumed (a few KB), same 64 KiB as wayl-webhook.
 */
export const PUBLIC_BODY_MAX_BYTES = 64 * KiB;

/**
 * Every other action (claim-token actions and JWT dashboard / widget
 * dashboard actions). 1 MiB. Evidence: verified in code: the largest
 * legitimate bodies are qa_save (<= QA_SAVE_MAX_PAIRS pairs of at most
 * QA_QUESTION_MAX_CHARS + QA_ANSWER_MAX_CHARS characters: 50 x 5,000 chars,
 * ~0.5 MB for Arabic at 2 bytes/char) and ingest_text / knowledge_add text
 * (<= 50,000 chars, <= 150 KB UTF-8). Widget settings are a small JSON
 * config (avatar/logo uploads are disabled in the dashboard; URLs only).
 */
export const ACTION_BODY_MAX_BYTES = 1 * MiB;

export type BodyClass = "meta_webhook" | "public" | "action";

const META_WEBHOOK_ACTIONS: ReadonlySet<string> = new Set([
  "whatsapp_webhook",
  "instagram_webhook",
]);

const PUBLIC_ACTIONS: ReadonlySet<string> = new Set([
  "create_tenant",
  "widget_public",
  "widget_session",
  "widget_message",
  "widget.js",
  "pay_webhook",
  "inbound_recovery_tick",
]);

/** Request class of an ?action= value (unknown / empty -> "action"). */
export function bodyClassFor(action: string): BodyClass {
  if (META_WEBHOOK_ACTIONS.has(action)) return "meta_webhook";
  if (PUBLIC_ACTIONS.has(action)) return "public";
  return "action";
}

export function bodyLimitFor(cls: BodyClass): number {
  if (cls === "meta_webhook") return META_WEBHOOK_BODY_MAX_BYTES;
  if (cls === "public") return PUBLIC_BODY_MAX_BYTES;
  return ACTION_BODY_MAX_BYTES;
}

/* ── Limited body reader ── */

export type LimitedBody =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" };

/**
 * Same result as `await req.text()` for a body of at most maxBytes bytes;
 * { ok:false } as soon as the limit is known to be exceeded.
 * - Declared Content-Length (decimal digits only) > maxBytes: rejected
 *   before reading; the body stream is cancelled, never read.
 * - A missing, malformed, negative or non-numeric Content-Length is ignored
 *   (the actual-bytes limit below always applies).
 * - Actual bytes are counted chunk by chunk; the stream is cancelled as soon
 *   as the running total exceeds maxBytes (at most maxBytes + one chunk is
 *   ever buffered). Chunked / undeclared and lying-Content-Length bodies are
 *   limited the same way.
 * - Decoding: TextDecoder("utf-8") with default options = the Fetch "UTF-8
 *   decode" used by req.text(): a leading BOM is stripped, invalid sequences
 *   become U+FFFD. The returned string is therefore identical to req.text()
 *   and the signature checks see the same raw text as before.
 * - Stream read errors propagate exactly like a req.text() rejection.
 */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<LimitedBody> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const d = declared.trim();
    if (/^\d+$/.test(d) && Number(d) > maxBytes) {
      req.body?.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
  }
  if (req.body === null) return { ok: true, text: "" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new TypeError("request body chunk is not a Uint8Array");
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(bytes) };
}

/** Fixed client message for HTTP 413 (never echoes sizes or body content). */
export const BODY_TOO_LARGE_MESSAGE = "حجم الطلب كبير جدًا (Request body too large)";
/** Fixed coarse log tag for a rejected oversized body (no body, no sizes). */
export const BODY_TOO_LARGE_LOG_TAG = "[milan-api] request body too large";

/* ── Field limits (HTTP 400 when exceeded) ── */

/**
 * ingest_text body.text and knowledge_add body.text (trimmed), both
 * chunkText (700-char chunks) + one batched embedding call + DB insert.
 * 50,000 chars => roughly 85 to 170 chunks depending on paragraph layout
 * (was unbounded up to the body limit). Owner-set target. Frontend: Hero
 * onboarding sends a few short "label: value" lines; the Dashboard textarea
 * has no maxLength (a paste > 50,000 chars now gets a 400).
 */
export const INGEST_TEXT_MAX_CHARS = 50_000;

/**
 * qa_save body.pairs. qa_extract returns at most 15 pairs; the Hero editor
 * lets the user add pairs manually. 50 = generous over 15 and under the
 * 100-input Gemini batchEmbedContents limit (documented knowledge). Each
 * pair becomes ONE embedding input
 * ("س: q\nج: a"): question <= 1,000 chars, answer <= 4,000 chars (the
 * existing widget_message cap for one customer-facing text), trimmed length.
 */
export const QA_SAVE_MAX_PAIRS = 50;
export const QA_QUESTION_MAX_CHARS = 1_000;
export const QA_ANSWER_MAX_CHARS = 4_000;

/** create_tenant / qa_save body.sourceUrl: optional; string <= 2,048 chars. */
export const SOURCE_URL_MAX_CHARS = 2_048;

export const TEXT_TOO_LONG_MESSAGE = "النص طويل جدًا (Text too long)";
export const QA_PAIRS_LIMIT_MESSAGE =
  "عدد الأسئلة أو طولها يتجاوز الحد المسموح (Too many or too long Q&A pairs)";
export const SOURCE_URL_INVALID_MESSAGE = "الرابط غير صالح أو طويل جدًا (Invalid source URL)";

export function textWithinLimit(text: string, maxChars: number): boolean {
  return text.length <= maxChars;
}

/**
 * qa_save pairs bound. A non-array keeps the existing behaviour (treated as
 * an empty list -> "القائمة فارغة"); only string question/answer values are
 * length-checked (other types keep the existing filter path).
 */
export function qaPairsWithinLimits(pairs: unknown): boolean {
  if (!Array.isArray(pairs)) return true;
  if (pairs.length > QA_SAVE_MAX_PAIRS) return false;
  for (const p of pairs) {
    if (!p || typeof p !== "object") continue;
    const { question, answer } = p as { question?: unknown; answer?: unknown };
    if (typeof question === "string" && question.trim().length > QA_QUESTION_MAX_CHARS) return false;
    if (typeof answer === "string" && answer.trim().length > QA_ANSWER_MAX_CHARS) return false;
  }
  return true;
}

/** Absent (undefined / null) or a string of at most SOURCE_URL_MAX_CHARS. */
export function optionalSourceUrlValid(v: unknown): boolean {
  return v === undefined || v === null ||
    (typeof v === "string" && v.length <= SOURCE_URL_MAX_CHARS);
}
