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

/** رصيد احتياطي حسب المبلغ (IQD) إن لم يُحفظ مع الدفعة. */
const CREDITS_BY_AMOUNT: Record<number, number> = {
  35000: 1000,
  85000: 3000,
  225000: 10000,
};

/**
 * معالجة دفعة شحن رصيد: تمنح الرصيد مرة واحدة فقط (claim ذري ثم منح).
 */
async function handleTopup(sb: any, pay: any, payload: any): Promise<Response> {
  const mapped = mapStatus(payload?.paymentStatus);
  const prev = (pay.webhook_event && typeof pay.webhook_event === "object") ? pay.webhook_event : {};
  const event = { ...prev, wayl: payload };

  if (mapped === "paid") {
    const paidTotal = Number(payload?.total);

    if (Number.isFinite(paidTotal) && paidTotal !== Number(pay.amount)) {
      console.error(
        `[wayl-webhook] topup amount mismatch ${pay.id}: paid=${paidTotal} expected=${pay.amount}`,
      );
      await sb.from("payments").update({ status: "amount_mismatch", webhook_event: event }).eq("id", pay.id);
      return text("ok");
    }

    const credits = Number(prev.credits) > 0
      ? Number(prev.credits)
      : (CREDITS_BY_AMOUNT[Number(pay.amount)] ?? 0);

    if (credits <= 0) {
      console.error(`[wayl-webhook] cannot determine credits for payment ${pay.id}`);
      await sb.from("payments").update({ webhook_event: event }).eq("id", pay.id);
      return text("ok");
    }

    // claim ذري: ينجح مرة واحدة فقط حتى لو أعاد Wayl الإرسال
    const { data: claimed, error: claimErr } = await sb
      .from("payments")
      .update({
        status: "paid",
        credits_granted: credits,
        webhook_event: event,
        paid_at: new Date().toISOString(),
      })
      .eq("id", pay.id)
      .neq("status", "paid")
      .select("id");

    if (claimErr) {
      console.error("[wayl-webhook] topup claim failed", claimErr);
      return text("db error", 500);
    }

    if (!claimed || claimed.length === 0) return text("ok"); // مُعالجة سابقاً

    const { error: grantErr } = await sb.rpc("grant_credits", {
      p_tenant_id: pay.tenant_id,
      p_credits: credits,
    });

    if (grantErr) {
      // تراجع عن الـ claim ليعيد Wayl المحاولة ولا يضيع الرصيد
      console.error("[wayl-webhook] grant_credits failed, reverting", grantErr);
      await sb.from("payments").update({ status: pay.status, credits_granted: 0, paid_at: null }).eq("id", pay.id);
      return text("db error", 500);
    }

    console.log(`[wayl-webhook] topup ${pay.id}: granted ${credits} credits`);
    return text("ok");
  }

  // حالات أخرى: نحفظ الحدث، ونُحدّث الحالة فقط إن لم تكن الدفعة مدفوعة
  const patch: Record<string, unknown> = { webhook_event: event };
  let q = sb.from("payments");

  if (mapped === "cancelled" || mapped === "failed") {
    await q.update({ ...patch, status: mapped }).eq("id", pay.id).neq("status", "paid");
  } else {
    await q.update(patch).eq("id", pay.id);
    if (mapped === "refunded") {
      console.warn(`[wayl-webhook] topup ${pay.id} refunded — credits are NOT clawed back automatically`);
    }
  }

  return text("ok");
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

    // ─── شحن رصيد الردود (جدول payments)؟ referenceId = payments.id ───
    const { data: pay, error: payErr } = await sb
      .from("payments")
      .select("id, tenant_id, amount, status, webhook_event")
      .eq("id", orderId)
      .maybeSingle();

    if (payErr) {
      console.error("[wayl-webhook] payment lookup failed", payErr);
      return text("db error", 500);
    }

    if (pay) return await handleTopup(sb, pay, payload);

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
