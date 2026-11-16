// ═══════════════════════════════════════════════════════════════════
// wayl-webhook core logic (pure; no Deno globals, no npm imports) so it can be
// unit-tested with fakes. index.ts wires Deno.env + supabase-js into it.
//
// Security model:
// - Body size capped (MAX_BODY_BYTES) while streaming, BEFORE signature/parse.
// - HMAC-SHA256 hex over the RAW body bytes, constant-time compare, fails closed.
// - Wayl sends no signed timestamp/nonce, so replay protection is provided by a
//   forward-only state machine: every status write is a single conditional
//   UPDATE ... WHERE status IN (<allowed previous states>). A paid row can never
//   regress (pending/cancelled/failed); duplicates and replays are no-ops.
// - Top-up 'paid' is applied ONLY by rpc wayl_grant_topup_once (one transaction:
//   lock row, re-verify, mark paid, credit the row's tenant). If that RPC is
//   missing or fails, the handler answers 500 (Wayl retries); there is no
//   fallback to a separate claim + grant_credits. Deploy the migration first.
// - Credits and amounts come only from the server-stored row, never the body.
// - Payment is accepted only when total (and currency, IQD) is present and equal
//   to the stored row; otherwise nothing is granted/activated (fail closed).
// - Logs never contain secrets, signatures, payload bodies or customer data.
// ═══════════════════════════════════════════════════════════════════

export const MAX_BODY_BYTES = 64 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG_RE = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();

// deno-lint-ignore no-explicit-any
export type Db = any;

export type WebhookDeps = {
  env: (name: string) => string | undefined;
  /** Creates the service-role DB client (called only after the signature is valid). */
  db: (url: string, serviceKey: string) => Db;
  now?: () => Date;
  log?: Pick<Console, "log" | "warn" | "error">;
};

const text = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hmacHex(secret: string, raw: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, raw));
}

/** Constant-time comparison (both inputs are fixed-length hex here). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Map Wayl paymentStatus to our status (case-insensitive). */
export function mapStatus(paymentStatus: string | null): string | null {
  switch ((paymentStatus ?? "").trim().toLowerCase()) {
    case "complete":
    case "completed":
      return "paid";
    case "delivered":
      return "delivered";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "rejected":
      return "failed";
    case "returned":
      return "refunded";
    default:
      return null;
  }
}

/** Fallback credits by IQD amount when the server-stored row carries none. */
const CREDITS_BY_AMOUNT: Record<number, number> = {
  35000: 1000,
  85000: 3000,
  225000: 10000,
};

// ─── Allowed previous states (forward-only state machines) ───
/** payments (top-up): states from which a verified 'paid' may be granted. Must equal
 *  the pre-payment list in wayl_grant_topup_once (migration 20261115130000); failed /
 *  cancelled / refunded rows are never granted automatically (manual review). */
export const PAYMENT_PAYABLE = ["created", "creating", "pending", "pending_payment", "creation_uncertain"];
/** payments: states that a cancel/failure event may overwrite. */
export const PAYMENT_CANCELLABLE = ["created", "creating", "pending", "pending_payment", "creation_uncertain"];

/** orders: incoming mapped status → allowed previous statuses. */
export const ORDER_TRANSITIONS: Record<string, string[]> = {
  paid: ["pending", "pending_payment", "cancelled", "failed"],
  cancelled: ["pending", "pending_payment"],
  failed: ["pending", "pending_payment"],
  delivered: ["paid"],
  refunded: ["paid", "delivered"],
};
/** orders: states in which an unverifiable 'paid' is flagged as amount_mismatch. */
const ORDER_FLAGGABLE = ["pending", "pending_payment", "cancelled", "failed"];
/** orders: states in which non-status events (webhook_data only) are recorded. */
const ORDER_OPEN = ["pending", "pending_payment"];

export type WaylEvent = {
  referenceId: string;
  paymentStatus: string | null;
  total: number | null;
  currency: string | null;
  paymentMethod: string | null;
  payload: Record<string, unknown>;
};

function optString(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > max) return undefined;
  return v;
}

/** Strict structural validation. Returns null when the event is malformed. */
export function parseEvent(v: unknown): WaylEvent | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.referenceId !== "string" || o.referenceId.length === 0 || o.referenceId.length > 128) {
    return null;
  }
  const paymentStatus = optString(o.paymentStatus, 64);
  const currency = optString(o.currency, 8);
  const paymentMethod = optString(o.paymentMethod, 64);
  if (paymentStatus === undefined || currency === undefined || paymentMethod === undefined) return null;

  let total: number | null;
  if (o.total === undefined || o.total === null) total = null;
  else if (typeof o.total === "number") {
    if (!Number.isFinite(o.total)) return null;
    total = o.total;
  } else if (typeof o.total === "string" && /^\d{1,15}(\.\d{1,6})?$/.test(o.total)) {
    total = Number(o.total);
  } else return null;

  return { referenceId: o.referenceId, paymentStatus, total, currency, paymentMethod, payload: o };
}

/** Paid amount and currency must be present and equal to the stored row (IQD only). */
export function amountVerified(ev: WaylEvent, storedAmount: unknown, storedCurrency: unknown): boolean {
  const expected = Number(storedAmount);
  if (storedAmount === null || storedAmount === undefined || storedAmount === "") return false;
  if (!Number.isSafeInteger(expected) || expected <= 0) return false;
  if (ev.total === null || !Number.isSafeInteger(ev.total) || ev.total !== expected) return false;
  if (String(storedCurrency ?? "").toUpperCase() !== "IQD") return false;
  if (ev.currency !== null && ev.currency.trim().toUpperCase() !== "IQD") return false;
  return true;
}

/** Credits come ONLY from the server-stored payments row (or the server package table). */
export function creditsFor(pay: Record<string, unknown>): number {
  const prev = (pay.webhook_event && typeof pay.webhook_event === "object" && !Array.isArray(pay.webhook_event))
    ? pay.webhook_event as Record<string, unknown>
    : {};
  if (prev.credits !== undefined && prev.credits !== null) {
    const stored = Number(prev.credits);
    return Number.isSafeInteger(stored) && stored > 0 && stored <= 1_000_000 ? stored : 0;
  }
  return CREDITS_BY_AMOUNT[Number(pay.amount)] ?? 0;
}

type Log = Pick<Console, "log" | "warn" | "error">;

const errCode = (e: unknown) =>
  (e && typeof e === "object" && "code" in e) ? String((e as { code: unknown }).code) : "unknown";

/** Top-up payment (payments table): grants credits at most once. */
async function handleTopup(
  sb: Db, pay: Record<string, unknown>, ev: WaylEvent, log: Log,
): Promise<Response> {
  const mapped = mapStatus(ev.paymentStatus);
  const prev = (pay.webhook_event && typeof pay.webhook_event === "object" && !Array.isArray(pay.webhook_event))
    ? pay.webhook_event as Record<string, unknown>
    : {};
  // The provider body is nested under "wayl"; it can never overwrite server keys (e.g. credits).
  const event = { ...prev, wayl: ev.payload };
  const payId = String(pay.id);

  if (String(pay.provider ?? "").toLowerCase() !== "wayl") {
    log.warn("[wayl-webhook] payment row is not a Wayl payment; ignored");
    return text("ok");
  }

  if (mapped === "paid") {
    if (pay.status === "paid") return text("ok"); // already processed (duplicate/replay)

    // Pre-checks on the row read above (fail closed, no writes). The RPC
    // re-checks everything under a row lock and is the only authority.
    if (!amountVerified(ev, pay.amount, pay.currency)) {
      log.error(`[wayl-webhook] topup ${payId}: amount/currency not verified; no credits granted`);
      return text("ok");
    }
    if (!PAYMENT_PAYABLE.includes(String(pay.status))) {
      log.warn(`[wayl-webhook] topup ${payId}: payment not payable; manual review`);
      return text("ok");
    }
    if (creditsFor(pay) <= 0 || Number(pay.credits_granted ?? 0) !== 0) {
      log.error(`[wayl-webhook] topup ${payId}: credits undeterminable or already granted; manual review`);
      return text("ok");
    }

    // ONE call, ONE transaction (migration 20261115130000): lock the payment,
    // re-verify provider/status/currency/amount, mark paid and grant the
    // row-stored credits to the row's tenant, all-or-nothing. Tenant and
    // credits are never sent; amount/currency are the verified values.
    // A lost response is safe: a retry returns already_paid.
    const { data, error: rpcErr } = await sb.rpc("wayl_grant_topup_once", {
      p_payment_id: payId,
      p_expected_amount: ev.total,
      p_currency: (ev.currency ?? String(pay.currency ?? "")).trim().toUpperCase(),
      p_event: ev.payload,
    });

    if (rpcErr) {
      // Fail closed (Wayl retries). Never fall back to a non-atomic grant.
      const code = errCode(rpcErr);
      log.error(
        code === "PGRST202" || code === "42883"
          ? "[wayl-webhook] atomic grant RPC unavailable; payment not processed"
          : "[wayl-webhook] atomic grant RPC failed",
        code,
      );
      return text("db error", 500);
    }

    const result = (data && typeof data === "object" && !Array.isArray(data))
      ? data as Record<string, unknown>
      : null;
    if (!result || typeof result.granted !== "boolean" || typeof result.reason !== "string") {
      log.error("[wayl-webhook] atomic grant RPC returned an unexpected result");
      return text("db error", 500);
    }
    if (result.granted) {
      log.log(`[wayl-webhook] topup ${payId}: granted ${Number(result.credits) || 0} credits`);
      return text("ok");
    }
    if (result.reason === "already_paid") return text("ok"); // concurrent/duplicate callback

    const reason = /^[a-z_]{1,32}$/.test(result.reason) ? result.reason : "unknown";
    log.warn(`[wayl-webhook] topup ${payId}: not granted (${reason}); manual review`);
    return text("ok");
  }

  if (mapped === "cancelled" || mapped === "failed") {
    // Never overwrites paid (or any terminal) state; a replay after payment is a no-op.
    // payments.status CHECK allows only created|paid|failed|refunded, so a Wayl
    // cancel is stored as 'failed'; the original Wayl status stays in
    // webhook_event.wayl (e.g. paymentStatus "Cancelled").
    const { error } = await sb.from("payments")
      .update({ status: "failed", webhook_event: event })
      .eq("id", payId).in("status", PAYMENT_CANCELLABLE);
    if (error) {
      log.error("[wayl-webhook] topup status update failed", errCode(error));
      return text("db error", 500);
    }
    return text("ok");
  }

  // delivered / refunded / unmapped: record the event only; status unchanged.
  const { error } = await sb.from("payments").update({ webhook_event: event }).eq("id", payId);
  if (error) {
    log.error("[wayl-webhook] topup event save failed", errCode(error));
    return text("db error", 500);
  }
  if (mapped === "refunded") {
    log.warn(`[wayl-webhook] topup ${payId} refunded; credits are NOT clawed back automatically`);
  }
  return text("ok");
}

async function readCapped(req: Request): Promise<Uint8Array<ArrayBuffer> | "too_large" | "bad_body"> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) return "too_large";
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return "bad_body";
  } finally {
    try {
      reader.releaseLock();
    } catch { /* already released */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return bytes;
}

export async function handleWaylWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const log = deps.log ?? console;
  if (req.method !== "POST") return text("Method not allowed", 405);

  try {
    const secret = deps.env("WAYL_WEBHOOK_SECRET");
    const supaUrl = deps.env("SUPABASE_URL");
    const srvKey = deps.env("SUPABASE_SERVICE_ROLE_KEY");

    if (!secret || !supaUrl || !srvKey) {
      log.error("[wayl-webhook] missing configuration");
      return text("server misconfigured", 500);
    }

    // ─── Size cap before signature verification or parsing ───
    const body = await readCapped(req);
    if (body === "too_large") return text("payload too large", 413);
    if (body === "bad_body") return text("invalid request body", 400);

    // ─── Signature over the RAW bytes, before any JSON.parse ───
    const sigHeader = (req.headers.get("x-wayl-signature-256") ?? "")
      .trim()
      .toLowerCase()
      .replace(/^sha256=/, "");

    if (!sigHeader) {
      log.warn("[wayl-webhook] missing signature");
      return text("missing signature", 401);
    }

    const expected = await hmacHex(secret, body);
    if (!SIG_RE.test(sigHeader) || !safeEqual(sigHeader, expected)) {
      log.warn("[wayl-webhook] invalid signature; ignored");
      return text("invalid signature", 401);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body));
    } catch {
      return text("invalid payload", 400);
    }

    const ev = parseEvent(parsed);
    if (!ev) {
      log.warn("[wayl-webhook] malformed event rejected");
      return text("invalid payload", 400);
    }

    const orderId = ev.referenceId;
    if (!UUID_RE.test(orderId)) {
      // Well-typed but unknown reference: 200 so Wayl does not retry forever.
      log.warn("[wayl-webhook] non-UUID referenceId ignored");
      return text("ok");
    }

    const sb = deps.db(supaUrl, srvKey);
    const now = (deps.now ?? (() => new Date()))();

    // ─── Top-up (payments table)? referenceId = payments.id ───
    const { data: pay, error: payErr } = await sb
      .from("payments")
      .select("id, tenant_id, provider, amount, currency, status, credits_granted, webhook_event")
      .eq("id", orderId)
      .maybeSingle();

    if (payErr) {
      log.error("[wayl-webhook] payment lookup failed", errCode(payErr));
      return text("db error", 500);
    }

    if (pay) return await handleTopup(sb, pay, ev, log);

    const { data: order, error: orderErr } = await sb
      .from("orders")
      .select("id, total, status, paid_at")
      .eq("id", orderId)
      .maybeSingle();

    if (orderErr) {
      log.error("[wayl-webhook] order lookup failed", errCode(orderErr));
      return text("db error", 500); // Wayl retries
    }

    if (!order) {
      log.warn(`[wayl-webhook] order not found: ${orderId}`);
      return text("ok");
    }

    const mapped = mapStatus(ev.paymentStatus);
    const patch: Record<string, unknown> = { webhook_data: ev.payload };
    if (ev.paymentMethod) patch.payment_method = ev.paymentMethod;

    let allowedFrom: string[];
    if (mapped === "paid") {
      if (order.status === "paid") return text("ok"); // duplicate/replay
      // orders has no currency column: the order is always created in IQD
      // (create-payment), so only the signed currency (if sent) is checked.
      if (!amountVerified(ev, order.total, "IQD")) {
        log.error(`[wayl-webhook] amount/currency not verified for order ${orderId}; not marked paid`);
        patch.status = "amount_mismatch";
        allowedFrom = ORDER_FLAGGABLE;
      } else {
        patch.status = "paid";
        if (!order.paid_at) patch.paid_at = now.toISOString();
        allowedFrom = ORDER_TRANSITIONS.paid;
      }
    } else if (mapped) {
      patch.status = mapped;
      allowedFrom = ORDER_TRANSITIONS[mapped] ?? [];
    } else {
      log.log("[wayl-webhook] unmapped paymentStatus; event recorded only");
      allowedFrom = ORDER_OPEN;
    }

    if (!allowedFrom.includes(String(order.status))) {
      log.warn(`[wayl-webhook] order ${orderId}: transition not allowed; ignored`);
      return text("ok");
    }

    // Conditional on the previous state, so a concurrent transition cannot be overwritten.
    const { error: upErr } = await sb
      .from("orders")
      .update(patch)
      .eq("id", orderId)
      .in("status", allowedFrom);

    if (upErr) {
      log.error("[wayl-webhook] update failed", errCode(upErr));
      return text("db error", 500);
    }

    return text("ok");
  } catch (e) {
    log.error("[wayl-webhook] internal error", e instanceof Error ? e.name : "unknown");
    return text("internal error", 500);
  }
}
