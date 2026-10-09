// ═══════════════════════════════════════════════════════════════════
// Edge Function: create-payment
// POST { orderId, items?: [{ name, price }] }  (Bearer: Supabase user JWT)
// → { checkoutUrl, code, orderId }
//
// - يتحقق من المستخدم ومن أن الطلب ملكه وحالته pending
// - يأخذ المبلغ من قاعدة البيانات فقط (لا يثق بما يرسله العميل)
// - ينشئ رابط دفع في Wayl ويحفظ wayl_code / wayl_url
//
// Secrets: WAYL_TOKEN, WAYL_WEBHOOK_SECRET, WAYL_ENV (test|live، الافتراضي test)،
//          SITE_URL (اختياري، مثال https://example.com — يُستخدم لرابط العودة)
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "npm:@supabase/supabase-js@2";

const WAYL_API = "https://api.thewayl.com/api/v1/links";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Item = { label: string; amount: number; type: "increase" };

/**
 * بنود الفاتورة: نستخدم أسماء/أسعار العميل فقط إذا طابق مجموعها المبلغ المخزن،
 * وإلا نستخدم بنداً واحداً بالمبلغ الموثوق من قاعدة البيانات.
 */
function buildLineItems(
  total: number,
  orderId: string,
  clientItems: unknown,
): Item[] {
  if (Array.isArray(clientItems) && clientItems.length > 0 && clientItems.length <= 50) {
    const items: Item[] = [];
    let sum = 0;
    let ok = true;

    for (const it of clientItems) {
      const label = String((it as any)?.name ?? (it as any)?.label ?? "").trim().slice(0, 120);
      const amount = Number((it as any)?.price ?? (it as any)?.amount);

      if (!label || !Number.isInteger(amount) || amount <= 0) {
        ok = false;
        break;
      }

      sum += amount;
      items.push({ label, amount, type: "increase" });
    }

    if (ok && sum === total) return items;
  }

  return [{
    label: `طلب #${orderId.slice(0, 8)}`,
    amount: total,
    type: "increase",
  }];
}

/** رابط العودة بعد الدفع: SITE_URL إن ضُبط، وإلا Origin الطلب (HTTPS فقط). */
function redirectionUrl(req: Request, orderId: string): string | null {
  const base = (Deno.env.get("SITE_URL") ?? req.headers.get("origin") ?? "").trim().replace(/\/+$/, "");

  if (!/^https:\/\/[^\s/]+/i.test(base)) return null;

  return `${base}/payment-status?order=${orderId}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: cors });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supaUrl = Deno.env.get("SUPABASE_URL");
    const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const waylToken = Deno.env.get("WAYL_TOKEN");
    const waylSecret = Deno.env.get("WAYL_WEBHOOK_SECRET");

    if (!supaUrl || !srvKey) return json({ error: "إعدادات الخادم ناقصة" }, 500);

    if (!waylToken || !waylSecret) {
      console.error("[create-payment] WAYL_TOKEN or WAYL_WEBHOOK_SECRET missing");
      return json({ error: "بوابة الدفع غير مهيأة بعد" }, 500);
    }

    if (waylSecret.length < 32) {
      console.error("[create-payment] WAYL_WEBHOOK_SECRET is shorter than 32 chars");
      return json({ error: "إعداد بوابة الدفع غير آمن" }, 500);
    }

    const sb = createClient(supaUrl, srvKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ─── المصادقة ───
    const header = req.headers.get("authorization") ?? "";
    const jwt = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!jwt) return json({ error: "غير مصرح" }, 401);

    const { data: userData, error: userErr } = await sb.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "جلسة غير صالحة" }, 401);
    const user = userData.user;

    // ─── المدخلات ───
    const body = await req.json().catch(() => ({}));
    const orderId = String(body?.orderId ?? "");
    if (!UUID_RE.test(orderId)) return json({ error: "orderId غير صالح" }, 400);

    // ─── الطلب: ملكية + حالة + مبلغ موثوق من القاعدة ───
    const { data: order, error: orderErr } = await sb
      .from("orders")
      .select("id, user_id, total, status, wayl_code, wayl_url")
      .eq("id", orderId)
      .maybeSingle();

    if (orderErr) return json({ error: orderErr.message }, 500);
    if (!order || order.user_id !== user.id) return json({ error: "الطلب غير موجود" }, 404);

    // رابط دفع موجود مسبقاً لنفس الطلب → أعده بدل إنشاء رابط مكرر
    if (order.status === "pending_payment" && order.wayl_url) {
      return json({ checkoutUrl: order.wayl_url, code: order.wayl_code, orderId });
    }

    if (order.status !== "pending") {
      return json({ error: `لا يمكن الدفع لطلب حالته: ${order.status}` }, 409);
    }

    const total = Number(order.total);
    if (!Number.isInteger(total) || total <= 0) return json({ error: "مبلغ الطلب غير صالح" }, 400);

    const returnUrl = redirectionUrl(req, orderId);
    if (!returnUrl) {
      return json({ error: "تعذر تحديد رابط العودة: اضبط SITE_URL (HTTPS) في الأسرار" }, 500);
    }

    // ─── إنشاء رابط الدفع في Wayl ───
    const env = (Deno.env.get("WAYL_ENV") ?? "test").toLowerCase() === "live" ? "live" : "test";

    const waylRes = await fetch(WAYL_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WAYL-AUTHENTICATION": waylToken,
      },
      body: JSON.stringify({
        env,
        referenceId: orderId,
        total,
        currency: "IQD",
        customParameter: "",
        lineItem: buildLineItems(total, orderId, body?.items),
        webhookUrl: `${supaUrl}/functions/v1/wayl-webhook`,
        webhookSecret: waylSecret,
        redirectionUrl: returnUrl,
      }),
    });

    const waylText = await waylRes.text();
    let waylJson: any = {};
    try {
      waylJson = JSON.parse(waylText);
    } catch {
      /* ليس JSON */
    }

    const checkoutUrl: string | undefined = waylJson?.data?.url;
    const code: string | undefined = waylJson?.data?.code;

    if (!waylRes.ok || !checkoutUrl) {
      console.error(`[create-payment] wayl ${waylRes.status}: ${waylText.slice(0, 500)}`);
      return json({ error: "تعذر إنشاء رابط الدفع، حاول لاحقاً" }, 502);
    }

    // ─── حفظ الرابط وتحديث الحالة (فقط إن كان الطلب ما زال pending) ───
    const { error: upErr } = await sb
      .from("orders")
      .update({ wayl_code: code ?? null, wayl_url: checkoutUrl, status: "pending_payment" })
      .eq("id", orderId)
      .eq("status", "pending");

    if (upErr) {
      console.error("[create-payment] order update failed", upErr);
      return json({ error: "تعذر حفظ رابط الدفع" }, 500);
    }

    return json({ checkoutUrl, code: code ?? null, orderId });
  } catch (e) {
    console.error("[create-payment]", e);
    return json({ error: e instanceof Error ? e.message : "خطأ داخلي" }, 500);
  }
});
