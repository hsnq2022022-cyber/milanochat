// ═══════════════════════════════════════════════════════════════════
// Edge Function: wayl-webhook
// POST من Wayl عند تغيّر حالة الدفع.
// - يتحقق من التوقيع x-wayl-signature-256 (HMAC-SHA256 hex على الجسم الخام)
// - يحدّث حالة الطلب في orders ويحفظ webhook_data كاملاً
//
// Secrets: WAYL_WEBHOOK_SECRET
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "npm:@supabase/supabase-js@2";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const enc = new TextEncoder();

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(raw)));
}

/** مقارنة بزمن ثابت لتفادي تسريب التوقيع بالتوقيت. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return diff === 0;
}

/** تحويل paymentStatus من Wayl إلى حالة الطلب (غير حساس لحالة الأحرف). */
function mapStatus(paymentStatus: unknown): string | null {
  switch (String(paymentStatus ?? "").trim().toLowerCase()) {
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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return text("Method not allowed", 405);

  try {
    const secret = Deno.env.get("WAYL_WEBHOOK_SECRET");
    const supaUrl = Deno.env.get("SUPABASE_URL");
    const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!secret || !supaUrl || !srvKey) {
      console.error("[wayl-webhook] missing configuration");
      return text("server misconfigured", 500);
    }

    // ─── التوقيع: على الجسم الخام قبل أي JSON.parse ───
    const raw = await req.text();

    const sigHeader = (req.headers.get("x-wayl-signature-256") ?? "")
      .trim()
      .toLowerCase()
      .replace(/^sha256=/, "");

    if (!sigHeader) {
      console.warn("[wayl-webhook] missing signature");
      return text("missing signature", 401);
    }

    const expected = await hmacHex(secret, raw);

    if (!safeEqual(sigHeader, expected)) {
      console.warn("[wayl-webhook] invalid signature — ignored");
      return text("invalid signature", 401);
    }

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return text("invalid json", 400);
    }

    const orderId = String(payload?.referenceId ?? "");

    if (!UUID_RE.test(orderId)) {
      // توقيع صحيح لكن مرجع غير معروف: نرد 200 كي لا يعيد Wayl المحاولة بلا نهاية
      console.warn(`[wayl-webhook] unknown referenceId: ${orderId}`);
      return text("ok");
    }

    const sb = createClient(supaUrl, srvKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: order, error: orderErr } = await sb
      .from("orders")
      .select("id, total, status, paid_at")
      .eq("id", orderId)
      .maybeSingle();

    if (orderErr) {
      console.error("[wayl-webhook] order lookup failed", orderErr);
      return text("db error", 500); // Wayl سيعيد المحاولة
    }

    if (!order) {
      console.warn(`[wayl-webhook] order not found: ${orderId}`);
      return text("ok");
    }

    const mapped = mapStatus(payload?.paymentStatus);

    const patch: Record<string, unknown> = {
      webhook_data: payload,
    };

    if (payload?.paymentMethod) patch.payment_method = String(payload.paymentMethod);

    if (mapped) {
      // حماية: لا نقبل "paid" إن لم يطابق المبلغ المدفوع مبلغ الطلب المخزن
      const paidTotal = Number(payload?.total);

      if (mapped === "paid" && Number.isFinite(paidTotal) && paidTotal !== Number(order.total)) {
        console.error(
          `[wayl-webhook] amount mismatch for ${orderId}: paid=${paidTotal} expected=${order.total}`,
        );
        patch.status = "amount_mismatch";
      } else {
        patch.status = mapped;
        if (mapped === "paid" && !order.paid_at) patch.paid_at = new Date().toISOString();
      }
    } else {
      console.log(`[wayl-webhook] unmapped paymentStatus: ${payload?.paymentStatus}`);
    }

    const { error: upErr } = await sb.from("orders").update(patch).eq("id", orderId);

    if (upErr) {
      console.error("[wayl-webhook] update failed", upErr);
      return text("db error", 500);
    }

    return text("ok");
  } catch (e) {
    console.error("[wayl-webhook]", e);
    return text("internal error", 500);
  }
});
