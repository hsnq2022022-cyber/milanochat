/**
 * ميلانو — الباك-إند الكامل على Supabase Edge Function واحدة.
 *
 * الوظائف:
 * عامة:
 *   create_tenant
 *
 * برمز الجلسة:
 *   bind_number
 *   wa_status
 *   qa_extract
 *   qa_save
 *   ingest_text
 *   qa_test
 *
 * بالحساب:
 *   claim_account
 *   summary
 *   conversations
 *   messages
 *   reply
 *   unresolved
 *   resolve
 *   knowledge
 *   knowledge_add
 *   knowledge_delete
 *   pay_create
 *
 * Widget:
 *   widget_public
 *   widget_session
 *   widget_message
 *
 * Pay:
 *   pay_webhook
 *
 * الاستدعاء:
 * POST {SUPABASE_URL}/functions/v1/milan-api?action=<الإجراء>
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as cheerio from "npm:cheerio@1";
import { flowShadowMayObserve } from "./flowShadowGate.ts";
import { persistInboundOnce } from "./persistInboundOnce.ts";
import { processExclusiveEvent } from "./exclusiveMessageClaim.ts";
import { routeInbound } from "./messageRouting.ts";
import {durableAccountAllowed} from "../_shared/durableAccounts.ts";
import { invalidSignatureDiagnostics } from "./webhookDiagnostics.ts";
import { createStageTimer, NOOP_STAGE_TIMER, type StageTimer } from "./webhookTimings.ts";
import { runBackgroundJobs } from "./backgroundWork.ts";
import { recordRoutingFailure, markRoutingResolved, retryableEvent, webhookStatusFor,
  isRetryableOutcome, retryAttemptCap, runBatchEvent } from "./inboundRoutingRetry.ts";
// B-3/B-4 opt-in recovery sweeper (default OFF) and its webhook-side lease check.
import { inboundRecoveryEnabled, runInboundRecovery, recoveryLeaseActive, markLiveNoReply, type LiveNoReplyReason } from "./inboundRecovery.ts";
import { acceptsFlowWorkerBearer } from "../flowWorkerAuth.ts";
import { syntheticEventId } from "./syntheticEventId.ts";
import { prepareSimpleFlowReply } from "./flowPrepareMessage.ts";
import { readConversationStart } from "./conversationStart.ts";
import {attemptDurableInstagram,selectedFlowChoice,multichannelEnabled,
  durableIngressConfigured,supportedDurableDocument} from "./flowDurableIngress.ts";
import { normalizeMetaMessages } from "./normalizeMetaMessage.ts";
import { chargeWidgetReply } from "./widgetCredit.ts";
// Comment automation (FLOW_COMMENT_AUTOMATION_ENABLED, default OFF) and its Inbox read contract.
import { ingestSignedComments, commentAutomationEnabled } from "./commentIngress.ts";
import { readCommentActivity } from "./commentActivity.ts";
import { commentActivityRules } from "./abuseGuards.ts";
import { verifyMetaWebhookSignature } from "./metaSignature.ts";
import { verifyTokenMatches } from "./verifyToken.ts";
// T5-S4: request body size limits and input boundaries (bodyLimits.ts).
import {
  bodyClassFor, bodyLimitFor, readBodyLimited, BODY_TOO_LARGE_MESSAGE, BODY_TOO_LARGE_LOG_TAG,
  INGEST_TEXT_MAX_CHARS, TEXT_TOO_LONG_MESSAGE, textWithinLimit, qaPairsWithinLimits,
  QA_PAIRS_LIMIT_MESSAGE, optionalSourceUrlValid, SOURCE_URL_INVALID_MESSAGE,
} from "./bodyLimits.ts";
import { recordVerifiedMetaReceipts } from "./metaDeliveryReceipts.ts";
// Security hardening (S1 / S3 / S4): pure, unit-tested modules.
import { safeFetchText, denoResolver } from "./safeFetch.ts";
import { rateGate, widgetIpRules, widgetScopeRules, aiActionRules, knowledgeAddRules, CLAIM_AI_ACTIONS, rateGateStrict, createTenantRules } from "./abuseGuards.ts";
import { bindWhatsappNumber, supabaseBindStore, BIND_CONFLICT_BODY } from "./waBinding.ts";
// Security hardening (S8 Widget billing / S9 WhatsApp binding verification).
import { widgetBillingEnabled, reserveWidgetAnswer, commitWidgetAnswer, releaseWidgetAnswer, widgetBillingEarlyReply } from "./widgetBilling.ts";
import { bindingIsVerified, readBindingVerified, provenWhatsappAccount } from "./waBinding.ts";
// T5-D1: claim token authority ends when the tenant is claimed (claimToken.ts).
import { tenantByClaimToken, claimTenantByToken, isClaimTokenFormat } from "./claimToken.ts";
// T5-D2: CORS by action and request Origin (corsPolicy.ts, ../_shared/cors.ts).
import { withMilanCors } from "./corsPolicy.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b instanceof Uint8Array ? b.buffer : b)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

const env = (k: string) => Deno.env.get(k) ?? "";

const sbAdmin = (): SupabaseClient =>
  createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY")
  );

/* ═══════════════════════════════════════════════════════════════════════
   HTTP
═══════════════════════════════════════════════════════════════════════ */

// T5-D2: no Access-Control-Allow-Origin here; every response gets it from
// withMilanCors (corsPolicy.ts) at the Deno.serve entry point.
const CORS = {
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-tenant-token",
  "Access-Control-Allow-Methods":
    "GET, POST, PUT, DELETE, OPTIONS",
};

const json = (
  d: unknown,
  s = 200,
  extraHeaders: Record<string, string> = {}
) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });

const err = (m: string, s = 400) =>
  json({ error: m }, s);

/* ═══════════════════════════════════════════════════════════════════════
   تشفير حقلي
═══════════════════════════════════════════════════════════════════════ */

async function aesKey(mode: "encrypt" | "decrypt") {
  const mat = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(env("FIELD_ENCRYPTION_KEY"))
  );

  return crypto.subtle.importKey(
    "raw",
    mat,
    "AES-GCM",
    false,
    [mode]
  );
}

async function encryptField(plain: string): Promise<string> {
  if (!plain) return "";

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
      },
      await aesKey("encrypt"),
      enc.encode(plain)
    )
  );

  return `enc:v1:${hex(iv)}:${hex(
    ct.slice(-16)
  )}:${hex(ct.slice(0, -16))}`;
}

async function decryptField(
  stored: string | null | undefined
): Promise<string> {
  if (!stored) return "";

  if (!stored.startsWith("enc:v1:")) {
    return stored;
  }

  const [, , ivH, tagH, dataH] = stored.split(":");

  const fromHex = (h: string) =>
    Uint8Array.from(
      h.match(/../g)!.map((x) => parseInt(x, 16))
    );

  try {
    const data = fromHex(dataH);
    const tag = fromHex(tagH);

    const buf = new Uint8Array(data.length + 16);

    buf.set(data, 0);
    buf.set(tag, data.length);

    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromHex(ivH) as BufferSource,
      },
      await aesKey("decrypt"),
      buf as BufferSource
    );

    return dec.decode(pt);
  } catch {
    // Fixed reason code only: never any part of the ciphertext, ids or names.
    // Lenient by design (display fields keep the placeholder); channel access
    // tokens use decryptAccessTokenStrict instead.
    console.error("[decryptField] decryption_failed");
    return "[رسالة غير قابلة للقراءة]";
  }
}

/**
 * STRICT field decryption for the inbound recovery sweeper only: THROWS on a
 * legacy plaintext value or any decryption failure (decryptField returns a
 * placeholder instead, which must never be replayed as customer text). Logs
 * nothing; the result lives in memory only.
 */
async function decryptFieldStrict(stored: string): Promise<string> {
  if (typeof stored !== "string" || !stored.startsWith("enc:v1:")) {
    throw new Error("not an encrypted field");
  }
  const [, , ivH, tagH, dataH] = stored.split(":");
  const fromHex = (h: string) => {
    if (typeof h !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(h)) throw new Error("bad hex");
    return Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
  };
  const data = fromHex(dataH);
  const tag = fromHex(tagH);
  const buf = new Uint8Array(data.length + 16);
  buf.set(data, 0);
  buf.set(tag, data.length);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromHex(ivH) as BufferSource },
    await aesKey("decrypt"),
    buf as BufferSource
  );
  return dec.decode(pt);
}

/**
 * Typed failure of decryptAccessTokenStrict: the channel ACCESS TOKEN is
 * missing, undecryptable or empty. Callers make NO provider request.
 */
class AccountTokenUnavailableError extends Error {
  readonly code = "token_unavailable";
  constructor() {
    super("token_unavailable");
    this.name = "AccountTokenUnavailableError";
  }
}

/**
 * STRICT decryption for channel ACCESS TOKENS sent to Meta (DM send, profile
 * fetch). decryptField is lenient (returns a display placeholder on failure),
 * which must never be sent to Meta as a token. Any decrypt failure or empty
 * result THROWS AccountTokenUnavailableError. A legacy value without the
 * "enc:v1:" prefix is returned unchanged, exactly as decryptField did.
 * Logs nothing (callers log the fixed code "token_unavailable" only).
 */
async function decryptAccessTokenStrict(
  stored: string | null | undefined
): Promise<string> {
  if (typeof stored !== "string" || stored.length === 0) {
    throw new AccountTokenUnavailableError();
  }
  let token: string;
  if (!stored.startsWith("enc:v1:")) {
    token = stored;
  } else {
    try {
      token = await decryptFieldStrict(stored);
    } catch {
      throw new AccountTokenUnavailableError();
    }
  }
  if (!token.trim()) throw new AccountTokenUnavailableError();
  return token;
}

/* ═══════════════════════════════════════════════════════════════════════
   المصادقة
═══════════════════════════════════════════════════════════════════════ */

async function userOf(
  req: Request,
  sb: SupabaseClient
) {
  const h = req.headers.get("authorization") ?? "";

  const token = h.startsWith("Bearer ")
    ? h.slice(7)
    : "";

  if (!token) return null;

  const { data } = await sb.auth.getUser(token);

  return data.user ?? null;
}

function claimOf(req: Request) {
  return req.headers.get("x-tenant-token") ?? "";
}

async function tenantByClaim(
  sb: SupabaseClient,
  req: Request,
  tenantId: string
) {
  // T5-D1: null (=> the same "invalid token" 403) unless the token is
  // well-formed, matches in constant time AND the tenant is still unclaimed.
  return await tenantByClaimToken(sb, tenantId, claimOf(req));
}

async function ownedTenant(
  sb: SupabaseClient,
  req: Request
) {
  const u = await userOf(req, sb);

  if (!u) return null;

  const { data } = await sb
    .from("tenants")
    .select("*")
    .eq("user_id", u.id)
    .maybeSingle();

  return data;
}

/* ═══════════════════════════════════════════════════════════════════════
   LLM / EMBEDDINGS
═══════════════════════════════════════════════════════════════════════ */

/**
 * مفتاح مزوّد الذكاء الاصطناعي. يقبل عدة أسماء للسر:
 * - للـ embeddings: EMBED_API_KEY ثم GEMINI_API_KEY ثم LLM_API_KEY
 * - للمحادثة:      LLM_API_KEY ثم GEMINI_API_KEY ثم EMBED_API_KEY
 * ويرجع احتياطياً إلى OPENAI_API_KEY.
 */
function aiKey(kind: "embed" | "llm" = "llm"): string {
  const order =
    kind === "embed"
      ? ["EMBED_API_KEY", "GEMINI_API_KEY", "LLM_API_KEY"]
      : ["LLM_API_KEY", "GEMINI_API_KEY", "EMBED_API_KEY"];

  for (const k of [...order, "OPENAI_API_KEY"]) {
    const v = env(k).trim();
    if (v) return v;
  }

  return "";
}

/* ── Stage 6 hardening: provider/network errors safe for logs and clients ──
 * Provider response bodies (they can echo API keys, tokens or customer text)
 * and fetch error messages (they embed the request URL) never reach a log
 * line, a thrown message or a client response. Only the provider name, the
 * numeric HTTP status and a validated provider error code are kept. */

/** A provider error code: a finite number or a short [A-Za-z0-9_.-] token. */
function safeProviderCode(x: unknown): number | string | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(x)) return x;
  return undefined;
}

/** Same pattern the reply/unresolved callers used on the old message text. */
const LEGACY_AUTH_HINT = /توكن|token|auth|190/i;

/** Non-2xx provider response. Message is FIXED: provider + status + code. */
class ProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly code: number | string | undefined;
  /** LEGACY_AUTH_HINT on the old `${provider} ${status}: ${body}` message. */
  readonly authHint: boolean;
  constructor(provider: string, status: number, code?: unknown, authHint = false) {
    const p = /^[A-Za-z0-9 _.-]{1,40}$/.test(provider) ? provider : "provider";
    const s = Number.isFinite(status) ? Math.trunc(status) : 0;
    const c = safeProviderCode(code);
    super(`${p} ${s}` + (c === undefined ? "" : ` (code ${c})`));
    this.name = "ProviderHttpError";
    this.provider = p;
    this.status = s;
    this.code = c;
    this.authHint = authHint;
  }
}

/** Builds a ProviderHttpError from a raw body; the body is then discarded. */
function providerErrorFromBody(provider: string, status: number, raw: string): ProviderHttpError {
  let code: unknown;
  try {
    const j: any = JSON.parse(raw);
    code = j?.error?.code ?? j?.code ?? j?.error?.type ?? j?.type;
  } catch {
    /* not JSON: no code */
  }
  return new ProviderHttpError(
    provider, status, code, LEGACY_AUTH_HINT.test(`${provider} ${status}: ${raw}`)
  );
}

async function providerHttpError(provider: string, res: Response): Promise<ProviderHttpError> {
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    /* unreadable body: status only */
  }
  return providerErrorFromBody(provider, res.status, raw);
}

/** Fixed category of a thrown fetch/runtime error; never its text. */
function fetchErrorCategory(e: unknown): "timeout" | "network" | "bad_response" | "unknown" {
  try {
    const n = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
    const c = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
    if (n === "AbortError" || n === "TimeoutError" || (typeof c === "string" && /TIMEOUT/i.test(c))) {
      return "timeout";
    }
    if (n === "SyntaxError") return "bad_response";
    if (n === "TypeError" || (typeof c === "string" && /^E[A-Z]+$/.test(c))) return "network";
  } catch {
    /* hostile error object */
  }
  return "unknown";
}

/** fetch threw (no response). Message is FIXED: provider + category. */
class ProviderNetworkError extends Error {
  readonly provider: string;
  readonly category: string;
  constructor(provider: string, category: string) {
    super(`${provider} network error (${category})`);
    this.name = "ProviderNetworkError";
    this.provider = provider;
    this.category = category;
  }
}

const SAFE_ERROR_NAMES = new Set([
  "Error", "TypeError", "SyntaxError", "RangeError", "ReferenceError",
  "AbortError", "TimeoutError", "WaAuthError", "AccountTokenUnavailableError",
  "SafeFetchError", "FlowRoutingUnavailableError",
]);

/** Log fields for any caught error: never e.message, stack, cause or the object. */
function safeErrorLog(e: unknown): Record<string, unknown> {
  if (e instanceof ProviderHttpError) {
    return { provider: e.provider, status: e.status, code: e.code };
  }
  if (e instanceof ProviderNetworkError) {
    return { provider: e.provider, category: e.category };
  }
  let name: string | undefined;
  try {
    const n = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
    if (typeof n === "string" && SAFE_ERROR_NAMES.has(n)) name = n;
  } catch {
    /* hostile error object */
  }
  return { category: fetchErrorCategory(e), name: name ?? "unknown" };
}

/** Client-facing text: fixed provider messages; our own plain Error texts
 * (Arabic user messages) unchanged; fetch/runtime errors -> fallback.
 * T5-S2: a plain Error without Arabic text (internal English diagnostics,
 * raw Postgres/PostgREST text) is never forwarded -> fallback. */
function clientErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ProviderHttpError || e instanceof ProviderNetworkError) return e.message;
  if (e instanceof WaAuthError || e instanceof AccountTokenUnavailableError) return e.message;
  // safeFetch.ts SafeFetchError (URL import): fixed Arabic text + [code] by
  // construction; matched by name (its import line is pinned unchanged).
  if (e instanceof Error && e.name === "SafeFetchError") return e.message;
  if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype && e.name === "Error" &&
      /[\u0600-\u06FF]/.test(e.message)) {
    return e.message;
  }
  return fallback;
}

/* ── T5-S2: database errors safe for logs and clients ──
 * Postgres/PostgREST message, details and hint can carry SQL, table /
 * column / constraint names and row values (tokens, phone numbers, customer
 * text): they never reach a client or a log line. Clients get a fixed Arabic
 * message (same status and body keys); logs get a fixed tag + coarse code. */
const DB_ERROR_MESSAGE = "تعذر إتمام العملية — حاول مرة أخرى";

/** Coarse, value-free code: SQLSTATE (5 chars) or PGRSTnnn, else "unknown". */
function safeDbCode(error: unknown): string {
  try {
    const c = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (typeof c === "string" && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(c)) return c;
  } catch {
    /* hostile error object */
  }
  return "unknown";
}

/** Logs `error` (if any) as tag + code only and returns the fixed client text. */
function dbFail(error: unknown, tag: string, message: string = DB_ERROR_MESSAGE): string {
  if (error) console.error("[milan-api] db error", { tag, code: safeDbCode(error) });
  return message;
}

/**
 * fetch مع إعادة محاولة للأخطاء المؤقتة (ازدحام النموذج 503، تحديد المعدل 429، ...).
 * 3 محاولات بانتظار قصير بينها، بدون تجاوز زمن معقول لرد الـ webhook.
 */
async function fetchRetry(
  url: string,
  init: RequestInit,
  attempts = 3
): Promise<Response> {
  const delays = [1000, 2500];
  let last: Response | null = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);

      if (![429, 500, 502, 503, 504].includes(res.status)) {
        return res;
      }

      last = res;
      console.warn(
        `[ai] transient ${res.status}, attempt ${i + 1}/${attempts}`
      );
    } catch (e) {
      // Stage 6: fixed category only; the error text embeds the request URL.
      const category = fetchErrorCategory(e);
      console.warn(
        `[ai] network error, attempt ${i + 1}/${attempts}`,
        { category }
      );

      if (i === attempts - 1) throw new ProviderNetworkError("ai", category);
    }

    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delays[i] ?? 2500));
    }
  }

  return last as Response;
}

async function embed(
  texts: string[]
): Promise<number[][]> {
  const key = aiKey("embed");
  if (!key) throw new Error("No API key found for embeddings");

  // إذا كان المفتاح يخص Google (يبدأ بـ AIza)
  if (key.startsWith("AIza")) {
    // Stage 6: the key travels in the x-goog-api-key header, never in the URL.
    const res = await fetchRetry(
      "https://generativelanguage.googleapis.com/v1/models/text-embedding-004:batchEmbedContents",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          requests: texts.map(text => ({
            model: "models/text-embedding-004",
            content: { parts: [{ text }] }
          }))
        }),
      }
    );
    if (!res.ok) throw await providerHttpError("Gemini embedding", res);
    const j = await res.json();
    return j.embeddings.map((e: any) => e.values);
  }

  // الإعداد الافتراضي لـ OpenAI
  const res = await fetchRetry(
    `${env("EMBED_BASE_URL") || "https://api.openai.com/v1"}/embeddings`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: env("EMBED_MODEL") || "text-embedding-3-small",
        input: texts,
      }),
    }
  );
  if (!res.ok) throw await providerHttpError("OpenAI embedding", res);
  const j = await res.json();
  return j.data.map((d: { embedding: number[] }) => d.embedding);
}

const pg = (v: number[]) =>
  `[${v.join(",")}]`;

async function chatJSON(
  system: string,
  user: string
): Promise<Record<string, unknown>> {
  const url = `${
    env("LLM_BASE_URL") ||
    "https://api.openai.com/v1"
  }/chat/completions`;

  const call = (model: string) =>
    fetchRetry(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aiKey()}`,
      },
      body: JSON.stringify({
        model,

        response_format: {
          type: "json_object",
        },

        messages: [
          {
            role: "system",
            content: system,
          },
          {
            role: "user",
            content: user,
          },
        ],
      }),
    });

  const primary =
    env("LLM_MODEL") || "gpt-4o-mini";

  let res = await call(primary);

  /**
   * نموذج بديل اختياري عند استمرار الفشل المؤقت (مثلاً gemini-2.0-flash).
   */
  const fallback = env("LLM_FALLBACK_MODEL").trim();

  if (
    !res.ok &&
    fallback &&
    fallback !== primary &&
    [404, 429, 500, 502, 503, 504].includes(res.status)
  ) {
    console.warn(
      `[ai] primary model ${primary} failed (${res.status}), trying ${fallback}`
    );

    res = await call(fallback);
  }

  if (!res.ok) {
    throw await providerHttpError("llm", res);
  }

  const j = await res.json();

  try {
    return JSON.parse(
      j.choices?.[0]?.message?.content ?? "{}"
    );
  } catch {
    return {};
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   استخراج نص الموقع
═══════════════════════════════════════════════════════════════════════ */

async function extractFromUrl(
  url: string
): Promise<{
  title: string;
  text: string;
}> {
  // S4 SSRF guard (safeFetch.ts): public http(s) hosts only, ports 80/443,
  // manual re-validated redirects (max 3), 8s deadline, 1.5 MB cap,
  // text/html | text/plain | application/xhtml+xml only.
  const res = await safeFetchText(url, {
    fetch: (u, init) => fetch(u, init),
    resolve: denoResolver(),
  });

  if (!res.ok) {
    throw new Error(
      `تعذر فتح الرابط (HTTP ${res.status})`
    );
  }

  const raw = res.text;

  const $ = cheerio.load(raw);

  $(
    "script,style,noscript,nav,footer,header,aside,iframe,svg,form"
  ).remove();

  const title = (
    $("title").first().text() ||
    url
  )
    .trim()
    .slice(0, 200);

  const text = (
    $("main").first().text() ||
    $("article").first().text() ||
    $("body").text()
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40_000);

  return {
    title,
    text,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   تقسيم النص
═══════════════════════════════════════════════════════════════════════ */

function chunkText(
  text: string,
  size = 700,
  overlap = 120
): string[] {
  const parts = text
    .split(/\n{2,}|\s{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const out: string[] = [];

  let buf = "";

  for (const p of parts) {
    if (
      (buf + " " + p).length >
      size
    ) {
      if (buf.trim().length > 30) {
        out.push(buf.trim());
      }

      buf = (
        buf.slice(-overlap) +
        " " +
        p
      ).trim();
    } else {
      buf = (
        buf +
        "\n" +
        p
      ).trim();
    }
  }

  if (buf.trim().length > 30) {
    out.push(buf.trim());
  }

  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   QA
═══════════════════════════════════════════════════════════════════════ */

const QA_SYSTEM = `
أنت محلل محتوى لمشاريع تجارية.
من النص المرفق ولّد أسئلة وأجوبة قد يسألها عميل حقيقي.

قواعد:
- أجوبة من النص فقط.
- لا تختلق أسعارًا.
- لا تختلق مواعيد.
- لا تختلق خدمات.
- لا تختلق معلومات غير موجودة.
- الأسئلة بلهجة عميل عادي.
- الأجوبة واضحة ومباشرة.
- غطِ الأسعار، المواعيد، الموقع، الخدمات، التواصل، والاسترجاع إن وجدت.
- 5 إلى 12 زوجًا كحد أقصى.

أعد JSON فقط:
{
  "pairs": [
    {
      "question": "...",
      "answer": "..."
    }
  ]
}
`;

/* ═══════════════════════════════════════════════════════════════════════
   واتساب
═══════════════════════════════════════════════════════════════════════ */

/**
 * توكن واتساب: يدعم الاسمين WA_ACCESS_TOKEN و WHATSAPP_ACCESS_TOKEN
 * (الأخير هو الاسم المستخدم في سيرفر Railway) مع تنظيف المسافات
 * وكلمة Bearer إن لُصقت بالخطأ.
 */
function waToken(): string {
  const raw =
    env("WA_ACCESS_TOKEN") ||
    env("WHATSAPP_ACCESS_TOKEN");

  return raw
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "");
}

/**
 * خطأ مصادقة واتساب (توكن منتهي/غير صالح).
 */
class WaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaAuthError";
  }
}

/** Provider-success body only; never persist tokens or full response. */
async function providerIdFromResponse(res:Response,channel:"whatsapp"|"instagram"|"facebook")
 :Promise<string|null>{
 try{
  const raw:unknown=await res.json();
  if(!raw||typeof raw!=="object")return null;
  const body=raw as Record<string,unknown>;
  const messages=body.messages;
  const item=Array.isArray(messages)?messages[0]:null;
  const id=channel==="whatsapp"&&item&&typeof item==="object"?
    (item as Record<string,unknown>).id:(body.message_id??body.id);
  return typeof id==="string"&&id.length>0&&id.length<=255?id:null;
 }catch{return null;}
}

async function sendWa(
  phoneId: string,
  to: string,
  text: string
): Promise<string|null> {
  const token = waToken();

  if (!token) {
    throw new WaAuthError(
      "توكن واتساب غير مضبوط: أضف WA_ACCESS_TOKEN في Supabase Edge Function Secrets"
    );
  }

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${phoneId}/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: {
          body: text,
        },
      }),
    }
  );

  if (!res.ok) {
    const raw = await res.text();

    let code: number | undefined;

    try {
      const parsed = JSON.parse(raw);
      code = parsed?.error?.code;
    } catch {
      /* ليس JSON */
    }

    // 190 = توكن منتهي أو غير صالح، 102/104 = جلسة غير صالحة
    if (
      res.status === 401 ||
      code === 190 ||
      code === 102 ||
      code === 104
    ) {
      // Stage 6: status + validated code only, never Meta's free text.
      console.error("[wa] auth failure", {
        status: res.status,
        code: safeProviderCode(code),
      });

      throw new WaAuthError(
        "توكن واتساب منتهي أو غير صالح (Meta code 190). " +
          "أنشئ توكن دائم عبر System User في Meta Business Settings " +
          "ثم حدّث WA_ACCESS_TOKEN في Supabase Secrets."
      );
    }

    throw providerErrorFromBody("wa send", res.status, raw);
  }
  return providerIdFromResponse(res,"whatsapp");
}

async function boundPhone(
  sb: SupabaseClient,
  tenantId: string,
  // SEC (account resolution): true for SENDS — only an operator-VERIFIED
  // binding may pick the sending phone_number_id. Display reads (wa_status,
  // me) stay unfiltered so a pending binding still shows.
  verifiedOnly = false
): Promise<string | null> {
  const query = sb
    .from("wa_bindings")
    .select("phone_id")
    .eq("tenant_id", tenantId);
  const { data } = await (verifiedOnly
    ? query.eq("is_verified", true)
    : query
  ).maybeSingle();

  return data?.phone_id ?? null;
}

/**
 * يجلب حساب القناة مع التوكن الكامل (بدون قصّ الحقول) —
 * يستخدمه كل من المسار القديم والمسار الجديد المرسل عبر sendToConversation.
 */
async function fetchAccountWithToken(
  sb: SupabaseClient,
  accountId: string
): Promise<any> {
  const { data, error } = await sb
    .from("channel_accounts")
    .select("*")
    .eq("id", accountId)
    .maybeSingle();

  // T5-S2: fixed text; keeps "توكن" so the reply / unresolved 502 branch
  // (/توكن|token|auth|190/) is unchanged for a failed account read.
  if (error) throw new Error(dbFail(error, "account_read", "تعذر قراءة توكن حساب القناة — حاول مرة أخرى"));
  if (!data) throw new Error("لا يوجد حساب مرتبط بهذه المحادثة");

  return data;
}

/**
 * يرسل نصاً إلى محادثة عبر القناة الصحيحة:
 * - whatsapp  → sendWa (WA_ACCESS_TOKEN أو phone_number_id الخاص بالحساب)
 *   أولوية تحديد phone_id: conv.phone_id ← conversation ← wa_bindings ←
 *   channel_accounts(watsapp).external_id
 * - instagram / facebook → sendMetaDirectMessage
 *   (توكن الحساب المشفّر في channel_accounts عبر fetchAccountWithToken + decryptAccessTokenStrict)
 */
async function sendToConversation(
  sb: SupabaseClient,
  tenantId: string,
  conv: any,
  text: string
): Promise<void> {
  const channel: string =
    conv?.channel ?? "whatsapp";

  /* ── مسارات القنوات القديمة التي كانت تمرر الحساب صراحةً ── */
  if (
    channel !== "whatsapp" &&
    conv?.account &&
    conv?.recipient
  ) {
    const account = conv.account;
    let token: string | null = null;

    try {
      if (account.access_token_encrypted) {
        // Strict: an undecryptable token is never sent to Meta.
        token = await decryptAccessTokenStrict(account.access_token_encrypted);
      }
    } catch {
      console.warn("[sendToConversation] token_unavailable");
    }

    if (!token) {
      throw new Error(
        `لا يوجد توكن محفوظ لحساب ${channel} — أعد ربط الحساب`
      );
    }

    await sendMetaDirectMessage({
      channel: channel as "instagram" | "facebook",
      externalId: String(account.external_id ?? ""),
      token,
      recipientId: String(conv.recipient),
      text,
    });

    return;
  }

  if (channel === "instagram" || channel === "facebook") {
    if (!conv.account_id) {
      throw new Error(
        "حساب القناة غير مرتبط بهذه المحادثة"
      );
    }

    const account = await fetchAccountWithToken(
      sb,
      String(conv.account_id)
    );

    if (String(account.tenant_id ?? "") !== String(tenantId)) {
      throw new Error("حساب القناة لا يعود لهذا العميل");
    }

    if (!account.access_token_encrypted) {
      throw new Error(
        `لا يوجد توكن محفوظ لحساب ${channel} — أعد ربط الحساب`
      );
    }

    // Strict: an undecryptable/empty token fails clearly (no request to Meta).
    let token: string;
    try {
      token = await decryptAccessTokenStrict(
        account.access_token_encrypted
      );
    } catch {
      console.warn("[sendToConversation] token_unavailable");
      throw new Error(
        `لا يوجد توكن محفوظ لحساب ${channel} — أعد ربط الحساب`
      );
    }

    await sendMetaDirectMessage({
      channel: channel as "instagram" | "facebook",
      externalId: String(account.external_id),
      token,
      recipientId: String(
        conv.recipient_id ?? conv.wa_chat_id ?? ""
      )
        .split(":")
        .slice(1)
        .join(":"),
      text,
    });

    return;
  }

  /* ── واتساب: تحديد phone_number_id بأولويات واضحة ── */
  let phoneId: string | null =
    conv.phone_id ?? conv.wa_phone_id ?? null;

  if (!phoneId && conv.account_id) {
    const acc = await fetchAccountWithToken(
      sb,
      String(conv.account_id)
    ).catch(() => null);

    if (acc && acc.channel === "whatsapp") {
      phoneId = String(acc.external_id ?? "") || null;
    }
  }

  if (!phoneId) {
    phoneId = await boundPhone(sb, tenantId, true);
  }

  if (!phoneId) {
    throw new Error(
      "واتساب غير مربوط — اربط رقم المنصة أولاً"
    );
  }

  await sendWa(
    phoneId,
    String(conv.recipient ?? conv.wa_chat_id).replace(
      /^whatsapp:/,
      ""
    ),
    text
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Widget Helpers
═══════════════════════════════════════════════════════════════════════ */

/**
 * تحويل سجل Widget من snake_case إلى camelCase
 * لأن widget.js يستخدم camelCase.
 */
function widgetConfig(widget: any, tenant: any) {
  return {
    id: widget.id,
    name: widget.name,

    businessName:
      tenant?.business_name ??
      "",

    enabled:
      Boolean(widget.enabled),

    welcomeMessage:
      widget.welcome_message ??
      "مرحباً! كيف يمكنني مساعدتك؟",

    primaryColor:
      widget.primary_color ??
      "#2ec27e",

    position:
      widget.position === "right"
        ? "right"
        : "left",

    language:
      widget.language ??
      "ar",

    rtl:
      widget.rtl !== false,

    avatarUrl:
      widget.avatar_url ??
      null,

    showBranding:
      widget.show_branding !== false,

    placeholder:
      widget.placeholder ??
      "اكتب رسالتك...",

    suggestedQuestions:
      Array.isArray(widget.suggested_questions)
        ? widget.suggested_questions
        : [],

    publicToken:
      widget.public_token,
  };
}

/**
 * البحث عن Widget بواسطة public_token.
 *
 * هذه العملية عامة ولا تعتمد على auth.
 */
async function publicWidget(
  sb: SupabaseClient,
  token: string
) {
  if (!token) return null;

  const { data: widget } = await sb
    .from("widgets")
    .select("*")
    .eq("public_token", token)
    .eq("enabled", true)
    .maybeSingle();

  if (!widget) return null;

  const { data: tenant } = await sb
    .from("tenants")
    .select(
      "id,business_name,is_active,credits_remaining"
    )
    .eq("id", widget.tenant_id)
    .maybeSingle();

  if (!tenant) return null;

  return {
    widget,
    tenant,
  };
}

/**
 * إنشاء أو استرجاع جلسة Widget.
 */
async function getOrCreateWidgetSession(
  sb: SupabaseClient,
  widget: any,
  visitorId: string,
  visitorIp?: string | null,
  visitorUa?: string | null
) {
  const cleanVisitorId =
    String(visitorId || "")
      .trim()
      .slice(0, 200);

  if (!cleanVisitorId) {
    throw new Error(
      "visitorId مطلوب"
    );
  }

  const { data: existing } = await sb
    .from("widget_sessions")
    .select("*")
    .eq("widget_id", widget.id)
    .eq("visitor_id", cleanVisitorId)
    .maybeSingle();

  if (existing) {
    await sb
      .from("widget_sessions")
      .update({
        last_message_at:
          new Date().toISOString(),
      })
      .eq("id", existing.id);

    return existing;
  }

  const { data, error } = await sb
    .from("widget_sessions")
    .insert({
      widget_id: widget.id,
      tenant_id: widget.tenant_id,
      visitor_id: cleanVisitorId,
      visitor_ip:
        visitorIp
          ? String(visitorIp).slice(0, 100)
          : null,
      visitor_ua:
        visitorUa
          ? String(visitorUa).slice(0, 300)
          : null,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(
      dbFail(error, "widget_session_insert",
        "تعذر إنشاء جلسة Widget")
    );
  }

  return data;
}

/**
 * جلب رسائل جلسة Widget.
 */
async function widgetMessages(
  sb: SupabaseClient,
  sessionId: string,
  tenantId: string
) {
  const { data, error } = await sb
    .from("widget_messages")
    .select(
      "id,direction,body,kind,created_at"
    )
    .eq("session_id", sessionId)
    .eq("tenant_id", tenantId)
    .order("created_at", {
      ascending: true,
    })
    .limit(200);

  if (error) {
    throw new Error(
      dbFail(error, "widget_messages_read", "تعذر جلب رسائل الجلسة")
    );
  }

  return data ?? [];
}

/**
 * التأكد أن جلسة Widget تابعة فعلًا للـ Widget.
 */
async function widgetSession(
  sb: SupabaseClient,
  sessionId: string,
  widgetId: string,
  tenantId: string
) {
  const { data } = await sb
    .from("widget_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("widget_id", widgetId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  return data;
}

/**
 * محرك RAG المشترك بين WhatsApp و Widget.
 */
async function answerFromKnowledge(
  sb: SupabaseClient,
  tenant: any,
  text: string,
  history = ""
): Promise<{
  answer: string | null;
  kind:
    | "answer"
    | "refusal"
    | "error";
  similarity: number;
}> {
  const [qv] = await embed([text]);

  const { data: hits, error } =
    await sb.rpc(
      "match_knowledge",
      {
        p_tenant_id:
          tenant.id,

        p_query:
          pg(qv),

        p_limit:
          Number(
            env("RAG_TOP_K") || 5
          ),

        p_threshold: 0,
      }
    );

  if (error) {
    throw new Error(
      dbFail(error, "match_knowledge", "فشل البحث في قاعدة المعرفة")
    );
  }

  const matches =
    (
      (hits ?? []) as {
        id: string;
        content: string;
        similarity: number;
      }[]
    ).map((h) => ({
      id: h.id,
      content: h.content,
      similarity:
        Number(h.similarity) || 0,
    }));

  const best =
    matches[0]?.similarity ?? 0;

  const threshold =
    Number(
      env("SIMILARITY_THRESHOLD") ||
        0.25
    );

  if (
    !matches.length ||
    best < threshold
  ) {
    return {
      answer: null,
      kind: "refusal",
      similarity: best,
    };
  }

  const context =
    matches
      .map(
        (m, i) =>
          `[${i + 1}] ${m.content}`
      )
      .join("\n");

  const g = await chatJSON(
    [
      `أنت موظف خدمة عملاء لمشروع «${tenant.business_name}».`,
      "أجب بناءً على السياق المرفق فقط.",
      "لا تستخدم أي معلومات خارج السياق.",
      "لا تخترع سعرًا أو منتجًا أو موعدًا أو سياسة.",
      "إذا لم تجد الإجابة في السياق، قل إنك غير متأكد.",
      "استخدم اللغة العربية المناسبة للعميل.",
      "اجعل الرد مختصرًا وواضحًا.",
      ...(String(tenant.agent_system_prompt ?? "").trim()
        ? [
            "تعليمات صاحب المشروع (للأسلوب واللهجة فقط، ولا تلغي قاعدة الإجابة من السياق):",
            String(tenant.agent_system_prompt).trim().slice(0, 8000),
          ]
        : []),
      'أعد JSON فقط: {"answer":"...","grounded":true|false}',
    ].join("\n"),
    `
<context>
${context}
</context>

سؤال العميل:
${text}
${history ? `\nسياق المحادثة السابق:\n${history}\n` : ""}`
  );

  const answer =
    String(
      g.answer ?? ""
    ).trim();

  const grounded =
    Boolean(g.grounded) &&
    answer.length > 0;

  if (!grounded) {
    return {
      answer: null,
      kind: "refusal",
      similarity: best,
    };
  }

  return {
    answer,
    kind: "answer",
    similarity: best,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   Webhooks helpers (WhatsApp / Instagram)
═══════════════════════════════════════════════════════════════════════ */

/**
 * التحقق من توقيع Meta عبر x-hub-signature-256.
 * إذا لم يكن سر التطبيق مضبوطًا نرفض الحدث، ولا نتجاوز التحقق أبدًا.
 */
async function verifyMetaSignature(raw: string, sigHeader: string): Promise<boolean> {
  // Missing secrets are a configuration error and now fail closed.
  // Keep both configured app-secret candidates for existing IG/FB connections.
  return verifyMetaWebhookSignature(raw,sigHeader,[
    env("INSTAGRAM_APP_SECRET"),
    env("META_APP_SECRET"),
  ]);
}

/**
 * استخراج كل الرسائل من entry — من كلا البنيتين
 * (Messenger-style و Instagram Login changes[].value).
 */
function extractIgMessages(entry: any): Array<{
  senderId: string;
  recipientId: string;
  text: string;
  mid: string | null;
  choiceId: string | null;
  timestamp: number | null;
}> {
  const out: Array<{
    senderId: string;
    recipientId: string;
    text: string;
    mid: string | null;
    choiceId: string | null;
    /** The event's own timestamp (ms), only for a deterministic id when `mid` is missing. */
    timestamp: number | null;
  }> = [];

  // ─── 1) البنية القديمة: entry.messaging[] ───

  if (Array.isArray(entry.messaging)) {
    for (const ev of entry.messaging) {
      if (!ev?.message || ev.message.is_echo) {
        continue;
      }

      const senderId = String(ev.sender?.id ?? "");
      const recipientId = String(ev.recipient?.id ?? "");

      const text =
        typeof ev.message.text === "string"
          ? ev.message.text
          : "";

      const mid =
        typeof ev.message.mid === "string"
          ? ev.message.mid
          : null;

      if (senderId && text) {
        out.push({
          senderId,
          recipientId,
          text,
          mid,
          choiceId:selectedFlowChoice(ev.message),
          timestamp: Number.isSafeInteger(ev.timestamp) ? ev.timestamp : null,
        });
      }
    }
  }

  // ─── 2) البنية الجديدة: entry.changes[].value ───

  if (Array.isArray(entry.changes)) {
    for (const change of entry.changes) {
      if (change?.field !== "messages") {
        continue;
      }

      const value = change.value;

      if (!value) {
        continue;
      }

      if (Array.isArray(value.messaging)) {
        for (const ev of value.messaging) {
          if (!ev?.message || ev.message.is_echo) {
            continue;
          }

          const senderId = String(
            ev.sender?.id ?? ""
          );

          const recipientId = String(
            ev.recipient?.id ?? ""
          );

          const text =
            typeof ev.message.text === "string"
              ? ev.message.text
              : "";

          const mid =
            typeof ev.message.mid === "string"
              ? ev.message.mid
              : null;

          if (senderId && text) {
            out.push({
              senderId,
              recipientId,
              text,
              mid,
              choiceId:selectedFlowChoice(ev.message),
              timestamp: Number.isSafeInteger(ev.timestamp) ? ev.timestamp : null,
            });
          }
        }

        continue;
      }

      if (
        value.message &&
        !value.message.is_echo
      ) {
        const senderId = String(
          value.sender?.id ?? ""
        );

        const recipientId = String(
          value.recipient?.id ?? ""
        );

        const text =
          typeof value.message.text === "string"
            ? value.message.text
            : "";

        const mid =
          typeof value.message.mid === "string"
            ? value.message.mid
            : null;

        if (senderId && text) {
          out.push({
            senderId,
            recipientId,
            text,
            mid,
            choiceId:selectedFlowChoice(value.message),
            timestamp: Number.isSafeInteger(value.timestamp) ? value.timestamp : null,
          });
        }
      }
    }
  }

  return out;
}

/**
 * إرسال رسالة مباشرة عبر Facebook/Instagram Graph API.
 * يدعم نوعي رموز Instagram (IG... و EAA...) كما في metaSend.ts.
 */
async function sendMetaDirectMessage(opts: {
  channel: "instagram" | "facebook";
  externalId: string;
  token: string;
  recipientId: string;
  text: string;
}): Promise<string|null> {
  const {
    channel,
    externalId,
    token,
    recipientId,
    text,
  } = opts;

  if (!token) throw new Error("Missing Meta access token");
  if (!recipientId) throw new Error("Missing recipient ID");
  if (!text) throw new Error("Missing message text");

  const payload: Record<string, unknown> = {
    recipient: { id: recipientId },
    message: { text },
  };

  let url: string;
  let headers: Record<string, string> = {
    "content-type": "application/json",
  };
  let body: Record<string, unknown>;

  if (
    channel === "instagram" &&
    token.startsWith("IG")
  ) {
    /* Instagram Login */
    url =
      `https://graph.instagram.com/v21.0/me/messages`;

    headers = {
      ...headers,
      authorization:
        `Bearer ${token}`,
    };

    body = payload;
  } else if (channel === "instagram") {
    /* Facebook Login → Instagram API */
    if (!externalId) {
      throw new Error(
        "Missing Instagram Business Account ID"
      );
    }

    url =
      `https://graph.facebook.com/v21.0/${externalId}/messages`;

    body = { ...payload, access_token: token };
  } else {
    /* Facebook Messenger */
    url =
      "https://graph.facebook.com/v21.0/me/messages";

    body = { ...payload, access_token: token };
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw await providerHttpError(`${channel} send`, res);
  }
  return providerIdFromResponse(res,channel);
}

/**
 * جلب آخر N رسائل من المحادثة كسياق للـ RAG.
 */
async function conversationHistory(
  sb: SupabaseClient,
  conversationId: string,
  limit = 8
): Promise<string> {
  const { data: msgs } = await sb
    .from("messages")
    .select("direction, body_encrypted, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!msgs || msgs.length === 0) {
    return "";
  }

  const reversed = [...msgs].reverse();

  const lines: string[] = [];

  for (const m of reversed) {
    let bodyText = "";

    try {
      bodyText = await decryptField(m.body_encrypted);
    } catch {
      continue;
    }

    if (!bodyText?.trim()) continue;

    const role =
      m.direction === "in"
        ? "العميل"
        : "المساعد";

    lines.push(`${role}: ${bodyText.trim()}`);
  }

  return lines.join("\n");
}

/**
 * معالجة رسالة واردة (من WhatsApp أو Instagram)
 * وتشغيل الرد الآلي عبر RAG.
 */
/**
 * جلب بيانات المرسل (اسم + صورة) من Meta Graph API.
 * يعمل فقط لـ Instagram و Facebook (ليس WhatsApp).
 */
async function fetchSenderProfile(opts: {
  channel: "instagram" | "facebook" | "whatsapp";
  senderId: string;
  token: string | null;
  /** Hard deadline for the whole Graph request incl. body (default 3000 ms). */
  timeoutMs?: number;
}): Promise<{ name: string | null; avatar: string | null }> {
  const { channel, senderId, token } = opts;
  const timeoutMs =
    typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 3000;

  if (channel === "whatsapp" || !token || !senderId) {
    return { name: null, avatar: null };
  }

  try {
    let url: string;

    if (channel === "instagram" && token.startsWith("IG")) {
      // Instagram Login
      url = `https://graph.instagram.com/v21.0/${senderId}?fields=name,username,profile_pic`;
    } else if (channel === "instagram") {
      // Facebook Login → Instagram API
      url = `https://graph.facebook.com/v21.0/${senderId}?fields=name,profile_picture`;
    } else {
      // Facebook Messenger
      url = `https://graph.facebook.com/v21.0/${senderId}?fields=name,picture`;
    }

    // T5-S5: the token travels in the Authorization header, never in the URL
    // (same Bearer form as sendMeta / ../_shared/metaGraph.ts).
    // R1: strict deadline (covers headers AND body); a stall is a fixed "timeout" category.
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // سجل آمن: HTTP status + sanitized Meta error code فقط.
      // No free-text error message (Meta can echo the access token, e.g.
      // "Malformed access token ..."), no senderId (customer identifier),
      // no URL (it carries access_token=). The code is kept only if it is a
      // number or a short [A-Za-z0-9_.-] string; anything else is omitted.
      let errCode: unknown;
      try {
        const ej: any = await res.json();
        errCode = ej?.error?.code ?? ej?.code ?? ej?.error_type;
      } catch {
        /* استجابة غير JSON — نتجاهل الجسم بأمان */
      }
      const code =
        typeof errCode === "number" && Number.isFinite(errCode)
          ? errCode
          : typeof errCode === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(errCode)
          ? errCode
          : undefined;
      console.warn("[fetchSenderProfile] http_error", { status: res.status, code });
      return { name: null, avatar: null };
    }

    const pj: any = await res.json();

    let name: string | null = null;
    if (typeof pj.name === "string" && pj.name.trim()) {
      name = pj.name.trim();
    } else if (typeof pj.username === "string" && pj.username.trim()) {
      name = `@${pj.username.trim()}`;
    }

    let avatar: string | null = null;
    if (typeof pj.profile_pic === "string") avatar = pj.profile_pic;
    else if (typeof pj.profile_picture === "string") avatar = pj.profile_picture;
    else if (typeof pj.picture?.data?.url === "string") avatar = pj.picture.data.url;

    // Privacy: the customer's name is never logged (present/missing only).
    console.log("[fetchSenderProfile]", {
      senderId,
      name: name ? "present" : "missing",
      avatar: avatar ? "present" : "missing",
    });

    return { name, avatar };
  } catch (e: unknown) {
    // Fixed category only. Never the error text, stack, cause or object: a
    // fetch network error embeds the request URL, which carries access_token=.
    let category = "unknown";
    try {
      const n = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
      const c = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
      if (n === "AbortError" || n === "TimeoutError" || (typeof c === "string" && /TIMEOUT/i.test(c))) {
        category = "timeout";
      } else if (n === "SyntaxError") {
        category = "bad_response";
      } else if (n === "TypeError" || (typeof c === "string" && /^E[A-Z]+$/.test(c))) {
        category = "network";
      }
    } catch {
      /* hostile error object: keep "unknown" */
    }
    console.warn("[fetchSenderProfile] failed", { category });
    return { name: null, avatar: null };
  }
}
async function handleIncomingWebhookMessage(
  sb: SupabaseClient,
  account: any,
  chatId: string,
  customerText: string,
  externalMsgId: string | null,
  channel: "whatsapp" | "instagram" | "facebook",
  phoneId?: string,
  selectedChoiceId?: string | null,
  providerEventIdGenuine?: boolean,
  // Re-drive of an already persisted event whose flow lookup failed before
  // (inboundRoutingRetry.ts): the SAME inbound row and conversation are used,
  // nothing is inserted again. Only set by the duplicate pre-check below.
  redrive?: { conversationId: string; inboundId: string },
  // R1: optional bounded stage timing (webhookTimings.ts); inert by default.
  timer: StageTimer = NOOP_STAGE_TIMER
): Promise<"retry" | void> {
  const endConversation = timer.start("conversation");
  const tenantId: string =
    channel === "whatsapp"
      ? account.tenant_id
      : account.tenant_id;

  // Retry policy (inboundRoutingRetry.ts, migration 20261029340000):
  //  * UNKNOWN state (read error, unconfirmed claim, flow eligibility unknown)
  //    -> no flow and no AI; a persisted event is kept 'retrying' (webhook 503,
  //    provider redelivery re-drives it); an event not yet persisted is simply
  //    answered 503 (the redelivery is processed as new). Bounded: the last
  //    attempt marks the row 'exhausted' (terminal, observable).
  //  * KNOWN TERMINAL outcome -> a re-driven event is marked 'resolved'.
  //  * Events without a Meta mid (B-5, syntheticEventId.ts) are never
  //    retried: attempt cap 1 -> immediately 'exhausted' (observable), 200.
  const syntheticEvent = channel !== "whatsapp" && providerEventIdGenuine !== true;
  const retryKey = {
    tenantId: String(tenantId), accountId: String(account?.id ?? ""),
    platform: channel, eventId: String(externalMsgId ?? ""),
  };
  const keepRetryable = async (conversationId: string, inboundId: string): Promise<"retry" | void> => {
    const decision = await recordRoutingFailure(sb, {
      ...retryKey, conversationId, inboundId,
    }, retryAttemptCap(syntheticEvent));
    if (decision === "retry") {
      console.warn("[webhook-routing] flow eligibility unknown; event kept for redelivery");
      return "retry";
    }
    if (decision === "exhausted") {
      console.error("[webhook-routing] flow eligibility unknown; retries exhausted (automation_inbound_routing_retries)");
    } else if (decision === "unavailable") {
      console.error("[webhook-routing] flow eligibility unknown; retry state unavailable, event not retried");
    }
  };
  // Unknown state BEFORE the inbound row exists (or in a re-drive).
  const unknownState = async (): Promise<"retry" | void> =>
    redrive ? keepRetryable(redrive.conversationId, redrive.inboundId) : "retry";
  // Known terminal outcome: a re-driven event no longer needs a retry.
  const resolvedAfterRedrive = async () => {
    if (redrive) await markRoutingResolved(sb, retryKey);
  };
  // Deliberate no-reply exit of a LIVE delivery (never a re-drive: those are
  // resolved above / by the sweeper itself): mark the persisted event
  // terminal so the opt-in recovery sweeper never answers it late
  // (inboundRecovery.ts markLiveNoReply). Best effort; the result is ignored
  // and never changes this exit.
  const liveNoReply = async (reason: LiveNoReplyReason, conversationId: string, inboundId: string | null) => {
    if (redrive || !inboundId) return;
    await markLiveNoReply(sb, { ...retryKey, conversationId: String(conversationId), inboundId }, reason);
  };

  /**
   * البحث عن conversation موجود أو إنشاؤه.
   * PERF (webhook latency): this read needs only tenantId/chatId, so it is STARTED together with the tenant read
   * (each Edge -> database round trip is several hundred ms cross-region) but is still awaited, and its result
   * used, only after every tenant check below: a read never changes state, and every write stays after the checks.
   */
  const conversationRead = Promise.resolve(redrive
    ? sb
        .from("conversations")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("id", redrive.conversationId)
        .eq("wa_chat_id", chatId)
        .maybeSingle()
    : sb
        .from("conversations")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("wa_chat_id", chatId)
        .maybeSingle());
  // An early return below (tenant missing/inactive/unreadable) abandons this promise: never an unhandled rejection.
  conversationRead.catch(() => {});

  const { data: tenant, error: tenantError } = await sb
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .maybeSingle();

  if (tenantError) {
    console.error(`[${channel}_webhook] tenant read failed`);
    return await unknownState();
  }

  if (!tenant) {
    console.error(
      `[${channel}_webhook] tenant not found: ${tenantId}`
    );
    await resolvedAfterRedrive();
    return;
  }

  if (tenant.is_active === false) {
    console.log(
      `[${channel}_webhook] tenant inactive: ${tenantId}`
    );
    await resolvedAfterRedrive();
    return;
  }

  /** المحادثة: انظر conversationRead أعلاه. */
  const { data: existingConv, error: convError } = await conversationRead;

  let conv: any = existingConv;
  let conversationTouch: Promise<unknown> | null = null;

  if (convError) {
    console.error(`[${channel}_webhook] conversation read failed`);
    return await unknownState();
  }

  if (redrive && !conv) {
    // Proven absence (no read error): nothing left to answer.
    console.error(`[${channel}_webhook] re-drive conversation not found`);
    await resolvedAfterRedrive();
    return;
  }

  if (!conv) {
    const { data: newConv } = await sb
      .from("conversations")
      .insert({
        tenant_id: tenantId,
        wa_chat_id: chatId,
        customer_phone_encrypted:
          await encryptField(
            chatId.replace(/@s\.whatsapp\.net$/, "")
          ),
        channel,
        account_id: account?.id ?? null,
        last_message_at:
          new Date().toISOString(),
      })
      .select()
      .single();

    conv = newConv;
  } else {
    // PERF: independent of the conversation-start read below; awaited before the inbound row is stored.
    conversationTouch = Promise.resolve(sb
      .from("conversations")
      .update({
        last_message_at:
          new Date().toISOString(),
      })
      .eq("id", conv.id));
    conversationTouch.catch(() => {});
  }

  if (!conv) {
    console.error(
      `[${channel}_webhook] conversation is null`
    );
    // Not persisted yet: the provider redelivers it as a new event.
    return "retry";
  }

  // messageScope "conversation_start" (conversationStart.ts): is this the
  // conversation's first customer DM? Read BEFORE the inbound row is stored
  // (a re-drive excludes its own row), only where a flow can be selected:
  // a proven channel account on Instagram (durable / V2), or any channel
  // while FLOW_MULTICHANNEL_ENABLED (durable) or FLOW_RUNTIME_MODE
  // "message_only" (V2) is on. Read failure = unknown state: nothing is
  // persisted, no flow and no AI; the event stays retryable.
  let conversationStart: boolean | null = null;
  if (typeof account?.id === "string" && account.id.length > 0 &&
      (channel === "instagram" || multichannelEnabled() || env("FLOW_RUNTIME_MODE") === "message_only")) {
    try {
      conversationStart = await readConversationStart(sb, {
        tenantId: String(tenantId), accountId: account.id, conversation: conv,
        excludeInboundId: redrive ? redrive.inboundId : null,
      });
    } catch {
      // ConversationStartUnavailableError (or any unexpected failure): unknown.
      console.warn("[webhook-routing] conversation start unknown", { code: "conversation_start_unavailable" });
      return await unknownState();
    }
  }

  if (conversationTouch) await conversationTouch;
  endConversation();

  /**
   * حفظ رسالة العميل الواردة.
   */
  let inboundMessageId: string | null = redrive ? redrive.inboundId : null;
  const endPersist = timer.start("persist");
  const incomingResult = redrive ? "saved" : await persistInboundOnce(async () => {
    const response = await sb.from("messages").insert({
      conversation_id: conv.id,
      tenant_id: tenantId,
      direction: "in",
      body_encrypted: await encryptField(customerText),
      kind: "customer",
      is_auto: false,
      wa_message_id: externalMsgId,
    }).select("id").single();
    if (!response.error && typeof response.data?.id === "string") {
      inboundMessageId = response.data.id;
    }
    return response;
  });
  endPersist();

  if (incomingResult !== "saved") {
    if (incomingResult === "duplicate") {
      console.log(`[${channel}_webhook] duplicate inbound message skipped`);
    } else {
      console.error(`[${channel}_webhook] inbound insert did not commit`);
      // Not persisted: the provider redelivers it as a new event (a commit
      // whose response was lost is skipped as a duplicate, as before).
      return "retry";
    }
    return;
  }

  /**
   * مسار واحد للقرار (messageRouting.ts). الأسبقية: موظف بشري > إيقاف/عدم أهلية الرد الآلي >
   * جلسة تدفق قائمة > تدفق مطابق > الذكاء الاصطناعي. هذه الدالة تُمرّر الوقائع والعمليات فقط.
   * One decision (messageRouting.ts): human takeover > automation paused/ineligible > existing Flow
   * session > matching Flow trigger > AI. The exclusive DB claim below is the atomic owner of an event.
   */
  const deliveryTracking=env("DELIVERY_TRACKING_V1_ENABLED")==="true";
  // Several active flows: prepareSimpleFlowReply answers only the single
  // deterministic winner (flowInboundSelection.ts) when it is a V2 flow. While
  // the durable ingress is configured for this account, durable flows are
  // ranked too, so a durable winner is never replaced by a lower V2 flow.
  // No match -> null -> legacy AI (unchanged). A routing READ error makes
  // processExclusiveEvent return "routing_unavailable": no claim, no reply.
  const durableRanked=durableIngressConfigured(String(account.id),channel);
  let claimedRoute: "legacy_ai" | "flow" | null = null;
  const endRoute = timer.start("route");
  const decision = await routeInbound(
    {
      conversation: {
        transferred: conv.transferred,
        autoPausedReason: conv.auto_paused_reason,
        humanAgentExpiresAtMs: conv.human_agent_expires_at
          ? new Date(conv.human_agent_expires_at).getTime()
          : null,
        agentEnabled: account.agent_enabled,
        autoReply: account.auto_reply,
        creditsRemaining: Number(tenant.credits_remaining ?? 0),
        nowMs: Date.now(),
      },
      accountProven: typeof account?.id === "string" && account.id.length > 0,
      // Events without a stable provider ID cannot be deduplicated reliably.
      eventClaimable: !!externalMsgId && externalMsgId.length <= 256 && !!inboundMessageId,
      durableApplicable:
        channel === "instagram" ||
        ((channel === "whatsapp" || channel === "facebook") && multichannelEnabled()),
    },
    {
      // انتهت مدة Human Agent (15 دقيقة) → أعد الرد الآلي تلقائياً.
      resumeTakeover: async () => {
        await sb
          .from("conversations")
          .update({
            transferred: false,
            auto_paused_reason: null,
            human_agent_expires_at: null,
          })
          .eq("id", conv.id);
        conv.transferred = false;
        conv.auto_paused_reason = null;
        conv.human_agent_expires_at = null;
        console.log(
          `[${channel}_webhook] human agent expired, auto reply resumed: ${conv.id}`
        );
      },
      pauseForCredits: async () => {
        await sb
          .from("conversations")
          .update({
            auto_paused_reason: "credits",
          })
          .eq("id", conv.id);
        console.log(
          `[${channel}_webhook] no credits: ${tenantId}`
        );
      },
      afterGate: async () => {
  /**
   * تدفق آمن للمراقبة فقط: بدون إرسال أو تغيير على مسار AI.
   * No extra DB reads unless explicitly enabled by server environment.
   */
  if (env("FLOW_SHADOW_MODE") === "observe") {
    const observe = await flowShadowMayObserve(
      env("FLOW_SHADOW_MODE"),
      String(tenantId),
      String(account?.id ?? ""),
      {
        readGlobal: async () => {
          const { data, error } = await sb
            .from("automation_flow_global_switch")
            .select("enabled")
            .eq("singleton", true)
            .maybeSingle();
          if (error) throw error;
          return data;
        },
        readTenant: async (verifiedId: string) => {
          const { data, error } = await sb
            .from("automation_flow_tenant_switches")
            .select("enabled,test_only")
            .eq("tenant_id", verifiedId)
            .maybeSingle();
          if (error) throw error;
          return data;
        },
      }
    );
    if (observe) {
      console.info("[flow-shadow] test account eligible; legacy AI remains owner");
    }
  }

      },
      attemptDurable: async () => {
        const endDurable = timer.start("durable");
        const durable = await attemptDurableInstagram(sb, {
          conversationStart,
          tenantId, accountId: String(account.id), conversationId: String(conv.id),
          inboundId: inboundMessageId as string, eventId: externalMsgId as string, platform: channel,
          text: customerText,
          selectedChoiceId, providerEventIdGenuine: providerEventIdGenuine === true,
        });
        endDurable();
        return durable === "retry" ? "retry" : durable === "handled" ? "handled" : "fallback";
      },
      exclusive: async () => {
        const outcome = await processExclusiveEvent({
          onClaim: (c) => { claimedRoute = c.route; },
    prepareFlow: () => prepareSimpleFlowReply(
      sb, tenantId, String(account.id), channel, customerText,
      durableRanked?{durableDocument:(d)=>supportedDurableDocument(d,channel),conversationStart}:{conversationStart}
    ),
    claim: async (engineReady) => {
      const { data, error } = await sb.rpc("flow_claim_inbound", {
        p_tenant_id: tenantId,
        p_account_id: account.id,
        p_platform: channel,
        p_provider_event_id: externalMsgId,
        p_conversation_id: conv.id,
        p_inbound_message_id: inboundMessageId,
        p_engine_ready: engineReady,
      });
      if (error || !Array.isArray(data) || data.length !== 1) {
        throw new Error("exclusive message claim unavailable");
      }
      return data[0];
    },
    legacyAnswer: async () => {
      const history = await conversationHistory(sb, conv.id, 8);
      const result = await answerFromKnowledge(sb, tenant, customerText, history);
      const text = result.answer?.trim() ?? "";
      if (!text) {
        try {
          await sb.from("unresolved_questions").insert({
            tenant_id: tenantId,
            question_encrypted: await encryptField(customerText),
            status: "open",
            conversation_id: conv.id,
            best_similarity: result.similarity,
          });
        } catch {
          console.warn("[webhook-claim] unresolved insert failed");
        }
      }
      return text || null;
    },
    send: async (text) => {
      if (channel === "whatsapp") {
        if (!phoneId) throw new Error("missing WhatsApp phone ID");
        const providerMessageId=await sendWa(phoneId, chatId.replace(/^whatsapp:/, ""), text);
        return {providerMessageId};
      }
      if (!account.access_token_encrypted) throw new Error("missing account token");
      // Strict: an undecryptable/empty token throws BEFORE any request to
      // Meta (never a placeholder token). Outcome stays "send_failed"
      // (claim semantics unchanged) with the fixed reason code below.
      let token: string;
      try {
        token = await decryptAccessTokenStrict(account.access_token_encrypted);
      } catch (e) {
        console.warn("[webhook-claim] account token unavailable; no provider request", { code: "token_unavailable" });
        throw e;
      }
      if (!token) throw new Error("empty account token");
      const providerMessageId=await sendMetaDirectMessage({
        channel,
        externalId: String(account.external_id),
        token,
        recipientId: chatId.split(":").slice(1).join(":"),
        text,
      });
      return {providerMessageId};
    },
    ...(deliveryTracking?{delivery:{
      begin:async (claimId:string,outgoingId:string,text:string)=>{
        const hashBytes=await crypto.subtle.digest("SHA-256",
          new TextEncoder().encode(outgoingId+":"+text));
        const fingerprint=Array.from(new Uint8Array(hashBytes))
          .map(b=>b.toString(16).padStart(2,"0")).join("");
        const {data,error}=await sb.rpc("flow_begin_delivery",{
          p_claim_id:claimId,p_request_fingerprint:fingerprint
        });
        if(error||data!==true){
          console.error("[delivery] reservation refused",{
            claimId,messageId:outgoingId,code:error?.code??"duplicate_or_invalid"
          });
          return false;
        }
        return true;
      },
      finish:async (claimId:string,status:"confirmed"|"uncertain",providerId:string|null)=>{
        const {data,error}=await sb.rpc("flow_finish_delivery",{
          p_claim_id:claimId,p_status:status,p_provider_message_id:providerId
        });
        if(error||data!==true){
          console.error("[delivery] state update failed",{
            claimId,status,code:error?.code??"invalid_transition"
          });
          return false;
        }
        return true;
      }
    }}:{}),
    persistSent: async (outgoingId, text, providerMessageId) => {
      // Store the provider-accepted MID on the outgoing row, not merely in
      // the ephemeral send response. Both fields already exist in production.
      // wa_message_id is also used by existing webhook/Inbox lookups;
      // external_message_id preserves the provider-neutral identifier.
      const { error } = await sb.from("messages").insert({
        id: outgoingId,
        conversation_id: conv.id,
        tenant_id: tenantId,
        direction: "out",
        body_encrypted: await encryptField(text),
        kind: "answer",
        is_auto: true,
        wa_message_id: providerMessageId,
        external_message_id: providerMessageId,
      });
      // Same deterministic outgoing UUID cannot be persisted twice.
      return !error;
    },
    debit: async (outgoingId) => {
      const { data, error } = await sb.rpc("consume_flow_reply", {
        p_tenant_id: tenantId,
        p_message_id: outgoingId,
      });
      if(error){
        console.error("[webhook_billing] consume_reply PostgREST error",{
          tenantId,messageId:outgoingId,code:safeDbCode(error)
        });
        throw new Error("credit RPC error");
      }
      if(typeof data!=="number"||!Number.isInteger(data)){
        console.error("[webhook_billing] invalid consume_reply return",{
          tenantId,messageId:outgoingId
        });
        throw new Error("invalid credit RPC result");
      }
      if(data===-1||data===-3){
        console.error("[webhook_billing] sent message not billed",{
          tenantId,messageId:outgoingId,result:data
        });
      }
      return data;
    },
        });
        return { outcome, route: claimedRoute };
      },
    }
  );
  endRoute();

  switch (decision.kind) {
    case "no_reply": {
      if (decision.reason === "account_unproven") {
        // No PROVEN channel account (e.g. a WhatsApp binding without a proven channel_accounts row):
        // flow_claim_inbound refuses a NULL account. Known terminal state, not a retry loop.
        console.warn("[webhook-claim] no proven channel account; no auto-send", { code: "account_unproven" });
        await resolvedAfterRedrive();
        return;
      }
      if (decision.reason === "event_unclaimable") {
        console.warn("[webhook-claim] missing persisted inbound/provider ID; no auto-send");
        return;
      }
      console.log(
        decision.reason === "live_human_takeover"
          ? `[${channel}_webhook] conversation transferred: ${conv.id}`
          : decision.reason === "live_credits_paused"
          ? `[${channel}_webhook] paused (credits): ${conv.id}`
          : decision.reason === "live_auto_reply_off"
          ? `[${channel}_webhook] auto reply disabled for account ${account?.id}`
          : `[${channel}_webhook] automation not eligible: ${decision.reason}`
      );
      await liveNoReply(decision.reason, conv.id, inboundMessageId);
      await resolvedAfterRedrive();
      return;
    }
    case "retry":
      // Flow eligibility UNKNOWN (read error / unconfirmed claim): no flow and no AI; the event
      // stays retryable. A retry re-claims (a committed claim answers "duplicate"), so it can never
      // send twice (inboundRoutingRetry.ts, migration 20261029340000).
      return await keepRetryable(String(conv.id), inboundMessageId as string);
    case "flow_session":
      await resolvedAfterRedrive();
      return;
    case "claimed":
      await resolvedAfterRedrive();
      if (decision.outcome !== "sent_and_billed" && decision.outcome !== "duplicate") {
        console.warn("[webhook-claim] auto reply outcome:", decision.outcome);
      }
      return;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   المعالج الرئيسي
═══════════════════════════════════════════════════════════════════════ */

Deno.serve(async (req) => {
  // T5-D2: the handler below is unchanged; only the CORS origin headers of its
  // response (preflight included) are set per action and request Origin.
  return withMilanCors(req, await milanApiHandler(req), env);
});

// T5-D2: the former Deno.serve handler, byte-identical from here to its
// closing "});" (only this declaration line is new).
const milanApiHandler = (async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: CORS,
    });
  }

  const url = new URL(req.url);

  const action =
    url.searchParams.get("action") ??
    "";

  // T5-S4 (bodyLimits.ts): per-class byte limit on the raw body, enforced on
  // the declared Content-Length AND the bytes actually received, BEFORE
  // JSON.parse and BEFORE any signature check. Same text as req.text().
  const bodyClass = bodyClassFor(action);
  const limitedBody = await readBodyLimited(req, bodyLimitFor(bodyClass));
  if (!limitedBody.ok) {
    console.warn(BODY_TOO_LARGE_LOG_TAG, { class: bodyClass });
    return err(BODY_TOO_LARGE_MESSAGE, 413);
  }
  const raw = limitedBody.text;

  let body: Record<string, any> = {};

  try {
    body = raw
      ? JSON.parse(raw)
      : {};
  } catch {
    return err(
      "JSON غير صالح"
    );
  }

  const sb = sbAdmin();

  try {
    /* ═══════════════════════════════════════════════════════════════════
       PUBLIC
    ═══════════════════════════════════════════════════════════════════ */

    switch (action) {

      /* ────────────────────────────────────────────────────────────────
         تقديم ملف الـ Widget كـ JavaScript
      ──────────────────────────────────────────────────────────────── */
      case "widget.js": {
        try {
          const ghUrl = "https://raw.githubusercontent.com/hsnq2022022-cyber/milanochat/main/server/public/widget.js";
          const ghResponse = await fetch(ghUrl);
          if (!ghResponse.ok) {
            return err("Failed to load widget script from GitHub", 500);
          }
          const jsContent = await ghResponse.text();
          return new Response(jsContent, {
            status: 200,
            headers: {
              ...CORS,
              "content-type": "application/javascript; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
            },
          });
        } catch (error) {
          console.error("[widget.js] Error fetching script:", safeErrorLog(error));
          return err("Internal server error", 500);
        }
      }


      /* ────────────────────────────────────────────────────────────────
         إنشاء Tenant
      ──────────────────────────────────────────────────────────────── */

      case "create_tenant": {
        // T5-S1 (abuseGuards.ts): DB-backed, FAIL-CLOSED per-IP limit
        // (5 / 10 min AND 20 / 24 h) BEFORE any body use or tenant insert.
        // Limiter unavailable => 503, never an in-memory fallback.
        const ctLimited = await rateGateStrict({
          rpc: sb, headers: req.headers, salt: env("RATE_LIMIT_IP_SALT"), cors: CORS,
          rules: createTenantRules,
        });
        if (ctLimited) return ctLimited;
        // T5-S4 (bodyLimits.ts): optional sourceUrl must be a string <= 2,048 chars.
        if (!optionalSourceUrlValid(body.sourceUrl)) return err(SOURCE_URL_INVALID_MESSAGE);

        const {
          businessName,
          sourceType,
          sourceUrl,
          phoneE164,
        } = body;

        if (
          !businessName?.trim() ||
          ![
            "gmaps",
            "website",
            "manual",
          ].includes(sourceType)
        ) {
          return err(
            "بيانات ناقصة"
          );
        }

        const phone =
          typeof phoneE164 ===
          "string" &&
          /^\+\d{7,15}$/.test(
            phoneE164
          )
            ? phoneE164
            : null;

        const { data, error } =
          await sb
            .from("tenants")
            .insert({
              business_name:
                businessName
                  .trim()
                  .slice(0, 120),

              source_type:
                sourceType,

              source_url:
                sourceUrl ??
                null,

              business_phone_encrypted:
                phone
                  ? await encryptField(
                      phone
                    )
                  : null,

              credits_remaining: 0,

              is_active: false,
            })
            .select(
              "id, claim_token"
            )
            .single();

        if (
          error ||
          !data
        ) {
          return err(
            error
              ? dbFail(error, "create_tenant", "تعذر إنشاء الحساب — حاول مرة أخرى")
              : "خطأ",
            500
          );
        }

        return json({
          tenantId:
            data.id,

          claimToken:
            data.claim_token,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         PAY WEBHOOK
      ═══════════════════════════════════════════════════════════════ */

      case "pay_webhook": {
        const sig =
          req.headers.get(
            "moyasar-signature"
          ) ?? "";

        const expected =
          hex(
            await crypto.subtle.sign(
              "HMAC",
              await crypto.subtle.importKey(
                "raw",
                enc.encode(
                  env(
                    "MOYASAR_WEBHOOK_SECRET"
                  )
                ),
                {
                  name: "HMAC",
                  hash: "SHA-256",
                },
                false,
                ["sign"]
              ),
              enc.encode(raw)
            )
          );

        if (
          !sig ||
          sig !== expected
        ) {
          return err(
            "توقيع غير صالح",
            401
          );
        }

        const ev = body;

        const type: string =
          ev.type ?? "";

        const invoiceId: string =
          ev.data?.invoice_id ??
          ev.data?.id;

        if (
          !invoiceId ||
          !/paid|succeeded/.test(
            type
          )
        ) {
          return json({
            received: true,
          });
        }

        const {
          data: payment,
        } = await sb
          .from("payments")
          .select("*")
          .eq(
            "invoice_id",
            invoiceId
          )
          .maybeSingle();

        if (
          !payment ||
          payment.status ===
            "paid"
        ) {
          return json({
            received: true,
          });
        }

        const creditValues: Record<number, number> = {
          9900: 1000,
          24900: 3000,
          64900: 10000,
        };
        const credits = creditValues[Number(payment.amount)] ?? 1000;

        await sb
          .from("payments")
          .update({
            status: "paid",
            credits_granted:
              credits,
            webhook_event: ev,
            paid_at:
              new Date().toISOString(),
          })
          .eq(
            "id",
            payment.id
          );

        await sb.rpc(
          "grant_credits",
          {
            p_tenant_id:
              payment.tenant_id,
            p_credits:
              credits,
          }
        );

        return json({
          received: true,
          activated: true,
        });
      }

      /* ────────────────────────────────────────────────────────────────
         WhatsApp Webhook (Meta Cloud API)
         GET  ?action=whatsapp_webhook&hub.mode=... → verification
         POST ?action=whatsapp_webhook             → incoming messages
      ──────────────────────────────────────────────────────────────── */

      case "whatsapp_webhook": {
        if (req.method === "GET") {
          const mode =
            url.searchParams.get("hub.mode");

          const token =
            url.searchParams.get(
              "hub.verify_token"
            );

          const challenge =
            url.searchParams.get(
              "hub.challenge"
            );

          const expected =
            env("WHATSAPP_VERIFY_TOKEN");

          if (
            mode === "subscribe" &&
            verifyTokenMatches(token, expected)
          ) {
            return new Response(
              challenge ?? "",
              { status: 200 }
            );
          }

          return new Response(
            "Forbidden",
            { status: 403 }
          );
        }

        if (
          body.object !==
          "whatsapp_business_account"
        ) {
          return json({
            received: true,
          });
        }

        // WhatsApp Cloud API signs every event POST with the Meta App
        // Secret. WHATSAPP_VERIFY_TOKEN is ONLY for the GET handshake.
        // Missing signing configuration is a recoverable 503, never an
        // implicit authorization to accept unsigned customer messages.
        const whatsappSecrets = [
          env("WHATSAPP_APP_SECRET"),
          env("META_APP_SECRET"),
        ].map((secret) => secret.trim()).filter(Boolean);

        if (whatsappSecrets.length === 0) {
          console.error("[whatsapp_webhook] missing signing secret");
          return json({ error: "WhatsApp signing secret unavailable" }, 503);
        }

        const whatsappSignatureValid = await verifyMetaWebhookSignature(
          raw,
          req.headers.get("x-hub-signature-256") ?? "",
          whatsappSecrets
        );

        if (!whatsappSignatureValid) {
          console.error("[whatsapp_webhook] invalid signature");
          return json({ error: "Invalid WhatsApp signature" }, 401);
        }

        // Per-event outcomes: any "retry" (flow eligibility unknown) answers 503
        // so the provider redelivers (inboundRoutingRetry.ts).
        const waOutcomes: unknown[] = [];
        for (const entry of body.entry ?? []) {
          for (const change of entry?.changes ?? []) {
            if (change?.field !== "messages") {
              continue;
            }

            const value = change.value;

            if (!value) {
              continue;
            }

            const phoneId = String(
              value.metadata?.phone_number_id ?? ""
            );

            if (!phoneId) {
              continue;
            }

            /**
             * تحديد الحساب/المستأجر عبر wa_bindings.
             */
            let account: any = null;

            // S9 (waBinding.ts): only operator-VERIFIED bindings route traffic
            // (20261029290000). Unverified -> not answered; approve with the
            // service role: UPDATE public.wa_bindings SET is_verified = true,
            // verified_at = now(), verified_by = '<operator>:<ticket>'
            // WHERE phone_id = '<id>' AND tenant_id = '<tenant>';
            const { data: bindingRow } = await sb
              .from("wa_bindings")
              .select("tenant_id, phone_id, is_verified")
              .eq("phone_id", phoneId)
              .maybeSingle();
            const binding = bindingIsVerified(bindingRow) ? bindingRow : null;
            if (bindingRow && !binding) {
              console.warn("[whatsapp_webhook] binding ignored", { code: "wa_binding_unverified" });
            }

            if (binding) {
              // E1 (waBinding.ts provenWhatsappAccount): the binding proves
              // the tenant only. Its channel_accounts row (and so the account
              // id the exclusive claim needs) is used ONLY when proven: same
              // tenant, whatsapp, external_id == this phone number id, active,
              // exactly one row. Otherwise the event is stored without an
              // automatic reply (code logged), never assigned to a guess.
              const proven = await provenWhatsappAccount(sb, String(binding.tenant_id), phoneId);
              if (proven.status === "proven" && proven.account.tenant_id === binding.tenant_id) {
                account = proven.account;
              } else {
                console.warn("[whatsapp_webhook] binding account unproven", { code: "wa_account_" + proven.status });
                account = {
                  tenant_id: binding.tenant_id,
                  external_id: phoneId,
                  channel: "whatsapp",
                };
              }
            } else {
              // SEC (account resolution): the channel_accounts fallback routes
              // only when EXACTLY ONE active row claims this phone id. A lookup
              // error or several rows (e.g. several tenants) fail closed, and a
              // wa_bindings row (verified or not) of ANOTHER tenant blocks it.
              const { data: chAccs, error: chAccErr } = await sb
                .from("channel_accounts")
                .select(
                  "id, tenant_id, channel, external_id, status, agent_enabled, auto_reply, access_token_encrypted"
                )
                .eq("external_id", phoneId)
                .eq("channel", "whatsapp")
                .eq("status", "active")
                .limit(2);
              const chAcc =
                !chAccErr && Array.isArray(chAccs) && chAccs.length === 1
                  ? chAccs[0]
                  : null;

              if (chAccErr || !Array.isArray(chAccs) || chAccs.length > 1) {
                console.warn("[whatsapp_webhook] fallback account ignored", { code: "wa_account_lookup_failed_or_ambiguous" });
              } else if (
                chAcc &&
                bindingRow &&
                String(bindingRow.tenant_id) !== String(chAcc.tenant_id)
              ) {
                console.warn("[whatsapp_webhook] fallback account ignored", { code: "wa_binding_tenant_mismatch" });
              } else if (chAcc) {
                account = chAcc;
              }
            }

            if (!account) {
              console.warn(
                `[whatsapp_webhook] no account for phone_number_id=${phoneId}`
              );
              continue;
            }

            // FLOW_MULTICHANNEL_ENABLED (default OFF), and ONLY for the
            // operator-selected durable canary account: signed interactive
            // button replies carrying "flow-choice:<id>" (parsed by
            // normalizeMetaMessage.ts) reach the durable path as their title
            // + choice id. OFF or any other account: null, and the text-only
            // handling below is unchanged.
            const durableReplies =
              multichannelEnabled() &&
              typeof account.id === "string" &&
              account.id === env("FLOW_DURABLE_CANARY_ACCOUNT_ID")
                ? new Map(
                    normalizeMetaMessages({
                      object: "whatsapp_business_account",
                      entry: [{ changes: [change] }],
                    })
                      .filter((m) => m.choiceId !== null && m.providerMessageId !== null)
                      .map((m) => [String(m.providerMessageId), m] as const)
                  )
                : null;

            const customerNameOf = (waId: string) => {
              const c = (value.contacts ?? []).find(
                (x: any) => x.wa_id === waId
              );
              return c?.profile?.name
                ? String(c.profile.name)
                : null;
            };

            for (const message of value.messages ?? []) {
              const from = String(message?.from ?? "");

              if (!from) {
                continue;
              }

              const text =
                typeof message?.text?.body === "string"
                  ? message.text.body
                  : "";

              const msgId =
                typeof message?.id === "string"
                  ? message.id
                  : null;

              const durableReply =
                durableReplies && msgId
                  ? durableReplies.get(msgId) ?? null
                  : null;

              if (!text && !durableReply) {
                /*
                 * أنواع غير نصية — نسجلها الواردة فقط إن وُجد نص،
                 * وإلا نتجاهلها (كما في extractText القديم).
                 */
                continue;
              }

              const chatId = `whatsapp:${from}`;

              /**
               * منع التكرار قبل المعالجة.
               */
              if (msgId) {
                const { data: dup } = await sb
                  .from("messages")
                  .select("id")
                  .eq("wa_message_id", msgId)
                  .maybeSingle();

                if (dup) {
                  // Re-drive ONLY an event kept retryable after an unknown
                  // flow eligibility; every other duplicate is skipped.
                  const pending = await retryableEvent(sb, {
                    tenantId: String(account.tenant_id), accountId: String(account.id ?? ""),
                    platform: "whatsapp", eventId: msgId,
                  });
                  if (pending) {
                    // The opt-in recovery sweeper holds a lease on this event
                    // (inboundRecovery.ts): never re-drive it concurrently;
                    // 503 and let the provider redeliver.
                    if (await recoveryLeaseActive(sb, { tenantId: String(account.tenant_id), inboundId: pending.inboundId })) {
                      waOutcomes.push("retry");
                      continue;
                    }
                    waOutcomes.push(await runBatchEvent(() => handleIncomingWebhookMessage(
                      sb, account, chatId,
                      durableReply && !text ? durableReply.text : text,
                      msgId, "whatsapp", phoneId,
                      durableReplies ? durableReply?.choiceId ?? null : undefined,
                      durableReplies ? typeof msgId === "string" && msgId.length > 0 : undefined,
                      pending
                    )));
                    continue;
                  }
                  console.log(
                    `[whatsapp_webhook] duplicate skipped: ${msgId}`
                  );
                  continue;
                }
              }

              const name = customerNameOf(from);

              // runBatchEvent: an event that throws never aborts the batch;
              // every event is processed before the status is chosen.
              waOutcomes.push(await runBatchEvent(() => handleIncomingWebhookMessage(
                sb,
                account,
                chatId,
                durableReply && !text ? durableReply.text : text,
                msgId,
                "whatsapp",
                phoneId,
                durableReplies ? durableReply?.choiceId ?? null : undefined,
                durableReplies ? typeof msgId === "string" && msgId.length > 0 : undefined
              )));

              if (name) {
                await sb
                  .from("conversations")
                  .update({
                    customer_name: name,
                  })
                  .eq("tenant_id", account.tenant_id)
                  .eq("wa_chat_id", chatId);
              }
            }
          }
        }

        if (webhookStatusFor(waOutcomes) === 503) {
          return json({ error: "Flow routing temporarily unavailable" }, 503);
        }

        return json({
          received: true,
        });
      }

      /* ────────────────────────────────────────────────────────────────
         Instagram Webhook (Meta Messenger/Instagram API)
         GET  ?action=instagram_webhook&hub.mode=... → verification
         POST ?action=instagram_webhook             → incoming messages
      ──────────────────────────────────────────────────────────────── */

      case "instagram_webhook": {
        if (req.method === "GET") {
          const mode =
            url.searchParams.get("hub.mode");

          const token =
            url.searchParams.get(
              "hub.verify_token"
            );

          const challenge =
            url.searchParams.get(
              "hub.challenge"
            );

          const expected =
            env("INSTAGRAM_VERIFY_TOKEN") ||
            env("META_WEBHOOK_VERIFY_TOKEN");

          if (
            mode === "subscribe" &&
            verifyTokenMatches(token, expected)
          ) {
            return new Response(
              challenge ?? "",
              { status: 200 }
            );
          }

          return new Response(
            "Forbidden",
            { status: 403 }
          );
        }

        // R1: bounded per-stage timing for this request (webhookTimings.ts).
        const timer = createStageTimer();
        const endTotal = timer.start("total");

        if (
          body.object !== "instagram" &&
          body.object !== "page"
        ) {
          return json({
            received: true,
          });
        }

        // Missing signing-secret configuration is a server outage, not a
        // verified invalid event. Do not ACK and lose legitimate messages.
        // Meta should retry while operators restore the proper app secret.
        if (!env("INSTAGRAM_APP_SECRET").trim() &&
            !env("META_APP_SECRET").trim()) {
          console.error("[instagram_webhook] missing signing secret");
          return json({ error: "Webhook signing secret unavailable" }, 503);
        }

        const endVerify = timer.start("verify");
        const sigOk = await verifyMetaSignature(
          raw,
          req.headers.get(
            "x-hub-signature-256"
          ) ?? ""
        );
        endVerify();

        if (!sigOk) {
          // Facebook Page events (object "page"): a missing or bad signature
          // is rejected like WhatsApp (401), before any parsing side effect
          // or DB access. The Instagram object keeps its behaviour below.
          if (body.object === "page") {
            console.error("[instagram_webhook] invalid page signature");
            return json({ error: "Invalid webhook signature" }, 401);
          }

          // R2: fixed-field, payload-free diagnostics (webhookDiagnostics.ts).
          // Never throws and never logs the signature, ids, text or secrets.
          try {
            console.warn(
              "[instagram_webhook] invalid signature diagnostics",
              invalidSignatureDiagnostics(
                raw,
                body,
                req.headers.get("x-hub-signature-256")
              )
            );
          } catch { /* diagnostics must never change the response */ }

          console.error(
            "[instagram_webhook] invalid signature — ignored"
          );

          return json({
            received: true,
          });
        }

        // Only run after X-Hub-Signature-256 verification. Defaults OFF.
        if (env("FLOW_META_RECEIPTS_ENABLED") === "true") {
          try {
            await recordVerifiedMetaReceipts(sb, body);
          } catch (err) {
            console.error("[flow-meta-receipts] signed receipt storage failed",
              err instanceof Error ? err.name : "unknown");
            return json({error:"Delivery receipt temporarily unavailable"},503);
          }
        }

        // Per-event outcomes: any "retry" (flow eligibility unknown) answers 503
        // so the provider redelivers (inboundRoutingRetry.ts).
        const igOutcomes: unknown[] = [];
        // R1: optional sender-profile enrichment, run AFTER the response
        // (best effort) and never before the durable ingress decision.
        const profileJobs: Array<() => Promise<unknown>> = [];
        for (const entry of body.entry ?? []) {
          const entryId = String(entry.id ?? "");

          const msgs = extractIgMessages(entry);

          // FLOW_MULTICHANNEL_ENABLED only: signed Facebook postbacks carrying
          // "flow-choice:<id>" and a Meta mid (normalizeMetaMessage.ts). They
          // are processed below ONLY for the durable canary account. OFF: [].
          const pagePostbacks =
            body.object === "page" && multichannelEnabled()
              ? normalizeMetaMessages({ object: "page", entry: [entry] })
                  .filter((m) => m.kind === "postback" && m.choiceId !== null &&
                    m.providerMessageId !== null)
                  .map((m) => ({
                    senderId: m.senderId,
                    recipientId: m.recipientId,
                    text: m.text,
                    mid: m.providerMessageId,
                    choiceId: m.choiceId,
                    postback: true as const,
                  }))
              : [];

          for (const msg of [...msgs, ...pagePostbacks]) {
            const candidates = [
              entryId,
              msg.recipientId,
            ].filter((x) => x && x !== "0");

            let account: any = null;
            // Facebook Page events: a channel='facebook' account ONLY (never
            // an Instagram one); a page id shared by several accounts (e.g.
            // several tenants) is never assigned to one of them: ignored.
            let ambiguousPage = false;
            // SEC (account resolution): a lookup error or an ambiguous
            // Instagram id (2+ rows) stops resolution entirely — the next
            // candidate is never tried (fail closed; same idea as
            // commentIngress.ts: exactly one row or nothing). Rows with
            // status 'disconnected' are not candidates at all; a needs_reauth
            // (non-active) match still stops at the "not active" skip below.
            let lookupFailed = false;

            const endLookup = timer.start("lookup");
            for (const candidate of candidates) {
              if (body.object === "page") {
                const { data: pageAccounts, error: pageLookupError } = await sb
                  .from("channel_accounts")
                  .select(
                    "id, tenant_id, channel, external_id, status, agent_enabled, auto_reply, access_token_encrypted"
                  )
                  .eq("external_id", candidate)
                  .eq("channel", "facebook")
                  // A disconnected row neither receives nor blocks (it is
                  // outside the global unique index, 20261115120000).
                  .or("status.is.null,status.neq.disconnected")
                  .limit(2);

                if (pageLookupError) {
                  lookupFailed = true;
                  break;
                }

                if (Array.isArray(pageAccounts) && pageAccounts.length > 1) {
                  ambiguousPage = true;
                  break;
                }

                if (Array.isArray(pageAccounts) && pageAccounts.length === 1) {
                  account = pageAccounts[0];
                  break;
                }

                continue;
              }

              const { data: igAccounts, error: igLookupError } = await sb
                .from("channel_accounts")
                .select(
                  "id, tenant_id, channel, external_id, status, agent_enabled, auto_reply, access_token_encrypted"
                )
                .eq("external_id", candidate)
                .in("channel", [
                  "instagram",
                  "facebook",
                ])
                // A disconnected row neither receives nor blocks (it is
                // outside the global unique index, 20261115120000).
                .or("status.is.null,status.neq.disconnected")
                .limit(2);

              if (igLookupError || (Array.isArray(igAccounts) && igAccounts.length > 1)) {
                lookupFailed = true;
                break;
              }

              if (Array.isArray(igAccounts) && igAccounts.length === 1) {
                account = igAccounts[0];
                break;
              }
            }

            endLookup();

            if (lookupFailed) {
              console.warn(
                "[instagram_webhook] account lookup failed or ambiguous — event ignored"
              );
              continue;
            }

            if (ambiguousPage) {
              console.warn(
                "[instagram_webhook] page id matches several accounts — event ignored"
              );
              continue;
            }

            if (!account) {
              console.warn(
                `[instagram_webhook] no matching account | entryId=${entryId} recipient=${msg.recipientId}`
              );
              continue;
            }

            if (account.status !== "active") {
              console.warn(
                `[instagram_webhook] account not active — skipped | status=${account.status}`
              );
              continue;
            }

            // Postbacks (flag ON only) reach the durable canary account only.
            if ("postback" in msg &&
                !durableAccountAllowed(env("FLOW_DURABLE_CANARY_ACCOUNT_ID"), String(account.id))) {
              continue;
            }

            const channel =
              account.channel === "facebook"
                ? "facebook"
                : "instagram";

            const chatId =
              `${channel}:${msg.senderId}`;

            // B-5 (syntheticEventId.ts): no Meta mid -> a deterministic id from
            // signed payload fields (never raw text), so a redelivery maps to the
            // same inbound row/claim key; without an event timestamp the old
            // non-deduplicable fallback stays. Never treated as a provider id.
            const derivedId = msg.mid
              ? null
              : await syntheticEventId({
                  entryId, recipientId: msg.recipientId, senderId: msg.senderId,
                  timestamp: "timestamp" in msg ? msg.timestamp : null, text: msg.text,
                });
            const msgId =
              msg.mid || derivedId || `ig_${Date.now()}`;
            // Provenance, never inferred from the id's shape: true only when
            // Meta itself supplied a non-empty mid (msgId is then that mid).
            const providerEventIdGenuine =
              typeof msg.mid === "string" && msg.mid.length > 0;

            /**
             * منع التكرار.
             */
            if (msg.mid || derivedId) {
              const { data: dup } = await sb
                .from("messages")
                .select("id")
                .eq("wa_message_id", msgId)
                .limit(1);

              if (dup && dup.length > 0) {
                // Re-drive ONLY an event kept retryable after an unknown
                // flow eligibility; every other duplicate is skipped.
                const pending = await retryableEvent(sb, {
                  tenantId: String(account.tenant_id), accountId: String(account.id),
                  platform: channel, eventId: msgId,
                });
                if (pending) {
                  // Never concurrently with the recovery sweeper's lease.
                  if (await recoveryLeaseActive(sb, { tenantId: String(account.tenant_id), inboundId: pending.inboundId })) {
                    igOutcomes.push("retry");
                    continue;
                  }
                  const endRedriveHandle = timer.start("handle");
                  igOutcomes.push(await runBatchEvent(() => handleIncomingWebhookMessage(
                    sb, account, chatId, msg.text, msgId,
                    channel as "instagram" | "facebook",
                    undefined, msg.choiceId, providerEventIdGenuine, pending, timer
                  )));
                  endRedriveHandle();
                  continue;
                }
                console.log(
                  `[instagram_webhook] duplicate skipped: ${msgId}`
                );
                continue;
              }
            }

            // runBatchEvent: an event that throws never aborts the batch.
            const endHandle = timer.start("handle");
            igOutcomes.push(await runBatchEvent(() => handleIncomingWebhookMessage(
              sb,
              account,
              chatId,
              msg.text,
              msgId,
              channel as
                | "instagram"
                | "facebook",
              undefined,
              msg.choiceId,
              providerEventIdGenuine,
              undefined,
              timer
            )));
            endHandle();

            /* ── جلب بيانات المرسل (اسم + صورة) وحفظها ──
               بعد اكتمال معالجة الرسالة حتى لا يمنع الفشل
               الاستقبالَ أو الردَّ الآلي. أي خطأ هنا يُبتلع
               بأمان وتُكمل الحلقة بقية الرسائل.
               R1: لا يعمل هنا بل بعد الرد على Meta (best effort)؛
               قرار الاستقبال المتين اكتمل أعلاه ولا يعتمد عليه. */
            profileJobs.push(async () => {
            const profileT0 = performance.now();
            try {
              let senderToken: string | null = null;

              if (account.access_token_encrypted) {
                // Strict: an undecryptable token skips the profile fetch
                // (senderToken stays null -> no request to Meta).
                try {
                  senderToken = await decryptAccessTokenStrict(
                    account.access_token_encrypted
                  );
                } catch {
                  console.warn(
                    "[instagram_webhook] token_unavailable; profile fetch skipped"
                  );
                }
              }

              const profile = await fetchSenderProfile({
                channel: channel as "instagram" | "facebook",
                senderId: msg.senderId,
                token: senderToken,
              });

              // لا نكتب شيئًا إذا لم تأتِ بيانات فعلية —
              // ولا نستبدل قيمة موجودة بـ NULL أو سلسلة فارغة.
              if (profile.name || profile.avatar) {
                const patch: Record<string, string> = {};

                if (profile.name) patch.customer_name = profile.name;

                if (
                  profile.avatar &&
                  /^https?:\/\//i.test(profile.avatar)
                ) {
                  patch.customer_avatar = profile.avatar;
                }

                if (Object.keys(patch).length > 0) {
                  const { error: profUpdErr } = await sb
                    .from("conversations")
                    .update(patch)
                    .eq("tenant_id", account.tenant_id)
                    .eq("wa_chat_id", chatId);

                  if (profUpdErr) {
                    console.error(
                      `[instagram_webhook] sender profile update failed | chatId=${chatId}`,
                      { code: safeDbCode(profUpdErr) }
                    );
                  } else {
                    console.log(
                      `[instagram_webhook] sender profile saved | chatId=${chatId}`,
                      {
                        name: profile.name ? "present" : "unchanged",
                        avatar: profile.avatar ? "present" : "unchanged",
                      }
                    );
                  }
                }
              }
            } catch (e: unknown) {
              // Stage 6: fixed category only (no error text / object).
              console.warn(
                "[instagram_webhook] sender profile step skipped",
                { category: fetchErrorCategory(e) }
              );
            }
            // R1: duration only (whole ms); no ids, names, tokens or text.
            console.log("[instagram_webhook] profile_timing", {
              ms: Math.min(Math.max(Math.round(performance.now() - profileT0), 0), 3_600_000),
            });
            });
          }

          // FLOW_COMMENT_AUTOMATION_ENABLED (default OFF; commentIngress.ts):
          // signed Instagram "comments" / Page "feed" comment changes start a
          // comment run (public reply first, then the DM). OFF: never parsed.
          // A comment-ingest exception no longer aborts the remaining entries
          // (it used to answer 500); it is a transient outcome (503) instead.
          if (commentAutomationEnabled()) {
            igOutcomes.push(await runBatchEvent(async () => {
              await ingestSignedComments(sb, body.object, entry, {
                env, encrypt: encryptField,
              });
            }));
          }
        }

        // R1: every durable ingress / routing decision above has been AWAITED.
        // Only the optional profile enrichment is deferred (or awaited inline
        // when EdgeRuntime.waitUntil is unavailable). The 503 decision is
        // computed from the already-resolved outcomes and is unchanged.
        const answerRetry = webhookStatusFor(igOutcomes) === 503;
        const edgeRuntime = (globalThis as {
          EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
        }).EdgeRuntime;
        const profileMode = await runBackgroundJobs(
          profileJobs,
          edgeRuntime && typeof edgeRuntime.waitUntil === "function"
            ? (p) => edgeRuntime.waitUntil!(p)
            : null,
        );
        endTotal();
        try {
          const timings = timer.snapshot();
          if (timings.handle !== undefined || (timings.total ?? 0) >= 1000) {
            console.log("[instagram_webhook] stage_timings", {
              ...timings,
              profile_jobs: profileJobs.length,
              profile_mode: profileMode,
            });
          }
        } catch { /* timing diagnostics must never change the response */ }

        if (answerRetry) {
          return json({ error: "Flow routing temporarily unavailable" }, 503);
        }

        return json({
          received: true,
        });
      }

      /* ────────────────────────────────────────────────────────────────
         B-3/B-4 inbound recovery tick (inboundRecovery.ts, migration
         20261029360000). Server-to-server only; DEFAULT OFF.
         POST ?action=inbound_recovery_tick  body {"mode":"tick"}
         Auth first: the SAME bearer rule as the flow workers
         (flowWorkerAuth.ts; unchanged). Then FLOW_INBOUND_RECOVERY_ENABLED
         + the worker release gate (423 while off), then only opted-in
         tenants (automation_inbound_recovery_tenants, default none).
         Re-drives through handleIncomingWebhookMessage (same claim/route).
         Response: counters only (no ids, no text).
      ──────────────────────────────────────────────────────────────── */
      case "inbound_recovery_tick": {
        if (req.method !== "POST") {
          return json({ error: "Method not allowed" }, 405);
        }
        if (!acceptsFlowWorkerBearer(
          req.headers.get("authorization"),
          env("SUPABASE_SERVICE_ROLE_KEY"),
          env("flow_worker_service_role_key")
        )) {
          return json({ error: "Unauthorized" }, 401);
        }
        if (!inboundRecoveryEnabled((k) => Deno.env.get(k))) {
          return json({ status: "disabled" }, 423);
        }
        if (body?.mode !== "tick") {
          return json({ error: "Invalid mode" }, 400);
        }
        const counters = await runInboundRecovery(sb, {
          decrypt: decryptFieldStrict,
          redrive: (e) => handleIncomingWebhookMessage(
            sb, e.account, e.chatId, e.text, e.eventId, e.channel, e.phoneId,
            null, true, { conversationId: e.conversationId, inboundId: e.inboundId }
          ),
        });
        return json({ status: "ok", counters });
      }

      default:
        break;
    }

    /* ═══════════════════════════════════════════════════════════════════
       WIDGET PUBLIC API
    ═══════════════════════════════════════════════════════════════════ */

    if (
      action ===
      "widget_public"
    ) {
      const token =
        String(
          body.token ??
            url.searchParams.get(
              "token"
            ) ??
            ""
        ).trim();

      if (!token) {
        return err(
          "Widget token مطلوب",
          400
        );
      }

      const found =
        await publicWidget(
          sb,
          token
        );

      if (!found) {
        return err(
          "Widget غير موجود أو غير مفعّل",
          404
        );
      }

      return json(
        widgetConfig(
          found.widget,
          found.tenant
        )
      );
    }

    /* ═══════════════════════════════════════════════════════════════════
       WIDGET SESSION
    ═══════════════════════════════════════════════════════════════════ */

    if (
      action ===
      "widget_session"
    ) {
      const token =
        String(
          body.token ??
            url.searchParams.get(
              "token"
            ) ??
            ""
        ).trim();

      const visitorId =
        String(
          body.visitorId ??
            ""
        ).trim();

      if (!token) {
        return err(
          "Widget token مطلوب"
        );
      }

      if (!visitorId) {
        return err(
          "visitorId مطلوب"
        );
      }

      const found =
        await publicWidget(
          sb,
          token
        );

      if (!found) {
        return err(
          "Widget غير موجود أو غير مفعّل",
          404
        );
      }

      const visitorIp =
        req.headers.get(
          "x-forwarded-for"
        ) ??
        req.headers.get(
          "cf-connecting-ip"
        );

      const visitorUa =
        req.headers.get(
          "user-agent"
        );

      const session =
        await getOrCreateWidgetSession(
          sb,
          found.widget,
          visitorId,
          visitorIp,
          visitorUa
        );

      const messages =
        await widgetMessages(
          sb,
          session.id,
          found.tenant.id
        );

      return json({
        sessionId:
          session.id,

        messages,
      });
    }

    /* ═══════════════════════════════════════════════════════════════════
       WIDGET MESSAGE
    ═══════════════════════════════════════════════════════════════════ */

    if (
      action ===
      "widget_message"
    ) {
      const token =
        String(
          body.token ??
            url.searchParams.get(
              "token"
            ) ??
            ""
        ).trim();

      const sessionId =
        String(
          body.sessionId ??
            ""
        ).trim();

      const message =
        String(
          body.message ??
            ""
        ).trim();

      if (!token) {
        return err(
          "Widget token مطلوب"
        );
      }

      if (!sessionId) {
        return err(
          "sessionId مطلوب"
        );
      }

      if (!message) {
        return err(
          "الرسالة فارغة"
        );
      }

      if (
        message.length >
        4000
      ) {
        return err(
          "الرسالة طويلة جدًا"
        );
      }

      // S3 (abuseGuards.ts): per-IP limit BEFORE any lookup, write or LLM call.
      const widgetIpLimited = await rateGate({
        rpc: sb, headers: req.headers, salt: env("RATE_LIMIT_IP_SALT"), cors: CORS,
        rules: widgetIpRules,
      });
      if (widgetIpLimited) return widgetIpLimited;

      const found =
        await publicWidget(
          sb,
          token
        );

      if (!found) {
        return err(
          "Widget غير موجود أو غير مفعّل",
          404
        );
      }

      const session =
        await widgetSession(
          sb,
          sessionId,
          found.widget.id,
          found.tenant.id
        );

      if (!session) {
        return err(
          "جلسة Widget غير صالحة",
          404
        );
      }

      // S3 (abuseGuards.ts): per-session and per-tenant caps BEFORE the
      // customer message is stored and before any LLM / embedding call.
      const widgetScopeLimited = await rateGate({
        rpc: sb, headers: req.headers, salt: env("RATE_LIMIT_IP_SALT"), cors: CORS,
        rules: () => widgetScopeRules(found.tenant.id, session.id),
      });
      if (widgetScopeLimited) return widgetScopeLimited;

      /*
       * حفظ رسالة العميل أولًا
       */
      const {
        error: insertInError,
      } = await sb
        .from(
          "widget_messages"
        )
        .insert({
          session_id:
            session.id,

          widget_id:
            found.widget.id,

          tenant_id:
            found.tenant.id,

          direction: "in",

          body: message,

          kind: "customer",
        });

      if (
        insertInError
      ) {
        throw new Error(
          dbFail(insertInError, "widget_message_insert", "تعذر حفظ الرسالة — حاول مرة أخرى")
        );
      }

      /*
       * تحديث وقت الجلسة
       */
      await sb
        .from(
          "widget_sessions"
        )
        .update({
          last_message_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          session.id
        );

      /*
       * التأكد من حالة الحساب
       */
      if (
        found.tenant.is_active ===
        false
      ) {
        const reply =
          "عذرًا، المساعد غير متاح حاليًا.";

        await sb
          .from(
            "widget_messages"
          )
          .insert({
            session_id:
              session.id,

            widget_id:
              found.widget.id,

            tenant_id:
              found.tenant.id,

            direction: "out",

            body: reply,

            kind: "error",
          });

        return json({
          reply,
          kind: "error",
        });
      }

      /*
       * التحقق من الرصيد
       */
      const credits =
        Number(
          found.tenant
            .credits_remaining ??
            0
        );

      if (credits <= 0) {
        const reply =
          "عذرًا، المساعد غير متاح حاليًا.";

        await sb
          .from(
            "widget_messages"
          )
          .insert({
            session_id:
              session.id,

            widget_id:
              found.widget.id,

            tenant_id:
              found.tenant.id,

            direction: "out",

            body: reply,

            kind: "error",
          });

        return json({
          reply,
          kind: "error",
        });
      }

      // S8 (widgetBilling.ts): reserve ONE credit atomically BEFORE any
      // embedding / LLM call. Billing is ON unless WIDGET_BILLING_V2_ENABLED
      // is exactly "false" (operator kill switch). Idempotent per session +
      // client message id / message hash; released when no answer is delivered.
      const widgetBill = await reserveWidgetAnswer(sb, {
        enabled: widgetBillingEnabled(env("WIDGET_BILLING_V2_ENABLED")),
        tenantId: found.tenant.id, sessionId: session.id, message,
        clientMessageId: body.clientMessageId,
      });
      const widgetEarly = await widgetBillingEarlyReply(sb, widgetBill, {
        tenantId: found.tenant.id, widgetId: found.widget.id, sessionId: session.id,
      });
      if (widgetEarly) return json(widgetEarly);

      /*
       * البحث في قاعدة المعرفة + LLM
       */
      let result;

      try {
        result =
          await answerFromKnowledge(
            sb,
            found.tenant,
            message
          );
      } catch (e) {
        await releaseWidgetAnswer(sb, found.tenant.id, widgetBill);
        console.error(
          "[widget_message] AI error",
          safeErrorLog(e)
        );

        const reply =
          "عذرًا، حدث خطأ مؤقت أثناء معالجة رسالتك.";

        await sb
          .from(
            "widget_messages"
          )
          .insert({
            session_id:
              session.id,

            widget_id:
              found.widget.id,

            tenant_id:
              found.tenant.id,

            direction: "out",

            body: reply,

            kind: "error",
          });

        return json({
          reply,
          kind: "error",
        });
      }

      /*
       * لا توجد إجابة موثوقة
       */
      if (
        !result.answer ||
        result.kind ===
          "refusal"
      ) {
        await releaseWidgetAnswer(sb, found.tenant.id, widgetBill);
        const reply =
          "عذرًا، ما عندي معلومات كافية عن هذا السؤال حاليًا.";

        await sb
          .from(
            "widget_messages"
          )
          .insert({
            session_id:
              session.id,

            widget_id:
              found.widget.id,

            tenant_id:
              found.tenant.id,

            direction: "out",

            body: reply,

            kind: "refusal",
          });

        /*
         * تسجيل السؤال في unresolved_questions
         * إذا كان الجدول موجودًا.
         */
        try {
          await sb
            .from(
              "unresolved_questions"
            )
            .insert({
              tenant_id:
                found.tenant.id,

              question_encrypted:
                await encryptField(
                  message
                ),

              status: "open",

              conversation_id:
                null,

              best_similarity:
                result.similarity,
            });
        } catch (e) {
          console.error(
            "[widget_message] unresolved insert failed",
            e
          );
        }

        return json({
          reply,
          kind: "refusal",
        });
      }

      /*
       * حفظ إجابة Widget والحصول على معرّفها الحقيقي.
       * لا تستخدم public.messages أو consume_reply هنا.
       */
      const {data:savedWidgetReply,error:widgetSaveError}=await sb
        .from("widget_messages")
        .insert({
          session_id:session.id,
          widget_id:found.widget.id,
          tenant_id:found.tenant.id,
          direction:"out",
          body:result.answer,
          kind:"answer"
        }).select("id").single();

      if(widgetSaveError||!savedWidgetReply?.id){
        await releaseWidgetAnswer(sb, found.tenant.id, widgetBill);
        console.error("[widget_message] answer insert failed",{
          tenantId:found.tenant.id,code:widgetSaveError?safeDbCode(widgetSaveError):"missing_id"
        });
        return err("تعذر حفظ رد المساعد",500);
      }

      // S8 (widgetBilling.ts): the credit was reserved before the LLM call;
      // bind it to the saved answer ("deferred" only under the kill switch).
      const billingStatus=await commitWidgetAnswer(
        sb,found.tenant.id,widgetBill,savedWidgetReply.id);

      await sb
        .from(
          "widget_sessions"
        )
        .update({
          last_message_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          session.id
        );

      return json({
        reply:
          result.answer,

        kind:
          "answer",

        similarity:
          result.similarity,
        billingStatus,
      });
    }

    /* ═══════════════════════════════════════════════════════════════════
       إجراءات رمز الجلسة
    ═══════════════════════════════════════════════════════════════════ */

    const claimActions = [
      "bind_number",
      "wa_status",
      "qa_extract",
      "qa_save",
      "ingest_text",
      "qa_test",
      "comment_activity",
    ];

    if (
      claimActions.includes(
        action
      )
    ) {
      const tenant =
        await tenantByClaim(
          sb,
          req,
          body.tenantId ?? ""
        );

      if (!tenant) {
        return err(
          "رمز الجلسة غير صالح",
          403
        );
      }

      // S3/S4 (abuseGuards.ts): URL fetch / LLM / embedding claim actions are
      // rate limited per IP and per tenant before any of that work.
      if (CLAIM_AI_ACTIONS.has(action)) {
        const aiLimited = await rateGate({
          rpc: sb, headers: req.headers, salt: env("RATE_LIMIT_IP_SALT"), cors: CORS,
          rules: (ipHash) => aiActionRules(ipHash, tenant.id),
        });
        if (aiLimited) return aiLimited;
      }

      switch (action) {
        /* ─────────────────────────────────────────────────────────────
           ربط الرقم
        ───────────────────────────────────────────────────────────── */

        // Inbox comment activity (commentActivity.ts): read-only, scoped to
        // the claim-verified tenant, rate limited, at most 100 per page.
        case "comment_activity": {
          const caLimited = await rateGate({
            rpc: sb, headers: req.headers, salt: env("RATE_LIMIT_IP_SALT"), cors: CORS,
            rules: (ipHash) => commentActivityRules(ipHash, String(tenant.id)),
          });
          if (caLimited) return caLimited;
          const activity = await readCommentActivity(sb, String(tenant.id),
            { limit: body.limit, cursor: body.cursor }, decryptField);
          if (!activity.ok) {
            return json({ ok: false, error: activity.error }, activity.status);
          }
          return json(activity);
        }

        case "bind_number": {
          const phoneId =
            String(
              body.phoneId ??
                ""
            ).trim();

          if (
            !/^\d{6,20}$/.test(
              phoneId
            )
          ) {
            return err(
              "Phone Number ID غير صالح — خذه من Meta → WhatsApp → API Setup"
            );
          }

          // S1 (waBinding.ts): never overwrite another tenant's number.
          // INSERT .. ON CONFLICT (phone_id) DO NOTHING, then verify owner.
          const bound = await bindWhatsappNumber(
            supabaseBindStore(sb), tenant.id, phoneId
          );
          if (bound.status === "conflict") {
            console.warn("[bind_number] refused", { code: "phone_id_owned_by_other_tenant" });
            return json(BIND_CONFLICT_BODY, 409);
          }
          if (bound.status === "error") {
            console.error("[bind_number] failed", { code: "bind_error" });
            return err("تعذر ربط الرقم — حاول مرة أخرى", 500);
          }

          // S9 interim control (20261029290000): new bindings start
          // UNVERIFIED and get no auto-replies until an operator approves them
          // (SQL in the migration header). Same-tenant re-bind never touches
          // the flag (INSERT .. ON CONFLICT DO NOTHING).
          // TODO(security): permanent fix — require the tenant's WhatsApp
          // Business access token, call GET https://graph.facebook.com/<ver>/{phone_number_id}
          // with it (fail closed on any error / mismatch) and set
          // is_verified = true automatically instead of manual approval.
          return json({
            ok: true,
            verified: await readBindingVerified(sb, phoneId, tenant.id),
          });
        }

        /* ─────────────────────────────────────────────────────────────
           حالة واتساب
        ───────────────────────────────────────────────────────────── */

        case "wa_status": {
          const phoneId =
            await boundPhone(
              sb,
              tenant.id
            );

          return json({
            bound:
              Boolean(phoneId),

            phoneId,
            // S9: additive; false until an operator verified the binding,
            // null when the tenant has no binding.
            verified: phoneId ? await readBindingVerified(sb, phoneId, tenant.id) : null,
          });
        }

        /* ─────────────────────────────────────────────────────────────
           استخراج QA
        ───────────────────────────────────────────────────────────── */

        case "qa_extract": {
          const url =
            String(
              body.url ??
                ""
            );

          if (
            !/^https?:\/\/\S+\.\S+/.test(
              url
            )
          ) {
            return err(
              "الرابط غير صالح"
            );
          }

          const {
            title,
            text,
          } =
            await extractFromUrl(
              url
            );

          if (
            text.length < 40
          ) {
            return err(
              "المحتوى المستخرج غير كافٍ — جرّب الإدخال اليدوي",
              502
            );
          }

          const out =
            await chatJSON(
              QA_SYSTEM,
              `<website_content>
${text}
</website_content>`
            );

          const pairs =
            (
              Array.isArray(
                out.pairs
              )
                ? out.pairs
                : []
            )
              .filter(
                (p: any) =>
                  p?.question?.trim() &&
                  p?.answer?.trim()
              )
              .map(
                (p: any) => ({
                  question:
                    String(
                      p.question
                    ).trim(),

                  answer:
                    String(
                      p.answer
                    ).trim(),
                })
              )
              .slice(0, 15);

          if (
            !pairs.length
          ) {
            return err(
              "تعذر توليد الأسئلة — المحتوى قد لا يحوي معلومات كافية",
              502
            );
          }

          return json({
            pairs,
            title,
          });
        }

        /* ─────────────────────────────────────────────────────────────
           حفظ QA
        ───────────────────────────────────────────────────────────── */

        case "qa_save": {
          // T5-S4 (bodyLimits.ts): <= 50 pairs, bounded question / answer length,
          // optional sourceUrl string <= 2,048 chars; before any DB write / embedding.
          if (!qaPairsWithinLimits(body.pairs)) return err(QA_PAIRS_LIMIT_MESSAGE);
          if (!optionalSourceUrlValid(body.sourceUrl)) return err(SOURCE_URL_INVALID_MESSAGE);
          const pairs =
            (
              Array.isArray(
                body.pairs
              )
                ? body.pairs
                : []
            ).filter(
              (p: any) =>
                p?.question?.trim() &&
                p?.answer?.trim()
            );

          if (
            !pairs.length
          ) {
            return err(
              "القائمة فارغة"
            );
          }

          const {
            data: src,
            error: srcError,
          } = await sb
            .from(
              "knowledge_sources"
            )
            .insert({
              tenant_id:
                tenant.id,

              kind: "qa",

              url:
                body.sourceUrl ??
                null,

              status:
                "indexed",

              chunks_count:
                pairs.length,
            })
            .select()
            .single();

          if (
            srcError ||
            !src
          ) {
            return err(
              dbFail(srcError, "qa_save_source_insert", "تعذر إنشاء مصدر المعرفة"),
              500
            );
          }

          const contents =
            pairs.map(
              (p: any) =>
                `س: ${p.question.trim()}\nج: ${p.answer.trim()}`
            );

          const vectors =
            await embed(
              contents
            );

          const {
            error: chunksError,
          } = await sb
            .from(
              "knowledge_chunks"
            )
            .insert(
              contents.map(
                (
                  content: string,
                  i: number
                ) => ({
                  tenant_id:
                    tenant.id,

                  source_id:
                    src.id,

                  chunk_index:
                    i,

                  content,

                  embedding:
                    pg(
                      vectors[i]
                    ),
                })
              )
            );

          if (
            chunksError
          ) {
            return err(
              dbFail(chunksError, "qa_save_chunks_insert", "تعذر حفظ المحتوى في قاعدة المعرفة"),
              500
            );
          }

          return json({
            saved:
              pairs.length,

            sourceId:
              src.id,
          });
        }

        /* ─────────────────────────────────────────────────────────────
           إدخال نص
        ───────────────────────────────────────────────────────────── */

        case "ingest_text": {
          const text =
            String(
              body.text ??
                ""
            ).trim();

          if (
            text.length < 20
          ) {
            return err(
              "النص قصير جدًا"
            );
          }

          // T5-S4 (bodyLimits.ts): bounded text before chunking / embedding.
          if (!textWithinLimit(text, INGEST_TEXT_MAX_CHARS)) return err(TEXT_TOO_LONG_MESSAGE);

          const chunks =
            chunkText(text);

          const vectors =
            await embed(
              chunks
            );

          const {
            data: src,
            error: srcError,
          } = await sb
            .from(
              "knowledge_sources"
            )
            .insert({
              tenant_id:
                tenant.id,

              kind: "manual",

              status:
                "indexed",

              chunks_count:
                chunks.length,

              raw_text_encrypted:
                await encryptField(
                  text
                ),
            })
            .select()
            .single();

          if (
            srcError ||
            !src
          ) {
            return err(
              dbFail(srcError, "ingest_text_source_insert", "تعذر إنشاء المصدر"),
              500
            );
          }

          const {
            error: chunksError,
          } = await sb
            .from(
              "knowledge_chunks"
            )
            .insert(
              chunks.map(
                (
                  content,
                  i
                ) => ({
                  tenant_id:
                    tenant.id,

                  source_id:
                    src.id,

                  chunk_index:
                    i,

                  content,

                  embedding:
                    pg(
                      vectors[i]
                    ),
                })
              )
            );

          if (
            chunksError
          ) {
            return err(
              dbFail(chunksError, "ingest_text_chunks_insert", "تعذر حفظ المحتوى في قاعدة المعرفة"),
              500
            );
          }

          return json({
            chunks:
              chunks.length,
          });
        }

        /* ─────────────────────────────────────────────────────────────
           اختبار QA
        ───────────────────────────────────────────────────────────── */

        case "qa_test": {
          const text =
            String(
              body.text ??
                ""
            ).trim();

          if (!text) {
            return err(
              "اكتب صياغة لتجربتها"
            );
          }

          const [qv] =
            await embed([
              text,
            ]);

          const {
            data: hits,
            error,
          } = await sb.rpc(
            "match_knowledge",
            {
              p_tenant_id:
                tenant.id,

              p_query:
                pg(qv),

              p_limit:
                Number(
                  env(
                    "RAG_TOP_K"
                  ) || 5
                ),

              p_threshold: 0,
            }
          );

          if (error) {
            return err(
              dbFail(error, "qa_test", "فشل البحث في قاعدة المعرفة"),
              500
            );
          }

          const matches =
            (
              (hits ??
                []) as {
                id: string;
                content: string;
                similarity: number;
              }[]
            ).map(
              (h) => ({
                id:
                  h.id,

                content:
                  h.content,

                similarity:
                  Math.round(
                    h.similarity *
                      1000
                  ) / 1000,
              })
            );

          const best =
            matches[0]
              ?.similarity ??
            0;

          const threshold =
            Number(
              env(
                "SIMILARITY_THRESHOLD"
              ) || 0.25
            );

          if (
            !matches.length ||
            best <
              threshold
          ) {
            return json({
              confident:
                false,

              bestSimilarity:
                best,

              threshold,

              matches,

              answer:
                null,
            });
          }

          const g =
            await chatJSON(
              [
                `أنت موظف خدمة عملاء لمشروع «${tenant.business_name}» يرد عبر واتساب.`,
                "أجب بناءً على السياق المرفق فقط، وبنفس لهجة وأسلوب المحتوى المتوفر.",
                "إذا لم تجد إجابة كافية قل صراحة إنك غير متأكد ولا تختلق.",
                'أعد JSON فقط: {"answer":"...","grounded":true|false}',
              ].join("\n"),
              `<context>
${matches
  .map(
    (m, i) =>
      `[${i + 1}] ${m.content}`
  )
  .join("\n")}
</context>

سؤال العميل:
${text}`
            );

          const answer =
            String(
              g.answer ??
                ""
            ).trim();

          const confident =
            Boolean(
              g.grounded
            ) &&
            answer.length >
              0;

          return json({
            confident,

            bestSimilarity:
              best,

            threshold,

            matches,

            answer:
              confident
                ? answer
                : null,
          });
        }
      }
    }

    /* ═══════════════════════════════════════════════════════════════════
       AUTH
    ═══════════════════════════════════════════════════════════════════ */

    const u =
      await userOf(
        req,
        sb
      );

    if (!u) {
      return err(
        "غير مصرح",
        401
      );
    }

    /* ═══════════════════════════════════════════════════════════════════
       CLAIM ACCOUNT
    ═══════════════════════════════════════════════════════════════════ */

    switch (action) {
      case "claim_account": {
        const {
          claimToken,
        } = body;

        if (!claimToken) {
          return err(
            "رمز الضم ناقص"
          );
        }

        // T5-D1 (claimToken.ts): a non-string / malformed token is "invalid or
        // used" (404 below) with no DB call; otherwise ONE conditional UPDATE
        // (claim_token match AND user_id IS NULL, token rotated) so exactly one
        // concurrent claim wins and user_id is never overwritten.
        const {
          data,
          error,
        } = isClaimTokenFormat(claimToken)
          ? await claimTenantByToken(sb, u.id, claimToken)
          : { data: null, error: null };

        if (
          error ||
          !data
        ) {
          return err(
            error
              ? dbFail(error, "claim_account")
              : "رمز غير صالح أو مستخدم",
            error
              ? 500
              : 404
          );
        }

        return json({
          tenantId:
            data.id,
        });
      }
    }

    const tenant =
      await ownedTenant(
        sb,
        req
      );

    if (!tenant) {
      return err(
        "لا يوجد حساب مرتبط — أنشئ موظفًا من الصفحة الرئيسية أولاً",
        404
      );
    }

    /* ═══════════════════════════════════════════════════════════════════
       DASHBOARD WIDGET ACTIONS
    ═══════════════════════════════════════════════════════════════════ */

    switch (action) {
      /* ─────────────────────────────────────────────────────────────
         جلب Widgets الخاصة بالحساب
      ───────────────────────────────────────────────────────────── */

      case "widget_dashboard_list": {
        const {
          data,
          error,
        } = await sb
          .from("widgets")
          .select("*")
          .eq(
            "tenant_id",
            tenant.id
          )
          .order(
            "created_at",
            {
              ascending: false,
            }
          );

        if (error) {
          return err(
            dbFail(error, "widget_dashboard_list", "تعذر جلب البيانات — حاول مرة أخرى"),
            500
          );
        }

        return json(
          data ?? []
        );
      }

      /* ─────────────────────────────────────────────────────────────
         إنشاء Widget
      ───────────────────────────────────────────────────────────── */

      case "widget_dashboard_create": {
        const name =
          String(
            body.name ??
              ""
          )
            .trim()
            .slice(0, 100);

        if (!name) {
          return err(
            "اسم الـ Widget مطلوب"
          );
        }

        const settings =
          body.settings ??
          {};

        const appearance = settings.appearance ?? {};
        const chat = settings.chat ?? {};
        const branding = settings.branding ?? {};
        const avatar = settings.avatar ?? {};

        const welcomeMessage =
          chat.welcomeMessage ?? settings.welcomeMessage;
        const primaryColor =
          appearance.primaryColor ?? settings.primaryColor;
        const position =
          appearance.position ?? settings.position;
        const avatarUrl =
          avatar.botAvatar?.url ??
          appearance.avatar?.url ??
          settings.avatarUrl ??
          null;
        const showBranding =
          branding.showBranding ?? settings.showBranding;
        const placeholder =
          chat.placeholder ?? settings.placeholder;

        const suggested =
          Array.isArray(
            settings.suggestedQuestions
          )
            ? settings.suggestedQuestions
                .map(
                  (x: any) =>
                    String(x)
                      .trim()
                      .slice(
                        0,
                        200
                      )
                )
                .filter(Boolean)
                .slice(0, 20)
            : [];

        const {
          data,
          error,
        } = await sb
          .from("widgets")
          .insert({
            tenant_id:
              tenant.id,

            name,

            settings,

            enabled:
              true,

            welcome_message:
              String(
                welcomeMessage ??
                  "مرحباً! كيف يمكنني مساعدتك؟"
              ).slice(
                0,
                500
              ),

            primary_color:
              String(
                primaryColor ??
                  "#2ec27e"
              ).slice(
                0,
                30
              ),

            position:
              position ===
              "right"
                ? "right"
                : "left",

            language:
              "ar",

            rtl:
              true,

            avatar_url:
              avatarUrl,

            show_branding:
              showBranding !==
              false,

            placeholder:
              String(
                placeholder ??
                  "اكتب رسالتك..."
              ).slice(
                0,
                200
              ),

            suggested_questions:
              suggested,
          })
          .select("*")
          .single();

        if (
          error ||
          !data
        ) {
          return err(
            dbFail(error, "widget_dashboard_create", "تعذر إنشاء Widget"),
            500
          );
        }

        return json(
          data,
          201
        );
      }

      /* ─────────────────────────────────────────────────────────────
         تحديث Widget
      ───────────────────────────────────────────────────────────── */

      case "widget_dashboard_update": {
        const id =
          String(
            body.widgetId ??
              ""
          ).trim();

        if (!id) {
          return err(
            "Widget ID مطلوب"
          );
        }

        const {
          data: existing,
        } = await sb
          .from("widgets")
          .select("*")
          .eq(
            "id",
            id
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .maybeSingle();

        if (!existing) {
          return err(
            "Widget غير موجود",
            404
          );
        }

        const patch: Record<
          string,
          unknown
        > = {};

        if (body.name !== undefined) {
          const name = String(body.name).trim().slice(0, 100);
          if (!name) {
            return err("اسم الـ Widget مطلوب");
          }
          patch.name = name;
        }

        if (
          typeof body.enabled ===
          "boolean"
        ) {
          patch.enabled =
            body.enabled;
        }

        if (
          body.settings &&
          typeof body.settings ===
            "object"
        ) {
          const settings =
            body.settings;

          // حفظ الإعدادات المتداخلة كاملة.
          patch.settings = settings;

          const appearance = settings.appearance ?? {};
          const chat = settings.chat ?? {};
          const branding = settings.branding ?? {};
          const avatar = settings.avatar ?? {};

          const welcomeMessage =
            chat.welcomeMessage ?? settings.welcomeMessage;
          const primaryColor =
            appearance.primaryColor ?? settings.primaryColor;
          const position =
            appearance.position ?? settings.position;
          const placeholder =
            chat.placeholder ?? settings.placeholder;
          const showBranding =
            branding.showBranding ?? settings.showBranding;
          const avatarUrl =
            avatar.botAvatar?.url ??
            appearance.avatar?.url ??
            settings.avatarUrl;

          const chatWindow = settings.chatWindow ?? {};
          const chatWindowHeader = chatWindow.header ?? {};
          const backgroundColor =
            appearance.backgroundColor ?? settings.backgroundColor;
          const headerBackgroundColor =
            chatWindowHeader.backgroundColor ??
            settings.headerBackgroundColor;

          if (
            welcomeMessage !==
            undefined
          ) {
            patch.welcome_message =
              String(
                welcomeMessage
              ).slice(
                0,
                500
              );
          }

          if (
            primaryColor !==
            undefined
          ) {
            patch.primary_color =
              String(
                primaryColor
              ).slice(
                0,
                30
              );
          }

          if (
            position !==
            undefined
          ) {
            patch.position =
              position ===
              "right"
                ? "right"
                : "left";
          }

          if (
            placeholder !==
            undefined
          ) {
            patch.placeholder =
              String(
                placeholder
              ).slice(
                0,
                200
              );
          }

          if (
            showBranding !==
            undefined
          ) {
            patch.show_branding =
              showBranding !==
              false;
          }

          if (
            Array.isArray(
              settings.suggestedQuestions
            )
          ) {
            patch.suggested_questions =
              settings
                .suggestedQuestions
                .map(
                  (x: any) =>
                    String(x)
                      .trim()
                      .slice(
                        0,
                        200
                      )
                )
                .filter(Boolean)
                .slice(
                  0,
                  20
                );
          }

          if (
            avatarUrl !==
            undefined
          ) {
            patch.avatar_url =
              avatarUrl ??
              null;
          }

          if (
            settings.theme !==
            undefined
          ) {
            patch.theme =
              String(
                settings.theme
              ).slice(
                0,
                20
              );
          }

          if (
            backgroundColor !==
            undefined
          ) {
            patch.background_color =
              backgroundColor ??
              null;
          }

          if (
            headerBackgroundColor !==
            undefined
          ) {
            patch.header_background_color =
              headerBackgroundColor ??
              null;
          }
        }

        if (!Object.keys(patch).length) {
          return json(
            existing
          );
        }

        const {
          data,
          error,
        } = await sb
          .from("widgets")
          .update(patch)
          .eq(
            "id",
            id
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .select("*")
          .single();

        if (
          error ||
          !data
        ) {
          return err(
            dbFail(error, "widget_dashboard_update", "تعذر تحديث Widget"),
            500
          );
        }

        return json(
          data
        );
      }

      /* ─────────────────────────────────────────────────────────────
         حذف Widget
      ───────────────────────────────────────────────────────────── */

      case "widget_dashboard_delete": {
        const id =
          String(
            body.widgetId ??
              ""
          ).trim();

        if (!id) {
          return err(
            "Widget ID مطلوب"
          );
        }

        const {
          error,
        } = await sb
          .from("widgets")
          .delete()
          .eq(
            "id",
            id
          )
          .eq(
            "tenant_id",
            tenant.id
          );

        if (error) {
          return err(
            dbFail(error, "widget_dashboard_delete", "تعذر الحذف — حاول مرة أخرى"),
            500
          );
        }

        return json({
          ok: true,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         SUMMARY
      ═══════════════════════════════════════════════════════════════ */

      case "summary": {
        const [
          oq,
          cc,
        ] =
          await Promise.all([
            sb
              .from(
                "unresolved_questions"
              )
              .select(
                "id",
                {
                  count:
                    "exact",
                  head: true,
                }
              )
              .eq(
                "tenant_id",
                tenant.id
              )
              .eq(
                "status",
                "open"
              ),

            sb
              .from(
                "conversations"
              )
              .select(
                "id",
                {
                  count:
                    "exact",
                  head: true,
                }
              )
              .eq(
                "tenant_id",
                tenant.id
              ),
          ]);

        const phoneId =
          await boundPhone(
            sb,
            tenant.id
          );

        return json({
          tenant: {
            id:
              tenant.id,

            businessName:
              tenant.business_name,

            isActive:
              tenant.is_active,

            creditsRemaining:
              tenant.credits_remaining,

            phone:
              null,
          },

          wa: {
            status:
              phoneId
                ? "connected"
                : "disconnected",

            cloudApi:
              true,

            phoneId,
          },

          openUnresolved:
            oq.count ??
            0,

          conversations:
            cc.count ??
            0,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         CONVERSATIONS
      ═══════════════════════════════════════════════════════════════ */

      case "conversations": {
        const {
          data,
          error,
        } = await sb
          .from(
            "conversations"
          )
          .select(
            "id, wa_chat_id, customer_phone_encrypted, customer_name, customer_avatar, channel, account_id, transferred, auto_paused_reason, human_agent_expires_at, last_message_at"
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .order(
            "last_message_at",
            {
              ascending:
                false,
            }
          )
          .limit(50);

        if (error) {
          return err(
            dbFail(error, "conversations", "تعذر جلب البيانات — حاول مرة أخرى"),
            500
          );
        }

        /**
         * آخر رسالة لكل محادثة (تظهر معاينتها في قائمة الصندوق الموحد).
         */
        const lastBodies = await Promise.all(
          (data ?? []).map(async (c: any) => {
            try {
              const { data: lm } = await sb
                .from("messages")
                .select("body_encrypted")
                .eq("conversation_id", c.id)
                .eq("tenant_id", tenant.id)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

              return lm?.body_encrypted
                ? await decryptField(lm.body_encrypted)
                : null;
            } catch {
              return null;
            }
          })
        );

        const rows = [];

        for (
          const [idx, c] of
            (data ?? []).entries()
        ) {
          rows.push({
            id:
              c.id,

            customerPhone:
              await decryptField(
                c.customer_phone_encrypted
              ),

            customerName:
              c.customer_name ?? null,

            customerAvatar:
              c.customer_avatar ?? null,

            channel:
              c.channel ?? null,

            accountId:
              c.account_id ?? null,

            transferred:
              c.transferred,

            autoPausedReason:
              c.auto_paused_reason,

            humanAgentExpiresAt:
              c.human_agent_expires_at ?? null,

            lastMessageAt:
              c.last_message_at,

            lastMessageBody:
              lastBodies[idx] ?? null,
          });
        }

        return json(
          rows
        );
      }

      /* ═══════════════════════════════════════════════════════════════
         MESSAGES
      ═══════════════════════════════════════════════════════════════ */

      case "messages": {
        const {
          data,
          error,
        } = await sb
          .from("messages")
          .select(
            "id,direction,body_encrypted,kind,is_auto,created_at"
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .eq(
            "conversation_id",
            body.convId ??
              ""
          )
          .order(
            "created_at"
          )
          .limit(200);

        if (error) {
          return err(
            dbFail(error, "messages", "تعذر جلب البيانات — حاول مرة أخرى"),
            500
          );
        }

        const rows = [];

        for (
          const m of
            data ?? []
        ) {
          rows.push({
            ...m,

            body:
              await decryptField(
                m.body_encrypted
              ),
          });
        }

        return json(
          rows
        );
      }

      /* ═══════════════════════════════════════════════════════════════
         MANUAL REPLY
      ═══════════════════════════════════════════════════════════════ */

      case "reply": {
        const {
          convId,
          text,
          resumeAuto,
        } = body;

        if (
          !text?.trim()
        ) {
          return err(
            "نص الرد فارغ"
          );
        }

        const {
          data: conv,
        } = await sb
          .from(
            "conversations"
          )
          .select("*")
          .eq(
            "id",
            convId ??
              ""
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .maybeSingle();

        if (!conv) {
          return err(
            "المحادثة غير موجودة",
            404
          );
        }

        try {
          await sendToConversation(
            sb,
            tenant.id,
            conv,
            text.trim()
          );
        } catch (e) {
          /* فشل التوكن/المصادقة → 502 برسالة عربية واضحة */
          if (e instanceof WaAuthError) {
            return err(e.message, 502);
          }

          // Stage 6: same 502/400 branch as before (provider errors carry the
          // old body-based hint); the client only sees a safe message.
          const msg =
            e instanceof Error ? e.message : "فشل الإرسال";
          const safeMsg = clientErrorMessage(e, "فشل الإرسال");

          if (
            e instanceof ProviderHttpError
              ? e.authHint
              : /توكن|token|auth|190/i.test(msg)
          ) {
            return err(safeMsg, 502);
          }

          return err(safeMsg, 400);
        }

        await sb
          .from(
            "messages"
          )
          .insert({
            conversation_id:
              conv.id,

            tenant_id:
              tenant.id,

            direction:
              "out",

            body_encrypted:
              await encryptField(
                text.trim()
              ),

            kind:
              "manual",

            is_auto:
              false,
          });

        const patch:
          Record<
            string,
            unknown
          > = {
          last_message_at:
            new Date().toISOString(),
        };

        if (
          resumeAuto
        ) {
          Object.assign(
            patch,
            {
              transferred:
                false,

              auto_paused_reason:
                null,
            }
          );
        }

        await sb
          .from(
            "conversations"
          )
          .update(patch)
          .eq(
            "id",
            conv.id
          );

        return json({
          ok: true,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         UNRESOLVED
      ═══════════════════════════════════════════════════════════════ */

      /* ═══════════════════════════════════════════════════════════════
         AGENT PROMPT — رسالة توجيه الوكيل
      ═══════════════════════════════════════════════════════════════ */

      case "agent_prompt_get": {
        return json({
          prompt: tenant.agent_system_prompt ?? null,
        });
      }

      case "agent_prompt_set": {
        const { prompt } = body;

        if (typeof prompt !== "string") {
          return err("prompt يجب أن يكون نصًا");
        }

        if (prompt.length > 8000) {
          return err(
            "prompt يتجاوز الحد الأقصى (8000 حرف)"
          );
        }

        const { error: upErr } = await sb
          .from("tenants")
          .update({
            agent_system_prompt: prompt.trim() || null,
          })
          .eq("id", tenant.id);

        if (upErr) return err(dbFail(upErr, "agent_prompt_set", "تعذر حفظ التغييرات — حاول مرة أخرى"), 500);

        return json({ ok: true });
      }

      /* ═══════════════════════════════════════════════════════════════
         HUMAN AGENT — takeover / release
      ═══════════════════════════════════════════════════════════════ */

      case "takeover": {
        const { convId } = body;

        if (!convId) return err("convId مطلوب");

        const expiresAt = new Date(
          Date.now() + 15 * 60 * 1000
        ).toISOString();

        const { error: upErr } = await sb
          .from("conversations")
          .update({
            transferred: true,
            auto_paused_reason: "manual_takeover",
            human_agent_expires_at: expiresAt,
          })
          .eq("id", convId)
          .eq("tenant_id", tenant.id);

        if (upErr) return err(dbFail(upErr, "takeover", "تعذر حفظ التغييرات — حاول مرة أخرى"), 500);

        return json({ ok: true, expiresAt });
      }

      case "release": {
        const { convId } = body;

        if (!convId) return err("convId مطلوب");

        const { error: upErr } = await sb
          .from("conversations")
          .update({
            transferred: false,
            auto_paused_reason: null,
            human_agent_expires_at: null,
          })
          .eq("id", convId)
          .eq("tenant_id", tenant.id);

        if (upErr) return err(dbFail(upErr, "release", "تعذر حفظ التغييرات — حاول مرة أخرى"), 500);

        return json({ ok: true });
      }

      case "unresolved": {
        const {
          data,
          error,
        } = await sb
          .from(
            "unresolved_questions"
          )
          .select(
            "id, question_encrypted, status, manual_answer, added_to_kb, created_at, conversation_id, best_similarity"
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .order(
            "created_at",
            {
              ascending:
                false,
            }
          )
          .limit(100);

        if (error) {
          return err(
            dbFail(error, "unresolved", "تعذر جلب البيانات — حاول مرة أخرى"),
            500
          );
        }

        const rows = [];

        for (
          const q of
            data ?? []
        ) {
          rows.push({
            id:
              q.id,

            question:
              await decryptField(
                q.question_encrypted
              ),

            status:
              q.status,

            manualAnswer:
              q.manual_answer,

            addedToKb:
              q.added_to_kb,

            createdAt:
              q.created_at,

            conversationId:
              q.conversation_id,

            bestSimilarity:
              q.best_similarity ??
              null,
          });
        }

        return json(
          rows
        );
      }

      /* ═══════════════════════════════════════════════════════════════
         RESOLVE
      ═══════════════════════════════════════════════════════════════ */

      case "resolve": {
        const {
          id,
          answer,
          saveToKb,
          sendToCustomer,
        } = body;

        if (
          !answer?.trim()
        ) {
          return err(
            "الإجابة فارغة"
          );
        }

        const {
          data: q,
        } = await sb
          .from(
            "unresolved_questions"
          )
          .select("*")
          .eq(
            "id",
            id ?? ""
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .maybeSingle();

        if (!q) {
          return err(
            "السؤال غير موجود",
            404
          );
        }

        if (saveToKb) {
          const question =
            await decryptField(
              q.question_encrypted
            );

          const content =
            `س: ${question}\nج: ${answer.trim()}`;

          const [v] =
            await embed([
              content,
            ]);

          await sb
            .from(
              "knowledge_chunks"
            )
            .insert({
              tenant_id:
                tenant.id,

              source_id:
                null,

              chunk_index:
                0,

              content,

              embedding:
                pg(v),
            });
        }

        await sb
          .from(
            "unresolved_questions"
          )
          .update({
            status:
              "resolved",

            manual_answer:
              answer.trim(),

            added_to_kb:
              Boolean(
                saveToKb
              ),

            resolved_at:
              new Date().toISOString(),
          })
          .eq(
            "id",
            q.id
          );

        if (
          sendToCustomer &&
          q.conversation_id
        ) {
          const {
            data: conv,
          } = await sb
            .from(
              "conversations"
            )
            .select(
              "wa_chat_id, channel, account_id"
            )
            .eq(
              "id",
              q.conversation_id
            )
            .maybeSingle();

          if (conv) {
            try {
              await sendToConversation(
                sb,
                tenant.id,
                conv,
                answer.trim()
              );

              await sb
                .from(
                  "messages"
                )
                .insert({
                  conversation_id:
                    q.conversation_id,

                  tenant_id:
                    tenant.id,

                  direction:
                    "out",

                  body_encrypted:
                    await encryptField(
                      answer.trim()
                    ),

                  kind:
                    "manual",

                  is_auto:
                    false,
                });
            } catch (e) {
              console.error(
                "[unresolved] send failed",
                safeErrorLog(e)
              );

              /* فشل الإرسال إلى العميل → خطأ واضح بـ 502/400 */
              if (e instanceof WaAuthError) {
                return err(e.message, 502);
              }

              // Stage 6: same 502/400 branch as before; safe client message.
              const msg =
                e instanceof Error ? e.message : "فشل الإرسال";
              const safeMsg = clientErrorMessage(e, "فشل الإرسال");

              if (
                e instanceof ProviderHttpError
                  ? e.authHint
                  : /توكن|token|auth|190/i.test(msg)
              ) {
                return err(safeMsg, 502);
              }

              return err(safeMsg, 400);
            }
          }
        }

        return json({
          ok: true,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         KNOWLEDGE
      ═══════════════════════════════════════════════════════════════ */

      case "knowledge": {
        const {
          data,
          error,
        } = await sb
          .from(
            "knowledge_sources"
          )
          .select(
            "id, kind, url, status, error, chunks_count, created_at"
          )
          .eq(
            "tenant_id",
            tenant.id
          )
          .order(
            "created_at",
            {
              ascending:
                false,
            }
          );

        if (error) {
          return err(
            dbFail(error, "knowledge", "تعذر جلب البيانات — حاول مرة أخرى"),
            500
          );
        }

        return json(
          data ?? []
        );
      }

      /* ═══════════════════════════════════════════════════════════════
         KNOWLEDGE ADD
      ═══════════════════════════════════════════════════════════════ */

      
      /* ────────────────────────────────────────────────────────────────
         مزامنة منتجات سلة إلى قاعدة المعرفة
      ──────────────────────────────────────────────────────────────── */
      case "sync_salla_products": {
        const { data: sallaAcc } = await sb
          .from("channel_accounts")
          .select("access_token_encrypted")
          .eq("tenant_id", tenant.id)
          .eq("channel", "salla")
          .maybeSingle();

        if (!sallaAcc || !sallaAcc.access_token_encrypted) {
          return err("لم يتم العثور على توكن سلة. يرجى إعادة ربط المتجر.", 400);
        }

        const token = await decryptField(sallaAcc.access_token_encrypted);

        // جلب المنتجات من واجهة سلة
        const sallaRes = await fetch("https://api.salla.dev/admin/v2/products?per_page=50", {
          headers: { 
            "Authorization": `Bearer ${token}`, 
            "Accept": "application/json" 
          }
        });

        if (!sallaRes.ok) {
          return err("فشل الاتصال بـ Salla API. تأكد من صلاحية التوكن.", 502);
        }

        const sallaData = await sallaRes.json();
        const products = sallaData.data || [];

        if (products.length === 0) {
          return json({ success: true, message: "لا توجد منتجات لمزامنتها." });
        }

        // تحويل المنتجات إلى نص
        let fullText = `قائمة منتجات المتجر الحالية:
`;
        for (const p of products) {
          const price = p.price ? `${p.price.amount} ${p.price.currency}` : "غير محدد";
          const stock = p.quantity > 0 ? "متوفر" : "غير متوفر";
          fullText += `
- المنتج: ${p.name}
  السعر: ${price}
  الحالة: ${stock}
  الوصف: ${p.description || "لا يوجد وصف"}
  الرابط: ${p.url}
`;
        }

        // التقسيم وإنشاء الـ Embeddings
        const chunks = chunkText(fullText);
        const vectors = await embed(chunks);

        // حذف المنتجات القديمة من قاعدة المعرفة لتجنب التكرار
        await sb.from("knowledge_sources")
          .delete()
          .eq("tenant_id", tenant.id)
          .eq("kind", "salla_products");

        // حفظ المصدر الجديد
        const { data: src, error: srcError } = await sb
          .from("knowledge_sources")
          .insert({
            tenant_id: tenant.id,
            kind: "salla_products",
            url: "salla://products",
            status: "indexed",
            chunks_count: chunks.length,
          })
          .select()
          .single();

        if (srcError || !src) return err("تعذر إنشاء مصدر البيانات.", 500);

        // حفظ النصوص والـ Embeddings
        const { error: chunksError } = await sb
          .from("knowledge_chunks")
          .insert(
            chunks.map((content, i) => ({
              tenant_id: tenant.id,
              source_id: src.id,
              chunk_index: i,
              content,
              embedding: pg(vectors[i]),
            }))
          );

        if (chunksError) {
          return err("فشل حفظ المنتجات في قاعدة المعرفة.", 500);
        }

        return json({
          success: true,
          message: `تمت مزامنة ${products.length} منتج بنجاح.`,
          chunks: chunks.length
        });
      }


      case "knowledge_add": {
        // S4 (abuseGuards.ts): per-tenant limit before URL fetch / embeddings.
        const kbLimited = await rateGate({
          rpc: sb, headers: req.headers, salt: env("RATE_LIMIT_IP_SALT"), cors: CORS,
          rules: () => knowledgeAddRules(tenant.id),
        });
        if (kbLimited) return kbLimited;

        const {
          url,
          text,
        } = body;

        if (
          url?.trim()
        ) {
          const {
            title,
            text: raw2,
          } =
            await extractFromUrl(
              url.trim()
            );

          if (
            raw2.length < 40
          ) {
            return err(
              "المحتوى غير كافٍ",
              502
            );
          }

          const chunks =
            chunkText(
              raw2
            );

          const vectors =
            await embed(
              chunks
            );

          const {
            data: src,
            error: srcError,
          } = await sb
            .from(
              "knowledge_sources"
            )
            .insert({
              tenant_id:
                tenant.id,

              kind:
                "website",

              url:
                url.trim(),

              status:
                "indexed",

              chunks_count:
                chunks.length,
            })
            .select()
            .single();

          if (
            srcError ||
            !src
          ) {
            return err(
              dbFail(srcError, "knowledge_add_url_source_insert", "تعذر إنشاء المصدر"),
              500
            );
          }

          const {
            error:
              chunksError,
          } = await sb
            .from(
              "knowledge_chunks"
            )
            .insert(
              chunks.map(
                (
                  content,
                  i
                ) => ({
                  tenant_id:
                    tenant.id,

                  source_id:
                    src.id,

                  chunk_index:
                    i,

                  content,

                  embedding:
                    pg(
                      vectors[i]
                    ),
                })
              )
            );

          if (
            chunksError
          ) {
            return err(
              dbFail(chunksError, "knowledge_add_url_chunks_insert", "تعذر حفظ المحتوى في قاعدة المعرفة"),
              500
            );
          }

          return json({
            status:
              "indexed",

            chunks:
              chunks.length,

            title,
          });
        }

        const t =
          String(
            text ??
              ""
          ).trim();

        if (
          t.length < 20
        ) {
          return err(
            "النص قصير جدًا"
          );
        }

        // T5-S4 (bodyLimits.ts): bounded text before chunking / embedding.
        if (!textWithinLimit(t, INGEST_TEXT_MAX_CHARS)) return err(TEXT_TOO_LONG_MESSAGE);

        const chunks =
          chunkText(t);

        const vectors =
          await embed(
            chunks
          );

        const {
          data: src,
          error: srcError,
        } = await sb
          .from(
            "knowledge_sources"
          )
          .insert({
            tenant_id:
              tenant.id,

            kind:
              "manual",

            status:
              "indexed",

            chunks_count:
              chunks.length,

            raw_text_encrypted:
              await encryptField(
                t
              ),
          })
          .select()
          .single();

        if (
          srcError ||
          !src
        ) {
          return err(
            dbFail(srcError, "knowledge_add_text_source_insert", "تعذر إنشاء المصدر"),
            500
          );
        }

        const {
          error:
            chunksError,
        } = await sb
          .from(
            "knowledge_chunks"
          )
          .insert(
            chunks.map(
              (
                content,
                i
              ) => ({
                tenant_id:
                  tenant.id,

                source_id:
                  src.id,

                chunk_index:
                  i,

                content,

                embedding:
                  pg(
                    vectors[i]
                  ),
              })
            )
          );

        if (
          chunksError
        ) {
          return err(
            dbFail(chunksError, "knowledge_add_text_chunks_insert", "تعذر حفظ المحتوى في قاعدة المعرفة"),
            500
          );
        }

        return json({
          status:
            "indexed",

          chunks:
            chunks.length,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         KNOWLEDGE DELETE
      ═══════════════════════════════════════════════════════════════ */

      case "knowledge_delete": {
        const {
          error,
        } = await sb
          .from(
            "knowledge_sources"
          )
          .delete()
          .eq(
            "id",
            body.sourceId ??
              ""
          )
          .eq(
            "tenant_id",
            tenant.id
          );

        if (error) {
          return err(
            dbFail(error, "knowledge_delete", "تعذر الحذف — حاول مرة أخرى"),
            500
          );
        }

        return json({
          ok: true,
        });
      }

      /* ═══════════════════════════════════════════════════════════════
         PAYMENT CREATE
      ═══════════════════════════════════════════════════════════════ */

      case "pay_create": {
        const packages: Record<
          string,
          {
            name: string;
            credits: number;
            amount: number;
          }
        > = {
          starter: {
            name:
              "باقة البداية",
            credits:
              1000,
            amount:
              9900,
          },

          growth: {
            name:
              "باقة النمو",
            credits:
              3000,
            amount:
              24900,
          },

          scale: {
            name:
              "باقة التوسع",
            credits:
              10000,
            amount:
              64900,
          },
        };

        const p =
          packages[
            body.packageId
          ] ??
          packages.starter;

        const res =
          await fetch(
            "https://api.moyasar.com/v1/invoices",
            {
              method:
                "POST",

              headers: {
                "content-type":
                  "application/json",

                authorization:
                  `Basic ${btoa(
                    env(
                      "MOYASAR_SECRET_KEY"
                    ) + ":"
                  )}`,
              },

              body: JSON.stringify(
                {
                  amount:
                    p.amount,

                  currency:
                    "SAR",

                  description:
                    `ميلانو — ${p.name} (${p.credits} رد) — ${tenant.business_name}`,

                  callback_url:
                    `${env(
                      "SUPABASE_URL"
                    )}/functions/v1/milan-api?action=pay_webhook`,

                  metadata: {
                    tenant_id:
                      tenant.id,
                  },
                }
              ),
            }
          );

        if (!res.ok) {
          // Stage 6: status + validated code only, never Moyasar's body.
          return err(
            (await providerHttpError("Moyasar", res)).message,
            502
          );
        }

        const inv: any =
          await res.json();

        const {
          error,
        } = await sb
          .from(
            "payments"
          )
          .insert({
            tenant_id:
              tenant.id,

            provider:
              "moyasar",

            invoice_id:
              inv.id,

            amount:
              p.amount,

            currency:
              "SAR",

            status:
              "created",

            credits_granted:
              0,
          });

        if (error) {
          return err(
            dbFail(error, "pay_create", "تعذر إنشاء الفاتورة — حاول مرة أخرى"),
            500
          );
        }

        return json({
          invoiceId:
            inv.id,

          paymentUrl:
            inv.transaction
              ?.url ??
            inv.url ??
            null,
        });
      }
    }

    return err(
      `إجراء غير معروف: ${action}`,
      404
    );
  } catch (e) {
    // Stage 6: safe fields only (provider/status/code or a fixed category).
    console.error(
      `[milan-api:${action}]`,
      safeErrorLog(e)
    );

    if (e instanceof WaAuthError) {
      return err(e.message, 502);
    }

    return err(
      clientErrorMessage(e, "خطأ داخلي"),
      500
    );
  }
});
