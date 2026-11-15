// ═══════════════════════════════════════════════════════════════════
// create-payment core logic (pure; no Deno globals, no npm imports) so it can
// be unit-tested with fakes. index.ts wires Deno.env + supabase-js into it.
//
// - Authenticated user (Supabase JWT) must own the order (orders.user_id).
// - Amount and currency are taken from the server (DB row / IQD), never the client.
// - Clients receive generic error messages only (no DB/provider/exception text).
// - CORS: only the approved app origin (and SITE_URL's origin if configured).
// ═══════════════════════════════════════════════════════════════════

export const WAYL_API = "https://api.thewayl.com/api/v1/links";
export const APPROVED_ORIGIN = "https://hsnq2022022-cyber.github.io";
const MAX_BODY_BYTES = 16 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// deno-lint-ignore no-explicit-any
export type Db = any;

export type CreatePaymentDeps = {
  env: (name: string) => string | undefined;
  db: (url: string, serviceKey: string) => Db;
  /** Resolves a Supabase JWT to its user id, or null when invalid. */
  authUser: (db: Db, jwt: string) => Promise<{ id: string } | null>;
  fetch: typeof fetch;
  log?: Pick<Console, "log" | "warn" | "error">;
};

type Item = { label: string; amount: number; type: "increase" };

/** https origin of SITE_URL, or null. */
function siteOrigin(siteUrl: string | undefined): string | null {
  try {
    const u = new URL((siteUrl ?? "").trim());
    return u.protocol === "https:" && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
}

export function allowedOrigins(env: CreatePaymentDeps["env"]): Set<string> {
  const set = new Set([APPROVED_ORIGIN]);
  const site = siteOrigin(env("SITE_URL"));
  if (site) set.add(site);
  return set;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

/**
 * Line items: client names/prices are used only when they are well-formed and sum
 * exactly to the DB amount; otherwise a single item with the trusted DB amount.
 */
export function buildLineItems(total: number, orderId: string, clientItems: unknown): Item[] {
  if (Array.isArray(clientItems) && clientItems.length > 0 && clientItems.length <= 50) {
    const items: Item[] = [];
    let sum = 0;
    let ok = true;

    for (const it of clientItems) {
      const o = (it && typeof it === "object") ? it as Record<string, unknown> : {};
      const rawLabel = o.name ?? o.label;
      const label = typeof rawLabel === "string" ? rawLabel.trim().slice(0, 120) : "";
      const amount = Number(o.price ?? o.amount);

      if (!label || !Number.isSafeInteger(amount) || amount <= 0) {
        ok = false;
        break;
      }

      sum += amount;
      items.push({ label, amount, type: "increase" });
    }

    if (ok && sum === total) return items;
  }

  return [{ label: `طلب #${orderId.slice(0, 8)}`, amount: total, type: "increase" }];
}

/** Checkout link must be an https URL on thewayl.com without credentials. */
export function validCheckoutUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 2048) return false;
  try {
    const u = new URL(v);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.username && !u.password &&
      (host === "thewayl.com" || host.endsWith(".thewayl.com"));
  } catch {
    return false;
  }
}

export async function handleCreatePayment(req: Request, deps: CreatePaymentDeps): Promise<Response> {
  const log = deps.log ?? console;
  const origin = req.headers.get("origin");
  const allowed = allowedOrigins(deps.env);
  const originOk = origin !== null && allowed.has(origin);
  const cors = corsHeaders(originOk ? origin : null);

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });

  // Browser requests from a foreign origin are refused (no CORS grant either).
  if (origin !== null && !originOk) return json({ error: "غير مسموح" }, 403);

  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supaUrl = deps.env("SUPABASE_URL");
    const srvKey = deps.env("SUPABASE_SERVICE_ROLE_KEY");
    const waylToken = deps.env("WAYL_TOKEN");
    const waylSecret = deps.env("WAYL_WEBHOOK_SECRET");

    if (!supaUrl || !srvKey) return json({ error: "إعدادات الخادم ناقصة" }, 500);

    if (!waylToken || !waylSecret) {
      log.error("[create-payment] payment gateway not configured");
      return json({ error: "بوابة الدفع غير مهيأة بعد" }, 500);
    }

    if (waylSecret.length < 32) {
      log.error("[create-payment] webhook secret too short");
      return json({ error: "إعداد بوابة الدفع غير آمن" }, 500);
    }

    // ─── Authentication ───
    const header = req.headers.get("authorization") ?? "";
    const jwt = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!jwt) return json({ error: "غير مصرح" }, 401);

    const sb = deps.db(supaUrl, srvKey);
    const user = await deps.authUser(sb, jwt).catch(() => null);
    if (!user?.id) return json({ error: "جلسة غير صالحة" }, 401);

    // ─── Input ───
    const declared = req.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
      return json({ error: "الطلب كبير جداً" }, 413);
    }
    const rawBody = await req.text().catch(() => "");
    if (rawBody.length > MAX_BODY_BYTES) return json({ error: "الطلب كبير جداً" }, 413);
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
    } catch { /* invalid JSON → orderId check fails below */ }

    const orderId = typeof body.orderId === "string" ? body.orderId : "";
    if (!UUID_RE.test(orderId)) return json({ error: "orderId غير صالح" }, 400);

    // ─── Order: ownership + status + trusted amount from the DB ───
    const { data: order, error: orderErr } = await sb
      .from("orders")
      .select("id, user_id, total, status, wayl_code, wayl_url")
      .eq("id", orderId)
      .maybeSingle();

    if (orderErr) {
      log.error("[create-payment] order lookup failed");
      return json({ error: "تعذر قراءة الطلب، حاول لاحقاً" }, 500);
    }
    // Same response for "missing" and "not yours" (no existence oracle).
    if (!order || typeof order.user_id !== "string" || order.user_id !== user.id) {
      return json({ error: "الطلب غير موجود" }, 404);
    }

    // Existing link for the same order → return it instead of creating a duplicate.
    if (order.status === "pending_payment" && order.wayl_url) {
      return json({ checkoutUrl: order.wayl_url, code: order.wayl_code ?? null, orderId });
    }

    if (order.status !== "pending") {
      return json({ error: "لا يمكن الدفع لهذا الطلب" }, 409);
    }

    const total = Number(order.total);
    if (order.total === null || !Number.isSafeInteger(total) || total <= 0) {
      return json({ error: "مبلغ الطلب غير صالح" }, 400);
    }

    // Return URL: SITE_URL if configured, else the (approved) request Origin; HTTPS only.
    const base = (deps.env("SITE_URL") ?? (originOk ? origin : "") ?? "").trim().replace(/\/+$/, "");
    if (!/^https:\/\/[^\s/]+/i.test(base)) {
      log.error("[create-payment] return URL unavailable (SITE_URL not set)");
      return json({ error: "تعذر تحديد رابط العودة" }, 500);
    }
    const returnUrl = `${base}/payment-status?order=${orderId}`;

    // ─── Create the Wayl payment link (server-controlled amount and currency) ───
    const env = (deps.env("WAYL_ENV") ?? "test").toLowerCase() === "live" ? "live" : "test";

    let waylRes: Response;
    try {
      waylRes = await deps.fetch(WAYL_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WAYL-AUTHENTICATION": waylToken },
        body: JSON.stringify({
          env,
          referenceId: orderId,
          total,
          currency: "IQD",
          customParameter: "",
          lineItem: buildLineItems(total, orderId, body.items),
          webhookUrl: `${supaUrl}/functions/v1/wayl-webhook`,
          webhookSecret: waylSecret,
          redirectionUrl: returnUrl,
        }),
      });
    } catch {
      log.error("[create-payment] wayl request failed");
      return json({ error: "تعذر إنشاء رابط الدفع، حاول لاحقاً" }, 502);
    }

    let waylJson: Record<string, unknown> | null = null;
    try {
      const p = await waylRes.json();
      if (p && typeof p === "object") waylJson = p as Record<string, unknown>;
    } catch { /* not JSON */ }

    const data = (waylJson?.data && typeof waylJson.data === "object")
      ? waylJson.data as Record<string, unknown>
      : null;
    const checkoutUrl = data?.url;
    const code = typeof data?.code === "string" && data.code.length <= 128 ? data.code : null;

    if (!waylRes.ok || !validCheckoutUrl(checkoutUrl)) {
      // Status only; never the provider body (may echo request data).
      log.error(`[create-payment] wayl link rejected: HTTP ${waylRes.status}`);
      return json({ error: "تعذر إنشاء رابط الدفع، حاول لاحقاً" }, 502);
    }

    // ─── Persist link + status (only while the order is still pending) ───
    const { data: saved, error: upErr } = await sb
      .from("orders")
      .update({ wayl_code: code, wayl_url: checkoutUrl, status: "pending_payment" })
      .eq("id", orderId)
      .eq("status", "pending")
      .select("id");

    if (upErr) {
      log.error("[create-payment] order update failed");
      return json({ error: "تعذر حفظ رابط الدفع" }, 500);
    }

    if (!saved || saved.length === 0) {
      // A concurrent request already stored a link: return that one so the user
      // never gets two different payable links for the same order.
      const { data: cur } = await sb
        .from("orders")
        .select("id, user_id, status, wayl_code, wayl_url")
        .eq("id", orderId)
        .maybeSingle();
      if (cur && cur.user_id === user.id && cur.status === "pending_payment" && cur.wayl_url) {
        return json({ checkoutUrl: cur.wayl_url, code: cur.wayl_code ?? null, orderId });
      }
      return json({ error: "لا يمكن الدفع لهذا الطلب" }, 409);
    }

    return json({ checkoutUrl, code, orderId });
  } catch (e) {
    log.error("[create-payment] internal error", e instanceof Error ? e.name : "unknown");
    return json({ error: "خطأ داخلي" }, 500);
  }
}
